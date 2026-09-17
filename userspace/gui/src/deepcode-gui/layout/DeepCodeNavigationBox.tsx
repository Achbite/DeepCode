import React from 'react';
import { usesNativeWindowChrome } from '../../services/hostTarget';
import DeepCodeBrand from './DeepCodeBrand';

interface DeepCodeNavigationBoxProps {
  settingsOpen: boolean;
  settingsTargetRef: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

/** The same grid cell and border surround both workspace and settings navigation. */
export default function DeepCodeNavigationBox({
  settingsOpen, settingsTargetRef, children,
}: DeepCodeNavigationBoxProps) {
  return (
    <aside className="deepcode-gui-navigation-box">
      <div className="deepcode-gui-navigation-box__titlebar" data-tauri-drag-region>
        {!settingsOpen && !usesNativeWindowChrome() && <DeepCodeBrand />}
      </div>
      <div className="deepcode-gui-navigation-box__content" hidden={settingsOpen} inert={settingsOpen}>
        {children}
      </div>
      <div className="deepcode-gui-navigation-box__content" hidden={!settingsOpen} ref={settingsTargetRef} />
    </aside>
  );
}
