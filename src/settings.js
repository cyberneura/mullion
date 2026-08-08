'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Bump when the on-disk shape changes so an old file can be ignored rather than
// half-read into the new shape.
const SETTINGS_VERSION = 1;

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultState() {
  return {
    bounds: null,
    navigationPinned: false,
    zoom: 1,
    lastUrls: []
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
  return {
    x: isFiniteNumber(x) ? Math.round(x) : undefined,
    y: isFiniteNumber(y) ? Math.round(y) : undefined,
    width: Math.round(width),
    height: Math.round(height)
  };
}

// Reads persisted state. A missing file, invalid JSON, or an unexpected shape
// all fall back to defaults -- persistence must never keep the window closed.
// Unknown keys on disk are dropped so a tampered file cannot inject state.
function loadState() {
  const state = defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== SETTINGS_VERSION) return state;
    const stored = parsed.state;
    if (!stored || typeof stored !== 'object') return state;

    state.bounds = sanitizeBounds(stored.bounds);
    if (typeof stored.navigationPinned === 'boolean') state.navigationPinned = stored.navigationPinned;
    if (isFiniteNumber(stored.zoom) && stored.zoom > 0) state.zoom = stored.zoom;
    if (Array.isArray(stored.lastUrls)) {
      state.lastUrls = stored.lastUrls.filter((url) => typeof url === 'string').slice(0, 20);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Failed to read settings: ${error.message}`);
  }
  return state;
}

// Written via temp file + rename so a crash mid-write cannot leave a truncated
// settings.json that would then be discarded on the next start.
function saveState(state) {
  const payload = {
    version: SETTINGS_VERSION,
    state: {
      bounds: sanitizeBounds(state.bounds),
      navigationPinned: Boolean(state.navigationPinned),
      zoom: isFiniteNumber(state.zoom) && state.zoom > 0 ? state.zoom : 1,
      lastUrls: Array.isArray(state.lastUrls) ? state.lastUrls.filter((url) => typeof url === 'string').slice(0, 20) : []
    }
  };
  const filePath = settingsFilePath();
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.warn(`Failed to write settings: ${error.message}`);
  }
}

module.exports = { loadState, saveState, settingsFilePath };
