# TCR：默认全平台构建与目标隔离

- 授权范围：默认尝试全平台交叉编译和打包；缺少对应支持环境则跳过；实际构建错误保留失败；仅调整构建脚本。
- 测试必要性：原构建入口把 Linux/Windows 产物校验绑定，Darwin 默认只打包 macOS。新增目标编排需要证明跳过不会阻断其他目标、真实失败不会被汇总吞掉；现有 Session/Kernel/UI 测试不覆盖这些行为。
- 新增 `scripts/tests/build-platforms.sh`，通过临时构建脚本调用真实编排函数，覆盖全部可用、Windows 环境缺失、Windows 子构建失败后继续 macOS 并返回非零、中断后停止后续目标、全部缺失时不产生任何构建调用五个场景。同时验证 macOS 不结束运行应用的参数保持传递，子脚本失败后不会落入后续产物输出语句。
- 注册到 `test.sh` 的 static 检查，随 required/cli/full 一同执行；未删除测试、未降低现有断言或必验 profile。
- 真实验证：在当前 worktree 的 Docker 开发容器执行默认 `build.sh`，核对 Linux 与 Windows 目标、两个 GUI、CLI/TUI、Kernel/Host/Session runtime；macOS 经现有原生打包服务执行。不启动 GUI，不以文件构建结果替代目标系统运行验收。
- 执行结果：默认 `bash ./build.sh --no-kill-running` 在当前项目容器完成，汇总 `built=3 skipped=0 failed=0`，总耗时 280 秒；Linux 174 秒、Windows 66 秒、macOS 40 秒。macOS 服务请求 `20260912T192702Z-183983` 返回 done。
- `bash ./build.sh --stage verify-package-runtime` 通过；两个 Linux GUI 为 ARM64 ELF、两个 Windows GUI 为 x64 PE、两个 macOS App 为 ARM64 Mach-O。构建产物不等于 Windows/Linux GUI 或 macOS 已安装应用的运行验收。
- 收尾修正宿主机预检的用户工具链路径，以及子构建中断时不启动剩余平台。之后 `bash ./test.sh cli` 全部通过，含新增五项构建检查、既有 Rust/Session/GUI/类型检查和 CLI fixture Provider 链路；CLI 记录释放 3 个测试 runtime，无 GUI 验证。宿主机 macOS 环境预检通过；指定不存在的 Windows Node runtime 时正确拒绝进入编译。
- 日志：`.logs/build-all-platforms-20260913.log`、`.logs/build-all-platforms-runtime-20260913.log`、`.logs/build-all-platforms-cli-20260913.log`。
