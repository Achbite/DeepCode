import React from 'react';
import {
  closeAppWindow,
  getRuntimeType,
  minimizeAppWindow,
  toggleMaximizeAppWindow,
} from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import './windowControls.css';

interface WindowControlsProps {
  language: UiLanguage;
}

const WindowControls: React.FC<WindowControlsProps> = ({ language }) => {
  // Web 模式下浏览器自带窗口控制按钮，不渲染自定义控件
  if (getRuntimeType() === 'web') {
    return null;
  }

  return (
    <div className="window-controls" aria-label={t(language, 'window.controls')}>
      <button
        className="window-control window-control--minimize"
        type="button"
        title={t(language, 'window.minimize')}
        aria-label={t(language, 'window.minimize')}
        onClick={() => void minimizeAppWindow()}
      />
      <button
        className="window-control window-control--maximize"
        type="button"
        title={t(language, 'window.maximize')}
        aria-label={t(language, 'window.maximize')}
        onClick={() => void toggleMaximizeAppWindow()}
      />
      <button
        className="window-control window-control--close"
        type="button"
        title={t(language, 'window.close')}
        aria-label={t(language, 'window.close')}
        onClick={() => void closeAppWindow()}
      />
    </div>
  );
};

export default WindowControls;
