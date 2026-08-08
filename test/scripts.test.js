'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveScripts, buildInjection, playwrightShimSource } = require('../src/scripts');

test('inline sources pass through unchanged', () => {
  const { scripts, errors } = resolveScripts([{ kind: 'js', source: 'document.title = "x"' }]);
  assert.deepEqual(errors, []);
  assert.equal(scripts[0].source, 'document.title = "x"');
  assert.equal(scripts[0].kind, 'js');
});

test('file sources are read relative to the working directory', () => {
  const seen = [];
  const readFile = (filePath) => {
    seen.push(filePath);
    return 'await page.click("#play")';
  };
  const { scripts, errors } = resolveScripts([{ kind: 'playwright', file: 'flow.js' }], { readFile, cwd: '/work' });
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, [path.join('/work', 'flow.js')]);
  assert.equal(scripts[0].origin, path.join('/work', 'flow.js'));
});

test('an unreadable file is reported without losing the other scripts', () => {
  const readFile = (filePath) => {
    if (filePath.endsWith('missing.js')) throw new Error('ENOENT');
    return 'ok()';
  };
  const { scripts, errors } = resolveScripts(
    [{ kind: 'js', file: 'missing.js' }, { kind: 'js', file: 'present.js' }],
    { readFile, cwd: '/work' }
  );
  assert.equal(scripts.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot read script/);
});

test('order is preserved across kinds', () => {
  const { scripts } = resolveScripts([
    { kind: 'js', source: 'one' },
    { kind: 'playwright', source: 'two' },
    { kind: 'js', source: 'three' }
  ]);
  assert.deepEqual(scripts.map((script) => script.source), ['one', 'two', 'three']);
});

test('plain JS is wrapped in an async IIFE without the shim', () => {
  const code = buildInjection({ kind: 'js', source: 'await x()' }, { shim: 'SHIM' });
  assert.equal(code, '(async () => {\nawait x()\n})()');
  assert.ok(!code.includes('SHIM'));
});

test('Playwright code gets the shim spliced in first', () => {
  const code = buildInjection({ kind: 'playwright', source: 'await page.click("a")' }, { shim: 'const page = {};' });
  assert.equal(code, '(async () => {\nconst page = {};\nawait page.click("a")\n})()');
});

test('a script ending in a line comment still terminates', () => {
  const code = buildInjection({ kind: 'js', source: 'doThing(); // done' }, { shim: '' });
  // The newline before `})` is what keeps the terminator out of the comment.
  assert.ok(code.endsWith('// done\n})()'));
});

test('the shim parses as a function body and defines the Playwright surface', () => {
  const shim = playwrightShimSource();
  // Compiling it as an async function body is exactly how it is used at runtime,
  // so a syntax error here is the same failure the page would hit.
  assert.doesNotThrow(() => new Function(`return (async () => {\n${shim}\nreturn { page, test, expect, chromium };\n})()`));
  for (const name of ['const page = {', 'const expect =', 'const test =', 'const chromium =', 'const require =']) {
    assert.ok(shim.includes(name), `shim should declare ${name}`);
  }
});
