'use strict';

const { CALIBRATION_TIERS } = require('./device-registry');

// What a calibration run produces, and what the app is willing to load back.
//
// A calibration file is a measurement, not a configuration: it says what was
// found on one headset at one moment, by what method, and how far it has been
// verified. The tier is the load-bearing field. A file straight out of the
// wizard is `provisional` no matter how clean the numbers look, because the
// mask can be derived from a frame but the panel cant cannot -- that still
// needs a human sweeping the angle against the roll-locked Quest menu. Only
// recording that judgement promotes a file to `measured`.
//
// Written by scripts/calibrate-device.js, and validated here so a hand-edited
// or truncated file fails loudly at load instead of quietly mis-framing a cast.

const SCHEMA_VERSION = 1;
const CROP_PATTERN = /^\d+:\d+:\d+:\d+$/;
const PROFILE_KEYS = Object.freeze([
  'widescreenLeft',
  'widescreenRight',
  'squareLeft',
  'squareRight',
]);

function isSize(value) {
  return Boolean(value)
    && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0;
}

function requireSize(value, label) {
  if (!isSize(value)) {
    throw new Error(`${label} must be a positive width and height.`);
  }
  return { width: value.width, height: value.height };
}

// A single measured framing. `angleDegrees` is null until somebody has done
// the physical sweep; a null angle is what keeps the file provisional.
function buildProfileEntry(analysis) {
  if (!analysis || !analysis.crop) {
    return null;
  }
  if (!CROP_PATTERN.test(analysis.crop)) {
    throw new Error(`Crop "${analysis.crop}" is not width:height:x:y.`);
  }
  return {
    crop: analysis.crop,
    eye: analysis.eye,
    angleDegrees: Number.isFinite(analysis.angleDegrees) ? analysis.angleDegrees : null,
    output: requireSize(
      { width: analysis.rect.width, height: analysis.rect.height },
      'Profile output',
    ),
    maskIntrusionFraction: analysis.maskIntrusionFraction ?? null,
    eyeCoverage: analysis.eyeCoverage ?? null,
    rotatedSample: analysis.rotatedSample ?? null,
  };
}

function buildCalibrationFile({
  model,
  deviceId,
  displaySize,
  eyeSize,
  capturedAt,
  maskedFraction,
  profiles,
  angleSweep,
  angleConfirmed = false,
  notes = null,
}) {
  if (typeof capturedAt !== 'string' || !capturedAt) {
    throw new Error('A capture timestamp is required.');
  }
  const entries = {};
  for (const key of PROFILE_KEYS) {
    entries[key] = profiles && profiles[key] ? buildProfileEntry(profiles[key]) : null;
  }
  const usable = PROFILE_KEYS.filter((key) => entries[key]);
  if (usable.length === 0) {
    throw new Error('A calibration with no usable crop is not worth writing.');
  }
  // Angle is the half that cannot be derived from a still frame, so a run that
  // has not had one confirmed is provisional however good the crops are.
  const tier = angleConfirmed ? 'measured' : 'provisional';
  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAt,
    calibration: tier,
    device: {
      id: typeof deviceId === 'string' && deviceId ? deviceId : 'unknown',
      model: typeof model === 'string' && model ? model : null,
      display: requireSize(displaySize, 'Display size'),
      eye: requireSize(eyeSize, 'Eye size'),
    },
    mask: {
      maskedFraction: Number.isFinite(maskedFraction) ? maskedFraction : null,
    },
    profiles: entries,
    angleSweep: Array.isArray(angleSweep) ? angleSweep.slice() : [],
    notes,
  };
}

function validateCalibrationFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error('A calibration file must be an object.');
  }
  if (file.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported calibration schema version ${file.schemaVersion}.`);
  }
  if (!CALIBRATION_TIERS.includes(file.calibration)) {
    throw new Error(`Unknown calibration tier "${file.calibration}".`);
  }
  if (file.calibration === 'uncalibrated') {
    throw new Error('An uncalibrated file records no measurement and cannot be loaded.');
  }
  if (typeof file.capturedAt !== 'string' || !file.capturedAt) {
    throw new Error('A calibration file must record when it was captured.');
  }
  if (!file.device || typeof file.device !== 'object') {
    throw new Error('A calibration file must identify its device.');
  }
  requireSize(file.device.display, 'Device display');
  requireSize(file.device.eye, 'Device eye');
  if (!file.profiles || typeof file.profiles !== 'object') {
    throw new Error('A calibration file must carry profiles.');
  }

  let usable = 0;
  for (const key of PROFILE_KEYS) {
    const entry = file.profiles[key];
    if (entry === null || entry === undefined) continue;
    if (!CROP_PATTERN.test(entry.crop || '')) {
      throw new Error(`Profile ${key} has an invalid crop.`);
    }
    if (entry.eye !== 'left' && entry.eye !== 'right') {
      throw new Error(`Profile ${key} must name the eye it crops.`);
    }
    // A crop that is not inside the display is the failure mode worth catching
    // here: it produces a cast rather than an error, just of the wrong region.
    const [width, height, x, y] = entry.crop.split(':').map(Number);
    if (x + width > file.device.display.width || y + height > file.device.display.height) {
      throw new Error(`Profile ${key} crops outside the display.`);
    }
    if (entry.angleDegrees !== null
      && (!Number.isFinite(entry.angleDegrees) || Math.abs(entry.angleDegrees) > 90)) {
      throw new Error(`Profile ${key} has an implausible presentation angle.`);
    }
    ++usable;
  }
  if (usable === 0) {
    throw new Error('A calibration file must contain at least one usable profile.');
  }
  // `measured` is a claim that somebody physically confirmed the angle. A file
  // making that claim with no angle recorded is self-contradictory.
  if (file.calibration === 'measured') {
    const missing = PROFILE_KEYS.filter(
      (key) => file.profiles[key] && file.profiles[key].angleDegrees === null,
    );
    if (missing.length > 0) {
      throw new Error(
        `Calibration claims to be measured but ${missing.join(', ')} has no confirmed angle.`);
    }
  }
  return file;
}

function parseCalibrationFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Calibration file is not valid JSON: ${error.message}`);
  }
  return validateCalibrationFile(parsed);
}

module.exports = {
  PROFILE_KEYS,
  SCHEMA_VERSION,
  buildCalibrationFile,
  buildProfileEntry,
  parseCalibrationFile,
  validateCalibrationFile,
};
