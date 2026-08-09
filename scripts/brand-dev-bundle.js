#!/usr/bin/env node
'use strict';

// macOS reads the application name for the menu bar and the Dock out of the
// running bundle's Info.plist. Unpackaged, that bundle is Electron's own, so
// both say "Electron" no matter what `app.setName()` is given -- setName only
// reaches app.name, the userData path and the About panel.
//
// This rewrites CFBundleName / CFBundleDisplayName in the copy of Electron that
// this checkout installed. It touches nothing outside node_modules, and since
// it runs from `postinstall` a reinstall re-applies it rather than undoing it.
// To get the stock bundle back, reinstall with the postinstall script skipped.
// Packaged builds do not need any of this: their own Info.plist is written
// from `build.productName`.

const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Mullion';
const KEYS = ['CFBundleName', 'CFBundleDisplayName'];

if (process.platform !== 'darwin') {
  console.log('brand-dev-bundle: macOS only, nothing to do.');
  process.exit(0);
}

const plistPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');

// Absent under `pnpm install --prod`, where electron is not installed at all.
// This script only renames a development bundle, so it must never be the
// reason an install fails.
if (!fs.existsSync(plistPath)) {
  console.log('brand-dev-bundle: no development Electron bundle installed, skipped.');
  process.exit(0);
}

// Everything from here is best effort. This script only renames a development
// bundle for cosmetic reasons, so an unreadable or read-only node_modules must
// not be the thing that fails somebody's install.
let original;
try {
  original = fs.readFileSync(plistPath, 'utf8');
} catch (error) {
  console.log(`brand-dev-bundle: could not read the bundle (${error.message}), skipped.`);
  process.exit(0);
}

let updated = original;
for (const key of KEYS) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (!pattern.test(updated)) {
    console.warn(`brand-dev-bundle: ${key} not found, skipped.`);
    continue;
  }
  updated = updated.replace(pattern, `$1${APP_NAME}$2`);
}

if (updated === original) {
  console.log(`brand-dev-bundle: already named ${APP_NAME}.`);
  process.exit(0);
}

// Written to a temporary file and renamed rather than edited in place: pnpm
// hardlinks package files from its global store, and writing through the link
// would rewrite the copy every other project shares.
const tempPath = `${plistPath}.tmp`;
try {
  fs.writeFileSync(tempPath, updated);
  fs.renameSync(tempPath, plistPath);
  // Without this the Finder and LaunchServices keep serving the cached name.
  fs.utimesSync(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app'), new Date(), new Date());
} catch (error) {
  console.log(`brand-dev-bundle: could not rename the bundle (${error.message}), skipped.`);
  process.exit(0);
}

console.log(`brand-dev-bundle: the development bundle is now named ${APP_NAME}.`);
