/**
 * Runtime Doctor 板块（Settings 中心）
 *
 * 检测本地 Agent 运行依赖（Node 版本、端口、Workspace 权限、外部 LLM Key 等），
 * 并给出修复建议。阶段 1 占位，阶段 2 接入真实诊断脚本。
 */
import React from 'react';
import DoctorPanelPlaceholder from '../../doctor-panel/DoctorPanelPlaceholder';

const RuntimeDoctorSection: React.FC = () => (
  <div>
    <h2 className="settings-title">Runtime Doctor</h2>

    <div className="settings-card">
      <h3 className="settings-card__title">环境诊断</h3>
      <p className="settings-card__body">
        检测本地 Agent 运行依赖，定位常见的端口冲突、权限缺失、依赖缺失等问题；阶段 2 接入后会输出可执行的修复建议。
      </p>
      <div className="settings-card__inline-placeholder">
        <DoctorPanelPlaceholder />
      </div>
    </div>
  </div>
);

export default RuntimeDoctorSection;
