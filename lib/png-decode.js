'use strict';

const zlib = require('node:zlib');

// A minimal PNG reader for `adb exec-out screencap -p`, which emits 8-bit
// non-interlaced RGB or RGBA. The app ships with no runtime dependencies and
// calibration is not a good reason to add an image library for one format we
// control the producer of, so this decodes exactly what screencap emits and
// refuses anything else rather than half-supporting it.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;
const MAX_PIXELS = 64 * 1024 * 1024;

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readChunks(buffer) {
  const chunks = [];
  let offset = SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`PNG chunk ${type} runs past the end of the file.`);
    }
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

// Undoes the per-scanline filters PNG applies before compression. Each row is
// prefixed with a filter byte and predicted from the row above and the pixel
// to the left, so this has to run in order and cannot be parallelised.
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.allocUnsafe(stride * height);
  let rawOffset = 0;
  for (let y = 0; y < height; ++y) {
    const filter = raw[rawOffset++];
    const rowStart = y * stride;
    const priorStart = (y - 1) * stride;
    for (let i = 0; i < stride; ++i) {
      const value = raw[rawOffset + i];
      const left = i >= channels ? out[rowStart + i - channels] : 0;
      const up = y > 0 ? out[priorStart + i] : 0;
      const upLeft = y > 0 && i >= channels ? out[priorStart + i - channels] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paethPredictor(left, up, upLeft); break;
        default: throw new Error(`Unsupported PNG row filter ${filter}.`);
      }
      out[rowStart + i] = restored & 0xff;
    }
    rawOffset += stride;
  }
  return out;
}

function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SIGNATURE.length
    || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error('Not a PNG file.');
  }
  const chunks = readChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!header || header.data.length < 13) {
    throw new Error('PNG is missing its IHDR chunk.');
  }
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];

  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new Error('PNG dimensions are out of range.');
  }
  if (bitDepth !== 8) {
    throw new Error(`Only 8-bit PNG is supported; this file is ${bitDepth}-bit.`);
  }
  if (colorType !== COLOR_TYPE_RGB && colorType !== COLOR_TYPE_RGBA) {
    throw new Error(`Only RGB and RGBA PNG are supported; colour type ${colorType} is not.`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNG is not supported.');
  }

  const compressed = Buffer.concat(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
  );
  if (compressed.length === 0) {
    throw new Error('PNG has no image data.');
  }
  const channels = colorType === COLOR_TYPE_RGBA ? 4 : 3;
  const raw = zlib.inflateSync(compressed);
  const expected = (width * channels + 1) * height;
  if (raw.length < expected) {
    throw new Error('PNG image data is truncated.');
  }
  return {
    width,
    height,
    channels,
    data: unfilter(raw, width, height, channels),
  };
}

// `adb exec-out` is meant to be binary-clean, but some adb builds on Windows
// still translate LF to CRLF on the way out and corrupt the PNG. The signature
// check catches it immediately rather than surfacing as a confusing inflate
// error, and undoing the translation recovers the image without asking the
// operator to reconfigure adb.
function decodeScreencapPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('screencap returned no data.');
  }
  try {
    return decodePng(buffer);
  } catch (error) {
    const repaired = unmangleCrLf(buffer);
    if (repaired.length === buffer.length) {
      throw error;
    }
    try {
      return decodePng(repaired);
    } catch (_repairError) {
      throw error;
    }
  }
}

function unmangleCrLf(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let written = 0;
  for (let i = 0; i < buffer.length; ++i) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) {
      continue;
    }
    out[written++] = buffer[i];
  }
  return out.subarray(0, written);
}

module.exports = { decodePng, decodeScreencapPng };
