'use strict';

// The license texts Mullion ships: its own LICENSE and THIRD-PARTY-NOTICES.txt,
// both packaged into app.asar (see `build.files`). Kept free of Electron imports
// so it can be unit tested with `node --test`; the caller passes the app root
// (`app.getAppPath()`), which is the checkout in development and app.asar once
// packaged. Electron's fs reads through asar transparently.

const fs = require('node:fs');
const path = require('node:path');

const LICENSE_FILE = 'LICENSE';
const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';

function noticesPath(appRoot) {
  return path.join(appRoot, NOTICES_FILE);
}

// What `--license` prints: Mullion's own license first, then everything it
// bundles.
function licenseText(appRoot) {
  const own = fs.readFileSync(path.join(appRoot, LICENSE_FILE), 'utf8').replace(/\s+$/, '');
  const notices = fs.readFileSync(noticesPath(appRoot), 'utf8').replace(/\s+$/, '');
  return `${own}\n\n\n${notices}\n`;
}

module.exports = { LICENSE_FILE, NOTICES_FILE, noticesPath, licenseText };
