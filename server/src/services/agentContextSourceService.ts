import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PromptLayer, PromptLayerResult, SkillReference, SkillReferenceResult } from '@deepcode/protocol';
import {
  resolveDeepCodeGlobalConfigDir,
  resolveDeepCodeUserConfigDir,
} from './appDataPath.js';
import { getUserSettings } from './userSettingsService.js';
import { getCurrentWorkspace } from './workspaceService.js';

interface SkillMountSetting {
  id?: string;
  name?: string;
  path?: string;
  description?: string;
  enabled?: boolean;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  return readFileSync(path, 'utf8');
}

function addPromptFile(
  layers: PromptLayer[],
  kind: PromptLayer['kind'],
  path: string,
  priority: number,
  title?: string
): void {
  const content = readTextIfExists(path);
  if (content === null) return;
  layers.push({
    id: `${kind}-${priority}-${sha256(path).slice(0, 8)}`,
    kind,
    path,
    priority,
    contentHash: sha256(content),
    title,
  });
}

function makeSkillReference(
  scope: SkillReference['scope'],
  skillPath: string,
  idSuffix: string,
  override?: Partial<Pick<SkillReference, 'name' | 'description' | 'enabled'>>
): SkillReference | null {
  if (!existsSync(skillPath)) return null;
  const stat = statSync(skillPath);
  if (!stat.isFile()) return null;
  const content = readFileSync(skillPath, 'utf8');
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstBodyLine = content
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith('#'))
    ?.trim();

  return {
    id: `${scope}-${idSuffix}`,
    name: override?.name || firstHeading || basename(skillPath),
    path: skillPath,
    scope,
    enabled: override?.enabled ?? true,
    description: override?.description || firstBodyLine,
  };
}

function listSkillDirs(
  root: string,
  scope: SkillReference['scope'],
  prefix = ''
): SkillReference[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const direct = makeSkillReference(
    scope,
    join(root, 'SKILL.md'),
    prefix || basename(root)
  );
  if (direct) return [direct];

  const skills: SkillReference[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const idSuffix = prefix ? `${prefix}-${entry.name}` : entry.name;
    const skill = makeSkillReference(
      scope,
      join(root, entry.name, 'SKILL.md'),
      idSuffix
    );
    if (skill) skills.push(skill);
  }
  return skills;
}

function parseSkillMounts(raw: unknown): SkillMountSetting[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is SkillMountSetting => {
          return Boolean(item) && typeof item === 'object';
        })
      : [];
  } catch {
    return [];
  }
}

export function listPromptLayers(): PromptLayerResult {
  const layers: PromptLayer[] = [
    {
      id: 'builtin-agent-system',
      kind: 'builtin',
      priority: 0,
      contentHash: sha256('DeepCode Agent builtin defaults'),
      title: 'DeepCode Agent builtin defaults',
    },
  ];

  const globalRoot = resolveDeepCodeGlobalConfigDir();
  const userRoot = resolveDeepCodeUserConfigDir();
  addPromptFile(layers, 'global', join(globalRoot, 'prompts', 'agent-system.md'), 10);
  addPromptFile(layers, 'global', join(globalRoot, 'prompts', 'action-format.md'), 11);
  addPromptFile(layers, 'global', join(globalRoot, 'ruler', 'default.md'), 12);
  addPromptFile(layers, 'user', join(userRoot, 'prompts', 'agent-system.md'), 20);
  addPromptFile(layers, 'user', join(userRoot, 'prompts', 'action-format.md'), 21);
  addPromptFile(layers, 'user', join(userRoot, 'ruler', 'default.md'), 22);

  const ws = getCurrentWorkspace();
  if (ws?.folders[0]) {
    const root = ws.folders[0].absolutePath;
    addPromptFile(layers, 'workspace', join(root, '.deepcode', 'ruler.md'), 30);
    addPromptFile(layers, 'workspace', join(root, '.deepcode', 'prompts', 'agent-system.md'), 31);
    addPromptFile(layers, 'workspace', join(root, '.deepcode', 'prompts', 'action-format.md'), 32);
  }

  return { layers: layers.sort((a, b) => a.priority - b.priority) };
}

export async function listSkills(): Promise<SkillReferenceResult> {
  const globalRoot = join(resolveDeepCodeGlobalConfigDir(), 'skills');
  const userRoot = join(resolveDeepCodeUserConfigDir(), 'skills');
  const workspaceRoots =
    getCurrentWorkspace()?.folders.map((folder) => join(folder.absolutePath, '.deepcode', 'skills')) ?? [];
  const settings = await getUserSettings();
  const mountSkills = parseSkillMounts(settings.settings['skills.mounts']).flatMap((mount) => {
    if (mount.enabled === false || !mount.path || mount.path.trim() === '') return [];
    const mountPath = mount.path.trim();
    const idSuffix = mount.id || basename(mountPath);
    const override = {
      name: mount.name,
      description: mount.description,
      enabled: mount.enabled,
    };
    if (!existsSync(mountPath)) return [];
    const stat = statSync(mountPath);
    if (stat.isFile()) {
      const skill = makeSkillReference('user', mountPath, idSuffix, override);
      return skill ? [skill] : [];
    }
    return listSkillDirs(mountPath, 'user', idSuffix).map((skill) => ({
      ...skill,
      name: mount.name || skill.name,
      description: mount.description || skill.description,
      enabled: mount.enabled ?? skill.enabled,
    }));
  });

  return {
    skills: [
      ...listSkillDirs(globalRoot, 'global'),
      ...listSkillDirs(userRoot, 'user'),
      ...mountSkills,
      ...workspaceRoots.flatMap((root) => listSkillDirs(root, 'workspace')),
    ],
  };
}
