'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCli, DEFAULTS } = require('../src/cli');

test('defaults apply when nothing is passed', () => {
  const cli = parseCli([]);
  assert.equal(cli.width, DEFAULTS.width);
  assert.equal(cli.height, DEFAULTS.height);
  assert.equal(cli.zoom, DEFAULTS.zoom);
  assert.deepEqual(cli.targets, []);
  assert.deepEqual(cli.errors, []);
  assert.equal(cli.menubar, false);
});

test('value options accept both spellings', () => {
  const spaced = parseCli(['--width', '900', '--height', '600']);
  const joined = parseCli(['--width=900', '--height=600']);
  assert.equal(spaced.width, 900);
  assert.deepEqual({ w: spaced.width, h: spaced.height }, { w: joined.width, h: joined.height });
});

test('negative window positions are allowed but sizes are not', () => {
  const cli = parseCli(['--x=-100', '--y=-40']);
  assert.equal(cli.x, -100);
  assert.equal(cli.y, -40);
  assert.deepEqual(cli.errors, []);

  const bad = parseCli(['--width=0']);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /invalid value for --width/);
});

test('boolean options are recognised and reject values', () => {
  const cli = parseCli(['--menubar', '--always-on-top', '--js-every-load']);
  assert.equal(cli.menubar, true);
  assert.equal(cli.alwaysOnTop, true);
  assert.equal(cli.jsEveryLoad, true);

  const bad = parseCli(['--menubar=yes']);
  assert.match(bad.errors[0], /does not take a value/);
});

test('short options map to their long form', () => {
  assert.equal(parseCli(['-h']).help, true);
  assert.equal(parseCli(['-v']).version, true);
});

test('unknown options are reported rather than thrown', () => {
  const cli = parseCli(['--nope', 'https://example.com']);
  assert.match(cli.errors[0], /unknown option: --nope/);
  assert.deepEqual(cli.targets, ['https://example.com']);
});

test('a missing value is reported', () => {
  const cli = parseCli(['--title']);
  assert.match(cli.errors[0], /--title requires a value/);
});

test('scripts keep command line order across both kinds', () => {
  const cli = parseCli([
    '--js', 'a()',
    '--playwright-file', 'flow.js',
    '--js-file', 'b.js',
    '--playwright', 'await page.click("#x")'
  ]);
  assert.deepEqual(cli.scripts, [
    { kind: 'js', source: 'a()' },
    { kind: 'playwright', file: 'flow.js' },
    { kind: 'js', file: 'b.js' },
    { kind: 'playwright', source: 'await page.click("#x")' }
  ]);
});

test('provided records which value options were written', () => {
  // A default width is indistinguishable from an explicit one otherwise, and
  // startupBounds() has to know whether to prefer the remembered geometry.
  assert.deepEqual(parseCli([]).provided, {});
  assert.equal(parseCli(['--width=1280']).provided.width, true);
  assert.equal(parseCli(['--height', '600']).provided.width, undefined);
  assert.equal(parseCli(['--height', '600']).provided.height, true);
});

test('a bare dash is a target, not an option', () => {
  const cli = parseCli(['-']);
  assert.deepEqual(cli.targets, ['-']);
  assert.deepEqual(cli.errors, []);
});

test('stdin can only be given once', () => {
  const cli = parseCli(['-', '-']);
  assert.match(cli.errors[0], /stdin/);
});

test('-- stops option parsing', () => {
  const cli = parseCli(['--', '--menubar', '-h']);
  assert.deepEqual(cli.targets, ['--menubar', '-h']);
  assert.equal(cli.menubar, false);
  assert.equal(cli.help, false);
});

test('--html conflicts are reported', () => {
  assert.match(parseCli(['--html', '<p>a', '--html-file', 'b.html']).errors[0], /cannot be combined/);
  assert.match(parseCli(['--html', '<p>a', 'https://example.com']).errors[0], /positional target/);
});

test('a script value that looks like an option is still taken as the value', () => {
  const cli = parseCli(['--js', '--not-an-option']);
  assert.deepEqual(cli.scripts, [{ kind: 'js', source: '--not-an-option' }]);
  assert.deepEqual(cli.errors, []);
});
