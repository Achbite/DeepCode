import React from 'react';
import WindowControls from '../../components/window-controls/WindowControls';
import { type UiLanguage } from '../../i18n';
import { usesNativeWindowChrome } from '../../services/hostTarget';
import DeepCodeBrand from './DeepCodeBrand';

const DeepCodeTitlebar: React.FC<{ language: UiLanguage; sessionHeaderRef: React.Ref<HTMLDivElement> }> = ({ language, sessionHeaderRef }) => (
  <header className="deepcode-gui-titlebar" data-tauri-drag-region>
    <div className="deepcode-gui-titlebar__navigation" data-tauri-drag-region>
      {!usesNativeWindowChrome() && <DeepCodeBrand />}
    </div>
    <div className="deepcode-gui-session-header" ref={sessionHeaderRef} />
    <WindowControls language={language} />
  </header>
);

export default DeepCodeTitlebar;
