# DeepCode 界面样式入口

`palette.json` 是内置界面颜色的唯一色号表：`tokens` 保存 GUI 和 Editor 的语义色，`themes` 保存具名主题的浅色与深色配色，`terminal`、`diff` 保存终端和差异视图的颜色。组件引用语义变量；不要把新色号写回组件 CSS 或 TSX。

默认 DeepCode 主题保持现有浅色风格，暗色通过背景、侧栏、内容面和浮层的明度区分层次。额外的 Catppuccin、Gruvbox、Nord 是适配 DeepCode 界面角色的配色，不是这些项目的官方移植版本。参考：[Catppuccin palette](https://github.com/catppuccin/catppuccin#-palette)、[Gruvbox palette](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim)、[Nord palette](https://www.nordtheme.com/docs/colors-and-palettes/)。

界面中的选择与编辑写入既有用户设置存储，不修改应用安装目录中的默认 JSON。`workbench.styleTokenOverrides` 是当前实际应用的配色；主题选中名称从实际配色推导。`gui.themeLibrary` 只保存导入的主题文档，添加主题不会改变已应用的颜色。浅色/深色独立选择，`gui.colorTheme` 仍只决定当前使用哪种模式；自定义强调色优先，选择强调色预设会清除两种模式的强调色覆盖。

## 导入格式

在“外观 → 主题配置 → 复制主题”复制当前完整的浅色与深色配色，保存成 JSON 或直接粘贴到“导入”窗口。文件结构为：

```json
{
  "name": "My Theme",
  "light": { "background": "#f4f4f6", "accent": "#0066cc" },
  "dark": { "background": "#1c1c1e", "accent": "#73b2ff" }
}
```

允许只提供一种模式；每种模式允许部分字段，缺省字段使用内置 DeepCode 语义色。支持 `#RRGGBB` 和 `#RRGGBBAA`，不接受任意 CSS。未知字段、非法色号和空主题保留错误，不能提交。同名主题不会静默替换。

支持字段由 `userspace/gui/src/theme/palette.ts` 的 `PALETTE_FIELDS` 唯一登记：背景、侧栏、内容面、浮层、正文、次要文字、强调色、分隔线、次级内容面、悬停、按下、重点文字、辅助文字、控件边框、代码背景、成功、提示、错误。主题文件使用该登记表中的英文名称。

## 字体和图标

`userspace/gui/src/theme/typography.ts` 维护 UI 字体选项和校验；`gui.fontFamily`、`gui.fontSize` 仍通过同一用户设置存储保存。系统默认使用平台字体栈，自定义值为单个已安装字体名称；系统未安装的字体按字体栈解析。界面字号 12–18 px，以原有 14 px 为基准保持标题、正文、辅助文字的比例。代码编辑器和终端保留各自字体设置。

`userspace/gui/src/icons/registry.tsx` 是内置 UI 图标的注册入口，`UI_ICON_ROLES` 映射设置分类和活动栏的语义角色。使用 `UiIcon`，不在业务组件中定义 SVG 路径或用 Unicode 字符模拟图标。图标统一使用 24 × 24 网格、1.8 描边和 `currentColor`。品牌字标和资源内容图片不属于 UI 操作图标。

## 作用范围

默认色表覆盖自有 GUI/Editor 样式、终端色表和差异背景。用户导入及可视化配色编辑针对 GUI 语义色。Monaco 语法主题、外部 HTML/PDF/图片、插件自带内容由各自渲染器拥有；本入口不改写其内容颜色。

调整内置色号后使用项目 Docker 构建入口生成前端资源。用户保存主题或字体后立即应用，无需重新构建。
