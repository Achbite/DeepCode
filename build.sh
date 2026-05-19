#!/usr/bin/env bash
# ====================================================================
# DeepCode 容器内构建脚本（根目录版本，进容器后直接 ./build.sh）
# 职责：编译并输出双平台产物到 ./bin/
#   - bin/linux-x64/  : 服务端 Node 单文件可执行（Linux x64） + 前端 dist
#   - bin/win-x64/    : 服务端 Node 单文件 .exe（Windows x64）   + 前端 dist
# 不在本期产出：Tauri GUI 的 Windows 安装包（需要 Windows runner + WebView2 SDK，跨平台不可行）
#
# 设计要点：
#   1. server 是 ESM (`"type": "module"`)，pkg 不直吃 ESM；先用 esbuild 打成单文件 CJS bundle，再喂给 pkg。
#   2. client 是纯前端静态资源，跨平台共用一份 dist/。
#   3. tauri Rust 端可选构建（默认开启 Linux release，Windows 通过 mingw 交叉编译）。
#   4. 任何阶段失败立即终止；产物目录使用 rm -rf 重建，确保干净。
# ====================================================================
set -euo pipefail

# ---- PATH 防御性 export ----
# Dockerfile.dev 已设 ENV PATH，但 bash -lc / login shell 会被 /etc/profile.d/*.sh 重置 PATH，
# 导致脚本中调用的 pkg / cargo / pnpm 可能找不到。这里显式拼接必要路径。
export PATH="/root/.local/share/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

# ---- 路径与常量 ----
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$ROOT_DIR/bin"
LINUX_DIR="$BIN_DIR/linux-x64"
WIN_DIR="$BIN_DIR/win-x64"
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
mkdir -p "$LINUX_DIR" "$WIN_DIR"
find "$LINUX_DIR" -mindepth 1 -delete 2>/dev/null || true
find "$WIN_DIR"   -mindepth 1 -delete 2>/dev/null || true

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
if [ "$BUILD_TAURI" = "1" ]; then
    echo "==[build][opt]== build tauri rust (linux + windows-gnu)"
    if [ -d "$TAURI_RUST_DIR" ]; then
        ( cd "$TAURI_RUST_DIR" && cargo build --release --target x86_64-unknown-linux-gnu ) || true
        ( cd "$TAURI_RUST_DIR" && cargo build --release --target x86_64-pc-windows-gnu )   || true
        # 拷贝产物（如成功）
        find "$TAURI_RUST_DIR/target/x86_64-unknown-linux-gnu/release" -maxdepth 1 -type f -executable \
            -not -name '*.d' -exec cp -v {} "$LINUX_DIR/" \; 2>/dev/null || true
        find "$TAURI_RUST_DIR/target/x86_64-pc-windows-gnu/release"    -maxdepth 1 -name '*.exe'      \
            -exec cp -v {} "$WIN_DIR/"   \; 2>/dev/null || true
    else
        echo "==[build][warn]== tauri/src-tauri 不存在，跳过 Rust 构建"
    fi
fi

# ---- 产物清单 ----
echo ""
echo "==[build]== DONE. 产物清单："
echo "----------------------------------------"
( cd "$BIN_DIR" && find . -maxdepth 3 -type f | sort )
echo "----------------------------------------"
echo "Linux/WSL 用户:  cd bin/linux-x64 && ./start.sh"
echo "Windows 兼容版:  bin\\win-x64\\start.bat  (推荐改用 WSL 跑 linux-x64)"
