'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { encode, capacityBytes, chooseVersion, formatBits, versionBits, MAX_VERSION } = require('../src/qrcode');

// The published format information strings for error correction level M, masks
// 0 to 7. They come from the specification, not from the encoder, so they check
// the BCH computation against something independent.
const FORMAT_STRINGS = [
  '101010000010010',
  '101000100100101',
  '101111001111100',
  '101101101001011',
  '100010111111001',
  '100000011001110',
  '100111110010111',
  '100101010100000'
];

const VERSION_STRINGS = {
  7: '000111110010010100',
  8: '001000010110111100',
  9: '001001101010011001',
  10: '001010010011010011'
};

// Matrices produced by an unrelated implementation. The round trip below can
// only show that the encoder disagrees with itself; two spec violations (the
// pad run starting at 0x11, and mask penalty rule 3 counted in one direction
// only) passed it for exactly that reason. These pin the output to something
// outside this repository, module for module, mask choice included.
const VECTORS = require('./fixtures/qrcode-vectors.json');

// Everything below this line is a second, deliberately separate implementation
// of the parts of the format the encoder has to get right: where the function
// patterns sit, the order the data modules are walked in, the mask functions,
// and the block interleaving. Reading a code back out with it is the only way
// to check the encoder without a scanner.

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  8: [6, 24, 42]
};

const BLOCKS = {
  1: { ec: 10, sizes: [16] },
  2: { ec: 16, sizes: [28] },
  3: { ec: 26, sizes: [44] },
  8: { ec: 22, sizes: [38, 38, 39, 39] }
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function isFunctionModule(version, size, row, col) {
  if ((row < 8 && col < 8) || (row < 8 && col >= size - 8) || (row >= size - 8 && col < 8)) return true;
  if (row === 6 || col === 6) return true;
  if (col === 8 && (row < 9 || row >= size - 8)) return true;
  if (row === 8 && (col < 9 || col >= size - 8)) return true;
  if (version >= 7) {
    if (row < 6 && col >= size - 11 && col < size - 8) return true;
    if (col < 6 && row >= size - 11 && row < size - 8) return true;
  }
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(row - centres[i]) <= 2 && Math.abs(col - centres[j]) <= 2) return true;
    }
  }
  return false;
}

function readFormat(size, modules) {
  let raw = 0;
  for (let i = 0; i < 15; i += 1) {
    let bit;
    if (i < 6) bit = modules[i][8];
    else if (i < 8) bit = modules[i + 1][8];
    else bit = modules[size - 15 + i][8];
    raw |= bit << i;
  }
  return (raw ^ 0x5412) >>> 10;
}

function readBits(version, size, modules, mask) {
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (isFunctionModule(version, size, row, col)) continue;
        bits.push(modules[row][col] ^ (MASKS[mask](row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  return bits;
}

function readCodewords(result) {
  const { size, modules } = result;
  const version = (size - 17) / 4;
  const bits = readBits(version, size, modules, readFormat(size, modules) & 7);
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function decode(result) {
  const { size, modules } = result;
  const version = (size - 17) / 4;
  const mask = readFormat(size, modules) & 7;
  const codewords = readCodewords(result);

  // Undo the interleaving: the data codewords come first, one per block in
  // turn, and the shortest blocks drop out of the rotation early.
  const { sizes } = BLOCKS[version];
  const blocks = sizes.map(() => []);
  let cursor = 0;
  for (let i = 0; i < Math.max(...sizes); i += 1) {
    for (let b = 0; b < sizes.length; b += 1) {
      if (i < sizes[b]) blocks[b].push(codewords[cursor++]);
    }
  }
  const data = blocks.flat();

  const stream = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i -= 1) stream.push((byte >>> i) & 1);
  }
  const take = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | stream.shift();
    return value;
  };

  const mode = take(4);
  const length = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(8));

  return { mode, version, mask, text: new TextDecoder().decode(Uint8Array.from(bytes)) };
}

test('the matrices match an independent implementation exactly', () => {
  for (const vector of VECTORS.vectors) {
    const result = encode(vector.text);
    assert.strictEqual(result.version, vector.version, vector.name);
    assert.strictEqual(result.size, vector.size, vector.name);
    const rows = result.modules.map((row) => row.join(''));
    assert.deepStrictEqual(rows, vector.modules, vector.name);
  }
});

test('the pad run starts at 0xEC whatever the input length', () => {
  // Only visible from outside as a difference in the finished matrix, which is
  // what the fixtures above cover; this pins the odd/even pair that regressed.
  for (const text of ['abcde', 'abcdef']) {
    const vector = VECTORS.vectors.find((entry) => entry.text === text);
    assert.deepStrictEqual(encode(text).modules.map((row) => row.join('')), vector.modules, text);
  }
});

test('format information matches the published strings', () => {
  for (let mask = 0; mask < 8; mask += 1) {
    assert.strictEqual(formatBits(mask).toString(2).padStart(15, '0'), FORMAT_STRINGS[mask], `mask ${mask}`);
  }
});

test('version information matches the published strings', () => {
  for (const [version, expected] of Object.entries(VERSION_STRINGS)) {
    assert.strictEqual(versionBits(Number(version)).toString(2).padStart(18, '0'), expected, `version ${version}`);
  }
});

test('picks the smallest version that fits', () => {
  assert.strictEqual(chooseVersion(14), 1);
  assert.strictEqual(chooseVersion(15), 2);
  assert.strictEqual(capacityBytes(1), 14);
  assert.strictEqual(capacityBytes(MAX_VERSION), 213);
  assert.strictEqual(chooseVersion(capacityBytes(MAX_VERSION) + 1), null);
});

test('rejects input that no supported version can hold', () => {
  assert.throws(() => encode('x'.repeat(1000)), RangeError);
});

test('the matrix has the expected size and finder patterns', () => {
  const { size, modules, version } = encode('https://example.com');
  assert.strictEqual(version, 2);
  assert.strictEqual(size, 25);

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.strictEqual(modules[top][left], 1);
    assert.strictEqual(modules[top + 1][left + 1], 0);
    assert.strictEqual(modules[top + 3][left + 3], 1);
  }
  // The timing patterns alternate, and the module below the top-left format
  // block is always dark.
  for (let i = 8; i < size - 8; i += 1) {
    assert.strictEqual(modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.strictEqual(modules[i][6], i % 2 === 0 ? 1 : 0);
  }
  assert.strictEqual(modules[size - 8][8], 1);
});

test('a single-block code reads back as what went in', () => {
  const text = 'https://example.com/watch?v=abc';
  const result = encode(text);
  const decoded = decode(result);
  assert.strictEqual(decoded.mode, 4);
  assert.strictEqual(decoded.text, text);
});

test('a multi-block code with version information reads back as what went in', () => {
  const text = `https://example.com/${'a'.repeat(130)}`;
  const result = encode(text);
  assert.strictEqual(result.version, 8);
  assert.strictEqual(decode(result).text, text);
});

// A Reed-Solomon codeword is by definition divisible by the generator, which
// means it evaluates to zero at every root. The round trip above ignores the
// error correction bytes, so this is what checks them.
test('the error correction codewords form valid Reed-Solomon blocks', () => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);

  const result = encode(`https://example.com/${'a'.repeat(130)}`);
  const { sizes, ec } = BLOCKS[result.version];
  const codewords = readCodewords(result);
  const dataLength = sizes.reduce((sum, size) => sum + size, 0);

  const blocks = sizes.map(() => []);
  let cursor = 0;
  for (let i = 0; i < Math.max(...sizes); i += 1) {
    for (let b = 0; b < sizes.length; b += 1) {
      if (i < sizes[b]) blocks[b].push(codewords[cursor++]);
    }
  }
  for (let i = 0; i < ec; i += 1) {
    for (let b = 0; b < sizes.length; b += 1) blocks[b].push(codewords[dataLength + i * sizes.length + b]);
  }

  for (const [index, block] of blocks.entries()) {
    for (let root = 0; root < ec; root += 1) {
      let value = 0;
      for (const byte of block) value = mul(value, exp[root]) ^ byte;
      assert.strictEqual(value, 0, `block ${index}, root ${root}`);
    }
  }
});

test('non-ASCII input is encoded as UTF-8 bytes', () => {
  const text = 'https://example.com/?q=ウインドウ';
  assert.strictEqual(decode(encode(text)).text, text);
});
