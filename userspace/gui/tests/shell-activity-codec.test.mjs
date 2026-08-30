import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isShellActivityResult,
  isShellExecutionEnvironment,
} from '../dist/userspace/gui/src/services/shellActivityCodec.js';

const baseResult = {
  stdout: 'ok\n',
  stderr: '',
  exitCode: 0,
  success: true,
  timedOut: false,
  truncated: false,
  capturedBytes: 3,
  durationMs: 12,
};

const environment = {
  shell: '/bin/sh',
  interactive: false,
  pathSource: 'hostPlusStandardDeveloperPaths',
  writeScope: 'workspaceAndKernelTemporary',
  homeWritable: false,
};

test('accepts the current process.shell projection contract', () => {
  assert.equal(isShellActivityResult({ ...baseResult, environment }), true);
});

test('accepts a result recorded before environment projection was added', () => {
  assert.equal(isShellActivityResult(baseResult), true);
});

test('rejects an unknown result or environment field', () => {
  assert.equal(isShellActivityResult({ ...baseResult, command: 'pwd' }), false);
  assert.equal(isShellActivityResult({
    ...baseResult,
    environment: { ...environment, home: '/tmp' },
  }), false);
});

test('rejects an environment that changes the non-interactive workspace contract', () => {
  assert.equal(isShellExecutionEnvironment({ ...environment, interactive: true }), false);
  assert.equal(isShellExecutionEnvironment({ ...environment, homeWritable: true }), false);
  assert.equal(isShellExecutionEnvironment({ ...environment, shell: '   ' }), false);
});
