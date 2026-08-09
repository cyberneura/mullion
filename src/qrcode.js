'use strict';

// A QR Code encoder, kept to the smallest subset that covers a URL: byte mode,
// error correction level M, versions 1 to 10 (213 bytes). The app has no
// dependencies and this is the only thing "Show QR Code" needs, so the
// alternative would have been sending the user's URL to a web service.
//
// No Electron imports: this file is unit tested under `node --test`.

// [blocks] is [blockCount, dataCodewordsPerBlock] pairs. `total` is the whole
// codeword count for the version and `ec` the EC codewords in every block.
const VERSIONS = [
  null,
  { total: 26, ec: 10, blocks: [[1, 16]] },
  { total: 44, ec: 16, blocks: [[1, 28]] },
  { total: 70, ec: 26, blocks: [[1, 44]] },
  { total: 100, ec: 18, blocks: [[2, 32]] },
  { total: 134, ec: 24, blocks: [[2, 43]] },
  { total: 172, ec: 16, blocks: [[4, 27]] },
  { total: 196, ec: 18, blocks: [[4, 31]] },
  { total: 242, ec: 22, blocks: [[2, 38], [2, 39]] },
  { total: 292, ec: 22, blocks: [[3, 36], [2, 37]] },
  { total: 346, ec: 26, blocks: [[4, 43], [1, 44]] }
];

const ALIGNMENT = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
];

const MAX_VERSION = VERSIONS.length - 1;
const BYTE_MODE = 0b0100;
// Level M as it appears in the format information, which is not the same order
// as the level names: L=01, M=00, Q=11, H=10.
const EC_LEVEL_M = 0b00;
const PAD_CODEWORDS = [0xec, 0x11];

const G15 = 0x537;
const G18 = 0x1f25;
const FORMAT_MASK = 0x5412;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Coefficients run highest power first, so the product below is (poly * x) plus
// (poly * a^i) shifted down one place.
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLength) {
  const gen = generatorPoly(ecLength);
  const buffer = new Uint8Array(data.length + ecLength);
  buffer.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const factor = buffer[i];
    if (factor === 0) continue;
    // gen[0] is always 1, so the leading term cancels itself and is skipped.
    for (let j = 1; j < gen.length; j += 1) buffer[i + j] ^= gfMul(gen[j], factor);
  }
  return buffer.subarray(data.length);
}

function bitLength(value) {
  let bits = 0;
  while (value !== 0) {
    bits += 1;
    value >>>= 1;
  }
  return bits;
}

// The format and version fields carry a BCH checksum. Computing it is shorter
// than the lookup tables the spec prints, and cannot be mistyped.
function bchRemainder(value, generator) {
  const generatorBits = bitLength(generator);
  let remainder = value;
  while (bitLength(remainder) >= generatorBits) {
    remainder ^= generator << (bitLength(remainder) - generatorBits);
  }
  return remainder;
}

function formatBits(mask) {
  const data = (EC_LEVEL_M << 3) | mask;
  return (((data << 10) | bchRemainder(data << 10, G15)) ^ FORMAT_MASK) & 0x7fff;
}

function versionBits(version) {
  return (version << 12) | bchRemainder(version << 12, G18);
}

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
];

function dataCodewordCount(version) {
  return VERSIONS[version].blocks.reduce((sum, [count, size]) => sum + count * size, 0);
}

function lengthBits(version) {
  return version < 10 ? 8 : 16;
}

function capacityBytes(version) {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - lengthBits(version)) / 8);
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= capacityBytes(version)) return version;
  }
  return null;
}

function buildDataCodewords(bytes, version) {
  const total = dataCodewordCount(version);
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(BYTE_MODE, 4);
  push(bytes.length, lengthBits(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator, then the run-up to a whole codeword, then the fixed pad pair.
  for (let i = 0; i < 4 && bits.length < total * 8; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // The pad run always starts at 0xEC, whatever the codeword count happens to
  // be at that point -- keying the alternation off the array length instead
  // starts it at 0x11 for every odd-length input.
  for (let pad = 0; codewords.length < total; pad += 1) codewords.push(PAD_CODEWORDS[pad % 2]);

  return codewords;
}

// Data and EC codewords are interleaved across the blocks rather than
// concatenated, so that a burst of damage is spread over every block.
function interleave(codewords, version) {
  const { ec, blocks } = VERSIONS[version];
  const groups = [];
  let offset = 0;
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i += 1) {
      const data = Uint8Array.from(codewords.slice(offset, offset + size));
      offset += size;
      groups.push({ data, ec: rsEncode(data, ec) });
    }
  }

  const result = [];
  const longest = Math.max(...groups.map((group) => group.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const group of groups) {
      if (i < group.data.length) result.push(group.data[i]);
    }
  }
  for (let i = 0; i < ec; i += 1) {
    for (const group of groups) result.push(group.ec[i]);
  }
  return result;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  const set = (row, col, value) => {
    modules[row * size + col] = value ? 1 : 0;
    reserved[row * size + col] = 1;
  };

  const finder = (top, left) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let col = -1; col <= 7; col += 1) {
        const r = top + row;
        const c = left + col;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inRing = (row >= 0 && row <= 6 && (col === 0 || col === 6)) || (col >= 0 && col <= 6 && (row === 0 || row === 6));
        const inCore = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        set(r, c, inRing || inCore);
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      // The three corners belong to the finder patterns. The rest are drawn
      // even where they cross a timing line, which they agree with by design.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const row = centres[i];
      const col = centres[j];
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // The always-dark module, and the areas the format and version fields will
  // occupy: reserved now so the data placement walks around them.
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8 * size + i]) set(8, i, false);
    if (!reserved[i * size + 8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8 * size + (size - 1 - i)]) set(8, size - 1 - i, false);
    if (!reserved[(size - 1 - i) * size + 8]) set(size - 1 - i, 8, false);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      set(row, col, false);
      set(col, row, false);
    }
  }

  return { size, modules, reserved };
}

// Up the right-hand column pair, down the next, skipping the vertical timing
// column, writing two modules per row.
function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  let bit = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (reserved[row * size + col]) continue;
        // Remainder bits past the end of the data are left at zero.
        let dark = 0;
        if (bit < totalBits) dark = (codewords[bit >> 3] >>> (7 - (bit & 7))) & 1;
        modules[row * size + col] = dark;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, mask) {
  const { size, modules, reserved } = matrix;
  const test = MASKS[mask];
  const masked = Uint8Array.from(modules);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (reserved[row * size + col]) continue;
      if (test(row, col)) masked[row * size + col] ^= 1;
    }
  }
  return masked;
}

function writeFormat(size, modules, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const value = (bits >>> i) & 1;
    if (i < 6) modules[i * size + 8] = value;
    else if (i < 8) modules[(i + 1) * size + 8] = value;
    else modules[(size - 15 + i) * size + 8] = value;

    if (i < 8) modules[8 * size + (size - 1 - i)] = value;
    else if (i === 8) modules[8 * size + 7] = value;
    else modules[8 * size + (14 - i)] = value;
  }
  modules[(size - 8) * size + 8] = 1;
}

function writeVersion(size, modules, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const value = (bits >>> i) & 1;
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    modules[row * size + col] = value;
    modules[col * size + row] = value;
  }
}

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;
// The 1:1:3:1:1 finder proportion with its four-module light run. The run may
// sit on either side of the pattern, so both orientations have to be counted --
// scoring only one of them leaves half the finder look-alikes unpenalised, and
// changes which mask wins.
const FINDER_RUN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const FINDER_RUN_MIRROR = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function penalty(size, modules) {
  const at = (row, col) => modules[row * size + col];
  let score = 0;

  // Runs of five or more, in both directions.
  for (let line = 0; line < size; line += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let i = 1; i < size; i += 1) {
        const current = horizontal ? at(line, i) : at(i, line);
        const previous = horizontal ? at(line, i - 1) : at(i - 1, line);
        if (current === previous) {
          run += 1;
          continue;
        }
        if (run >= 5) score += N1 + run - 5;
        run = 1;
      }
      if (run >= 5) score += N1 + run - 5;
    }
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const first = at(row, col);
      if (first === at(row, col + 1) && first === at(row + 1, col) && first === at(row + 1, col + 1)) score += N2;
    }
  }

  // The sequence a scanner would mistake for a finder pattern, counted in both
  // orientations and both directions.
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col <= size - FINDER_RUN.length; col += 1) {
      for (const run of [FINDER_RUN, FINDER_RUN_MIRROR]) {
        let horizontal = true;
        let vertical = true;
        for (let i = 0; i < run.length; i += 1) {
          if (at(row, col + i) !== run[i]) horizontal = false;
          if (at(col + i, row) !== run[i]) vertical = false;
        }
        if (horizontal) score += N3;
        if (vertical) score += N3;
      }
    }
  }

  let dark = 0;
  for (let i = 0; i < modules.length; i += 1) dark += modules[i];
  const percent = (dark * 100) / (size * size);
  score += N4 * Math.floor(Math.abs(percent - 50) / 5);

  return score;
}

// Returns { version, size, modules } where modules is an array of rows of 0/1,
// ready to travel over IPC and be drawn by the renderer.
function encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = chooseVersion(bytes.length);
  if (version === null) {
    throw new RangeError(`too long for a QR code: ${bytes.length} bytes, limit ${capacityBytes(MAX_VERSION)}`);
  }

  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const matrix = createMatrix(version);
  placeData(matrix, codewords);

  const { size } = matrix;
  let best = null;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const modules = applyMask(matrix, mask);
    writeFormat(size, modules, mask);
    writeVersion(size, modules, version);
    const score = penalty(size, modules);
    if (best === null || score < best.score) best = { score, modules };
  }

  const rows = [];
  for (let row = 0; row < size; row += 1) {
    rows.push(Array.from(best.modules.subarray(row * size, row * size + size)));
  }
  return { version, size, modules: rows };
}

module.exports = { encode, capacityBytes, chooseVersion, formatBits, versionBits, MAX_VERSION };
