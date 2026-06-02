/**
 * Skill Runtime 板块
 *
 * 只负责用户态挂载配置、目录选择和只读扫描展示；扫描结果不会注册、
 * 认证或执行 Skill，真正的运行权限仍由 Kernel/Skill 后续链路裁决。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type {
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import type { SkillScanItem } from '../../../services/apiClient';
import { useSettingsStore } from '../../../state/settingsStore';
import {
  browsePath,
  getInitialLocations,
  scanSkillMount,
} from '../../../services/runtimeAdapter';
import { normalizeUiLanguage, t, type UiLanguage } from '../../../i18n';
import '../../workspace-open-dialog/workspaceOpenDialog.css';

interface SkillMount {
  id: string;
  name: string;
  path: string;
  description: string;
  enabled: boolean;
  discoveredSkills: SkillScanItem[];
  scanWarnings: string[];
  lastScannedAt: string | null;
}

interface FolderPickerProps {
  visible: boolean;
  initialPath?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

const DEFAULT_MOUNT_NAME = 'Local Skill';

function normalizeScanItem(item: unknown): SkillScanItem | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Partial<SkillScanItem>;
  return {
    sourceKind: String(raw.sourceKind || 'manifest'),
    manifestStatus: String(raw.manifestStatus || 'unknown'),
    sourcePath: String(raw.sourcePath || ''),
    relativePath: String(raw.relativePath || '.'),
    skillId: String(raw.skillId || 'unknown'),
    version: String(raw.version || 'unknown'),
    title: String(raw.title || 'Untitled Skill'),
    description: String(raw.description || ''),
    entrypointKind: String(raw.entrypointKind || 'unknown'),
    trustMode: String(raw.trustMode || 'unknown'),
    workspaceAccess: String(raw.workspaceAccess || 'unknown'),
    requestedCapabilities: Array.isArray(raw.requestedCapabilities)
      ? raw.requestedCapabilities.map(String)
      : [],
    effects: Array.isArray(raw.effects) ? raw.effects.map(String) : [],
    envAllowlist: Array.isArray(raw.envAllowlist) ? raw.envAllowlist.map(String) : [],
    modelVisible: raw.modelVisible === true,
    requiresApproval: raw.requiresApproval === true,
    v1RuntimeEnabled: raw.v1RuntimeEnabled !== false,
    riskLevel: String(raw.riskLevel || 'low'),
  };
}

function safeParseMounts(raw: unknown): SkillMount[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const record = item as Partial<SkillMount>;
        return {
          id: String(record.id || `skill-${Date.now()}`),
          name: String(record.name || DEFAULT_MOUNT_NAME),
          path: String(record.path || ''),
          description: String(record.description || ''),
          enabled: record.enabled !== false,
          discoveredSkills: Array.isArray(record.discoveredSkills)
            ? record.discoveredSkills
                .map(normalizeScanItem)
                .filter((skill): skill is SkillScanItem => Boolean(skill))
            : [],
          scanWarnings: Array.isArray(record.scanWarnings)
            ? record.scanWarnings.map(String)
            : [],
          lastScannedAt:
            typeof record.lastScannedAt === 'string' ? record.lastScannedAt : null,
        };
      });
  } catch {
    return [];
  }
}

function createMount(): SkillMount {
  return {
    id: `skill-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: DEFAULT_MOUNT_NAME,
    path: '',
    description: '',
    enabled: true,
    discoveredSkills: [],
    scanWarnings: [],
    lastScannedAt: null,
  };
}

function folderName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || DEFAULT_MOUNT_NAME;
}

function skillRiskLabel(language: UiLanguage, skill: SkillScanItem): string {
  if (skill.trustMode === 'directHostScript' || skill.riskLevel === 'high') {
    return t(language, 'settings.skill.risk.high');
  }
  if (skill.requiresApproval || skill.trustMode === 'brokeredScript') {
    return t(language, 'settings.skill.risk.medium');
  }
  return t(language, 'settings.skill.risk.low');
}

const FolderPickerDialog: React.FC<FolderPickerProps> = ({
  visible,
  initialPath,
  onCancel,
  onSelect,
}) => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    const result = await browsePath(absolutePath);
    if (result.ok && result.data) {
      setBrowseResult(result.data);
      setAddressInput(result.data.absolutePath);
    } else {
      setError(result.message ?? t(language, 'workspaceDialog.error.browse'));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!visible) {
      setBrowseResult(null);
      setSelectedEntry(null);
      setError(null);
      setAddressInput('');
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      const init = await getInitialLocations();
      if (cancelled) return;
      if (init.ok && init.data) {
        setLocations(init.data.locations);
        const targetPath = initialPath || init.data.locations[0]?.absolutePath;
        if (targetPath) {
          await navigateTo(targetPath);
        } else {
          setLoading(false);
        }
      } else {
        setError(init.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const visibleEntries = browseResult
    ? showHidden
      ? browseResult.entries
      : browseResult.entries.filter((entry) => !entry.hidden)
    : [];
  const selectedPath = selectedEntry?.type === 'directory'
    ? selectedEntry.absolutePath
    : browseResult?.absolutePath ?? '';

  return (
    <div className="ws-open-dialog__backdrop" onClick={onCancel}>
      <div
        className="ws-open-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'settings.skill.pickFolder')}
      >
        <div className="ws-open-dialog__header">
          <span>{t(language, 'settings.skill.pickFolder')}</span>
          <button
            className="ws-open-dialog__close"
            onClick={onCancel}
            title={t(language, 'window.close')}
            type="button"
          >
            x
          </button>
        </div>

        <div className="ws-open-dialog__addressbar">
          <button
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
            title={t(language, 'workspaceDialog.parent')}
            type="button"
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            placeholder={t(language, 'workspaceDialog.addressPlaceholder')}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && addressInput.trim() !== '') {
                void navigateTo(addressInput.trim());
              }
            }}
          />
          <button
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
            type="button"
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          <label className="ws-open-dialog__toggle" title={t(language, 'workspaceDialog.hiddenTitle')}>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span>{t(language, 'workspaceDialog.hidden')}</span>
          </label>
        </div>

        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">
              {t(language, 'workspaceDialog.quickLocations')}
            </div>
            {locations.map((location) => (
              <button
                key={`${location.kind}::${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
                type="button"
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {location.kind === 'home' ? 'HOME' : location.kind === 'drive' ? 'DISK' : 'WS'}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>

          <main className="ws-open-dialog__main">
            {loading && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.loading')}
              </div>
            )}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">
                {t(language, 'workspaceDialog.empty')}
              </div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected = selectedEntry?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={
                        'ws-open-dialog__entry' +
                        (isSelected ? ' ws-open-dialog__entry--selected' : '')
                      }
                      onClick={() => setSelectedEntry(entry)}
                      onDoubleClick={() =>
                        entry.type === 'directory' && void navigateTo(entry.absolutePath)
                      }
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory' ? 'DIR' : 'FILE'}
                      </span>
                      <span>{entry.name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </div>

        <div className="ws-open-dialog__footer">
          <span className="ws-open-dialog__selected">
            {t(language, 'workspaceDialog.selected')}: {selectedPath}
          </span>
          <button className="ws-open-dialog__btn" onClick={onCancel} type="button">
            {t(language, 'common.cancel')}
          </button>
          <button
            className="ws-open-dialog__btn ws-open-dialog__btn--primary"
            disabled={!selectedPath}
            onClick={() => selectedPath && onSelect(selectedPath)}
            type="button"
          >
            {t(language, 'settings.skill.useFolder')}
          </button>
        </div>
      </div>
    </div>
  );
};

const SkillRuntimeSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const loading = useSettingsStore((s) => s.loading);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  const storedMounts = useMemo(
    () => safeParseMounts(effectiveSettings['skills.mounts']),
    [effectiveSettings]
  );

  const [pythonPath, setPythonPath] = useState(
    String(effectiveSettings['skills.pythonPath'] ?? 'python')
  );
  const [autoLoad, setAutoLoad] = useState(
    Boolean(effectiveSettings['skills.autoLoad'] ?? true)
  );
  const [mounts, setMounts] = useState<SkillMount[]>(storedMounts);
  const [message, setMessage] = useState<string | null>(null);
  const [scanBusyId, setScanBusyId] = useState<string | null>(null);
  const [pickerMountId, setPickerMountId] = useState<string | null>(null);

  useEffect(() => {
    setPythonPath(String(effectiveSettings['skills.pythonPath'] ?? 'python'));
    setAutoLoad(Boolean(effectiveSettings['skills.autoLoad'] ?? true));
    setMounts(storedMounts);
  }, [effectiveSettings, storedMounts]);

  const updateMount = (id: string, patch: Partial<SkillMount>) => {
    setMounts((prev) =>
      prev.map((mount) => (mount.id === id ? { ...mount, ...patch } : mount))
    );
  };

  const scanMount = async (mount: SkillMount) => {
    if (!mount.path.trim()) return;
    setMessage(null);
    setScanBusyId(mount.id);
    const result = await scanSkillMount(mount.path.trim());
    setScanBusyId(null);
    if (!result.ok || !result.data) {
      updateMount(mount.id, {
        scanWarnings: [result.message ?? t(language, 'settings.skill.scanFailed')],
      });
      return;
    }
    updateMount(mount.id, {
      path: result.data.mountPath,
      discoveredSkills: result.data.skills,
      scanWarnings: result.data.warnings,
      lastScannedAt: result.data.scannedAt,
      name:
        mount.name === DEFAULT_MOUNT_NAME || mount.name.trim() === ''
          ? folderName(result.data.mountPath)
          : mount.name,
      description:
        mount.description.trim() === '' && result.data.skills.length > 0
          ? t(language, 'settings.skill.discoveredCount', {
              count: result.data.skills.length,
            })
          : mount.description,
    });
  };

  const save = async () => {
    setMessage(null);
    await patchUserSetting('skills.pythonPath', pythonPath.trim() || 'python');
    await patchUserSetting('skills.autoLoad', autoLoad);
    await patchUserSetting('skills.mounts', JSON.stringify(mounts, null, 2));
    setMessage(t(language, 'settings.skill.saved'));
  };

  const pickerMount = mounts.find((mount) => mount.id === pickerMountId);

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.skill.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.skill.runtime')}</h3>
        <div className="settings-form-grid">
          <label>
            <span>{t(language, 'settings.skill.pythonPath')}</span>
            <input
              className="settings-field__input"
              value={pythonPath}
              onChange={(event) => setPythonPath(event.target.value)}
              placeholder="python"
            />
          </label>
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {t(language, 'settings.skill.autoLoad')}
          </label>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.skill.mounts')}</h3>
          <button
            className="settings-action-button"
            onClick={() => setMounts((prev) => [...prev, createMount()])}
            disabled={loading}
            type="button"
          >
            {t(language, 'settings.skill.addMount')}
          </button>
        </div>

        {mounts.length === 0 && (
          <div className="settings-card__hint">
            {t(language, 'settings.skill.emptyMounts')}
          </div>
        )}

        <div className="settings-list-editor">
          {mounts.map((mount) => (
            <div className="skill-mount-card" key={mount.id}>
              <div className="skill-mount-card__top">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={mount.enabled}
                    onChange={(event) =>
                      updateMount(mount.id, { enabled: event.target.checked })
                    }
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
                <input
                  className="settings-field__input"
                  value={mount.name}
                  onChange={(event) =>
                    updateMount(mount.id, { name: event.target.value })
                  }
                  placeholder={t(language, 'settings.skill.displayName')}
                />
                <button
                  className="settings-action-button"
                  onClick={() => setPickerMountId(mount.id)}
                  type="button"
                >
                  {t(language, 'settings.skill.chooseFolder')}
                </button>
                <button
                  className="settings-action-button"
                  onClick={() => void scanMount(mount)}
                  disabled={loading || scanBusyId === mount.id || !mount.path.trim()}
                  type="button"
                >
                  {scanBusyId === mount.id
                    ? t(language, 'settings.skill.scanning')
                    : t(language, 'settings.skill.scan')}
                </button>
                <button
                  className="settings-action-button"
                  onClick={() =>
                    setMounts((prev) => prev.filter((item) => item.id !== mount.id))
                  }
                  type="button"
                >
                  {t(language, 'settings.common.remove')}
                </button>
              </div>

              <div className="skill-mount-card__fields">
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={mount.path}
                  onChange={(event) =>
                    updateMount(mount.id, { path: event.target.value })
                  }
                  placeholder="E:/Dev-Agent/skills/my-skill"
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={mount.description}
                  onChange={(event) =>
                    updateMount(mount.id, { description: event.target.value })
                  }
                  placeholder={t(language, 'settings.skill.description')}
                />
              </div>

              {mount.lastScannedAt && (
                <div className="settings-card__hint">
                  {t(language, 'settings.skill.lastScannedAt', {
                    time: mount.lastScannedAt,
                  })}
                </div>
              )}

              {mount.scanWarnings.length > 0 && (
                <div className="skill-scan-warnings">
                  {mount.scanWarnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              )}

              {mount.discoveredSkills.length > 0 && (
                <div className="skill-discovery-list">
                  {mount.discoveredSkills.map((skill) => (
                    <div className="skill-discovery-card" key={`${skill.sourcePath}:${skill.skillId}`}>
                      <div className="skill-discovery-card__header">
                        <div>
                          <div className="skill-discovery-card__title">{skill.title}</div>
                          <div className="skill-discovery-card__meta">
                            {skill.skillId} · {skill.entrypointKind} · {skill.trustMode}
                          </div>
                        </div>
                        <span className={`skill-risk-badge skill-risk-badge--${skill.riskLevel}`}>
                          {skillRiskLabel(language, skill)}
                        </span>
                      </div>
                      {skill.description && (
                        <div className="skill-discovery-card__description">
                          {skill.description}
                        </div>
                      )}
                      <div className="skill-discovery-card__chips">
                        <span>{skill.manifestStatus}</span>
                        <span>{skill.workspaceAccess}</span>
                        <span>
                          {skill.v1RuntimeEnabled
                            ? t(language, 'settings.skill.v1Enabled')
                            : t(language, 'settings.skill.v1Disabled')}
                        </span>
                        <span>
                          {skill.requiresApproval
                            ? t(language, 'settings.skill.requiresApproval')
                            : t(language, 'settings.skill.noApproval')}
                        </span>
                      </div>
                      {skill.requestedCapabilities.length > 0 && (
                        <div className="skill-discovery-card__permissions">
                          {t(language, 'settings.skill.capabilities')}: {' '}
                          {skill.requestedCapabilities.join(', ')}
                        </div>
                      )}
                      <div className="skill-discovery-card__path">
                        {skill.relativePath} · {skill.sourcePath}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="settings-card__footer-row">
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
            type="button"
          >
            {t(language, 'settings.skill.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>

      <FolderPickerDialog
        visible={Boolean(pickerMount)}
        initialPath={pickerMount?.path}
        onCancel={() => setPickerMountId(null)}
        onSelect={(path) => {
          if (pickerMount) {
            updateMount(pickerMount.id, {
              path,
              name:
                pickerMount.name === DEFAULT_MOUNT_NAME || pickerMount.name.trim() === ''
                  ? folderName(path)
                  : pickerMount.name,
            });
          }
          setPickerMountId(null);
        }}
      />
    </div>
  );
};

export default SkillRuntimeSection;
