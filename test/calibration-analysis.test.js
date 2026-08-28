'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeEye,
  buildAngleSweep,
  detectMask,
  findClearCentre,
  findLargestClearRect,
  formatCrop,
  getEyeRegion,
  getRotatedSample,
  fitsInsideEye,
  measureMaskIntrusion,
} = require('../lib/calibration-analysis');

// A stand-in for a captured display frame: two eyes side by side, each lit
// through a rounded lens aperture, everything outside the aperture black.
// Scaled down from a real Quest frame so the tests stay fast, with the same
// shape -- which is what the mask detection actually keys on.
function buildSyntheticFrame({
  width = 516,
  height = 276,
  radiusScale = 0.92,
  channels = 3,
  darkPatch = null,
} = {}) {
  const data = Buffer.alloc(width * height * channels);
  const eyeWidth = Math.floor(width / 2);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const eyeIndex = x < eyeWidth ? 0 : 1;
      const centreX = eyeIndex === 0 ? eyeWidth / 2 : eyeWidth + eyeWidth / 2;
      const centreY = height / 2;
      const normalizedX = (x - centreX) / (eyeWidth / 2);
      const normalizedY = (y - centreY) / (height / 2);
      const inside = (normalizedX * normalizedX + normalizedY * normalizedY)
        <= radiusScale * radiusScale;
      const offset = (y * width + x) * channels;
      if (inside) {
        data[offset] = 180;
        data[offset + 1] = 190;
        data[offset + 2] = 200;
        if (channels === 4) data[offset + 3] = 255;
      } else if (channels === 4) {
        data[offset + 3] = 255;
      }
    }
  }
  if (darkPatch) {
    for (let y = darkPatch.y; y < darkPatch.y + darkPatch.height; ++y) {
      for (let x = darkPatch.x; x < darkPatch.x + darkPatch.width; ++x) {
        const offset = (y * width + x) * channels;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
  }
  return { width, height, channels, data };
}

test('the rotated sample matches the widths README measured on hardware', () => {
  // README derives the crop ceiling from w*cos(t) + h*sin(t) and reports the
  // sample width for each shipping crop. Reproducing those numbers is what
  // makes this function trustworthy for a headset nobody has measured yet.
  const at22 = (width, height) => Math.round(getRotatedSample({ width, height }, 22).width);
  assert.equal(at22(1792, 1008), 2039);   // Low Latency
  assert.equal(at22(1488, 1488), 1937);   // 1:1 left and right
  assert.equal(at22(1808, 1016), 2057);   // Stabilized, as documented
  assert.equal(at22(1920, 1080), 2185);   // the crop README warns against
});

test('the shipped Stabilized crop overruns a Quest 3 eye', () => {
  // profile.c ships 2064:1160 for Stabilized, which samples well past the
  // 2064px eye and pulls the other eye into a corner. Kept as a test so the
  // discrepancy is visible rather than living only in a code comment.
  const eye = { x: 2064, y: 0, width: 2064, height: 2208 };
  assert.equal(fitsInsideEye({ width: 2064, height: 1160 }, eye, 22), false);
  assert.equal(fitsInsideEye({ width: 1808, height: 1016 }, eye, 22), true);
  assert.equal(fitsInsideEye({ width: 1792, height: 1008 }, eye, 22), true);
});

test('the angle sweep covers the requested range inclusively', () => {
  assert.deepEqual(buildAngleSweep({ from: -4, to: 4, step: 2 }), [-4, -2, 0, 2, 4]);
  assert.equal(buildAngleSweep().length, 31);
  assert.ok(buildAngleSweep().includes(-22));
  assert.throws(() => buildAngleSweep({ from: 10, to: -10 }), /reversed/);
  assert.throws(() => buildAngleSweep({ step: 0 }), /positive step/);
});

test('mask detection finds the lens aperture and leaves the lit region clear', () => {
  const mask = detectMask(buildSyntheticFrame());
  assert.ok(mask.maskedFraction > 0.1 && mask.maskedFraction < 0.4,
    `masked fraction ${mask.maskedFraction} is not aperture-shaped`);
  // Dead centre of each eye is inside the aperture.
  assert.equal(mask.masked[Math.floor(mask.height / 2) * mask.width + 129], 0);
  assert.equal(mask.masked[Math.floor(mask.height / 2) * mask.width + 387], 0);
  // The display corners are mask.
  assert.equal(mask.masked[0], 1);
  assert.equal(mask.masked[mask.width - 1], 1);
});

test('dark content inside the eye is not mistaken for lens mask', () => {
  // A night scene or a black menu panel is dark but not connected to the
  // frame edge. Thresholding alone would carve it out of the crop; the
  // flood fill from the border must leave it clear.
  const patch = { x: 110, y: 130, width: 40, height: 20 };
  const mask = detectMask(buildSyntheticFrame({ darkPatch: patch }));
  const centreIndex = (patch.y + 10) * mask.width + (patch.x + 20);
  assert.equal(mask.masked[centreIndex], 0);
});

test('each eye yields a mask-free 16:9 crop covering most of the eye', () => {
  const mask = detectMask(buildSyntheticFrame());
  for (const eye of ['left', 'right']) {
    const result = analyzeEye(mask, eye, { aspectWidth: 16, aspectHeight: 9 });
    assert.equal(result.usable, true, `${eye}: ${result.reason}`);
    assert.equal(result.maskIntrusionFraction, 0);
    assert.ok(result.eyeCoverage > 0.6,
      `${eye}: covers only ${(result.eyeCoverage * 100).toFixed(1)}% of the eye`);
    assert.match(result.crop, /^\d+:\d+:\d+:\d+$/);
  }
});

test('a crop stays inside its own eye', () => {
  const mask = detectMask(buildSyntheticFrame());
  const eyeWidth = Math.floor(mask.width / 2);
  const left = analyzeEye(mask, 'left', { aspectWidth: 1, aspectHeight: 1 });
  const right = analyzeEye(mask, 'right', { aspectWidth: 1, aspectHeight: 1 });
  assert.ok(left.rect.x + left.rect.width <= eyeWidth,
    'the left crop must not cross into the right eye');
  assert.ok(right.rect.x >= eyeWidth,
    'the right crop must not cross into the left eye');
});

test('a larger presentation angle shrinks the crop it allows', () => {
  // Isolated from the mask on purpose: an aperture wide enough to fill the eye
  // leaves the rotation ceiling as the only binding constraint, which is the
  // thing under test. On a real frame whichever limit is tighter wins, and on
  // a small synthetic aperture that is the mask.
  const mask = detectMask(buildSyntheticFrame({ radiusScale: 4 }));
  assert.equal(mask.maskedFraction, 0, 'this frame is meant to be mask-free');
  const straight = analyzeEye(mask, 'right', {
    aspectWidth: 16, aspectHeight: 9, angleDegrees: 0,
  });
  const canted = analyzeEye(mask, 'right', {
    aspectWidth: 16, aspectHeight: 9, angleDegrees: 22,
  });
  assert.ok(canted.rect.width < straight.rect.width,
    `angled crop ${canted.rect.width} should be narrower than ${straight.rect.width}`);
  assert.ok(canted.rotatedSample.width <= Math.floor(mask.width / 2),
    'the rotated sample must stay inside one eye');
});

test('the mask binds instead when it is tighter than the rotation ceiling', () => {
  // Both limits are real and either can dominate. A narrow aperture caps the
  // crop before the angle does, and the result must still be mask-free.
  const mask = detectMask(buildSyntheticFrame({ radiusScale: 0.6 }));
  const result = analyzeEye(mask, 'right', {
    aspectWidth: 16, aspectHeight: 9, angleDegrees: 22,
  });
  assert.equal(result.usable, true, result.reason);
  assert.equal(result.maskIntrusionFraction, 0);
  assert.ok(result.rotatedSample.width < Math.floor(mask.width / 2),
    'the mask, not the ceiling, is what limited this crop');
});

test('crop values are encoder-aligned', () => {
  const mask = detectMask(buildSyntheticFrame());
  const { rect } = analyzeEye(mask, 'left', { aspectWidth: 16, aspectHeight: 9, alignment: 4 });
  for (const value of [rect.width, rect.height, rect.x, rect.y]) {
    assert.equal(value % 4, 0, `${value} is not aligned to 4`);
  }
});

test('an entirely dark frame yields no crop rather than a bogus one', () => {
  const width = 64;
  const height = 32;
  const dark = { width, height, channels: 3, data: Buffer.alloc(width * height * 3) };
  const mask = detectMask(dark);
  assert.equal(mask.maskedFraction, 1);
  assert.equal(findClearCentre(mask, getEyeRegion(mask, 'left')), null);
  const result = analyzeEye(mask, 'left', { aspectWidth: 16, aspectHeight: 9 });
  assert.equal(result.usable, false);
  assert.equal(result.crop, null);
  assert.match(result.reason, /No clear rectangle/);
});

test('RGBA frames decode the same as RGB', () => {
  const rgb = analyzeEye(detectMask(buildSyntheticFrame({ channels: 3 })), 'left',
    { aspectWidth: 16, aspectHeight: 9 });
  const rgba = analyzeEye(detectMask(buildSyntheticFrame({ channels: 4 })), 'left',
    { aspectWidth: 16, aspectHeight: 9 });
  assert.equal(rgb.crop, rgba.crop);
});

test('helpers reject malformed input instead of reading past the buffer', () => {
  assert.throws(() => detectMask(null), /bitmap is required/i);
  assert.throws(() => detectMask({ width: 4, height: 4, channels: 3, data: Buffer.alloc(4) }),
    /smaller than its declared dimensions/);
  assert.throws(() => detectMask({ width: 0, height: 4, channels: 3, data: Buffer.alloc(48) }),
    /positive integers/);
  const mask = detectMask(buildSyntheticFrame());
  assert.throws(() => getEyeRegion(mask, 'middle'), /left.*right/);
  assert.throws(
    () => findLargestClearRect(mask, getEyeRegion(mask, 'left'), { aspectWidth: 0, aspectHeight: 9 }),
    /positive aspect ratio/);
});

test('crop formatting and intrusion measurement agree with scrcpy ordering', () => {
  assert.equal(formatCrop({ width: 1792, height: 1008, x: 2200, y: 600 }),
    '1792:1008:2200:600');
  const mask = detectMask(buildSyntheticFrame());
  const corner = measureMaskIntrusion(mask, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(corner.fraction, 1);
  assert.equal(corner.area, 100);
});
