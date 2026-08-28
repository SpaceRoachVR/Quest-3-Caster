'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CALIBRATED_PROFILE_IDS,
  buildCalibratedMicrophoneArguments,
  buildCalibratedPrimaryArguments,
  getCalibratedProfileAvailability,
  isCalibratedProfileId,
  normalizeCalibratedStreamRequest,
  resolveCalibratedProfile,
} = require('../lib/calibrated-profiles');

// The real Quest 3S calibration measured by the wizard, trimmed to what these
// tests need. Using the measured numbers rather than invented ones means the
// arguments asserted here are the arguments the headset actually gets.
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
      widescreenLeft: {
        crop: '1656:932:70:458', eye: 'left', angleDegrees: null,
        output: { width: 1656, height: 932 },
      },
      widescreenRight: {
        crop: '1674:942:1930:452', eye: 'right', angleDegrees: null,
        output: { width: 1674, height: 942 },
      },
      squareLeft: {
        crop: '1460:1460:168:194', eye: 'left', angleDegrees: null,
        output: { width: 1460, height: 1460 },
      },
      squareRight: {
        crop: '1454:1454:2040:196', eye: 'right', angleDegrees: null,
        output: { width: 1454, height: 1454 },
      },
    },
    angleSweep: [],
    notes: null,
    ...overrides,
  };
}

const request = {
  serial: '340YC20G7102BQ',
  profileId: 'calibratedWidescreenRight',
  streamMic: false,
};

test('the calibrated primary arguments match what was verified on hardware', () => {
  // This exact invocation was run against a Quest 3S and reported
  // "INFO: Texture: 1674x942" -- the crop size, confirming both that the
  // stream starts and that the readiness signal carries the geometry.
  const args = buildCalibratedPrimaryArguments(request, calibration());
  assert.deepEqual(args, [
    '-s', '340YC20G7102BQ',
    '--crop', '1674:942:1930:452',
    '--angle', '0',
    '-b', '40M',
    '--max-fps', '60',
    '--video-codec', 'h264',
    '--video-buffer=0',
    '--window-width', '1674',
    '--window-height', '942',
    '--window-title', 'Quest 3 Stream (Caster)',
    '--audio-source', 'playback',
    '--audio-dup',
  ]);
});

test('the window always matches the delivered crop', () => {
  // Same invariant the locked profiles carry: a window bigger than the output
  // makes SDL rescale the image before OBS captures it.
  for (const profileId of CALIBRATED_PROFILE_IDS) {
    const args = buildCalibratedPrimaryArguments({ ...request, profileId }, calibration());
    const crop = args[args.indexOf('--crop') + 1];
    const [width, height] = crop.split(':').map(Number);
    assert.equal(args[args.indexOf('--window-width') + 1], String(width), profileId);
    assert.equal(args[args.indexOf('--window-height') + 1], String(height), profileId);
  }
});

test('a confirmed angle is passed through; an unconfirmed one streams unrotated', () => {
  const provisional = resolveCalibratedProfile(calibration(), 'calibratedWidescreenRight');
  assert.equal(provisional.angleDegrees, 0);
  assert.equal(provisional.angleConfirmed, false);

  const measured = calibration({ calibration: 'measured' });
  for (const key of Object.keys(measured.profiles)) {
    measured.profiles[key].angleDegrees = -22;
  }
  const resolved = resolveCalibratedProfile(measured, 'calibratedWidescreenRight');
  assert.equal(resolved.angleDegrees, -22);
  assert.equal(resolved.angleConfirmed, true);
  const args = buildCalibratedPrimaryArguments(request, measured);
  assert.equal(args[args.indexOf('--angle') + 1], '-22');
});

test('a profile the calibration never measured is unavailable, not guessed', () => {
  const partial = calibration();
  partial.profiles.squareLeft = null;
  const resolved = resolveCalibratedProfile(partial, 'calibratedSquareLeft');
  assert.equal(resolved.available, false);
  assert.match(resolved.reason, /no Calibrated 1:1 — left eye crop/);
  assert.throws(
    () => buildCalibratedPrimaryArguments({ ...request, profileId: 'calibratedSquareLeft' }, partial),
    /no Calibrated 1:1 — left eye crop/);
});

test('availability covers every profile and reports the tier', () => {
  const availability = getCalibratedProfileAvailability(calibration());
  assert.deepEqual(Object.keys(availability), [...CALIBRATED_PROFILE_IDS]);
  for (const profileId of CALIBRATED_PROFILE_IDS) {
    assert.equal(availability[profileId].available, true);
    assert.equal(availability[profileId].calibration, 'provisional');
    assert.equal(availability[profileId].angleConfirmed, false);
  }
  assert.deepEqual(availability.calibratedWidescreenRight.output,
    { width: 1674, height: 942 });
});

test('an invalid calibration makes every profile unavailable with the reason', () => {
  const broken = calibration();
  broken.profiles.widescreenRight.crop = '1674:942:3000:452';
  const availability = getCalibratedProfileAvailability(broken);
  assert.equal(availability.calibratedWidescreenRight.available, false);
  assert.match(availability.calibratedWidescreenRight.reason, /crops outside the display/);
});

test('the microphone stream uses the speech-tuned source at the raised bit rate', () => {
  assert.deepEqual(buildCalibratedMicrophoneArguments({ ...request, streamMic: true }), [
    '-s', '340YC20G7102BQ',
    '--port', '27190',
    '--no-video',
    '--no-control',
    '--audio-source', 'mic-voice-recognition',
    '--audio-codec', 'opus',
    '--audio-bit-rate=256K',
  ]);
});

test('requests are locked down the same way the native profiles are', () => {
  assert.throws(() => normalizeCalibratedStreamRequest({ ...request, crop: '1:1:0:0' }),
    /do not allow crop/);
  assert.throws(() => normalizeCalibratedStreamRequest({ ...request, profileId: 'obsLowLatency1080p60' }),
    /supported calibrated profile/);
  assert.throws(() => normalizeCalibratedStreamRequest({ ...request, streamMic: 'yes' }),
    /must be a boolean/);
  assert.throws(() => normalizeCalibratedStreamRequest({ ...request, serial: '' }),
    /valid ADB serial/);
  assert.throws(() => normalizeCalibratedStreamRequest(null), /request is required/);
});

test('calibrated and locked profile ids stay distinct', () => {
  const { isLockedProfileId } = require('../lib/locked-native-profiles');
  for (const profileId of CALIBRATED_PROFILE_IDS) {
    assert.equal(isCalibratedProfileId(profileId), true);
    assert.equal(isLockedProfileId(profileId), false,
      `${profileId} must not be mistaken for a locked profile`);
  }
  assert.equal(isCalibratedProfileId('obsLowLatency1080p60'), false);
});
