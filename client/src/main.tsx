/**
 * React 应用入口
 * 挂载 App 组件到 DOM
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到 #root 元素');
}

const root = ReactDOM.createRoot(rootEl);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
