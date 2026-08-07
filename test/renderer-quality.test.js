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
