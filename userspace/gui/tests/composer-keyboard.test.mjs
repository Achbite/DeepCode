import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldOfferFocusCommand,
  shouldSubmitComposerKey,
} from '../dist/userspace/gui/src/components/local-agent/composerKeyboard.js';

const plainEnter = {
  key: 'Enter',
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 13,
};

test('submits only a fresh Enter outside the IME composition lifecycle', () => {
  assert.equal(shouldSubmitComposerKey(plainEnter, {
    active: false,
    commitPending: false,
  }), true);
  assert.equal(shouldSubmitComposerKey({ ...plainEnter, shiftKey: true }, {
    active: false,
    commitPending: false,
  }), false);
  assert.equal(shouldSubmitComposerKey({ ...plainEnter, repeat: true }, {
    active: false,
    commitPending: false,
  }), false);
});

test('does not submit the Enter used to confirm an IME candidate', () => {
  assert.equal(shouldSubmitComposerKey(plainEnter, {
    active: true,
    commitPending: false,
  }), false);
  assert.equal(shouldSubmitComposerKey(plainEnter, {
    active: false,
    commitPending: true,
  }), false);
  assert.equal(shouldSubmitComposerKey({ ...plainEnter, isComposing: true }, {
    active: false,
    commitPending: false,
  }), false);
  assert.equal(shouldSubmitComposerKey({ ...plainEnter, keyCode: 229 }, {
    active: false,
    commitPending: false,
  }), false);
});

test('offers the focus command only while its exact slash prefix is being entered', () => {
  for (const draft of ['/', '/f', '/fo', '/foc', '/focu', '/focus']) {
    assert.equal(shouldOfferFocusCommand(draft), true);
  }
  for (const draft of ['', ' /f', '/focus ', '/focused', '/other']) {
    assert.equal(shouldOfferFocusCommand(draft), false);
  }
});
