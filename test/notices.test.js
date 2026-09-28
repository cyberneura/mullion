'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseCli, helpText } = require('../src/cli');
const { NOTICES_FILE, LICENSE_FILE, noticesPath, licenseText } = require('../src/notices');

const root = path.join(__dirname, '..');
// A checkout with autocrlf has CRLF in every text file.
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json'));
const notices = read(NOTICES_FILE);

// The version pnpm-lock.yaml resolved for a direct dependency of the root
// importer, e.g. `version: 42.8.0` under `electron:`.
function lockedVersion(name) {
  const lock = read('pnpm-lock.yaml');
  const importer = lock.slice(lock.indexOf('\nimporters:\n'), lock.indexOf('\npackages:\n'));
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = importer.match(new RegExp(`\\n      '?${escaped}'?:\\n        specifier: [^\\n]*\\n        version: ([^\\s(]+)`));
  assert.ok(match, `${name} is not a direct dependency in pnpm-lock.yaml`);
  return match[1];
}

test('the notices name the Electron the lockfile resolved', () => {
  assert.match(notices, new RegExp(`\\n  electron ${lockedVersion('electron').replace(/\./g, '\\.')} \\(`));
  assert.match(notices, /LICENSES\.chromium\.html/);
});

test('every production dependency is in the notices at its locked version', () => {
  const deps = Object.keys(pkg.dependencies || {});
  for (const name of deps) {
    assert.ok(notices.includes(`\n  ${name} ${lockedVersion(name)}`), `${name} is missing; run pnpm notices`);
  }
  if (deps.length === 0) assert.match(notices, /no production JavaScript dependencies/);
});

test('the Bootstrap Icons entry matches the version the markup names', () => {
  const version = read('src', 'navigation.html').match(/Bootstrap Icons (\d+\.\d+\.\d+)/)[1];
  assert.ok(notices.includes(`\n  Bootstrap Icons ${version} (`));
  assert.ok(notices.includes('Copyright (c) 2019-2024 The Bootstrap Authors'));
});

test('the license files are packaged into the app', () => {
  assert.ok(pkg.build.files.includes(LICENSE_FILE));
  assert.ok(pkg.build.files.includes(NOTICES_FILE));
  assert.equal(pkg.license, 'MIT');
  assert.match(read(LICENSE_FILE), /^MIT License\n\nCopyright \(c\) \d{4} Cyberneura\n/);
});

test('--license prints the app license followed by the notices', () => {
  assert.equal(noticesPath(root), path.join(root, NOTICES_FILE));
  const text = licenseText(root).replace(/\r\n/g, '\n');
  assert.ok(text.startsWith('MIT License\n'));
  assert.ok(text.includes('\nTHIRD-PARTY NOTICES\n'));
  assert.ok(text.indexOf('Cyberneura') < text.indexOf('THIRD-PARTY NOTICES'));
});

test('--license is a flag and is listed in the help', () => {
  const cli = parseCli(['--license']);
  assert.equal(cli.license, true);
  assert.deepEqual(cli.errors, []);
  assert.deepEqual(parseCli(['--license=yes']).errors, ['--license does not take a value']);
  assert.match(helpText('0.0.0'), /--license/);
});

// The one check that catches a forgotten `pnpm notices` after a dependency
// change of any depth. It needs node_modules and pnpm, which the CI test job has.
test('THIRD-PARTY-NOTICES.txt is what the generator writes today', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('bash', [path.join(root, 'scripts', 'generate-third-party-notices.sh'), '--check'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
