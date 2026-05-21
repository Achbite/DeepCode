#!/usr/bin/env bash
# ====================================================================
# DeepCode 容器内构建脚本（根目录版本，进容器后直接 ./build.sh  BUILD_TAURI=1 ./build.sh）
# 职责：编译并输出双平台产物到 ./bin/
#   - bin/linux-x64/   Linux 桌面便携产物（Tauri 模式：deepcode；Web 模式：deepcode-server + start.sh + web/）
#   - bin/win-x64/     Windows 桌面便携产物（Tauri 模式：deepcode.exe + WebView2Loader.dll；
#                      Web 模式：deepcode-server.exe + start.bat + web/）
#   - bin/installers/  一次性 GUI 安装包（Tauri 模式：DeepCode_*_x64-setup.exe）
#
# 设计要点：
#   1. server 是 ESM (`"type": "module"`)，pkg 不直吃 ESM；先用 esbuild 打成单文件 CJS bundle，再喂给 pkg。
#   2. client 是纯前端静态资源；Web 模式跨平台共用一份 dist/，Tauri 模式由 cargo tauri build 嵌入到 binary。
#   3. tauri Rust 端可选构建（BUILD_TAURI=1 启用，默认关闭，避免首次构建过慢）；走 cargo tauri build
#      让 Tauri CLI 自动启用 custom-protocol feature，否则 release build 仍走 devUrl 导致白屏。
#   4. 任何阶段失败立即终止；产物目录使用 find -delete 清内容方式重建，规避 NTFS DrvFs 句柄缓存问题。
# ====================================================================
set -euo pipefail

# ---- PATH 防御性 export ----
# Dockerfile.dev 已设 ENV PATH，但 bash -lc / login shell 会被 /etc/profile.d/*.sh 重置 PATH，
# 导致脚本中调用的 pkg / cargo / pnpm 可能找不到。这里显式拼接必要路径。
export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

# ---- 路径与常量 ----
# 产物目录布局对标 VSCode 风格：可执行产物（用户直接拿来跑的目录）与安装器（一次性安装包）分开放。
#   bin/linux-x64/  Linux 桌面便携产物（直接 ./deepcode）
#   bin/win-x64/    Windows 桌面便携产物（exe + dll 两件主体，依赖系统 WebView2 Runtime）
#   bin/installers/ 一次性 setup 安装包（NSIS *-setup.exe 等）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$ROOT_DIR/bin"
LINUX_DIR="$BIN_DIR/linux-x64"
WIN_DIR="$BIN_DIR/win-x64"
INSTALLERS_DIR="$BIN_DIR/installers"
SERVER_DIR="$ROOT_DIR/server"
CLIENT_DIR="$ROOT_DIR/client"
TAURI_RUST_DIR="$ROOT_DIR/tauri/src-tauri"

# 是否构建 Tauri Rust 二进制；默认关闭，避免首次构建过慢
BUILD_TAURI="${BUILD_TAURI:-0}"

cd "$ROOT_DIR"

echo "==[build]== DeepCode build started at $(date -Is)"
echo "==[build]== ROOT_DIR=$ROOT_DIR"
echo "==[build]== BUILD_TAURI=$BUILD_TAURI"

# ---- 1. 依赖安装 ----
# 容器开发期默认 --no-frozen-lockfile；lockfile 与 package.json 偏移时自动修正，
# 避免每次构建都需要先跳过一次 frozen 报错。CI 化后可改回 frozen。
echo "==[build][1/6]== pnpm install (no-frozen-lockfile)"
pnpm install --no-frozen-lockfile

# ---- 2. TypeScript 编译（protocol 优先 -> server/client）----
# 顺序重要：server/client 的 tsconfig 通过 paths 指向 protocol/dist，
# protocol 必须先产出 dist/*.{js,d.ts}，后续编译才能解析。
echo "==[build][2/6]== build protocol -> server (tsc) -> client (tsc + vite)"
pnpm --filter @deepcode/protocol run build
pnpm --filter @deepcode/server   run build
pnpm --filter @deepcode/client   run build

# ---- 3. 准备产物目录 ----
# 注意：清掉目录内容而非目录本身。NTFS DrvFs / WSL2 在 Windows 端有进程曾经持有过
# 这些目录或子文件时，可能短时间内仍持有 inode 句柄缓存，rm 整个目录会触发 EACCES。
# 清内容则只动子项，规避这个边界条件，且与 build 反复迭代场景兼容性更好。
echo "==[build][3/6]== prepare bin/ directories"
mkdir -p "$LINUX_DIR" "$WIN_DIR" "$INSTALLERS_DIR"
find "$LINUX_DIR"      -mindepth 1 -delete 2>/dev/null || true
find "$WIN_DIR"        -mindepth 1 -delete 2>/dev/null || true
find "$INSTALLERS_DIR" -mindepth 1 -delete 2>/dev/null || true

# ---- 3.1 预留配置目录结构 ----
# 打包产物中保留 config/global 与 config/user/local 两条线：
#   - global: 随产品分发的默认 skills / prompts / ruler
#   - user/local: 当前单机用户的设置、会话、密钥、skills、prompts、ruler
# 后续联网或多账号时，只需要把 local 替换为实际 user id，不再调整目录协议。
for TARGET_DIR in "$LINUX_DIR" "$WIN_DIR"; do
    mkdir -p \
        "$TARGET_DIR/config/global/skills" \
        "$TARGET_DIR/config/global/prompts" \
        "$TARGET_DIR/config/global/ruler" \
        "$TARGET_DIR/config/user/local/settings" \
        "$TARGET_DIR/config/user/local/skills" \
        "$TARGET_DIR/config/user/local/prompts" \
        "$TARGET_DIR/config/user/local/ruler" \
        "$TARGET_DIR/config/user/local/secrets" \
        "$TARGET_DIR/config/user/local/sessions"
done

# ---- 4. server 单文件可执行（双平台）----
# 先用 esbuild 把 ESM dist 打成 CJS 单文件 bundle，再交给 @yao-pkg/pkg 打成原生可执行
echo "==[build][4/6]== bundle server (esbuild) and package (pkg)"
BUNDLE_DIR="$ROOT_DIR/.build-cache/server-bundle"
rm -rf "$BUNDLE_DIR" && mkdir -p "$BUNDLE_DIR"

# 通过 pnpm exec 调用 esbuild（已声明为根 devDependency，./node_modules/.bin/ 可解析）
# CJS 输出下 import.meta.url 不可用，用 --define 重写为 CJS 等价表达式，让 fileURLToPath 仍能拿到正确的 __filename。
pnpm exec esbuild "$SERVER_DIR/src/index.ts" \
    --bundle \
    --platform=node \
    --target=node22 \
    --format=cjs \
    --outfile="$BUNDLE_DIR/index.cjs" \
    --external:fsevents \
    --legal-comments=none \
    --tsconfig="$SERVER_DIR/tsconfig.json" \
    "--define:import.meta.url=__deepcode_import_meta_url" \
    "--banner:js=const __deepcode_import_meta_url=require('url').pathToFileURL(__filename).toString();"

# 用 @yao-pkg/pkg 同时打两种目标（node22-linux-x64 / node22-win-x64）
# - --output 接基础名，pkg 会自动加 .exe 后缀（windows 目标）
# - --no-bytecode + --public + --public-packages "*"：禁用 V8 字节码预编译。
#   pkg 默认会在 host 上用 V8 生成字节码缓存，其格式与 host、架构、V8 版本绑定；
#   Linux x64 host 交叉打 Windows x64 时，字节码不兼容，启动会报
#   "V8 rejected the bytecode cache"。禁用后 pkg 嵌入原始 JS，运行时由
#   目标平台 V8 直接解析，代价是体积略增、冷启动加几十毫秒。
pkg "$BUNDLE_DIR/index.cjs" \
    --targets node22-linux-x64,node22-win-x64 \
    --output "$BUNDLE_DIR/deepcode-server" \
    --compress GZip \
    --no-bytecode \
    --public \
    --public-packages "*"

# 移动到对应平台目录
mv "$BUNDLE_DIR/deepcode-server-linux"     "$LINUX_DIR/deepcode-server"
mv "$BUNDLE_DIR/deepcode-server-win.exe"   "$WIN_DIR/deepcode-server.exe"
chmod +x "$LINUX_DIR/deepcode-server"

# ---- 5. client 静态资源（跨平台共用，分别拷贝以便单平台分发）----
echo "==[build][5/6]== copy client dist to both platforms"
if [ -d "$CLIENT_DIR/dist" ]; then
    cp -r "$CLIENT_DIR/dist" "$LINUX_DIR/web"
    cp -r "$CLIENT_DIR/dist" "$WIN_DIR/web"
else
    echo "==[build][warn]== client/dist 不存在，跳过前端资源拷贝"
fi

# ---- 6. 启动脚本（用户拿到产物后直接双击/运行）----
echo "==[build][6/6]== generate launcher scripts"

# Linux launcher
# server 静态托管由并且仅当 DEEPCODE_SERVE_CLIENT=1 时启用，路径走 DEEPCODE_CLIENT_DIST；
# 启动后轮询端口就绪，再调用 xdg-open 跳转默认浏览器进入 UI（WSL 下会调用 wslview 或宅主机默认浏览器）。
cat > "$LINUX_DIR/start.sh" <<'LINUX_LAUNCHER'
#!/usr/bin/env bash
# DeepCode Linux/WSL 启动脚本
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 工作区目录（用户数据，必须独立于产物目录避免权限/只读问题）----
# 优先级：
#   1) 用户显式指定 $DEEPCODE_WORKSPACE
#   2) XDG 数据目录（标准 Linux 桌面应用规范）
#   3) $HOME/.local/share/deepcode/workspace
if [ -z "${DEEPCODE_WORKSPACE:-}" ]; then
    if [ -n "${XDG_DATA_HOME:-}" ]; then
        DEEPCODE_WORKSPACE="${XDG_DATA_HOME}/deepcode/workspace"
    else
        DEEPCODE_WORKSPACE="${HOME}/.local/share/deepcode/workspace"
    fi
fi
mkdir -p "$DEEPCODE_WORKSPACE"
export DEEPCODE_WORKSPACE

export DEEPCODE_SERVE_CLIENT=1
export DEEPCODE_CLIENT_DIST="$SCRIPT_DIR/web"
PORT="${DEEPCODE_PORT:-31245}"
export DEEPCODE_PORT="$PORT"

echo "📂 Workspace: ${DEEPCODE_WORKSPACE}"

# 后台启动 server
"$SCRIPT_DIR/deepcode-server" &
SERVER_PID=$!
# 轮询端口就绪（最多 10s）
for i in $(seq 1 40); do
    if (echo > /dev/tcp/127.0.0.1/${PORT}) >/dev/null 2>&1; then break; fi
    sleep 0.25
done

URL="http://127.0.0.1:${PORT}/"
echo "🌐 打开 UI: ${URL}"
# 浏览器探测顺序：wslview > xdg-open > Windows 宿主 explorer.exe > Windows 宿主 PowerShell
# 在 WSL 中前两者通常缺失，靠 explorer.exe / powershell.exe 调起宿主默认浏览器
opened=0
if command -v wslview >/dev/null 2>&1; then
    wslview "$URL" >/dev/null 2>&1 && opened=1 || true
fi
if [ "$opened" -eq 0 ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 && opened=1 || true
fi
if [ "$opened" -eq 0 ] && command -v explorer.exe >/dev/null 2>&1; then
    # WSL：直接交给 Windows 默认协议处理器打开 URL
    explorer.exe "$URL" >/dev/null 2>&1 && opened=1 || true
fi
if [ "$opened" -eq 0 ] && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$URL'" >/dev/null 2>&1 && opened=1 || true
fi
if [ "$opened" -eq 0 ]; then
    echo "⚠️  无法自动打开浏览器，请手动访问: ${URL}"
fi

echo "按 Ctrl+C 或关闭终端可同时停止 server。"
# 前台等待 server 退出
wait "$SERVER_PID"
LINUX_LAUNCHER
chmod +x "$LINUX_DIR/start.sh"

# Windows launcher（纯 ASCII，避免 cmd.exe 默认 GBK 解释 UTF-8 中文导致乱码；
# 首行 chcp 65001 把控制台切到 UTF-8，以防后续 server 输出中文乱码。
# UI 外壳策略：
#   1) 设 DEEPCODE_SERVE_CLIENT=1 + DEEPCODE_CLIENT_DIST 让 server 托管前端静态资源
#   2) 后台启动 deepcode-server.exe（start /B）并轮询端口就绪
#   3) 优先 Edge --app=URL 开一个无地址栏的 PWA 独立窗口（体验近似桌面应用）；
#      找不到 Edge 时降级 start URL 调用默认浏览器
#   4) UI 启动后 cmd 窗口保留作为 server 状态台，关闭该窗口则 server 一同退出
cat > "$WIN_DIR/start.bat" <<'WIN_LAUNCHER'
@echo off
chcp 65001 > nul
setlocal
REM DeepCode Windows launcher (server + auto-open UI window)
set "BIN_DIR=%~dp0"
set "DEEPCODE_SERVE_CLIENT=1"
set "DEEPCODE_CLIENT_DIST=%BIN_DIR%web"
if "%DEEPCODE_PORT%"=="" set "DEEPCODE_PORT=31245"

REM Workspace directory (user data, must be outside read-only install dir).
REM Priority: user-defined DEEPCODE_WORKSPACE > %LOCALAPPDATA%\DeepCode\workspace
if "%DEEPCODE_WORKSPACE%"=="" set "DEEPCODE_WORKSPACE=%LOCALAPPDATA%\DeepCode\workspace"
if not exist "%DEEPCODE_WORKSPACE%" mkdir "%DEEPCODE_WORKSPACE%" >nul 2>&1
echo [DeepCode] Workspace: %DEEPCODE_WORKSPACE%

REM 1) start server in background within current console (so closing console kills server)
start "DeepCode Server" /B "%BIN_DIR%deepcode-server.exe"

REM 2) wait until port is up (max ~10s)
set /a TRY=0
:WAIT_PORT
set /a TRY+=1
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1', %DEEPCODE_PORT%)).Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto PORT_READY
if %TRY% GEQ 40 goto PORT_READY
ping -n 1 -w 250 127.0.0.1 >nul
goto WAIT_PORT
:PORT_READY

set "DEEPCODE_URL=http://127.0.0.1:%DEEPCODE_PORT%/"
echo [DeepCode] opening UI: %DEEPCODE_URL%

REM 3) prefer Microsoft Edge --app to get a clean PWA-like window
set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"      set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if defined EDGE (
    start "" "%EDGE%" --app=%DEEPCODE_URL% --new-window
) else (
    start "" %DEEPCODE_URL%
)

echo.
echo [DeepCode] server is running. Close this window to stop server.
echo.
REM 4) keep console alive so closing it tears down the background server
powershell -NoProfile -Command "Wait-Process -Name deepcode-server -ErrorAction SilentlyContinue"
endlocal
WIN_LAUNCHER

# ---- 可选：Tauri Rust 端原生二进制 ----
# BUILD_TAURI=1 时：用 Rust + WebView 把前端静态资源嵌入二进制，产出"真正的桌面应用"。
# 此时 Node server / start.* 启动器 / web/ 静态资源对最终用户都不再必要，会从 bin/ 中移除。
#
# 最终交付形态：
#   bin/linux-x64/deepcode                  Linux 原生桌面 ELF（直接执行）
#   bin/win-x64/deepcode.exe                Windows 桌面 EXE（含 WebView2Loader.dll 同目录分发）
#   bin/win-x64/WebView2Loader.dll          WebView2 加载器（与 deepcode.exe 同目录是 PE 加载器协议要求）
#   bin/win-x64/DeepCode_<ver>_x64-setup.exe  NSIS 安装器（如可生成）
#
# NSIS bundler 在 Linux→Windows-GNU cross 环境下要求容器装 nsis 包；
# 若 Tauri 内部依赖 Windows-only 的资源工具（如 signtool），cross 不可用时
# 仍输出 deepcode.exe + dll，跳过 installer，不影响主流程。
if [ "$BUILD_TAURI" = "1" ]; then
    echo "==[build][opt]== build tauri rust (linux + windows-gnu)"
    if [ -d "$TAURI_RUST_DIR" ]; then
        # ---- 0. WebView2 依赖说明（embedBootstrapper 模式）----
        # tauri.conf.json 配置 webviewInstallMode.type=embedBootstrapper：
        #   - 不在打包产物中嵌入 547MB Fixed Runtime。
        #   - Tauri 会在 NSIS 安装包中嵌入 ~1.8MB 官方 Bootstrapper（MicrosoftEdgeWebview2Setup.exe）。
        #   - 用户首次运行 setup.exe 时，Bootstrapper 检测系统是否已有运行时：
        #       · 已有（Win11 / 已装 Edge 的 Win10）→ 跳过；
        #       · 未安装 → 联网从微软下载安装（首次 ≈130MB，后续复用）。
        # 最终用户机器上 DeepCode 安装目录仅含 deepcode.exe + WebView2Loader.dll（~22MB），
        # 类 VSCode "exe + dll + 资源文件"的轻量分发形态。
        echo "==[build][webview2]== webviewInstallMode=embedBootstrapper；不下载 / 嵌入 547M Fixed Runtime"

        # 1) Linux 原生：cargo tauri build --no-bundle
        # 关键：必须用 cargo tauri build 而非裸 cargo build，原因是 Tauri CLI 会自动注入
        # --features custom-protocol，让前端 dist 通过自定义协议嵌入到 binary；
        # 否则 release 模式仍走 devUrl=http://localhost:5173，启动后白屏 ERR_CONNECTION_REFUSED。
        # --no-bundle 跳过 deb/AppImage 等 Linux 包，只产 ELF 可执行（我们只分发 portable 形态）。
        ( cd "$ROOT_DIR/tauri" && cargo tauri build --no-bundle --target x86_64-unknown-linux-gnu )
        cp -v "$TAURI_RUST_DIR/target/x86_64-unknown-linux-gnu/release/deepcode" "$LINUX_DIR/deepcode"
        chmod +x "$LINUX_DIR/deepcode"

        # 2) Windows 交叉：cargo tauri build --bundles nsis
        # 同样必须经 Tauri CLI 调度，确保 custom-protocol feature 生效；
        # 同步产 NSIS 安装器，单步完成（之前的两步 cargo build + cargo tauri bundle 会编译两次，浪费时间）。
        # cross 模式下 Tauri 会打印 "experimental" 警告，实测 130/131 系列 cab 与 mingw 链路稳定。
        ( cd "$ROOT_DIR/tauri" && cargo tauri build --bundles nsis --target x86_64-pc-windows-gnu )
        cp -v "$TAURI_RUST_DIR/target/x86_64-pc-windows-gnu/release/deepcode.exe"        "$WIN_DIR/deepcode.exe"
        cp -v "$TAURI_RUST_DIR/target/x86_64-pc-windows-gnu/release/WebView2Loader.dll"  "$WIN_DIR/WebView2Loader.dll"

        # 3) 拷贝 *-setup.exe 到 bin/installers/（与可执行产物分开）
        NSIS_OUT_DIR="$TAURI_RUST_DIR/target/x86_64-pc-windows-gnu/release/bundle/nsis"
        if [ -d "$NSIS_OUT_DIR" ]; then
            find "$NSIS_OUT_DIR" -maxdepth 1 -name '*-setup.exe' -exec cp -v {} "$INSTALLERS_DIR/" \;
        else
            echo "==[build][warn]== NSIS bundle 输出目录不存在；可能 cross 环境失败，便携形态仍可用"
        fi

        # 4) Tauri 模式下便携产物仅包含 deepcode.exe + WebView2Loader.dll
        #    【已切换为 embedBootstrapper】不再拷贝 547MB Fixed Runtime。
        #    便携用户需确保本机已安装 WebView2 Runtime（Win11 默认自带；老版 Win10 可
        #    走安装版 setup.exe 自动拉 Bootstrapper）。

        # Tauri 模式：清理 Web 模式残留（前端已嵌入二进制，server/start.* 不再需要）
        rm -f  "$LINUX_DIR/deepcode-server" "$LINUX_DIR/start.sh"
        rm -f  "$WIN_DIR/deepcode-server.exe" "$WIN_DIR/start.bat"
        rm -rf "$LINUX_DIR/web" "$WIN_DIR/web"

        # README：分发约束 + WSLg 启动指引
        cat > "$LINUX_DIR/README.txt" <<'LINUX_README'
DeepCode for Linux / WSL
========================

直接启动:
  ./deepcode

Windows + WSL 用户:
  在 WSL 中运行：./deepcode 即可借助 WSLg 在 Windows 桌面显示窗口。
  要求 WSL2 + Windows 11（或 Windows 10 已启用 WSLg 的版本）。

系统要求:
  - 已安装 webkit2gtk-4.1（包名因发行版而异：
    Debian/Ubuntu: libwebkit2gtk-4.1-0
    Arch: webkit2gtk-4.1
    Fedora: webkit2gtk4.1）
  - GTK3 / libsoup-3.0 运行时
LINUX_README

        # installers/ 目录写一份说明，避免用户拿到孤立 setup.exe 不知道与便携产物的关系
        cat > "$INSTALLERS_DIR/README.txt" <<'INSTALLERS_README'
DeepCode 安装包目录
==================

本目录存放标准 GUI 安装器（一次性使用）：
  DeepCode_<version>_x64-setup.exe   Windows NSIS 安装器（嵌入 ~1.8MB Bootstrapper，首次安装时检测 / 下载 WebView2 Runtime）

与便携产物的关系：
  - 便携形态： ../win-x64/        解压即用，不写注册表，不创建快捷方式
  - 安装形态： 当前目录 *-setup.exe，会安装到用户选定的目录（例如 D:\DeepCode），
              并注册开始菜单 / 桌面快捷方式 / 卸载入口。
  - 两种形态运行时表现完全一致，选其一即可；分发场景不同：
    * 团队 / IT 集中部署：用 setup.exe；
    * 单机临时使用 / U 盘携带：用 win-x64/。
INSTALLERS_README

        cat > "$WIN_DIR/README.txt" <<'WIN_README'
DeepCode for Windows
====================

本目录是 Windows 桌面便携产物（exe + dll 两件主体，类 VSCode / Codex 轻量分发形态）：
  deepcode.exe                主程序（嵌入前端 React + Monaco 资源）
  WebView2Loader.dll          WebView2 加载器（PE 同目录约束）

便携启动（推荐 Win11 / 已装 Edge 的 Win10）:
  双击 deepcode.exe 即可运行。该形态不携带运行时，依赖系统已安装的 WebView2 Runtime。

标准安装（推荐老版 Win10 / 不确定是否已装 Runtime 的机器）:
  使用 ../installers/DeepCode_<version>_x64-setup.exe 走 NSIS 安装流程。
  安装器嵌入了 ~1.8MB 微软官方 Bootstrapper，会自动检测 / 联网下载缺失的 Runtime。

系统要求:
  - Windows 10 1803 或 Windows 11
  - WebView2 Runtime（Win11 默认自带；Win10 可由安装器自动拉取）

注意:
  - deepcode.exe 与 WebView2Loader.dll 必须保持同一父目录，压缩 / 拷贝时不可遗漏 dll。
  - 首次启动会在用户目录下生成 EBWebView/ 缓存（WebView2 运行期产生，可安全删除）。
WIN_README
    else
        echo "==[build][warn]== tauri/src-tauri 不存在，跳过 Rust 构建"
    fi
fi

# ---- 产物清单 ----
echo ""
echo "==[build]== DONE. 产物清单："
echo "----------------------------------------"
( cd "$BIN_DIR" && find . -maxdepth 2 -mindepth 1 -type f \
    | sort | while read -r p; do
        if [ -d "$BIN_DIR/$p" ]; then
            sz=$(du -sh "$BIN_DIR/$p" 2>/dev/null | cut -f1)
            echo "  $p/   ($sz, dir)"
        else
            sz=$(du -h "$BIN_DIR/$p" 2>/dev/null | cut -f1)
            echo "  $p   ($sz)"
        fi
    done )
echo "----------------------------------------"
if [ "$BUILD_TAURI" = "1" ]; then
    echo "Linux/WSL 用户:    ./bin/linux-x64/deepcode      (双击或命令行直接运行)"
    echo "Windows 便携用户:  bin\\win-x64\\deepcode.exe      (整个 win-x64/ 目录视为一个分发单元)"
    echo "Windows 安装版:    bin\\installers\\DeepCode_*_x64-setup.exe  (走 NSIS 安装到用户目录如 D:\\DeepCode)"
else
    echo "Linux/WSL 用户:  cd bin/linux-x64 && ./start.sh"
    echo "Windows 兼容版:  bin\\win-x64\\start.bat  (推荐改用 WSL 跑 linux-x64)"
fi
