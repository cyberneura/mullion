'use strict';

const { ipcRenderer } = require('electron');

// Runs inside every page we show. It deliberately exposes nothing to the page
// (no contextBridge): it only reports the top-edge hover gesture that reveals
// the navigation bar, which cannot be detected from the main process because
// the page owns the whole window area.

const EDGE_HEIGHT = 4;
const DWELL_MS = 300;

let dwellTimer = null;

function clearDwell() {
  if (dwellTimer === null) return;
  clearTimeout(dwellTimer);
  dwellTimer = null;
}

window.addEventListener(
  'mousemove',
  (event) => {
    if (event.clientY > EDGE_HEIGHT) {
      clearDwell();
      return;
    }
    if (dwellTimer !== null) return;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      ipcRenderer.send('edge-hover');
    }, DWELL_MS);
  },
  { passive: true, capture: true }
);

// mouseleave only fires on elements, so it is bound to the document rather than
// the window; without it a pointer that leaves through the top edge mid-dwell
// would still trip the reveal.
document.addEventListener('mouseleave', clearDwell, { passive: true, capture: true });
