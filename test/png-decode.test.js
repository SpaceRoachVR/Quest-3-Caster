'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { decodePng, decodeScreencapPng } = require('../lib/png-decode');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 as PNG specifies it. The decoder does not verify CRCs -- screencap is
// a local pipe, not a network -- but chunks still need well-formed lengths, so
// the fixtures are built the same way a real encoder builds them.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

// `filter` selects the PNG row filter so each predictor path gets exercised;
// pixels are generated rather than hand-written so a filter bug shows up as a
// mismatch against the source values.
function buildPng({ width, height, channels = 3, filter = 0, bitDepth = 8, interlace = 0 }) {
  const pixels = [];
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const base = [(x * 7 + y * 3) & 0xff, (x * 11) & 0xff, (y * 13) & 0xff];
      pixels.push(channels === 4 ? [...base, 255] : base);
    }
  }

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; ++y) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = filter;
    for (let i = 0; i < stride; ++i) {
      const pixel = pixels[y * width + Math.floor(i / channels)];
      const value = pixel[i % channels];
      const left = i >= channels ? pixels[y * width + Math.floor((i - channels) / channels)][i % channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * width + Math.floor(i / channels)][i % channels] : 0;
      const upLeft = y > 0 && i >= channels
        ? pixels[(y - 1) * width + Math.floor((i - channels) / channels)][i % channels] : 0;
      let encoded;
      switch (filter) {
        case 0: encoded = value; break;
        case 1: encoded = value - left; break;
        case 2: encoded = value - up; break;
        case 3: encoded = value - ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          encoded = value - predictor;
          break;
        }
        default: throw new Error('unsupported test filter');
      }
      raw[rowStart + 1 + i] = encoded & 0xff;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = channels === 4 ? 6 : 2;
  header[12] = interlace;

  return {
    png: Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
    pixels,
  };
}

test('decodes every PNG row filter screencap can emit', () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    const { png, pixels } = buildPng({ width: 9, height: 7, filter });
    const image = decodePng(png);
    assert.equal(image.width, 9);
    assert.equal(image.height, 7);
    assert.equal(image.channels, 3);
    for (let i = 0; i < pixels.length; ++i) {
      assert.deepEqual(
        [...image.data.subarray(i * 3, i * 3 + 3)],
        pixels[i],
        `filter ${filter}, pixel ${i}`);
    }
  }
});

test('decodes RGBA and reports four channels', () => {
  const { png, pixels } = buildPng({ width: 5, height: 4, channels: 4, filter: 4 });
  const image = decodePng(png);
  assert.equal(image.channels, 4);
  assert.deepEqual([...image.data.subarray(0, 4)], pixels[0]);
});

test('IDAT split across chunks is reassembled', () => {
  // Real encoders split large images across several IDAT chunks; a decoder
  // that reads only the first gets a truncated image rather than an error.
  const { png, pixels } = buildPng({ width: 6, height: 6 });
  const chunks = [];
  let offset = SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  const idat = chunks.find((entry) => entry.type === 'IDAT').data;
  const split = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', chunks.find((entry) => entry.type === 'IHDR').data),
    chunk('IDAT', idat.subarray(0, 5)),
    chunk('IDAT', idat.subarray(5)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const image = decodePng(split);
  assert.deepEqual([...image.data.subarray(0, 3)], pixels[0]);
});

test('unsupported and malformed files are refused rather than half-decoded', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/);
  assert.throws(() => decodePng(null), /Not a PNG/);
  assert.throws(() => decodePng(buildPng({ width: 4, height: 4, bitDepth: 16 }).png),
    /16-bit/);
  assert.throws(() => decodePng(buildPng({ width: 4, height: 4, interlace: 1 }).png),
    /Interlaced/);
  assert.throws(() => decodePng(Buffer.concat([SIGNATURE, chunk('IEND', Buffer.alloc(0))])),
    /missing its IHDR/);
});

test('a truncated chunk is reported instead of read past the buffer', () => {
  const { png } = buildPng({ width: 4, height: 4 });
  assert.throws(() => decodePng(png.subarray(0, png.length - 20)), /runs past the end|truncated/);
});

test('a CRLF-mangled screencap is repaired rather than reported as corrupt', () => {
  // Some adb builds on Windows translate LF to CRLF even through exec-out,
  // which corrupts the PNG. Undoing it beats telling the operator to go
  // reconfigure adb midway through a calibration run.
  const { png, pixels } = buildPng({ width: 8, height: 6, filter: 3 });
  const mangled = Buffer.from(
    [...png].flatMap((byte) => (byte === 0x0a ? [0x0d, 0x0a] : [byte])));
  assert.throws(() => decodePng(mangled));
  const image = decodeScreencapPng(mangled);
  assert.equal(image.width, 8);
  assert.deepEqual([...image.data.subarray(0, 3)], pixels[0]);
});

test('an intact screencap decodes without the repair path', () => {
  const { png, pixels } = buildPng({ width: 8, height: 6 });
  assert.deepEqual([...decodeScreencapPng(png).data.subarray(0, 3)], pixels[0]);
});

test('screencap output that is not a PNG at all reports the original failure', () => {
  assert.throws(() => decodeScreencapPng(Buffer.from('error: device offline')), /Not a PNG/);
  assert.throws(() => decodeScreencapPng(Buffer.alloc(0)), /no data/);
});
