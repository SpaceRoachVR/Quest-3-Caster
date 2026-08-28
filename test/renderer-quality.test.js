'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const rendererQuality = require('../lib/renderer-quality');

test('exposes two visible casting profiles and migrates all legacy selections', () => {
  assert.equal(rendererQuality.normalizePresetSelection('obsLowLatency1080p60'), 'obsLowLatency1080p60');
  assert.equal(rendererQuality.normalizePresetSelection('obsStabilized1080p60'), 'obsStabilized1080p60');
  assert.equal(rendererQuality.normalizePresetSelection('custom'), 'obsLowLatency1080p60');
  assert.deepEqual(rendererQuality.resolveInitialProfileSelection('custom', '2'), {
    profileId: 'obsLowLatency1080p60', persist: true
  });
});

test('maps the output-format UI to fixed native profiles without passing crop overrides', () => {
  const payload = rendererQuality.buildStreamPayload('obsStabilized1080p60', {
    serial: '192.168.1.25:5555',
    streamMic: true,
    bitRate: 80,
    videoCodec: 'h265',
    displayId: '2'
  });
  assert.deepEqual(payload, {
    serial: '192.168.1.25:5555',
    profileId: 'obsStabilized1080p60',
    streamMic: true
  });
  assert.deepEqual(rendererQuality.buildStreamPayload('obsStabilized1080p60', {
    serial: '192.168.1.25:5555', streamMic: false, outputFormat: 'square', rightEye: false
  }), {
    serial: '192.168.1.25:5555', profileId: 'obsLowLatencySquareLeft1080p60', streamMic: false
  });
  assert.deepEqual(rendererQuality.buildStreamPayload('obsLowLatency1080p60', {
    serial: '192.168.1.25:5555', streamMic: false, outputFormat: 'square', rightEye: true
  }), {
    serial: '192.168.1.25:5555', profileId: 'obsLowLatencySquareRight1080p60', streamMic: false
  });
  assert.equal(rendererQuality.normalizeOutputFormat('unsupported'), 'widescreen');
  assert.throws(() => rendererQuality.buildStreamPayload('custom', payload), /supported casting profile/);
});

test('selects the safe default when preflight does not offer a profile', () => {
  assert.deepEqual(rendererQuality.chooseAvailableProfile('obsStabilized1080p60', rendererQuality.getProfileAvailability(null)), {
    profileId: 'obsLowLatency1080p60', changed: true, persist: false
  });
});

test('reports locked profile tradeoffs without claiming physical verification', () => {
  const low = rendererQuality.getProfileDescription('obsLowLatency1080p60');
  const stabilized = rendererQuality.getProfileDescription('obsStabilized1080p60');
  assert.match(low, /H\.264/i);
  assert.match(stabilized, /approximately 100 ms/i);
  assert.doesNotMatch(stabilized, /production-verified/i);
});

test('a calibrated headset resolves the framing controls to calibrated profiles', () => {
  // No new UI: 16:9 or 1:1 and which eye already name the four calibrated
  // profiles, so the same controls drive either path.
  const preflight = {
    calibrationTier: 'provisional',
    calibratedProfiles: {
      calibratedWidescreenRight: { available: true, reason: null, angleConfirmed: false },
      calibratedSquareLeft: { available: true, reason: null, angleConfirmed: false }
    }
  };
  const widescreen = rendererQuality.resolveStreamProfile({
    profileId: 'obsLowLatency1080p60', outputFormat: 'widescreen', rightEye: true, preflight
  });
  assert.equal(widescreen.profileId, 'calibratedWidescreenRight');
  assert.equal(widescreen.calibrated, true);

  const square = rendererQuality.resolveStreamProfile({
    profileId: 'obsStabilized1080p60', outputFormat: 'square', rightEye: false, preflight
  });
  assert.equal(square.profileId, 'calibratedSquareLeft');
});

test('a headset without a calibration still resolves to the locked profiles', () => {
  const preflight = {
    profiles: [{ id: 'obsLowLatency1080p60', available: true, reason: null }]
  };
  const resolved = rendererQuality.resolveStreamProfile({
    profileId: 'obsLowLatency1080p60', outputFormat: 'widescreen', rightEye: true, preflight
  });
  assert.equal(resolved.profileId, 'obsLowLatency1080p60');
  assert.equal(resolved.calibrated, false);
  assert.equal(resolved.availability.available, true);
});

test('a framing the calibration never measured is unavailable, not substituted', () => {
  const resolved = rendererQuality.resolveStreamProfile({
    profileId: 'obsLowLatency1080p60',
    outputFormat: 'square',
    rightEye: true,
    preflight: { calibrationTier: 'provisional', calibratedProfiles: {} }
  });
  assert.equal(resolved.availability.available, false);
  assert.match(resolved.availability.reason, /does not cover that framing/);
});

test('the calibrated payload carries only the three allowed fields', () => {
  const resolved = { profileId: 'calibratedWidescreenRight', calibrated: true };
  assert.deepEqual(
    rendererQuality.buildResolvedStreamPayload(resolved,
      { serial: '340YC20G7102BQ', streamMic: true, outputFormat: 'widescreen', rightEye: true }),
    { serial: '340YC20G7102BQ', profileId: 'calibratedWidescreenRight', streamMic: true });
  assert.throws(() => rendererQuality.buildResolvedStreamPayload(resolved,
    { serial: '', streamMic: true }), /valid ADB serial/);
  assert.throws(() => rendererQuality.buildResolvedStreamPayload(resolved,
    { serial: 'x', streamMic: 'yes' }), /must be a boolean/);
});

test('an unconfirmed angle is disclosed to the user, a confirmed one is not laboured', () => {
  const provisional = {
    calibrated: true, tier: 'provisional', availability: { angleConfirmed: false }
  };
  assert.match(rendererQuality.getCalibratedNote(provisional), /provisional calibration/);
  assert.match(rendererQuality.getCalibratedNote(provisional), /unrotated/);

  const measured = {
    calibrated: true, tier: 'measured', availability: { angleConfirmed: true }
  };
  assert.match(rendererQuality.getCalibratedNote(measured), /measured calibration/);
  assert.equal(rendererQuality.getCalibratedNote({ calibrated: false }), null);
});
