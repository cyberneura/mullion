'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { imageDimensions, imageTooLarge } = require('../src/images');

const MAX_EDGE = 4096;

// Signature, IHDR chunk header, then the size fields: the 24 bytes that are
// read. Building a real header matters -- a helper that leaves the chunk header
// blank would pass a gate that never looks at it, which is how the missing
// check went unnoticed.
function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(bytes, 8);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function sof0(width, height) {
  const segment = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
  segment.writeUInt16BE(height, 5);
  segment.writeUInt16BE(width, 7);
  return segment;
}

test('reads PNG dimensions out of the IHDR', () => {
  assert.deepStrictEqual(imageDimensions(png(64, 48)), { width: 64, height: 48 });
  assert.deepStrictEqual(imageDimensions(png(1, 1)), { width: 1, height: 1 });
});

test('a truncated PNG has no readable size', () => {
  assert.strictEqual(imageDimensions(png(64, 48).subarray(0, 23)), null);
  assert.strictEqual(imageDimensions(Buffer.alloc(0)), null);
});

test('a file that only starts like a PNG is refused', () => {
  const wrongSignature = png(64, 48);
  wrongSignature[3] = 0x00;
  assert.strictEqual(imageDimensions(wrongSignature), null);

  // The signature alone proves nothing: the IHDR has to be there too.
  const noChunkHeader = png(64, 48);
  noChunkHeader.fill(0, 8, 16);
  assert.strictEqual(imageDimensions(noChunkHeader), null);

  const wrongChunkType = png(64, 48);
  wrongChunkType.write('IDAT', 12, 'ascii');
  assert.strictEqual(imageDimensions(wrongChunkType), null);
});

test('a zero dimension is refused rather than passed as small', () => {
  assert.strictEqual(imageDimensions(png(0, 48)), null);
  assert.strictEqual(imageDimensions(png(64, 0)), null);
  assert.strictEqual(imageTooLarge(png(0, 0), MAX_EDGE), true);
});

test('the size limit applies to either edge, and to unreadable input', () => {
  assert.strictEqual(imageTooLarge(png(4096, 4096), MAX_EDGE), false);
  assert.strictEqual(imageTooLarge(png(4097, 16), MAX_EDGE), true);
  assert.strictEqual(imageTooLarge(png(16, 4097), MAX_EDGE), true);
  assert.strictEqual(imageTooLarge(Buffer.from('junk'), MAX_EDGE), true);
});

// JPEG is refused as a format rather than measured. Each of these declared a
// small size to the segment walk that used to live here and a much larger one
// to a real decoder. They are kept as cases so that anyone reinstating JPEG
// support has to answer them first.
test('JPEG is refused, whatever it declares', () => {
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), sof0(64, 48)]);

  // A frame header preceded by a 0xFF fill byte, which is legal padding.
  const fillByte = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), sof0(30000, 30000)]);

  // 0xFF 0x00 is a stuffed byte, not a marker. A walk that reads a length from
  // it lands wherever the file likes -- on a decoy frame, for instance.
  const stuffedZero = Buffer.alloc(300);
  Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x00]).copy(stuffedZero, 0);
  sof0(30000, 30000).copy(stuffedZero, 6);
  sof0(16, 16).copy(stuffedZero, 260);

  // A hierarchical frame header states the finished size before the frame.
  const hierarchical = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xde, 0x00, 0x0b, 0x08, 0x75, 0x30, 0x75, 0x30, 0x01, 0x01, 0x11, 0x00]),
    sof0(16, 16)
  ]);

  // A height of zero in the frame header is legal: the real one arrives in a
  // define-number-of-lines segment after the first scan.
  const definedLater = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof0(16, 0),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0xff, 0xdc, 0x00, 0x04, 0x75, 0x30]),
    Buffer.from([0xff, 0xd9])
  ]);

  for (const [name, bytes] of [
    ['plain', plain],
    ['fill byte', fillByte],
    ['stuffed zero', stuffedZero],
    ['hierarchical', hierarchical],
    ['height defined later', definedLater]
  ]) {
    assert.strictEqual(imageDimensions(bytes), null, name);
    assert.strictEqual(imageTooLarge(bytes, MAX_EDGE), true, name);
  }
});

test('other formats have no readable size either', () => {
  assert.strictEqual(imageDimensions(Buffer.from('GIF89a...............')), null);
  // An ICO, which is what a favicon most often is when it is not a PNG.
  assert.strictEqual(imageDimensions(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});
