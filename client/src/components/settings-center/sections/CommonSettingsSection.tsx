/**
 * Common Settings 板块（Settings 中心）
 *
 * 当前阶段（阶段 1）只展示项目运行时的关键只读信息：
 *   - 服务端口 / 工作区根目录 / 协议版本等。
 * 实际编辑能力（端口修改、主题、语言、字体等）将在阶段 2 接入。
 */
import React from 'react';

interface CommonSettingsSectionProps {
  /** 服务端 version（来自 /api/health） */
  serverVersion?: string;
  /** API 状态文案 */
  apiStatus: string;
  /** WS 状态文案 */
  wsStatus: string;
}

const CommonSettingsSection: React.FC<CommonSettingsSectionProps> = ({
  serverVersion,
  apiStatus,
  wsStatus,
}) => {
  return (
    <div>
      <h2 className="settings-title">Common Settings</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">运行时信息</h3>
        <table className="settings-kv">
          <tbody>
            <tr>
              <td>产品名</td>
              <td>DeepCode</td>
            </tr>
            <tr>
              <td>服务端版本</td>
              <td>{serverVersion ?? '—'}</td>
            </tr>
            <tr>
              <td>API 状态</td>
              <td>{apiStatus}</td>
            </tr>
            <tr>
              <td>WebSocket 状态</td>
              <td>{wsStatus}</td>
            </tr>
            <tr>
              <td>默认服务端口</td>
              <td>31245（环境变量 AGENT_LIGHT_PORT 可覆盖）</td>
            </tr>
            <tr>
              <td>默认工作区根目录</td>
              <td>./workspace（环境变量 WORKSPACE_ROOT 可覆盖）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">阶段说明</h3>
        <p className="settings-card__body">
          当前为阶段 1 骨架版本：仅启用文件读写最小闭环与简化文本编辑器；Skill / Prompt / Doctor / Ruler
          的真实能力将在阶段 2-3 接入。所有"高级配置"统一收纳在本设置中心，避免污染左侧文件树。
        </p>
      </div>
    </div>
  );
};

export default CommonSettingsSection;
