'use strict';

const { validateAdbSerial } = require('./stream-config');
const { validateCalibrationFile } = require('./calibration-file');

// Streaming from a calibration file instead of the baked-in native profiles.
//
// The locked profiles carry their crops inside profile.c, so they only fit the
// one headset those crops were measured on. A calibrated device supplies its
// own crop and angle and drives upstream scrcpy's `--crop` and `--angle`
// directly, which means a headset can be supported by measuring it rather than
// by rebuilding the native runtime.
//
// What this path gives up is the Q3C native event protocol -- no generation
// echo, no stabilization, no runtime fallback -- so readiness is confirmed
// from scrcpy's own output instead (see calibrated-startup.js). What it must
// not give up is the rule that a stream is never reported active until its
// geometry is confirmed.

const {
  CALIBRATED_PROFILE_IDS,
  isCalibratedProfileId,
} = require('./calibrated-profile-ids');

// Profile id to the key it reads out of a calibration file.
const PROFILE_SOURCE_KEYS = Object.freeze({
  calibratedWidescreenLeft: 'widescreenLeft',
  calibratedWidescreenRight: 'widescreenRight',
  calibratedSquareLeft: 'squareLeft',
  calibratedSquareRight: 'squareRight',
});

const PROFILE_NAMES = Object.freeze({
  calibratedWidescreenLeft: 'Calibrated 16:9 — left eye',
  calibratedWidescreenRight: 'Calibrated 16:9 — right eye',
  calibratedSquareLeft: 'Calibrated 1:1 — left eye',
  calibratedSquareRight: 'Calibrated 1:1 — right eye',
});

const ALLOWED_REQUEST_KEYS = new Set(['serial', 'profileId', 'streamMic']);

// Matches the locked profiles: H.264 at 40 Mbps/60 FPS with no video buffer.
// The bit rate and codec are not what calibration measures, so they stay the
// same across both paths rather than becoming a second thing to keep in step.
const VIDEO_BIT_RATE = '40M';
const MAX_FPS = '60';
const VIDEO_CODEC = 'h264';
const WINDOW_TITLE = 'Quest 3 Stream (Caster)';
const MICROPHONE_PORT = '27190';

function getCalibratedProfileName(profileId) {
  return PROFILE_NAMES[profileId] || null;
}

function normalizeCalibratedStreamRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Calibrated stream request is required.');
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new Error(`Calibrated profiles do not allow ${key}.`);
    }
  }
  if (!isCalibratedProfileId(request.profileId)) {
    throw new Error('A supported calibrated profile is required.');
  }
  if (typeof request.streamMic !== 'boolean') {
    throw new Error('Microphone stream state must be a boolean.');
  }
  return Object.freeze({
    serial: validateAdbSerial(request.serial),
    profileId: request.profileId,
    streamMic: request.streamMic,
  });
}

// The measured framing for one profile, or an explanation of why that profile
// is not available on this headset. A calibration legitimately covers only
// some profiles -- an eye whose mask leaves no clear 16:9 rectangle produces
// a null entry rather than a bad crop.
function resolveCalibratedProfile(calibration, profileId) {
  const validated = validateCalibrationFile(calibration);
  if (!isCalibratedProfileId(profileId)) {
    throw new Error('A supported calibrated profile is required.');
  }
  const entry = validated.profiles[PROFILE_SOURCE_KEYS[profileId]];
  if (!entry) {
    return {
      available: false,
      reason: `This headset's calibration has no ${getCalibratedProfileName(profileId)} crop.`,
      profileId,
    };
  }
  // A provisional calibration has no confirmed angle. Streaming it unrotated
  // is the honest default -- it is what was actually measured -- but the
  // caller has to be able to say so, which is what `angleConfirmed` is for.
  const angleConfirmed = entry.angleDegrees !== null;
  return {
    available: true,
    reason: null,
    profileId,
    crop: entry.crop,
    angleDegrees: angleConfirmed ? entry.angleDegrees : 0,
    angleConfirmed,
    output: Object.freeze({ width: entry.output.width, height: entry.output.height }),
    calibration: validated.calibration,
    eye: entry.eye,
  };
}

function buildCalibratedPrimaryArguments(request, calibration) {
  const normalized = normalizeCalibratedStreamRequest(request);
  const resolved = resolveCalibratedProfile(calibration, normalized.profileId);
  if (!resolved.available) {
    throw new Error(resolved.reason);
  }
  return [
    '-s', normalized.serial,
    '--crop', resolved.crop,
    '--angle', String(resolved.angleDegrees),
    '-b', VIDEO_BIT_RATE,
    '--max-fps', MAX_FPS,
    '--video-codec', VIDEO_CODEC,
    '--video-buffer=0',
    // The window must match the delivered size. SDL scales the decoded frame
    // to the window and OBS captures the window, so a larger window resamples
    // the image after the crop was chosen specifically to avoid that.
    '--window-width', String(resolved.output.width),
    '--window-height', String(resolved.output.height),
    '--window-title', WINDOW_TITLE,
    // Game audio, duplicated rather than taken, so sound keeps playing in the
    // headset while casting. The bundled server carries the patch that widens
    // playback capture to USAGE_GAME; upstream captures silence on a Quest.
    '--audio-source', 'playback',
    '--audio-dup',
  ];
}

// Same reasoning as the locked path: MIC runs the Horizon OS echo-cancellation
// chain, which treats game audio bleeding into the microphone as echo and
// clamps the wearer's voice with it. VOICE_RECOGNITION leaves that chain off.
function buildCalibratedMicrophoneArguments(request) {
  const normalized = normalizeCalibratedStreamRequest(request);
  return [
    '-s', normalized.serial,
    '--port', MICROPHONE_PORT,
    '--no-video',
    '--no-control',
    '--audio-source', 'mic-voice-recognition',
    '--audio-codec', 'opus',
    '--audio-bit-rate=256K',
  ];
}

// Availability for every calibrated profile, in a shape the renderer can use
// the same way it uses locked-profile availability.
function getCalibratedProfileAvailability(calibration) {
  const result = {};
  for (const profileId of CALIBRATED_PROFILE_IDS) {
    let resolved;
    try {
      resolved = resolveCalibratedProfile(calibration, profileId);
    } catch (error) {
      resolved = { available: false, reason: error.message, profileId };
    }
    result[profileId] = Object.freeze({
      available: resolved.available,
      reason: resolved.reason,
      name: getCalibratedProfileName(profileId),
      output: resolved.output || null,
      calibration: resolved.calibration || null,
      angleConfirmed: resolved.angleConfirmed === true,
      nominalDelayMs: 0,
    });
  }
  return Object.freeze(result);
}

module.exports = {
  CALIBRATED_PROFILE_IDS,
  PROFILE_SOURCE_KEYS,
  buildCalibratedMicrophoneArguments,
  buildCalibratedPrimaryArguments,
  getCalibratedProfileAvailability,
  getCalibratedProfileName,
  isCalibratedProfileId,
  normalizeCalibratedStreamRequest,
  resolveCalibratedProfile,
};
