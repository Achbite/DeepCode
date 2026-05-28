# DeepCode UI Icon Set

D-style layout + C-theme palette 的 DeepCode UI 图标资源包。图标以 **SVG 为主**，PNG 作为预览或不支持 SVG 场景的兜底资源。

## 目录结构

```text
deepcode-ui-icon-resources/
├─ svg/
│  ├─ currentColor/        # 推荐用于产品代码，颜色由 CSS currentColor 控制
│  │  ├─ 16/ 20/ 24/ 32/ 64/
│  ├─ themed/              # 固定色值版本，适合直接用 <img>
│  │  ├─ 16/ 20/ 24/ 32/ 64/
│  └─ 24/                  # 24px currentColor 快捷副本
├─ png/                    # 透明背景 PNG，按 16/20/24/32/64 分尺寸
├─ preview/                # 图标总览图和 HTML 预览
├─ tokens/                 # CSS 颜色与尺寸 token
├─ docs/USAGE.md           # 使用规范
├─ sprite/deepcode-icons.svg
└─ manifest.json           # 图标索引
```

## 推荐使用方式

### React / Vite 内联 SVG

```tsx
import WorkspaceIcon from './svg/currentColor/24/icon-workspace-24.svg?react';

export function SidebarItem() {
  return (
    <button className="sidebar-item is-active">
      <WorkspaceIcon className="dc-icon dc-icon--active" aria-hidden="true" />
      <span>Workspace</span>
    </button>
  );
}
```

```css
@import './tokens/deepcode-icon-tokens.css';
.sidebar-item { color: var(--dc-icon-neutral); }
.sidebar-item.is-active { color: var(--dc-icon-accent); }
```

### 直接作为图片使用

```html
<img src="/icons/svg/themed/24/icon-terminal-24.svg" width="24" height="24" alt="Terminal" />
```

### SVG Sprite

```html
<svg class="dc-icon" aria-hidden="true"><use href="#dc-icon-terminal" /></svg>
```

## 当前包含图标

- `workspace` — Workspace (core)
- `folder` — Folder (core)
- `folder-tree` — Folder Tree (core)
- `file` — File (core)
- `tabs` — Tabs (core)
- `code-editor` — Code Editor (core)
- `terminal` — Terminal (core)
- `ai-agent` — AI Agent (core)
- `browser` — Browser (core)
- `settings` — Settings (core)
- `search` — Search (core)
- `kernel` — Kernel (core)
- `workflow-task` — Workflow / Task (core)
- `run` — Run (action)
- `stop` — Stop (action)
- `refresh` — Refresh (action)
- `external-link` — External Link (action)
- `more-horizontal` — More Horizontal (action)
- `close` — Close (action)
- `chevron-right` — Chevron Right (action)
- `success` — Success (status)
- `warning` — Warning (status)
- `error` — Error (status)
- `info` — Info (status)
- `in-progress` — In Progress (status)
- `blocked` — Blocked (status)
- `chart-line` — Chart Line (chart)
- `chart-bar` — Chart Bar (chart)
- `chart-donut` — Chart Donut (chart)
- `activity-grid` — Activity Grid (chart)
- `kpi-card` — KPI Card (chart)
