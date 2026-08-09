'use strict';

// Reads the dimensions an image declares, without decoding it. The point is to
// refuse an allocation before it happens: a favicon URL is chosen by the page,
// and 256KB of image data can declare a canvas of several gigabytes.
//
// **PNG only, deliberately.** `nativeImage.createFromBuffer` also decodes JPEG,
// and measuring a JPEG safely turned out to be a losing game: the size can be
// restated by a hierarchical frame header, or left at zero in the frame header
// and supplied by a define-number-of-lines segment after the first scan, and a
// walk over the segments can be pushed onto an attacker-chosen offset by bytes
// that are not markers at all. Each is legal JPEG. Rejecting the format costs
// an icon on the rare site that serves one; parsing it costs a guarantee.
//
// PNG has none of that: the size is two fixed-width fields at a fixed offset,
// stated once.
//
// No Electron imports: this file is unit tested under `node --test`.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The IHDR is required to be the first chunk and to be 13 bytes long, so the
// chunk length and type are constants. Checking them is what makes this a
// measurement of a PNG rather than of any 24 bytes that open with the
// signature -- a gate has to prove its input is what it claims.
const IHDR_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const IHDR_WIDTH_AT = 16;
const IHDR_HEIGHT_AT = 20;
const PNG_HEADER_BYTES = 24;

function imageDimensions(bytes) {
  if (bytes.length < PNG_HEADER_BYTES) return null;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (!bytes.subarray(8, 16).equals(IHDR_HEADER)) return null;

  const width = bytes.readUInt32BE(IHDR_WIDTH_AT);
  const height = bytes.readUInt32BE(IHDR_HEIGHT_AT);
  // Zero is not a legal PNG dimension, and "0 x 0" would sail under any limit.
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// An image whose dimensions cannot be read is refused along with one that is
// too large. Treating "cannot tell" as "small enough" is how every one of the
// bypasses above worked.
function imageTooLarge(bytes, maxEdge) {
  const size = imageDimensions(bytes);
  return !size || size.width > maxEdge || size.height > maxEdge;
}

module.exports = { imageDimensions, imageTooLarge };
