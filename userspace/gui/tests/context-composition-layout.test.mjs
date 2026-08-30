import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContextCompositionLayout,
} from '../dist/userspace/gui/src/deepcode-gui/panel/contextCompositionLayout.js';

const segments = [
  { key: 'instructions', truePercent: 0.0148 },
  { key: 'sessionControls', truePercent: 0.1063 },
  { key: 'tools', truePercent: 0.366 },
  { key: 'workspaceBindings', truePercent: 0.0057 },
  { key: 'contextProviders', truePercent: 0 },
  { key: 'journalMessages', truePercent: 2.7622 },
  { key: 'messageAttachments', truePercent: 0 },
  { key: 'output', truePercent: 0.0313 },
  { key: 'free', truePercent: 96.7137 },
];

test('keeps the true whole-window proportions when no segment is focused', () => {
  const layout = buildContextCompositionLayout(segments, null);

  assert.equal(layout.focused, false);
  assert.ok(Math.abs(layout.widths.reduce((sum, width) => sum + width, 0) - 100) < 1e-9);
  assert.ok(Math.abs(layout.widths[5] - 2.7622) < 1e-9);
  assert.ok(Math.abs(layout.widths[7] - 0.0313) < 1e-9);
  assert.ok(Math.abs(layout.widths[8] - 96.7137) < 1e-9);
});

test('magnifies the focused segment in place while retaining surrounding comparisons', () => {
  const layout = buildContextCompositionLayout(segments, 'sessionControls');

  assert.equal(layout.focused, true);
  assert.ok(Math.abs(layout.widths[1] - 30) < 1e-9);
  assert.ok(Math.abs(layout.widths[8] - 44) < 1e-9);
  assert.ok(Math.abs(
    layout.widths
      .filter((_, index) => ![1, 8].includes(index))
      .reduce((sum, width) => sum + width, 0)
      - 26,
  ) < 1e-9);
  assert.equal(layout.widths[4], 0);
  assert.equal(layout.widths[6], 0);
  assert.ok(Math.abs(layout.widths.reduce((sum, width) => sum + width, 0) - 100) < 1e-9);
});

test('supports Provider output focus and ignores empty or free segments', () => {
  const output = buildContextCompositionLayout(segments, 'output');
  const empty = buildContextCompositionLayout(segments, 'contextProviders');
  const free = buildContextCompositionLayout(segments, 'free');

  assert.equal(output.focused, true);
  assert.ok(Math.abs(output.widths[7] - 30) < 1e-9);
  assert.equal(empty.focused, false);
  assert.equal(free.focused, false);
});
