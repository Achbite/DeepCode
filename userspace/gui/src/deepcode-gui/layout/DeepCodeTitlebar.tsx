import React from 'react';
import WindowControls from '../../components/window-controls/WindowControls';
import { type UiLanguage } from '../../i18n';

const DeepCodeTitlebar: React.FC<{ language: UiLanguage; sessionHeaderRef: React.Ref<HTMLDivElement>; hidden?: boolean }> = ({ language, sessionHeaderRef, hidden }) => (
  <header className="deepcode-gui-titlebar" data-tauri-drag-region inert={hidden} aria-hidden={hidden || undefined}>
    <div className="deepcode-gui-session-header" ref={sessionHeaderRef} />
    <WindowControls language={language} />
  </header>
);

export default DeepCodeTitlebar;
