/**
 * Ruler Rules 板块（Settings 中心）
 *
 * 展示当前对 Agent 生效的工作流规范、代码规范、行为速查表。
 * 阶段 1 占位，阶段 2 接入真实 Ruler 文件加载与展示。
 */
import React from 'react';
import RulerViewerPlaceholder from '../../ruler-viewer/RulerViewerPlaceholder';

const RulerRulesSection: React.FC = () => (
  <div>
    <h2 className="settings-title">Ruler Rules</h2>

    <div className="settings-card">
      <h3 className="settings-card__title">规则生效清单</h3>
      <p className="settings-card__body">
        展示当前对 Agent 生效的工作流规范、代码规范、行为速查表；阶段 2 接入后会显示来源文件、生效优先级和命中规则。
      </p>
      <div className="settings-card__inline-placeholder">
        <RulerViewerPlaceholder />
      </div>
    </div>
  </div>
);

export default RulerRulesSection;
