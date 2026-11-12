'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateAdbSerial } = require('../lib/stream-config');
const { connectWirelessTarget } = require('../lib/wireless-adb');
const { classifyAdbState } = require('../lib/native-preflight');
const { buildCalibrationFile, validateCalibrationFile } = require('../lib/calibration-file');

test('validateAdbSerial accepts hardware serials and in-range IPv4 endpoints', () => {
  assert.equal(validateAdbSerial('2G0YC1ZFCK04Q7'), '2G0YC1ZFCK04Q7');
  assert.equal(validateAdbSerial('192.168.1.20:5555'), '192.168.1.20:5555');
});

test('validateAdbSerial rejects option-like, padded, oversized and non-string serials', () => {
  const rejected = [
    '', null, undefined, 42, ' abc', 'abc ', '-s', 'a;b', 'abc\n', 'a b',
    '[::1]:5555', 'x'.repeat(256),
  ];
  for (const serial of rejected) {
    assert.throws(() => validateAdbSerial(serial), /valid ADB serial/, String(serial));
  }
});

test('validateAdbSerial rejects malformed IPv4 endpoints instead of treating them as serials', () => {
  const rejected = [
    '192.168.1.20:555555', // six-digit port
    '192.168.1.20:0',
    '192.168.1.20:65536',
    '192.168.1.256:5555',
    '1.2.3.4.5:5555', // fifth octet
    '192.168.1.20:',
    '1.2.3:5555',
  ];
  for (const serial of rejected) {
    assert.throws(() => validateAdbSerial(serial), /valid ADB serial/, serial);
  }
});

test('connectWirelessTarget rejects non-IPv4 targets before running adb', async () => {
  const calls = [];
  const runAdb = async (args) => {
    calls.push(args);
    return { success: true, stdout: '', stderr: '', error: null };
  };
  const rejected = [
    'undefined:5555', 'abc:def', 'evil.example.com:5555', '1.2.3.4:5555:1',
    '192.168.1.77', '2G0YC1ZFCK04Q7',
  ];
  for (const target of rejected) {
    await assert.rejects(connectWirelessTarget({ target, runAdb }), /wireless ADB target/, target);
  }
  assert.deepEqual(calls, []);
});

test('classifyAdbState ignores adb daemon banner lines', () => {
  const stdout = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    '',
  ].join('\r\n');
  assert.equal(classifyAdbState({ success: true, stdout }).code, 'no_device');

  const withDevice = `${stdout}ABC\tdevice\r\n`;
  const state = classifyAdbState({ success: true, stdout: withDevice });
  assert.equal(state.available, true);
});

function calibrationFile() {
  return buildCalibrationFile({
    model: 'Quest 3S',
    deviceId: 'quest3s',
    displaySize: { width: 3664, height: 1920 },
    eyeSize: { width: 1832, height: 1920 },
    capturedAt: '2026-08-28T00:00:00.000Z',
    maskedFraction: 0.164,
    profiles: {
      widescreenRight: {
        eye: 'right',
        crop: '1600:900:1900:500',
        rect: { x: 1900, y: 500, width: 1600, height: 900 },
        angleDegrees: null,
      },
    },
    angleSweep: [],
  });
}

test('a calibration profile without a usable output size fails at load', () => {
  const missing = calibrationFile();
  delete missing.profiles.widescreenRight.output;
  assert.throws(() => validateCalibrationFile(missing), /widescreenRight output must be a positive width and height/);

  const nonNumeric = calibrationFile();
  nonNumeric.profiles.widescreenRight.output = { width: '1600', height: 900 };
  assert.throws(() => validateCalibrationFile(nonNumeric), /widescreenRight output/);
});

test('a calibration profile with an empty crop fails at load', () => {
  const file = calibrationFile();
  file.profiles.widescreenRight.crop = '0:0:0:0';
  assert.throws(() => validateCalibrationFile(file), /empty crop/);
});
