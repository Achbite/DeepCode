# DeepCode UI 图标使用规范

## 1. 核心规则

- 统一使用线性 outline 风格。
- 24px 基准尺寸下使用 2px stroke。
- 使用 round caps 和 round joins。
- 图标周围保留 8px 级别的可点击或视觉留白。
- 不混用 filled icon 与 outline icon。
- 不随意拉伸图标；必须等比缩放。
- 状态色只用于状态语义，不要把页面装饰色滥用于普通图标。

## 2. 色彩使用

| 场景 | Token | 色值 |
|---|---:|---:|
| 默认中性图标 | `--dc-icon-neutral` | `#CBD5E1` |
| Active / 当前选中 | `--dc-icon-accent` | `#3A82F6` |
| 禁用 / 弱提示 | `--dc-icon-muted` | `#64748B` |
| 成功 | `--dc-icon-success` | `#22C55E` |
| 警告 | `--dc-icon-warning` | `#F59E0B` |
| 错误 | `--dc-icon-error` | `#EF4444` |

## 3. 推荐映射

| 产品区域 | 推荐图标 |
|---|---|
| 工作区入口 | `workspace`, `folder-tree`, `folder` |
| 文件 / Tab | `file`, `tabs`, `close` |
| 编辑器 | `code-editor`, `search` |
| 终端 | `terminal`, `run`, `stop` |
| Agent 面板 | `ai-agent`, `workflow-task`, `in-progress` |
| 设置中心 | `settings` |
| Kernel / Runtime | `kernel`, `refresh` |
| 诊断状态 | `success`, `warning`, `error`, `info`, `blocked` |
| 图表区域 | `chart-line`, `chart-bar`, `chart-donut`, `activity-grid`, `kpi-card` |

## 4. 前端接入建议

### Vite / React 作为组件使用

```tsx
import TerminalIcon from '@/assets/icons/svg/currentColor/24/icon-terminal-24.svg?react';

<TerminalIcon className="dc-icon" aria-hidden="true" />
```

### CSS 控色

```css
.dc-icon {
  width: 20px;
  height: 20px;
  color: var(--dc-icon-neutral);
}

.nav-item.active .dc-icon {
  color: var(--dc-icon-accent);
}

.status-success .dc-icon { color: var(--dc-icon-success); }
.status-warning .dc-icon { color: var(--dc-icon-warning); }
.status-error .dc-icon { color: var(--dc-icon-error); }
```

### 直接作为图片使用

```html
<img src="/assets/icons/svg/themed/24/icon-ai-agent-24.svg" width="24" height="24" alt="AI Agent" />
```

## 5. 导出建议

- 产品代码优先接入 `svg/currentColor`。
- README、官网、静态展示可使用 `svg/themed`。
- PNG 仅作为设计预览或不支持 SVG 的兜底。
- 新增图标时同步更新 `manifest.json`。
