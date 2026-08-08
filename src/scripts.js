'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Turns the `--js` / `--playwright` command line entries into evaluable source.
// Split out from main.js so `node --test` can cover the wrapping rules, which
// are easy to get subtly wrong (a missing newline before `})` silently swallows
// the last line of a script that ends in a `//` comment).

const SHIM_PATH = path.join(__dirname, 'injected', 'playwright-shim.js');

let cachedShim = null;

// Only the default reader is cached; a caller that supplies its own reader
// wants that reader's result, not whatever was read first.
function playwrightShimSource(readFile) {
  if (readFile) return readFile(SHIM_PATH, 'utf8');
  if (cachedShim === null) cachedShim = fs.readFileSync(SHIM_PATH, 'utf8');
  return cachedShim;
}

// Reads the `--js-file` / `--playwright-file` entries from disk and leaves the
// inline ones alone. Failures are collected rather than thrown so one bad path
// does not stop the window from opening.
function resolveScripts(entries, { readFile = fs.readFileSync, cwd = process.cwd() } = {}) {
  const scripts = [];
  const errors = [];

  for (const entry of entries || []) {
    if (entry.source !== undefined) {
      scripts.push({ kind: entry.kind, source: entry.source, origin: `--${entry.kind === 'js' ? 'js' : 'playwright'}` });
      continue;
    }
    const filePath = path.resolve(cwd, entry.file);
    try {
      scripts.push({ kind: entry.kind, source: readFile(filePath, 'utf8'), origin: filePath });
    } catch (error) {
      errors.push(`cannot read script ${filePath}: ${error.message}`);
    }
  }

  return { scripts, errors };
}

// Wraps one script for `webContents.executeJavaScript`.
//
// The async IIFE gives the user's code top-level `await`, which every Playwright
// snippet relies on. `\n` before the closing brace matters: without it a script
// whose last line is a `//` comment would comment out the terminator.
function buildInjection(script, { shim = playwrightShimSource() } = {}) {
  const prelude = script.kind === 'playwright' ? `${shim}\n` : '';
  return `(async () => {\n${prelude}${script.source}\n})()`;
}

module.exports = { resolveScripts, buildInjection, playwrightShimSource, SHIM_PATH };
