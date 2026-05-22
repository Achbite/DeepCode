import type React from 'react';

const EmptyEditorSurface: React.FC = () => (
  <div className="workbench-empty-editor">
    <div className="workbench-empty-editor__inner">
      <div className="workbench-empty-editor__icon" aria-hidden="true">
        FILE
      </div>
      <div>打开一个文件开始编辑</div>
      <div className="workbench-empty-editor__hint">使用左侧文件树选择文件</div>
    </div>
  </div>
);

export default EmptyEditorSurface;
