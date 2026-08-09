'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { classifyTarget, labelFor, fileKindFor } = require('../src/targets');

const CWD = '/tmp/mullion-test';
const nothingExists = () => false;
const everythingExists = () => true;

test('http(s) URLs pass through', () => {
  assert.deepEqual(classifyTarget('https://example.com/a?b=1', { cwd: CWD, exists: nothingExists }), {
    kind: 'url',
    url: 'https://example.com/a?b=1'
  });
});

test('a bare dash is stdin', () => {
  assert.deepEqual(classifyTarget('-'), { kind: 'stdin' });
});

test('host-shaped words become https URLs', () => {
  assert.equal(classifyTarget('example.com', { cwd: CWD, exists: nothingExists }).url, 'https://example.com/');
  assert.equal(classifyTarget('example.com/path', { cwd: CWD, exists: nothingExists }).kind, 'url');
});

test('host:port is a host, not a scheme', () => {
  // `.` and `-` are legal scheme characters, so both of these would otherwise
  // parse as a URL with a `localhost:` / `example.com:` protocol.
  assert.equal(classifyTarget('localhost:3000', { cwd: CWD, exists: nothingExists }).url, 'https://localhost:3000/');
  assert.equal(classifyTarget('example.com:8080/a', { cwd: CWD, exists: nothingExists }).url, 'https://example.com:8080/a');
  assert.equal(classifyTarget('localhost:3000', { cwd: CWD, exists: nothingExists }).kind, 'url');
});

test('an existing file wins over the host-shaped guess', () => {
  const asFile = classifyTarget('example.com', { cwd: CWD, exists: everythingExists });
  assert.equal(asFile.kind, 'file');
  assert.equal(asFile.filePath, path.join(CWD, 'example.com'));
});

test('explicit paths never probe as hosts', () => {
  assert.equal(classifyTarget('./example.com', { cwd: CWD, exists: everythingExists }).kind, 'file');
  assert.equal(classifyTarget('/var/www/example.com', { cwd: CWD, exists: nothingExists }).kind, 'file');
  assert.equal(classifyTarget('../up.html', { cwd: CWD, exists: nothingExists }).filePath, '/tmp/up.html');
});

test('a bare word with no dot is a file even when it is missing', () => {
  const target = classifyTarget('README', { cwd: CWD, exists: nothingExists });
  assert.equal(target.kind, 'file');
  assert.equal(target.filePath, path.join(CWD, 'README'));
});

test('~ expands to the home directory', () => {
  const target = classifyTarget('~/notes.md', { cwd: CWD, exists: nothingExists });
  assert.equal(target.filePath, path.join(os.homedir(), 'notes.md'));
});

test('file targets carry a viewer kind and a file:// URL', () => {
  const target = classifyTarget('/docs/deck.PDF', { cwd: CWD, exists: nothingExists });
  assert.equal(target.fileKind, 'pdf');
  assert.equal(target.url, 'file:///docs/deck.PDF');
  assert.equal(classifyTarget('/a/b.yml', { cwd: CWD, exists: nothingExists }).fileKind, 'yaml');
  assert.equal(classifyTarget('/a/b.bin', { cwd: CWD, exists: nothingExists }).fileKind, 'other');
});

test('non-web schemes are handed to the OS', () => {
  assert.deepEqual(classifyTarget('mailto:a@example.com', { cwd: CWD, exists: nothingExists }), {
    kind: 'external',
    url: 'mailto:a@example.com'
  });
});

test('file:// and about: are hosted directly', () => {
  assert.equal(classifyTarget('file:///etc/hosts', { cwd: CWD, exists: nothingExists }).kind, 'url');
  assert.equal(classifyTarget('about:blank', { cwd: CWD, exists: nothingExists }).kind, 'url');
});

test('windows drive letters are files, not a "c:" scheme', () => {
  assert.equal(classifyTarget('C:\\Users\\a\\page.html', { cwd: CWD, exists: nothingExists }).kind, 'file');
});

test('labels prefer the file name and the host', () => {
  assert.equal(labelFor(classifyTarget('/docs/deck.pdf', { cwd: CWD, exists: nothingExists })), 'deck.pdf');
  assert.equal(labelFor(classifyTarget('https://example.com/a', { cwd: CWD, exists: nothingExists })), 'example.com');
  assert.equal(labelFor(classifyTarget('-')), 'stdin');
  assert.equal(labelFor(null), 'Mullion');
});

test('extension matching is case insensitive', () => {
  assert.equal(fileKindFor('/a/B.JSON'), 'json');
});
