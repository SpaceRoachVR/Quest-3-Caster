'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOCKED_PROFILE_IDS,
  buildLockedPrimaryArguments,
  buildLockedMicrophoneArguments,
  normalizeLockedStreamRequest,
} = require('../lib/locked-native-profiles');

test('locked profiles derive only trusted native arguments', () => {
  const request = normalizeLockedStreamRequest({
    serial: '192.168.1.10:5555',
    profileId: 'obsStabilized1080p60',
    streamMic: true,
  });
  assert.deepEqual(LOCKED_PROFILE_IDS, [
    'obsLowLatency1080p60',
    'obsStabilized1080p60',
    'obsLowLatencySquareLeft1080p60',
    'obsLowLatencySquareRight1080p60',
  ]);
  assert.deepEqual(buildLockedPrimaryArguments(request, 7), [
    '-s', '192.168.1.10:5555',
    '--q3c-profile=obsStabilized1080p60',
    '--q3c-generation=7',
    '--window-title', 'Quest 3 Stream (Caster)',
  ]);
  assert.deepEqual(buildLockedMicrophoneArguments(request, 'obsStabilized1080p60'), [
    '-s', '192.168.1.10:5555',
    '--port', '27190',
    '--no-video',
    '--no-control',
    // Not plain MIC: that source is echo-cancelled against the headset
    // speakers, which suppresses the wearer's voice while game audio is loud.
    '--audio-source', 'mic-voice-recognition',
    '--audio-codec', 'opus',
    // Above scrcpy's 128 kbps default: that default smears a close microphone
    // once the wearer raises their voice over loud game audio.
    '--audio-bit-rate=256K',
    '--audio-buffer=100',
  ]);
  assert.equal(
    buildLockedMicrophoneArguments(
      { ...request, profileId: 'obsLowLatency1080p60' },
      'obsLowLatency1080p60',
    ).includes('--audio-buffer=100'),
    false,
  );
});

test('locked requests reject every protected native override and unknown keys', () => {
  for (const field of [
    'bitRate', 'maxFps', 'crop', 'videoCodec', 'videoEncoder', 'maxSize',
    'displayBuffer', 'videoBuffer', 'audioBuffer', 'audioSource',
    'audioCodec', 'audioDup', 'noWindow', 'noPlayback', 'noVideo',
    'port', 'nativeArgs', 'micSource', 'renderDriver', 'displayId',
  ]) {
    assert.throws(
      () => normalizeLockedStreamRequest({
        serial: '1WMHH00000',
        profileId: 'obsLowLatency1080p60',
        streamMic: false,
        [field]: field === 'nativeArgs' ? [] : 0,
      }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => normalizeLockedStreamRequest({
      serial: '1WMHH00000',
      profileId: 'obsLowLatency1080p60',
      streamMic: false,
      unexpected: true,
    }),
    /unexpected/,
  );
});

test('legacy requests are not accepted as locked profiles', () => {
  assert.throws(
    () => normalizeLockedStreamRequest({
      serial: '1WMHH00000',
      profileId: 'custom',
      streamMic: false,
    }),
    /locked OBS profile/,
  );
});

test('accepts only the fixed left and right square-eye native profiles', () => {
  for (const profileId of [
    'obsLowLatencySquareLeft1080p60',
    'obsLowLatencySquareRight1080p60',
  ]) {
    assert.equal(normalizeLockedStreamRequest({
      serial: '1WMHH00000',
      profileId,
      streamMic: false,
    }).profileId, profileId);
  }
});
