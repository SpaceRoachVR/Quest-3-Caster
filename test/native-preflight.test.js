'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNativeCapabilities,
  buildLockedProfilePreflight,
  classifyAdbState,
} = require('../lib/native-preflight');

const capability = {
  schemaVersion: 1,
  upstreamVersion: '4.1',
  forkVersion: 'quest3caster-stabilization-1',
  profiles: [
    'obsLowLatency1080p60', 'obsStabilized1080p60',
    'obsLowLatencySquareLeft1080p60', 'obsLowLatencySquareRight1080p60',
  ],
  stabilizationModes: ['off', 'openclFeaturePoint'],
  openclAvailable: true,
  gpu: 'NVIDIA GeForce RTX 3060',
  output: { width: 1920, height: 1080 },
  delays: {
    lowLatencyNominalMs: 0,
    stabilizedNominalMs: 100,
    stabilizedMaximumMs: 120,
  },
  calibratedSource: { width: 4128, height: 2208 },
  diagnostic: 'ready',
};

test('capability parsing and preflight return exact ordered availability', () => {
  const parsed = parseNativeCapabilities(`${JSON.stringify(capability)}\n`);
  const result = buildLockedProfilePreflight({
    capabilities: parsed,
    displaySize: { width: 4128, height: 2208 },
  });
  assert.deepEqual(result.profiles.map((profile) => profile.id), capability.profiles);
  assert.deepEqual(result.profiles.map((profile) => profile.available), [true, true, true, true]);
  assert.equal(result.profiles[0].nominalDelayMs, 0);
  assert.equal(result.profiles[1].nominalDelayMs, 100);
  assert.equal(result.profiles[1].maximumDelayMs, 120);
  assert.equal(result.profiles[1].gpu, capability.gpu);
  assert.deepEqual(result.profiles[2].output, { width: 1080, height: 1080 });
  assert.deepEqual(result.profiles[0].output, { width: 1792, height: 1008 });
  assert.equal(result.geometry.calibrationVerified, false);
  assert.equal(result.device.id, 'quest3');
  assert.equal(result.device.calibration, 'measured');
  assert.equal(result.device.matchedBy, 'display');
});

test('geometry and GPU disable profiles with exact actionable reasons', () => {
  // 3664x1920 is a real headset -- Quest 3S or Quest 2, which share a panel --
  // so the reason names it and points at the calibration wizard. The old
  // message demanded the display be 4128x2208, which is not a resolution this
  // hardware has and not an action anyone could take.
  const geometry = buildLockedProfilePreflight({
    capabilities: capability,
    displaySize: { width: 3664, height: 1920 },
  });
  assert.equal(geometry.profiles[0].available, false);
  assert.match(geometry.profiles[0].reason, /Quest 3S or Meta Quest 2/);
  assert.match(geometry.profiles[0].reason, /calibration wizard/);
  assert.doesNotMatch(geometry.profiles[0].reason, /4128x2208/);
  assert.equal(geometry.profiles[1].available, false);
  assert.equal(geometry.profiles[2].available, false);

  const named = buildLockedProfilePreflight({
    capabilities: capability,
    model: 'Quest 3S',
    displaySize: { width: 3664, height: 1920 },
  });
  assert.equal(named.device.id, 'quest3s');
  assert.equal(named.device.name, 'Meta Quest 3S');
  assert.equal(named.device.calibration, 'uncalibrated');
  assert.equal(named.device.matchedBy, 'model');
  assert.match(named.profiles[0].reason, /Meta Quest 3S is recognized but not calibrated/);

  const noGpu = buildLockedProfilePreflight({
    capabilities: { ...capability, openclAvailable: false, gpu: null },
    displaySize: { width: 4128, height: 2208 },
  });
  assert.equal(noGpu.profiles[0].available, true);
  assert.equal(noGpu.profiles[1].available, false);
  assert.equal(noGpu.profiles[2].available, true);
  assert.match(noGpu.profiles[1].reason, /OpenCL GPU/);
});

test('ADB state classification distinguishes missing, absent, offline, unauthorized, and ready', () => {
  assert.deepEqual(classifyAdbState({ success: false, error: 'ENOENT' }), {
    available: false,
    code: 'adb_missing',
    reason: 'ADB is unavailable. Configure a valid ADB executable path.',
  });
  assert.equal(classifyAdbState({ success: true, stdout: 'List of devices attached\n' }).code, 'no_device');
  assert.equal(classifyAdbState({ success: true, stdout: 'ABC\toffline\n' }, 'ABC').code, 'device_offline');
  assert.equal(classifyAdbState({ success: true, stdout: 'ABC\tunauthorized\n' }, 'ABC').code, 'device_unauthorized');
  assert.equal(classifyAdbState({ success: true, stdout: 'ABC\tdevice\n' }, 'ABC').available, true);
  assert.equal(classifyAdbState({ success: true, stdout: '192.168.1.3:5555\tdevice\n' }, '192.168.1.3:5555').isWireless, true);
  assert.equal(classifyAdbState({ success: true, stdout: 'ABC\tdevice\n' }, 'ABC').isWireless, false);
});

test('capability parser rejects extra keys and invalid GPU consistency', () => {
  assert.throws(
    () => parseNativeCapabilities(JSON.stringify({ ...capability, extra: true })),
    /unexpected/i,
  );
  assert.throws(
    () => parseNativeCapabilities(JSON.stringify({ ...capability, gpu: null })),
    /GPU/i,
  );
});
