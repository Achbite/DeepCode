import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import {
  minimizeAppWindow,
  requestCloseAppWindow,
  toggleMaximizeAppWindow,
} from '../../services/runtimeAdapter';
import './windowControls.css';

interface WindowControlsProps {
  language: UiLanguage;
}

const WindowControls: React.FC<WindowControlsProps> = ({ language }) => (
  <div className="window-controls" aria-label={t(language, 'window.controls')}>
    <button
      type="button"
      className="window-control window-control--minimize"
      title={t(language, 'window.minimize')}
      aria-label={t(language, 'window.minimize')}
      onClick={() => void minimizeAppWindow()}
    />
    <button
      type="button"
      className="window-control window-control--maximize"
      title={t(language, 'window.maximize')}
      aria-label={t(language, 'window.maximize')}
      onClick={() => void toggleMaximizeAppWindow()}
    />
    <button
      type="button"
      className="window-control window-control--close"
      title={t(language, 'window.close')}
      aria-label={t(language, 'window.close')}
      onClick={requestCloseAppWindow}
    />
  </div>
);

export default WindowControls;
