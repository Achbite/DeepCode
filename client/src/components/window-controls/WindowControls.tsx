import React from 'react';
import {
  closeAppWindow,
  getRuntimeType,
  minimizeAppWindow,
  toggleMaximizeAppWindow,
} from '../../services/runtimeAdapter';
import './windowControls.css';

const WindowControls: React.FC = () => {
  // Web 模式下浏览器自带窗口控制按钮，不渲染自定义控件
  if (getRuntimeType() === 'web') {
    return null;
  }

  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        className="window-control window-control--minimize"
        type="button"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void minimizeAppWindow()}
      />
      <button
        className="window-control window-control--maximize"
        type="button"
        title="Maximize or restore"
        aria-label="Maximize or restore"
        onClick={() => void toggleMaximizeAppWindow()}
      />
      <button
        className="window-control window-control--close"
        type="button"
        title="Close"
        aria-label="Close"
        onClick={() => void closeAppWindow()}
      />
    </div>
  );
};

export default WindowControls;
