'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROFILE_KEYS,
  buildCalibrationFile,
  parseCalibrationFile,
  validateCalibrationFile,
} = require('../lib/calibration-file');

function analysis(overrides = {}) {
  return {
    eye: 'right',
    // Sized for the 3664x1920 Quest 3S display below: the right eye starts at
    // x=1832, so 1900+1600 stays inside the panel. A Quest 3 crop here would
    // run off the end, which is exactly what validation is for.
    crop: '1600:900:1900:500',
    rect: { x: 1900, y: 500, width: 1600, height: 900 },
    angleDegrees: null,
    maskIntrusionFraction: 0,
    eyeCoverage: 0.87,
    rotatedSample: { width: 2039, height: 1606 },
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildCalibrationFile({
    model: 'Quest 3S',
    deviceId: 'quest3s',
    displaySize: { width: 3664, height: 1920 },
    eyeSize: { width: 1832, height: 1920 },
    capturedAt: '2026-08-28T00:00:00.000Z',
    maskedFraction: 0.164,
    profiles: { widescreenRight: analysis() },
    angleSweep: [-22, 0, 22],
    ...overrides,
  });
}

test('a run without a confirmed angle is provisional, however clean the crops', () => {
  // The mask can be derived from a frame; the panel cant cannot. A file that
  // called itself measured on crop quality alone would be claiming a physical
  // check nobody performed.
  const file = build();
  assert.equal(file.calibration, 'provisional');
  assert.equal(file.profiles.widescreenRight.angleDegrees, null);
  assert.deepEqual(validateCalibrationFile(file), file);
});

test('recording a confirmed angle promotes the run to measured', () => {
  const file = build({
    profiles: { widescreenRight: analysis({ angleDegrees: -22 }) },
    angleConfirmed: true,
  });
  assert.equal(file.calibration, 'measured');
  assert.deepEqual(validateCalibrationFile(file), file);
});

test('a measured claim with no angle recorded is rejected', () => {
  const file = build({ angleConfirmed: true });
  assert.throws(() => validateCalibrationFile(file),
    /measured but widescreenRight has no confirmed angle/);
});

test('unmeasured profiles are recorded as null rather than omitted', () => {
  const file = build();
  for (const key of PROFILE_KEYS) {
    assert.ok(key in file.profiles, `${key} must be present`);
  }
  assert.equal(file.profiles.squareLeft, null);
});

test('a calibration with nothing usable is refused', () => {
  assert.throws(() => build({ profiles: {} }), /no usable crop/);
  assert.throws(() => build({ profiles: { widescreenRight: { crop: null } } }), /no usable crop/);
});

test('a crop outside the display is caught at load', () => {
  // The failure this guards against does not error at stream time -- it casts
  // the wrong region, or a region that is partly off-panel.
  const file = build();
  file.profiles.widescreenRight.crop = '1600:900:3000:500';
  assert.throws(() => validateCalibrationFile(file), /crops outside the display/);
});

test('malformed files are rejected with the reason', () => {
  assert.throws(() => validateCalibrationFile(null), /must be an object/);
  assert.throws(() => validateCalibrationFile({ schemaVersion: 99 }), /schema version 99/);
  assert.throws(() => validateCalibrationFile({ ...build(), calibration: 'excellent' }),
    /Unknown calibration tier/);
  assert.throws(() => validateCalibrationFile({ ...build(), calibration: 'uncalibrated' }),
    /records no measurement/);
  assert.throws(() => validateCalibrationFile({ ...build(), capturedAt: '' }),
    /when it was captured/);

  const badCrop = build();
  badCrop.profiles.widescreenRight.crop = '1600x900';
  assert.throws(() => validateCalibrationFile(badCrop), /invalid crop/);

  const badEye = build();
  badEye.profiles.widescreenRight.eye = 'both';
  assert.throws(() => validateCalibrationFile(badEye), /must name the eye/);

  const badAngle = build();
  badAngle.profiles.widescreenRight.angleDegrees = 400;
  assert.throws(() => validateCalibrationFile(badAngle), /implausible presentation angle/);
});

test('geometry is required and must be positive', () => {
  assert.throws(() => build({ displaySize: { width: 0, height: 1920 } }), /Display size/);
  assert.throws(() => build({ eyeSize: null }), /Eye size/);
  assert.throws(() => build({ capturedAt: null }), /capture timestamp/);
});

test('a calibration round-trips through JSON', () => {
  const file = build({
    profiles: { widescreenRight: analysis({ angleDegrees: -22 }) },
    angleConfirmed: true,
  });
  assert.deepEqual(parseCalibrationFile(JSON.stringify(file)), file);
  assert.throws(() => parseCalibrationFile('{not json'), /not valid JSON/);
});
