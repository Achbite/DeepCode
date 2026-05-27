import type React from 'react';

export type ActivityIconName = 'explorer' | 'git' | 'search' | 'settings' | 'account';

const ActivityIcon: React.FC<{ name: ActivityIconName }> = ({ name }) => {
  const commonProps = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'explorer':
      return (
        <svg {...commonProps}>
          <path d="M3.5 6.5h6l1.8 2h9.2v9.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.5Z" />
          <path d="M3.5 6.5V5.7a1.2 1.2 0 0 1 1.2-1.2h4.6l1.7 2" />
        </svg>
      );
    case 'git':
      return (
        <svg {...commonProps}>
          <circle cx="6.5" cy="5.8" r="2.1" />
          <circle cx="17.5" cy="18.2" r="2.1" />
          <circle cx="6.5" cy="18.2" r="2.1" />
          <path d="M6.5 7.9v8.2" />
          <path d="M8.3 6.9c4.6.6 7.1 2.9 8 9.2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...commonProps}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.2-2-3.4-2.2 1a8.6 8.6 0 0 0-2.6-1.5L14.3 3h-4.6l-.4 2.4a8.6 8.6 0 0 0-2.6 1.5l-2.2-1-2 3.4 2 1.2a7.8 7.8 0 0 0 0 3l-2 1.2 2 3.4 2.2-1a8.6 8.6 0 0 0 2.6 1.5l.4 2.4h4.6l.4-2.4a8.6 8.6 0 0 0 2.6-1.5l2.2 1 2-3.4-2.1-1.2Z" />
        </svg>
      );
    case 'account':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    default:
      return null;
  }
};

export default ActivityIcon;
