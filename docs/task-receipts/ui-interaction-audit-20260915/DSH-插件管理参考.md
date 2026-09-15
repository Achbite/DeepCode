# DSH 插件管理参考与 DeepCode 映射

本轮按用户要求只读核对本地 `/Users/wangdi/Desktop/Project/deepseek-harness`，HEAD 为 `0d1f50007f`。结论来自所列源码；没有运行 DSH、验证插件数量规模，或修改该仓库。

## 源码确认的机制

| 机制 | DSH 当前事实 | 源码 |
| --- | --- | --- |
| 运行目录 | 每次直接读取 Loader entries，分别返回 enabled 与 fiberPhase；不建立第二份运行状态缓存。清单还可带 Agent preset 的组成 | `packages/host/plugin-inventory/src/index.ts:58` |
| 管理展示 | 支持搜索、折叠详情、实际加载阶段、失败条目。这个 inventory 页面是只读视图，不是通用安装与启停控制台 | `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx:204` |
| 单项配置 | 按可配置 namespace 派发 settings.plugin.item；插件提供自己的配置卡片，外层不解释每个插件的字段 | `packages/client/ui-settings-plugins/src/client/ConfigurablePluginsTab.tsx:31` |
| UI 热更新 | 订阅 rebuilt，预取新模块，等待旧 fiber 卸载，移除该插件自己的 style，再 entry.refresh；更新按队列串行处理，错误被保留 | `packages/client/hmr/src/client/index.ts:87`、`:122` |
| 动态 Host 插件 | 在指定动态 group 下创建子 fiber；等待初始化，失败时释放；依赖未出现时可保持 pending。注册资源由 fiber effect 负责释放 | `packages/extensions/cordis-host-runner/src/lifecycle.ts:24` |
| 更新范围 | 客户端插件包可局部更换；客户端 shell 变更仍需页面刷新。Host HMR 对启动入口依赖的变更走 Loader 退出／重启范围 | `packages/client/hmr/src/client/index.ts:1`、`vendor/hmr/src/index.ts:130` |

DSH 的热更新依赖显式注册、依赖关系和可等待的释放。插件名称、开关和一次保存本身不能证明插件已加载或已热更新。

## 映射到 DeepCode 的管理方式

1. **统一目录。** 工具和界面扩展在同一管理页可发现，普通列表只显示名称、用途、开关和需要处理的异常。运行目录、配置和加载结果继续由现有 Host / Kernel / Session / UI 插件运行时提供。
2. **本地读取。** 用户选择文件或文件夹后，读取清单中的名称等元信息；未提供的用途允许补充。清单有多份时明确选择；读取失败显示原始原因。读取、登记、启用、加载与当前任务曝光是不同事实。
3. **单项配置。** 点名称进入详情，编辑该插件的配置并单项保存；位置显示为可打开的简短来源，完整标识和位置留在详情。
4. **实际运行状态。** 启用意图与加载结果分开。加载中、等待依赖、失败时显示需要采取的操作；避免把设置开关当成准备完成的依据。
5. **按对象更新。** UI 扩展复用现有 apply / update / dispose、slot 与资源 scope；工具选择的改变复用同任务动态绑定。工具实现替换、窗口刷新和原生 Host 更新分别表达。新绑定不改写旧请求或在途调用。
6. **保留既有结构。** 设置八个栏目保持原有顺序。插件详情的配置组件继续归原配置 owner；展示稿没有画出的配置不被解释为应删除。

当前 DeepCode 已有可复用入口：`userspace/gui/src/ui-plugins/runtime.ts`、`UiPlugins.tsx`、`types.ts`；管理视图仍需从只面向 mcp.servers 的范围扩展到真实能力目录。DSH 的注册与释放原则映射到 DeepCode 既有三层职责，具体运行时继续使用当前实现。

## 本次预览与正式实现的界线

- 已在审计稿加入本地 JSON 文件／文件夹选择、File.text 读取、名称与用途带入、明确的未加载状态。仅读取用户选中的清单，不执行其入口文件。
- 已加入来源详情、单项配置、加载状态和更新范围。启用、重载、开发服务状态均明确标为演示。
- UI 热更新、工具热插拔、GitHub / PDF CLI 适配与预览权限策略尚未在本轮产品源码中实现；这里记录实施方向。
- 浏览器示例通过真实 File API 与同一 JSON 解析函数验证自动填写；系统文件选择器及 Host 完整路径解析未验收。

这份参考说明属于本轮回执，不修改锁定开发规划或引入新的公共合同。
