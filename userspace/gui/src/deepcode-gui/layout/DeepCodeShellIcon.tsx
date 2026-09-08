import React from 'react';

export type DeepCodeShellIconName =
  | 'compose'
  | 'folder'
  | 'paperclip'
  | 'plus'
  | 'more'
  | 'chevronRight'
  | 'chevronDown'
  | 'settings'
  | 'activity'
  | 'tool'
  | 'search'
  | 'extension'
  | 'artifact'
  | 'session'
  | 'copy'
  | 'thumbUp'
  | 'thumbDown'
  | 'stop'
  | 'arrowUp';

interface DeepCodeShellIconProps {
  name: DeepCodeShellIconName;
  className?: string;
}

const DeepCodeShellIcon: React.FC<DeepCodeShellIconProps> = ({ name, className }) => {
  const common = {
    className,
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'compose':
      return <svg {...common}><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>;
    case 'folder':
      return <svg {...common}><path d="M3 7.5h7l2-2h9v13H3v-11Z" /></svg>;
    case 'paperclip':
      return <svg {...common}><path d="m8.4 12.8 6.9-6.9a3.25 3.25 0 0 1 4.6 4.6l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.2-8.2" /><path d="m7.1 14.1 8.2-8.2" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
    case 'more':
      return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
    case 'chevronRight':
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case 'chevronDown':
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7 2-.7Z" /></svg>;
    case 'activity':
      return <svg {...common}><path d="M4 12h3l2-6 4 12 2-6h5" /></svg>;
    case 'tool':
      return <svg {...common}><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.2 2.2-3-3 2.2-2.2Z" /></svg>;
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>;
    case 'extension':
      return <svg {...common}><path d="M8 4h4v4h4v4h4v4h-4v4h-4v-4H8v-4H4V8h4V4Z" /><path d="M8 8h8v8H8Z" /></svg>;
    case 'artifact':
      return <svg {...common}><path d="M6 3h9l3 3v15H6V3Z" /><path d="M15 3v4h4" /><path d="M9 12h6M9 16h6" /></svg>;
    case 'session':
      return <svg {...common}><path d="M5 5h14v11H9l-4 3V5Z" /></svg>;
    case 'copy':
      return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
    case 'thumbUp':
      return <svg {...common}><path d="M7 10v10H4V10h3Z" /><path d="M7 19h9.2a2 2 0 0 0 1.9-1.4l1.7-5.4A2 2 0 0 0 17.9 9H14l.6-2.8A2.5 2.5 0 0 0 12.2 3L7 10v9Z" /></svg>;
    case 'thumbDown':
      return <svg {...common}><path d="M7 14V4H4v10h3Z" /><path d="M7 5h9.2a2 2 0 0 1 1.9 1.4l1.7 5.4a2 2 0 0 1-1.9 2.6H14l.6 2.8a2.5 2.5 0 0 1-2.4 3.2L7 14V5Z" /></svg>;
    case 'stop':
      return <svg {...common}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></svg>;
    case 'arrowUp':
      return <svg {...common}><path d="m7 11 5-5 5 5" /><path d="M12 6v12" /></svg>;
  }
};

export default DeepCodeShellIcon;
