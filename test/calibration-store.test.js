'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertCalibrationMatchesDisplay,
  calibrationFileName,
  loadCalibration,
  saveCalibration,
} = require('../lib/calibration-store');

function calibration(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt: '2026-08-28T00:00:00.000Z',
    calibration: 'provisional',
    device: {
      id: 'quest3s',
      model: 'Quest 3S',
      display: { width: 3664, height: 1920 },
      eye: { width: 1832, height: 1920 },
    },
    mask: { maskedFraction: 0.1645 },
    profiles: {
      widescreenLeft: null,
      widescreenRight: {
        crop: '1674:942:1930:452', eye: 'right', angleDegrees: null,
        output: { width: 1674, height: 942 },
      },
      squareLeft: null,
      squareRight: null,
    },
    angleSweep: [],
    notes: null,
    ...overrides,
  };
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-calibration-'));
}

test('a user calibration outranks a shipped one', () => {
  // A calibration is measured on one physical headset, so the user's own
  // measurement of their own hardware beats anything bundled with the app.
  const userDirectory = tempDirectory();
  const shippedDirectory = tempDirectory();
  saveCalibration(userDirectory, 'quest3s', calibration({ notes: 'mine' }));
  saveCalibration(shippedDirectory, 'quest3s', calibration({ notes: 'shipped' }));

  const found = loadCalibration('quest3s', [userDirectory, shippedDirectory]);
  assert.equal(found.calibration.notes, 'mine');
  assert.equal(found.path, path.join(userDirectory, 'quest3s.json'));
});

test('a shipped calibration is used when the user has none', () => {
  const userDirectory = tempDirectory();
  const shippedDirectory = tempDirectory();
  saveCalibration(shippedDirectory, 'quest3s', calibration({ notes: 'shipped' }));
  assert.equal(
    loadCalibration('quest3s', [userDirectory, shippedDirectory]).calibration.notes, 'shipped');
});

test('no calibration anywhere is null, not an error', () => {
  // "Never measured" is an ordinary state that preflight explains; it is not
  // a failure the user has to fix.
  assert.equal(loadCalibration('quest3s', [tempDirectory()]), null);
  assert.equal(loadCalibration('quest3s', []), null);
  assert.equal(loadCalibration('quest3s', null), null);
});

test('a corrupt calibration is reported rather than silently skipped', () => {
  // Falling through to "uncalibrated" after someone measured their headset
  // looks like the wizard did not work.
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'quest3s.json'), '{ truncated');
  assert.throws(() => loadCalibration('quest3s', [directory]), (error) => {
    assert.equal(error.code, 'calibration_invalid');
    assert.match(error.message, /unusable/);
    return true;
  });
});

test('a calibration that fails validation is reported with its reason', () => {
  const directory = tempDirectory();
  const broken = calibration();
  broken.profiles.widescreenRight.crop = '1674:942:3000:452';
  fs.writeFileSync(path.join(directory, 'quest3s.json'), JSON.stringify(broken));
  assert.throws(() => loadCalibration('quest3s', [directory]), /crops outside the display/);
});

test('a calibration measured on another display size is refused', () => {
  // The crops are absolute display coordinates, so applying them to a
  // different geometry frames the wrong region rather than erroring at launch.
  assert.throws(
    () => assertCalibrationMatchesDisplay(calibration(), { width: 4128, height: 2208 }),
    (error) => {
      assert.equal(error.code, 'calibration_geometry_mismatch');
      assert.match(error.message, /measured on a 3664x1920 display/);
      assert.match(error.message, /reports 4128x2208/);
      return true;
    });
  assert.throws(() => assertCalibrationMatchesDisplay(calibration(), null),
    /nothing usable/);
  assert.deepEqual(
    assertCalibrationMatchesDisplay(calibration(), { width: 3664, height: 1920 }),
    calibration());
});

test('device ids cannot escape the calibration directory', () => {
  for (const deviceId of ['../secrets', 'quest3s/../..', '', null, 'a'.repeat(65), 'q u e s t']) {
    assert.throws(() => calibrationFileName(deviceId), /short alphanumeric name/);
  }
  assert.equal(calibrationFileName('quest3s'), 'quest3s.json');
});
