/**
 * FileTree Codicons 图标集合（阶段 4 / S4-1）
 *
 * 来源：VSCode 官方 Codicons 图标集（MIT 协议，github.com/microsoft/vscode-codicons）。
 * 设计要求：
 *   - 仅 inline SVG，不引入字体文件或外部资源；
 *   - 颜色统一使用 currentColor，由 CSS 主题变量驱动；
 *   - 标准尺寸 16x16；工具栏按钮可在 CSS 中缩放至 14x14；
 *   - 单一来源：禁止其他组件散落定义同语义图标，必须复用此处。
 *
 * 替换关系（旧文本图标 -> Codicon）：
 *   expand/collapse -> ChevronRightIcon / ChevronDownIcon
 *   folder          -> FolderIcon
 *   file            -> FileIcon
 *   refresh         -> RefreshIcon
 *   create actions  -> NewFileIcon / NewFolderIcon
 */
import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

const SVG_BASE_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 16 16',
  fill: 'currentColor',
} as const;

// ---- 展开 / 收起箭头 ----

export const ChevronRightIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M6 4l4 4-4 4V4z" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M4 6l4 4 4-4H4z" />
  </svg>
);

// ---- 文件 / 文件夹 ----

export const FolderIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.43l.5-.5V6h7.07v1.49l-.5.5h-7v1h7v.5l.5.5h.5v.5l.5.5z" />
  </svg>
);

export const FolderOpenIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M1.5 14h11l.48-.379 2.5-8L15 5h-2V3.5l-.5-.5H7.71l-.86-.85L6.51 2h-5l-.5.5v11l.5.5zM2 3h4.29l.86.85.35.15H12v1H4.5l-.47.34-2 5.34L2 3zm10.13 10H2.7l2.13-5.69H14.3L12.13 13z" />
  </svg>
);

export const FileIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM13 14H4V2h5v4h4v8zm-3-9V2l3 3h-3z" />
  </svg>
);

// ---- 工具栏动作 ----

export const RefreshIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07L2.85 6.66l2.16 2.45-.78.77-1.18-1.34a5 5 0 0 0 9.79-1.27l1 .27a6 6 0 0 1-11.83 1.41zm9.46-3.32l1.18 1.34.78-.77L11.27 3.07l-.76.001L8.42 5.14l.78.77 1.226-1.227a5 5 0 0 0-9.79 1.34l1 .27a4 4 0 0 1 7.83-1.273z" />
  </svg>
);

export const NewFileIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H8V2H3v11h4v1H2.5l-.5-.5v-12l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2zm4 14h-1v-3H9v-1h3V9h1v3h3v1h-3v3z" />
  </svg>
);

export const NewFolderIcon: React.FC<IconProps> = ({ size = 16, className, title }) => (
  <svg {...SVG_BASE_PROPS} width={size} height={size} className={className} aria-label={title}>
    <path d="M14.5 2H7.71l-.85-.85L6.51 1h-5l-.5.5v11l.5.5H7v-1H1.99V6h4.49l.35-.15.86-.86H14v1.5l-.001.51h1.011V2.5L14.5 2zm-.51 2h-6.5l-.86.86-.353.15H2v-3h4.29l.85.85.36.15h6.5v1zM13 16h-1v-3H9v-1h3V9h1v3h3v1h-3v3z" />
  </svg>
);
