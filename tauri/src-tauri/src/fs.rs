// fs.rs
//
// 文件系统操作逻辑
//
// 提供目录树构建、文件读取、文件写入等能力；
// 所有操作必须基于已打开工作区的 folderId，并做路径防穿越校验。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ---- DTO：与 protocol DTO 字段同构 ----

/// 文件树节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub children: Option<Vec<FileTreeNode>>,
}

/// 文件读取结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub folder_id: String,
    pub path: String,
    pub content: String,
    pub size_bytes: u64,
    pub binary: bool,
}

/// 文件写入结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub folder_id: String,
    pub path: String,
    pub saved: bool,
    pub size_bytes: u64,
}

/// 新建目录结果（阶段 4 / S4-1）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderResult {
    pub folder_id: String,
    pub path: String,
    pub created: bool,
}

/// 重命名结果（文件或目录）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryResult {
    pub folder_id: String,
    pub old_path: String,
    pub new_path: String,
    pub renamed: bool,
}

/// 浏览条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub absolute_path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub is_code_workspace: bool,
    pub hidden: bool,
}

/// 浏览路径结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePathResult {
    pub absolute_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<BrowseEntry>,
}

/// 快捷起点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialLocation {
    pub label: String,
    pub absolute_path: String,
    pub kind: String,
}

/// 初始位置结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialLocations {
    pub platform: String,
    pub locations: Vec<InitialLocation>,
}

// ---- 常量 ----

/// 文本文件大小阈值（16 MiB）；超过此大小返回只读提示，不灌入编辑器
const TEXT_FILE_SIZE_LIMIT: u64 = 16 * 1024 * 1024;

/// 写入文件大小限制（16 MiB），与 Node 端 fileService 对齐
const WRITE_SIZE_LIMIT: u64 = 16 * 1024 * 1024;

/// 二进制嗅探：前 8KB 中出现 NUL 字节则认定为二进制
const BINARY_SNIFF_SIZE: usize = 8192;

/// 目录树最大递归深度；防止 monorepo 深目录把响应撑爆
const MAX_TREE_DEPTH: u32 = 6;

/// 目录树最大总节点数；超过即截断，避免一次性给前端 megabyte 级 JSON
const MAX_TREE_NODES: usize = 5000;

/// 目录树排除目录集合：与 Node 端 fileService.EXCLUDED_DIR_NAMES 保持一致
const EXCLUDED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".vite",
    ".cache",
    ".venv",
    "__pycache__",
    "target",
];

// ---- 目录树 ----

/// 构建指定 folder 根下的目录树。
///
/// folder_id 当前不直接写入返回结果（FileTreeNode 字段层不携带 folder 归属），
/// 但保留参数语义：调用方在多 folder 场景下据此匹配权属，未来若扩展节点 schema
/// 也无需调整签名。
pub fn build_file_tree(folder_root: &str, _folder_id: &str) -> Result<Vec<FileTreeNode>, String> {
    let root = PathBuf::from(folder_root);
    if !root.is_dir() {
        return Err(format!("folder 根路径不是目录: {}", folder_root));
    }
    let mut nodes = Vec::new();
    let mut node_count: usize = 0;
    visit_dir(&root, &root, &mut nodes, 0, &mut node_count)?;
    Ok(nodes)
}

/// 递归收集目录条目；带深度限制、节点总数限制、排除目录集合。
fn visit_dir(
    dir: &Path,
    root: &Path,
    nodes: &mut Vec<FileTreeNode>,
    depth: u32,
    node_count: &mut usize,
) -> Result<(), String> {
    if depth >= MAX_TREE_DEPTH {
        return Ok(());
    }
    if *node_count >= MAX_TREE_NODES {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过点开头隐藏项；与 Node 端 fileService 行为一致
        if name.starts_with('.') {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取元数据失败: {}", e))?;

        // 排除大型构建/缓存目录，避免遍历 monorepo 上百万文件
        if metadata.is_dir() && EXCLUDED_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());

        if metadata.is_dir() {
            let mut children = Vec::new();
            visit_dir(&path, root, &mut children, depth + 1, node_count)?;
            *node_count += 1;
            dirs.push(FileTreeNode {
                name,
                path: relative,
                node_type: "directory".into(),
                children: Some(children),
            });
        } else if metadata.is_file() {
            *node_count += 1;
            files.push(FileTreeNode {
                name,
                path: relative,
                node_type: "file".into(),
                children: None,
            });
        }
        // 命中节点上限即截断；上层依旧返回已收集结果，前端拿到部分树而非报错
        if *node_count >= MAX_TREE_NODES {
            break;
        }
    }

    // 排序：目录优先，目录/文件内部均按 lowercase 名称升序
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    nodes.extend(dirs);
    nodes.extend(files);
    Ok(())
}

// ---- 文件读取 ----

/// 读取工作区内文本文件
///
/// 与 Node 端 fileService.readFileContent 行为对齐：超过 16 MiB 阈值返回提示文本而非内容；
/// 二进制文件 content 留空并设置 binary=true。
pub fn read_text_file(
    folder_root: &str,
    folder_id: &str,
    relative_path: &str,
) -> Result<FileReadResult, String> {
    let full_path = resolve_and_validate(folder_root, relative_path)?;

    let metadata = fs::metadata(&full_path)
        .map_err(|e| format!("读取文件元数据失败: {}", e))?;

    if metadata.is_dir() {
        return Err(format!("路径是目录，不是文件: {}", relative_path));
    }

    let size_bytes = metadata.len();

    // 大文件：与 Node 端一致返回只读提示，不实际读取内容
    if size_bytes > TEXT_FILE_SIZE_LIMIT {
        return Ok(FileReadResult {
            folder_id: folder_id.into(),
            path: relative_path.into(),
            content: format!(
                "// 文件过大（{} 字节，阈值 {} 字节），已自动切换到只读提示模式。",
                size_bytes, TEXT_FILE_SIZE_LIMIT
            ),
            size_bytes,
            binary: false,
        });
    }

    let binary = is_binary_file(&full_path)?;

    let content = if binary {
        String::new()
    } else {
        fs::read_to_string(&full_path)
            .map_err(|e| format!("读取文件内容失败: {}", e))?
    };

    Ok(FileReadResult {
        folder_id: folder_id.into(),
        path: relative_path.into(),
        content,
        size_bytes,
        binary,
    })
}

// ---- 文件写入 ----

/// 写入工作区内文本文件
pub fn write_text_file(
    folder_root: &str,
    folder_id: &str,
    relative_path: &str,
    content: &str,
) -> Result<FileWriteResult, String> {
    let content_bytes = content.len() as u64;
    if content_bytes > WRITE_SIZE_LIMIT {
        return Err(format!(
            "文件内容超过写入限制 ({} > {})",
            content_bytes, WRITE_SIZE_LIMIT
        ));
    }

    let full_path = resolve_and_validate(folder_root, relative_path)?;

    // 确保父目录存在
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    fs::write(&full_path, content)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    let size_bytes = fs::metadata(&full_path)
        .map(|m| m.len())
        .unwrap_or(content_bytes);

    Ok(FileWriteResult {
        folder_id: folder_id.into(),
        path: relative_path.into(),
        saved: true,
        size_bytes,
    })
}

// ---- 新建文件 / 新建目录（阶段 4 / S4-1）----

/// 新建文件
///
/// 与 VSCode 一致：路径已存在不覆盖，返回 file_already_exists 错误。
/// 父目录不存在时递归创建。
pub fn create_file(
    folder_root: &str,
    folder_id: &str,
    relative_path: &str,
    initial_content: &str,
) -> Result<FileWriteResult, String> {
    if relative_path.trim().is_empty() {
        return Err("路径不能为空".into());
    }

    let content_bytes = initial_content.len() as u64;
    if content_bytes > WRITE_SIZE_LIMIT {
        return Err(format!(
            "写入内容过大（{} 字节，阈值 {} 字节）",
            content_bytes, WRITE_SIZE_LIMIT
        ));
    }

    let full_path = resolve_and_validate(folder_root, relative_path)?;

    if full_path.exists() {
        return Err(format!("file_already_exists: {}", relative_path));
    }

    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    fs::write(&full_path, initial_content)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    let size_bytes = fs::metadata(&full_path)
        .map(|m| m.len())
        .unwrap_or(content_bytes);

    Ok(FileWriteResult {
        folder_id: folder_id.into(),
        path: relative_path.into(),
        saved: true,
        size_bytes,
    })
}

/// 新建目录（递归创建中间目录）
///
/// 路径已存在为目录时返回 created=false 不报错；路径已存在为文件时报 file_already_exists。
pub fn create_folder(
    folder_root: &str,
    folder_id: &str,
    relative_path: &str,
) -> Result<CreateFolderResult, String> {
    if relative_path.trim().is_empty() {
        return Err("路径不能为空".into());
    }

    let full_path = resolve_and_validate(folder_root, relative_path)?;

    let mut created = true;
    if full_path.exists() {
        let meta = fs::metadata(&full_path)
            .map_err(|e| format!("读取元数据失败: {}", e))?;
        if meta.is_file() {
            return Err(format!("file_already_exists: {}", relative_path));
        }
        // 已存在为目录：mkdir recursive 幂等，标记 created=false
        created = false;
    }

    fs::create_dir_all(&full_path)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    Ok(CreateFolderResult {
        folder_id: folder_id.into(),
        path: relative_path.into(),
        created,
    })
}

/// 重命名文件或目录；目标已存在时不覆盖。
pub fn rename_entry(
    folder_root: &str,
    folder_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<RenameEntryResult, String> {
    if old_path.trim().is_empty() || new_path.trim().is_empty() {
        return Err("路径不能为空".into());
    }

    let old_full = resolve_and_validate(folder_root, old_path)?;
    let new_full = resolve_and_validate(folder_root, new_path)?;

    if !old_full.exists() {
        return Err(format!("源路径不存在: {}", old_path));
    }
    if new_full.exists() {
        return Err(format!("file_already_exists: {}", new_path));
    }
    if let Some(parent) = new_full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标父目录失败: {}", e))?;
    }
    fs::rename(&old_full, &new_full)
        .map_err(|e| format!("重命名失败: {}", e))?;

    Ok(RenameEntryResult {
        folder_id: folder_id.into(),
        old_path: old_path.into(),
        new_path: new_path.into(),
        renamed: true,
    })
}

// ---- 目录浏览（用于 Open Workspace 对话框）----

/// 浏览指定绝对路径下的子项
pub fn browse_path(absolute_path: &str) -> Result<BrowsePathResult, String> {
    let target = PathBuf::from(absolute_path);
    if !target.is_dir() {
        return Err(format!("路径不是目录: {}", absolute_path));
    }

    let abs_posix = target.to_string_lossy().replace('\\', "/");

    let parent_path = target
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .filter(|p| !p.is_empty());

    let entries = fs::read_dir(&target)
        .map_err(|e| format!("读取目录失败: {}", e))?;

    let mut result: Vec<BrowseEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path();
        let abs_entry = full_path.to_string_lossy().replace('\\', "/");

        let metadata = entry.metadata().map_err(|e| format!("读取元数据失败: {}", e))?;

        let is_dir = metadata.is_dir();
        let is_code_ws = !is_dir && name.to_lowercase().ends_with(".code-workspace");
        let hidden = name.starts_with('.');

        result.push(BrowseEntry {
            name,
            absolute_path: abs_entry,
            entry_type: if is_dir { "directory".into() } else { "file".into() },
            is_code_workspace: is_code_ws,
            hidden,
        });
    }

    // 排序：目录优先 + 名称升序
    result.sort_by(|a, b| {
        match (a.entry_type.as_str(), b.entry_type.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(BrowsePathResult {
        absolute_path: abs_posix,
        parent_path,
        entries: result,
    })
}

/// 获取初始位置（Home / Drives）
pub fn get_initial_locations() -> InitialLocations {
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    let mut locations = Vec::new();

    // Home 目录
    if let Some(home) = dirs_home() {
        let label = if cfg!(target_os = "windows") {
            "Home".into()
        } else {
            "Home".into()
        };
        locations.push(InitialLocation {
            label,
            absolute_path: home,
            kind: "home".into(),
        });
    }

    // Windows 盘符
    if cfg!(target_os = "windows") {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:/", letter as char);
            if Path::new(&drive).is_dir() {
                locations.push(InitialLocation {
                    label: format!("{}:\\", letter as char),
                    absolute_path: format!("{}:/", letter as char),
                    kind: "drive".into(),
                });
            }
        }
    }

    // 根目录（非 Windows）
    if !cfg!(target_os = "windows") {
        locations.push(InitialLocation {
            label: "Root".into(),
            absolute_path: "/".into(),
            kind: "drive".into(),
        });
    }

    InitialLocations {
        platform: platform.into(),
        locations,
    }
}

// ---- 路径安全 ----

/// 解析相对路径并校验不穿越 folder 根。
///
/// 安全分两层：
///   1. 输入层：拒绝绝对路径与含 `..` 的路径段，避免显式构造越界；
///   2. 解析层：拼接后规范化（仅父目录），再用 `starts_with(root)` 判断。
///
/// 写入新文件时 full 自身可能不存在，因此只对父目录做 canonicalize；这避免了
/// 旧实现 "父目录不存在就 fallback 到 root 误判通过" 的逻辑漏洞。
fn resolve_and_validate(folder_root: &str, relative_path: &str) -> Result<PathBuf, String> {
    use std::path::Component;

    let raw = Path::new(relative_path);
    if raw.is_absolute() {
        return Err(format!("不允许使用绝对路径: {}", relative_path));
    }
    for comp in raw.components() {
        match comp {
            Component::ParentDir => {
                return Err(format!("路径包含 '..' 段: {}", relative_path));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!("非法路径前缀: {}", relative_path));
            }
            _ => {}
        }
    }

    let root = PathBuf::from(folder_root)
        .canonicalize()
        .map_err(|e| format!("folder 根路径规范化失败: {}", e))?;

    let full = root.join(raw);

    // 父目录必须存在且仍落在 root 内。若父目录不存在则要求拼接路径自身也在 root 内（保守校验）。
    let parent_canonical = match full.parent().and_then(|p| p.canonicalize().ok()) {
        Some(p) => p,
        None => {
            return Err(format!("路径父目录无效: {}", relative_path));
        }
    };
    if !parent_canonical.starts_with(&root) {
        return Err(format!("路径穿越：{} 超出工作区范围", relative_path));
    }

    Ok(full)
}

/// 二进制文件嗅探：前 8KB 中出现 NUL 字节则认定为二进制
fn is_binary_file(path: &Path) -> Result<bool, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut buf = [0u8; BINARY_SNIFF_SIZE];
    let n = std::io::Read::read(&mut file, &mut buf)
        .map_err(|e| format!("读取文件头部失败: {}", e))?;
    Ok(buf[..n].contains(&0))
}

/// 获取用户 Home 目录
fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|p| PathBuf::from(p).to_string_lossy().replace('\\', "/"))
}
