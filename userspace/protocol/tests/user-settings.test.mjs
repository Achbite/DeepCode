import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_USER_SETTINGS,
  agentSettingsIndex,
  pluginSettingsIndex,
  shellPreferenceSettingsIndex,
} from '../dist/index.js';

test('GUI 壳设置与共享 Agent 设置使用不同目录边界', () => {
  const gui = new Set(shellPreferenceSettingsIndex('gui').map((entry) => entry.key));
  const shared = new Map(agentSettingsIndex().map((entry) => [entry.key, entry]));
  const plugins = new Set(pluginSettingsIndex().map((entry) => entry.key));

  assert.ok(gui.has('gui.colorTheme'));
  assert.ok(gui.has('gui.navigationDensity'));
  assert.ok(gui.has('gui.showContextRail'));
  assert.ok(!gui.has('agent.systemPrompt'));
  assert.ok(!shared.has('skills.mounts'));
  assert.ok(!shared.has('mcp.servers'));
  assert.ok(plugins.has('skills.mounts'));
  assert.ok(plugins.has('mcp.servers'));

  for (const key of [
    'agent.systemPrompt',
    'agent.permissions.workspaceMutation',
    'agent.permissions.engineeringDecisions',
    'agent.permissions.networkRead',
    'agent.permissions.external',
  ]) {
    assert.deepEqual(shared.get(key)?.shellSurface, ['editor', 'gui', 'cli', 'tui']);
  }
  assert.deepEqual(
    Object.keys(DEFAULT_USER_SETTINGS)
      .filter((key) => key.startsWith('agent.permissions.'))
      .sort(),
    [
      'agent.permissions.engineeringDecisions',
      'agent.permissions.external',
      'agent.permissions.networkRead',
      'agent.permissions.workspaceMutation',
    ],
  );
  assert.equal(DEFAULT_USER_SETTINGS['agent.permissions.workspaceMutation'], 'plan');
  assert.equal(DEFAULT_USER_SETTINGS['agent.permissions.engineeringDecisions'], 'ask');
  assert.equal(DEFAULT_USER_SETTINGS['agent.permissions.networkRead'], 'allow');
  assert.equal(DEFAULT_USER_SETTINGS['agent.permissions.external'], 'ask');
});
