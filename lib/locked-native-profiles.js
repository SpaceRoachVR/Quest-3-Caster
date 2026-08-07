'use strict';

const { validateAdbSerial } = require('./stream-config');

const LOCKED_PROFILE_IDS = Object.freeze([
  'obsLowLatency1080p60',
  'obsStabilized1080p60',
  'obsLowLatencySquareLeft1080p60',
  'obsLowLatencySquareRight1080p60',
]);
const LOCKED_PROFILE_SET = new Set(LOCKED_PROFILE_IDS);
const ALLOWED_KEYS = new Set([
  'serial',
  'profileId',
  'streamMic',
]);

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is required.`);
  }
}

function isLockedProfileId(profileId) {
  return LOCKED_PROFILE_SET.has(profileId);
}

function normalizeLockedStreamRequest(request) {
  requirePlainObject(request, 'Locked stream request');
  for (const key of Object.keys(request)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Locked OBS profiles do not allow ${key}.`);
    }
  }
  if (!isLockedProfileId(request.profileId)) {
    throw new Error('A supported locked OBS profile is required.');
  }
  const serial = validateAdbSerial(request.serial);
  if (typeof request.streamMic !== 'boolean') {
    throw new Error('Microphone stream state must be a boolean.');
  }
  return Object.freeze({
    serial,
    profileId: request.profileId,
    streamMic: request.streamMic,
  });
}

function buildLockedPrimaryArguments(request, generation) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Generation must be a positive safe integer.');
  }
  const normalized = normalizeLockedStreamRequest(request);
  return [
    '-s',
    normalized.serial,
    `--q3c-profile=${normalized.profileId}`,
    `--q3c-generation=${generation}`,
    '--window-title', 'Quest 3 Stream (Caster)',
  ];
}

function buildLockedMicrophoneArguments(request, effectiveProfile) {
  const normalized = normalizeLockedStreamRequest(request);
  if (!isLockedProfileId(effectiveProfile)) {
    throw new Error('A supported effective OBS profile is required.');
  }
  const args = [
    '-s',
    normalized.serial,
    '--port',
    '27190',
    '--no-video',
    '--no-control',
    // MediaRecorder.AudioSource.MIC runs the Horizon OS echo-cancellation
    // chain. The headset speakers bleed into the microphone, so that chain
    // treats game audio as echo and its residual suppressor clamps the whole
    // channel -- the wearer's voice included -- for as long as the game is
    // loud. Measured at 8 to 16 dB of voice suppression during loud passages.
    // VOICE_RECOGNITION is tuned for speech and leaves echo cancellation and
    // automatic gain control disabled, so the voice survives.
    '--audio-source',
    'mic-voice-recognition',
    '--audio-codec',
    'opus',
  ];
  if (effectiveProfile === 'obsStabilized1080p60') {
    args.push('--audio-buffer=100');
  }
  return args;
}

module.exports = {
  LOCKED_PROFILE_IDS,
  buildLockedMicrophoneArguments,
  buildLockedPrimaryArguments,
  isLockedProfileId,
  normalizeLockedStreamRequest,
};
