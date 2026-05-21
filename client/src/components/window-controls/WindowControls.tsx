import React from 'react';
import {
  closeAppWindow,
  minimizeAppWindow,
  toggleMaximizeAppWindow,
} from '../../services/runtimeAdapter';
import './windowControls.css';

const WindowControls: React.FC = () => {
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
