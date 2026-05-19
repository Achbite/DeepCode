// build.rs
//
// Tauri 构建脚本：在编译期注入资源、ICO/ICNS 图标、Windows manifest 等。
// 该文件由 tauri-build 自动驱动；保持极简。

fn main() {
    tauri_build::build()
}
