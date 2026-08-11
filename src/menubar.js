'use strict';

const TRAY_INTERACTION_GRACE_MS = 250;

function createMenubarBlurController(getWindow, options = {}) {
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  const now = options.now || Date.now;
  const delay = options.delay ?? TRAY_INTERACTION_GRACE_MS;
  let pendingHide = null;
  let suppressBlurUntil = 0;

  function cancelPendingHide() {
    if (pendingHide === null) return;
    cancel(pendingHide);
    pendingHide = null;
  }

  function onBlur() {
    cancelPendingHide();
    const remainingSuppression = Math.max(0, suppressBlurUntil - now());
    pendingHide = schedule(() => {
      pendingHide = null;
      const window = getWindow();
      if (!window || !window.isVisible() || window.isFocused()) return;
      window.hide();
    }, Math.max(delay, remainingSuppression));
  }

  function onTrayInteraction() {
    suppressBlurUntil = now() + delay;
    cancelPendingHide();
  }

  return { onBlur, onTrayInteraction };
}

module.exports = { createMenubarBlurController };
