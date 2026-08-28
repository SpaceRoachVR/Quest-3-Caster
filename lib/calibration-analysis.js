'use strict';

// The measurement half of headset calibration, as pure functions over a raw
// bitmap so it can be tested without a headset.
//
// The Quest composites each eye through a lens mask that leaves a large part
// of the display black, so a usable crop is bounded by the mask rather than by
// the eye rectangle. README describes doing this by hand -- flood-fill the
// mask out of a captured frame and measure the intrusion -- which is a
// per-model measurement someone has to own hardware to make. Automating it
// turns that into something any owner can run on their own headset, which is
// also strictly better data: it is per-unit rather than per-model.
//
// What is NOT automated here is the panel cant. README establishes the angle
// by sweeping `--angle` against the Quest menu, which is roll-locked to
// gravity, and judging by eye. Detecting that from a single frame means
// recovering a horizon from barrel-distorted content, and a wrong answer would
// silently tilt every cast. `buildAngleSweep` prepares the candidates for that
// judgement instead of pretending to make it.

const DEGREES_TO_RADIANS = Math.PI / 180;

function assertBitmap(bitmap) {
  if (!bitmap || typeof bitmap !== 'object') {
    throw new Error('A bitmap is required.');
  }
  const { width, height, data, channels } = bitmap;
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('Bitmap dimensions must be positive integers.');
  }
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 4) {
    throw new Error('Bitmap channels must be between 1 and 4.');
  }
  if (!data || typeof data.length !== 'number' || data.length < width * height * channels) {
    throw new Error('Bitmap data is smaller than its declared dimensions.');
  }
  return bitmap;
}

function luminanceAt(bitmap, x, y) {
  const { data, channels, width } = bitmap;
  const offset = (y * width + x) * channels;
  if (channels < 3) {
    return data[offset];
  }
  // Rec. 601 luma. The mask is pure black against lit content, so the exact
  // weighting does not matter much; what matters is not treating a saturated
  // blue as dark.
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

// The mask is the black region connected to the frame edge. Flood-filling from
// the border rather than thresholding the whole image matters: dark content
// inside the eye -- a night scene, a black menu panel -- is dark but not
// connected to the edge, and thresholding alone would carve it out of the crop.
function detectMask(bitmap, { threshold = 16 } = {}) {
  assertBitmap(bitmap);
  const { width, height } = bitmap;
  const masked = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  function visit(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (masked[index]) return;
    if (luminanceAt(bitmap, x, y) > threshold) return;
    masked[index] = 1;
    queue[tail++] = index;
  }

  for (let x = 0; x < width; ++x) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; ++y) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = (index - x) / width;
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }

  let maskedCount = 0;
  for (let i = 0; i < masked.length; ++i) maskedCount += masked[i];
  return {
    width,
    height,
    masked,
    maskedFraction: maskedCount / (width * height),
  };
}

// Each eye is half the display. Returned as an explicit region so every later
// step works in display coordinates and crops come out ready for `--crop`.
function getEyeRegion(mask, eye) {
  if (eye !== 'left' && eye !== 'right') {
    throw new Error('Eye must be "left" or "right".');
  }
  const eyeWidth = Math.floor(mask.width / 2);
  return {
    eye,
    x: eye === 'left' ? 0 : mask.width - eyeWidth,
    y: 0,
    width: eyeWidth,
    height: mask.height,
  };
}

function isClear(mask, x, y) {
  return mask.masked[y * mask.width + x] === 0;
}

// How wide a sample a crop actually reads once the presentation angle rotates
// it. A crop of w x h rotated by t samples w*cos(t) + h*sin(t) horizontally,
// and the rotation pulls in real pixels from outside the crop -- which is only
// true while that sample stays inside one eye. Past that it drags in a sliver
// of the other eye at one corner and off-display black at the opposite one.
function getRotatedSample(size, angleDegrees) {
  const radians = Math.abs(angleDegrees) * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    width: size.width * cos + size.height * sin,
    height: size.width * sin + size.height * cos,
  };
}

function fitsInsideEye(size, eyeRegion, angleDegrees) {
  const sample = getRotatedSample(size, angleDegrees);
  return sample.width <= eyeRegion.width && sample.height <= eyeRegion.height;
}

function alignDown(value, alignment) {
  return Math.floor(value / alignment) * alignment;
}

// Largest axis-aligned rectangle of a given aspect ratio that is entirely
// clear of the mask, centred on the eye's clear region. Grown by bisection on
// the half-height rather than scanned exhaustively: the clear region is a
// single convex-ish blob, so a rectangle that fits at one size fits at every
// smaller size about the same centre, and bisection converges in ~12 steps
// instead of testing every candidate.
function findLargestClearRect(mask, eyeRegion, {
  aspectWidth,
  aspectHeight,
  angleDegrees = 0,
  alignment = 2,
} = {}) {
  if (!Number.isFinite(aspectWidth) || !Number.isFinite(aspectHeight)
    || aspectWidth <= 0 || aspectHeight <= 0) {
    throw new Error('A positive aspect ratio is required.');
  }
  const centre = findClearCentre(mask, eyeRegion);
  if (!centre) {
    return null;
  }

  function rectAt(halfHeight) {
    const height = Math.max(alignment, alignDown(halfHeight * 2, alignment));
    const width = Math.max(alignment,
      alignDown(height * (aspectWidth / aspectHeight), alignment));
    const x = alignDown(centre.x - width / 2, alignment);
    const y = alignDown(centre.y - height / 2, alignment);
    return { x, y, width, height };
  }

  function isUsable(rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.x < eyeRegion.x || rect.y < eyeRegion.y) return false;
    if (rect.x + rect.width > eyeRegion.x + eyeRegion.width) return false;
    if (rect.y + rect.height > eyeRegion.y + eyeRegion.height) return false;
    if (!fitsInsideEye(rect, eyeRegion, angleDegrees)) return false;
    return isRectClear(mask, rect);
  }

  let low = 0;
  let high = Math.max(eyeRegion.width, eyeRegion.height);
  let best = null;
  for (let step = 0; step < 24 && high - low > 0.5; ++step) {
    const mid = (low + high) / 2;
    const rect = rectAt(mid);
    if (isUsable(rect)) {
      best = rect;
      low = mid;
    } else {
      high = mid;
    }
  }
  return best;
}

// The centre of the eye's clear region, not the centre of the eye rectangle.
// The lens mask is not necessarily symmetric within its half of the display,
// and centring on the rectangle would bias the crop into the mask on one side.
function findClearCentre(mask, eyeRegion) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = eyeRegion.y; y < eyeRegion.y + eyeRegion.height; ++y) {
    for (let x = eyeRegion.x; x < eyeRegion.x + eyeRegion.width; ++x) {
      if (isClear(mask, x, y)) {
        sumX += x;
        sumY += y;
        ++count;
      }
    }
  }
  if (count === 0) {
    return null;
  }
  return { x: sumX / count, y: sumY / count, clearPixels: count };
}

function isRectClear(mask, rect) {
  for (let y = rect.y; y < rect.y + rect.height; ++y) {
    for (let x = rect.x; x < rect.x + rect.width; ++x) {
      if (!isClear(mask, x, y)) {
        return false;
      }
    }
  }
  return true;
}

function formatCrop(rect) {
  return `${rect.width}:${rect.height}:${rect.x}:${rect.y}`;
}

// How much of the rectangle the mask eats. Zero is the goal; README reports
// 0.00% for the shipping 1:1 crops and treats any intrusion as a failed crop.
function measureMaskIntrusion(mask, rect) {
  let intruding = 0;
  for (let y = rect.y; y < rect.y + rect.height; ++y) {
    for (let x = rect.x; x < rect.x + rect.width; ++x) {
      if (!isClear(mask, x, y)) ++intruding;
    }
  }
  const area = rect.width * rect.height;
  return { intruding, area, fraction: area === 0 ? 1 : intruding / area };
}

// Candidate angles for the physical sweep. The operator judges these against
// the Quest menu, which is roll-locked to gravity and therefore a valid
// horizontal reference; the crop is recomputed per angle because a larger
// angle samples wider and so caps the crop harder.
function buildAngleSweep({ from = -30, to = 30, step = 2 } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0) {
    throw new Error('An angle sweep needs finite bounds and a positive step.');
  }
  if (from > to) {
    throw new Error('Angle sweep bounds are reversed.');
  }
  const angles = [];
  for (let angle = from; angle <= to + 1e-9; angle += step) {
    angles.push(Number(angle.toFixed(3)));
  }
  return angles;
}

// One eye, one aspect ratio, at one angle: the crop, what it costs, and
// whether it is usable at all. `angleDegrees` matters because the rotation
// ceiling shrinks the crop as the angle grows.
function analyzeEye(mask, eye, {
  aspectWidth,
  aspectHeight,
  angleDegrees = 0,
  alignment = 2,
} = {}) {
  const eyeRegion = getEyeRegion(mask, eye);
  const rect = findLargestClearRect(mask, eyeRegion, {
    aspectWidth, aspectHeight, angleDegrees, alignment,
  });
  if (!rect) {
    return {
      eye,
      angleDegrees,
      crop: null,
      rect: null,
      usable: false,
      reason: 'No clear rectangle of this aspect ratio fits inside the lens mask.',
    };
  }
  const sample = getRotatedSample(rect, angleDegrees);
  const intrusion = measureMaskIntrusion(mask, rect);
  return {
    eye,
    angleDegrees,
    crop: formatCrop(rect),
    rect,
    usable: intrusion.intruding === 0,
    reason: intrusion.intruding === 0 ? null
      : `${intrusion.intruding} pixels of lens mask intrude on the crop.`,
    maskIntrusionFraction: intrusion.fraction,
    rotatedSample: {
      width: Math.round(sample.width * 100) / 100,
      height: Math.round(sample.height * 100) / 100,
    },
    eyeCoverage: rect.width / eyeRegion.width,
  };
}

module.exports = {
  analyzeEye,
  assertBitmap,
  buildAngleSweep,
  detectMask,
  findClearCentre,
  findLargestClearRect,
  formatCrop,
  getEyeRegion,
  getRotatedSample,
  fitsInsideEye,
  measureMaskIntrusion,
};
