/**
 * Common Settings 板块（Settings 中心）
 *
 * 仅展示项目运行时的关键只读信息；工作区相关字段已迁移到 Workspace 板块。
 */
import React from 'react';

interface CommonSettingsSectionProps {
  serverVersion?: string;
  apiStatus: string;
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
              <td>31245（环境变量 DEEPCODE_PORT 可覆盖）</td>
            </tr>
            <tr>
              <td>当前活动工作区</td>
              <td>详见 Workspace 板块</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">阶段说明</h3>
        <p className="settings-card__body">
          当前为阶段 2.5 工作区与 Tauri 集成里程碑：已落地 VSCode 兼容工作区
          管理、Tauri 打包骨架；Skill / Prompt / Doctor / Ruler 的真实能力将在
          后续阶段接入。所有"高级配置"统一收纳在本设置中心。
        </p>
      </div>
    </div>
  );
};

export default CommonSettingsSection;
