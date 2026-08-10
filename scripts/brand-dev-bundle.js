#!/usr/bin/env node
'use strict';

// macOS reads the application name out of the running bundle. Unpackaged, that
// bundle is Electron's own, so it says "Electron" no matter what
// `app.setName()` is given -- setName only reaches app.name, the userData path
// and the About panel.
//
// Two different things are read, and the plist alone does not cover both. The
// menu bar takes CFBundleName / CFBundleDisplayName; the Dock tile ignores them
// and labels itself from the bundle directory's own name, so `Electron.app` has
// to be renamed too -- and with it `path.txt`, which is how the electron
// package tells `require('electron')` and `node_modules/.bin/electron` where
// the binary is. Measured, both ways round: the plist alone leaves the Dock
// saying "Electron", and renaming the directory alone is enough to change it.
//
// The executable inside is deliberately left named `Electron`. `app.isPackaged`
// is derived from its name, and `src/main.js` reads that flag to decide how
// much of argv is Electron's own and whether to set the Dock icon itself. Rename
// the binary and a development run starts believing it is a packaged build,
// which puts the app path in front of the CLI parser as if it were a URL.
//
// This rewrites the copy of Electron that this checkout installed. It touches
// nothing outside node_modules, and since it runs from `postinstall` a
// reinstall re-applies it rather than undoing it. To get the stock bundle back,
// reinstall with the postinstall script skipped. Packaged builds do not need
// any of this: their own Info.plist is written from `build.productName`.

const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Mullion';
const NAME_KEYS = ['CFBundleName', 'CFBundleDisplayName'];

const skip = (message) => {
  console.log(`brand-dev-bundle: ${message}`);
  process.exit(0);
};

if (process.platform !== 'darwin') skip('macOS only, nothing to do.');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const brandedBundle = path.join(distDir, `${APP_NAME}.app`);
const stockBundle = path.join(distDir, 'Electron.app');
// A reinstall puts the stock bundle back beside the renamed one, and it is the
// fresh copy of the two, so it wins when both are there.
const bundlePath = [stockBundle, brandedBundle].find((candidate) => fs.existsSync(candidate));

// Absent under `pnpm install --prod`, where electron is not installed at all.
// This script only renames a development bundle, so it must never be the
// reason an install fails.
if (!bundlePath) skip('no development Electron bundle installed, skipped.');

// Everything from here is best effort. This script only renames a development
// bundle for cosmetic reasons, so an unreadable or read-only node_modules must
// not be the thing that fails somebody's install.
function replaceKeys(source) {
  let result = source;
  for (const key of NAME_KEYS) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!pattern.test(result)) {
      console.warn(`brand-dev-bundle: ${key} not found, skipped.`);
      continue;
    }
    result = result.replace(pattern, `$1${APP_NAME}$2`);
  }
  return result;
}

// pnpm hardlinks package files from its global store, so a file is written to a
// temporary path and renamed rather than edited in place: writing through the
// link would rewrite the copy every other project shares. A rename only touches
// this checkout's directory entry.
function writeThroughRename(filePath, contents) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, contents);
  fs.renameSync(tempPath, filePath);
}

try {
  const plistPath = path.join(bundlePath, 'Contents', 'Info.plist');
  const original = fs.readFileSync(plistPath, 'utf8');
  const updated = replaceKeys(original);
  if (updated !== original) writeThroughRename(plistPath, updated);

  const pathFile = path.join(electronDir, 'path.txt');
  // Relative to `dist`, and with forward slashes: this is the exact shape the
  // electron package joins onto its own directory.
  const pathFor = (bundle) => `${path.basename(bundle)}/Contents/MacOS/Electron`;

  // `path.txt` is the only record of where the binary is, and two files that
  // have to agree cannot be updated as one, so the order is chosen for what
  // each failure leaves behind. The file is written first, with the name the
  // bundle still has: everything that can go wrong up to that point leaves both
  // untouched, and a checkout left inconsistent by some earlier run is repaired
  // on the way past.
  //
  // What remains is the gap between the rename and the second write -- an I/O
  // error there, or a kill between the two, leaves the file naming a bundle
  // that has just moved. `getElectronPath()` checks that the path exists and
  // re-runs `install.js` when it does not, so that state costs a download and
  // a Dock tile that says "Electron" again, or, offline, electron's own legible
  // "failed to install correctly" error. The re-download puts the stock bundle
  // back beside the renamed one, which is the case the next `postinstall`
  // already knows how to resolve. Not worth papering over with a rollback that
  // would need the very write that just failed in order to work.
  writeThroughRename(pathFile, pathFor(bundlePath));

  if (bundlePath !== brandedBundle) {
    // Whichever of the two is stale loses. Left in place it would be picked up
    // by the next run as the "fresh" stock bundle and shadow this one forever.
    fs.rmSync(brandedBundle, { recursive: true, force: true });
    fs.renameSync(bundlePath, brandedBundle);
    writeThroughRename(pathFile, pathFor(brandedBundle));
  }

  // Without this the Finder and LaunchServices keep serving the cached name.
  fs.utimesSync(brandedBundle, new Date(), new Date());
} catch (error) {
  skip(`could not rename the bundle (${error.message}), skipped.`);
}

console.log(`brand-dev-bundle: the development bundle is now named ${APP_NAME}.`);
