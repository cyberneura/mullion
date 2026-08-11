'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMenubarBlurController } = require('../src/menubar');

function setup() {
  let callback = null;
  let cancelled = false;
  let currentTime = 1000;
  let focused = false;
  let visible = true;
  let hidden = false;
  let window = {
    isVisible: () => visible,
    isFocused: () => focused,
    hide: () => { hidden = true; }
  };
  const controller = createMenubarBlurController(() => window, {
    schedule: (pending) => { callback = pending; return 1; },
    cancel: () => { cancelled = true; callback = null; },
    now: () => currentTime,
    delay: 250
  });

  return {
    controller,
    runPending: () => callback && callback(),
    wasCancelled: () => cancelled,
    wasHidden: () => hidden,
    setFocused: (value) => { focused = value; },
    setVisible: (value) => { visible = value; },
    destroyWindow: () => { window = null; },
    advance: (milliseconds) => { currentTime += milliseconds; }
  };
}

test('hides an unfocused visible window after the grace period', () => {
  const state = setup();

  state.controller.onBlur();

  assert.equal(state.wasHidden(), false);
  state.runPending();
  assert.equal(state.wasHidden(), true);
});

test('does not hide a window that regained focus during the grace period', () => {
  const state = setup();

  state.controller.onBlur();
  state.setFocused(true);
  state.runPending();

  assert.equal(state.wasHidden(), false);
});

test('a tray interaction cancels a pending blur hide', () => {
  const state = setup();

  state.controller.onBlur();
  state.controller.onTrayInteraction();
  state.runPending();

  assert.equal(state.wasCancelled(), true);
  assert.equal(state.wasHidden(), false);
});

test('a blur during the tray interaction grace period is reevaluated later', () => {
  const state = setup();

  state.controller.onTrayInteraction();
  state.controller.onBlur();
  state.runPending();

  assert.equal(state.wasHidden(), true);
});

test('transient blur after a tray interaction does not hide a refocused window', () => {
  const state = setup();

  state.controller.onTrayInteraction();
  state.controller.onBlur();
  state.setFocused(true);
  state.runPending();

  assert.equal(state.wasHidden(), false);
});

test('a blur after the tray interaction grace period hides the window', () => {
  const state = setup();

  state.controller.onTrayInteraction();
  state.advance(250);
  state.controller.onBlur();
  state.runPending();

  assert.equal(state.wasHidden(), true);
});

test('does not act on a window hidden during the grace period', () => {
  const state = setup();

  state.controller.onBlur();
  state.setVisible(false);
  state.runPending();

  assert.equal(state.wasHidden(), false);
});

test('does not act after the window has been destroyed', () => {
  const state = setup();

  state.controller.onBlur();
  state.destroyWindow();

  assert.doesNotThrow(() => state.runPending());
});
