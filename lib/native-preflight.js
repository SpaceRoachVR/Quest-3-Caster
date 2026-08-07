'use strict';

const { LOCKED_PROFILE_IDS } = require('./locked-native-profiles');

const CAPABILITY_KEYS = [
  'schemaVersion',
  'upstreamVersion',
  'forkVersion',
  'profiles',
  'stabilizationModes',
  'openclAvailable',
  'gpu',
  'output',
  'delays',
  'calibratedSource',
  'diagnostic',
];

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
}

function validateCapabilities(capabilities) {
  requireExactKeys(capabilities, CAPABILITY_KEYS, 'Native capabilities');
  requireExactKeys(capabilities.output, ['width', 'height'], 'Native output');
  requireExactKeys(
    capabilities.delays,
    ['lowLatencyNominalMs', 'stabilizedNominalMs', 'stabilizedMaximumMs'],
    'Native delays',
  );
  requireExactKeys(
    capabilities.calibratedSource,
    ['width', 'height'],
    'Native calibrated source',
  );
  if (
    capabilities.schemaVersion !== 1
    || capabilities.upstreamVersion !== '4.1'
    || capabilities.forkVersion !== 'quest3caster-stabilization-1'
    || JSON.stringify(capabilities.profiles) !== JSON.stringify(LOCKED_PROFILE_IDS)
    || JSON.stringify(capabilities.stabilizationModes)
      !== JSON.stringify(['off', 'openclFeaturePoint'])
    || typeof capabilities.openclAvailable !== 'boolean'
    || capabilities.output.width !== 1920
    || capabilities.output.height !== 1080
    || capabilities.delays.lowLatencyNominalMs !== 0
    || capabilities.delays.stabilizedNominalMs !== 100
    || capabilities.delays.stabilizedMaximumMs !== 120
    || capabilities.calibratedSource.width !== 4128
    || capabilities.calibratedSource.height !== 2208
    || capabilities.diagnostic !== 'ready'
  ) {
    throw new Error('Native capability result does not match the required contract.');
  }
  if (
    capabilities.openclAvailable
      ? typeof capabilities.gpu !== 'string' || capabilities.gpu.length === 0
      : capabilities.gpu !== null
  ) {
    throw new Error('Native capability GPU state is inconsistent.');
  }
  return Object.freeze(capabilities);
}

function parseNativeCapabilities(output) {
  if (typeof output !== 'string') {
    throw new TypeError('Native capability output must be a string.');
  }
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || Buffer.byteLength(lines[0], 'utf8') > 4096) {
    throw new Error('Native capability probe must emit one bounded JSON line.');
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Native capability probe emitted invalid JSON: ${error.message}`);
  }
  return validateCapabilities(parsed);
}

function profileRecord({
  id,
  available,
  reason,
  stabilization,
  gpu,
  nominalDelayMs,
  maximumDelayMs,
  output,
}) {
  return Object.freeze({
    id,
    available,
    reason,
    output: Object.freeze(output || { width: 1920, height: 1080 }),
    stabilization,
    gpu,
    nominalDelayMs,
    maximumDelayMs,
  });
}

function buildLockedProfilePreflight({ capabilities, displaySize }) {
  const parsed = validateCapabilities(capabilities);
  if (
    !displaySize
    || !Number.isSafeInteger(displaySize.width)
    || !Number.isSafeInteger(displaySize.height)
  ) {
    throw new Error('A valid physical display geometry is required.');
  }
  const geometryMatches =
    displaySize.width === parsed.calibratedSource.width
    && displaySize.height === parsed.calibratedSource.height;
  const geometryReason = geometryMatches
    ? null
    : `Calibrated OBS profiles require physical display geometry 4128x2208; detected ${displaySize.width}x${displaySize.height}.`;
  const openclReason = parsed.openclAvailable
    ? null
    : 'Stabilized capture requires a supported OpenCL GPU.';
  return Object.freeze({
    profiles: Object.freeze([
      profileRecord({
        id: LOCKED_PROFILE_IDS[0],
        available: geometryMatches,
        reason: geometryReason,
        stabilization: 'off',
        gpu: null,
        nominalDelayMs: 0,
        maximumDelayMs: 0,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[1],
        available: geometryMatches && parsed.openclAvailable,
        reason: geometryReason || openclReason,
        stabilization: 'openclFeaturePoint',
        gpu: parsed.openclAvailable ? parsed.gpu : null,
        nominalDelayMs: 100,
        maximumDelayMs: 120,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[2],
        available: geometryMatches,
        reason: geometryReason,
        output: { width: 1080, height: 1080 },
        stabilization: 'off',
        gpu: null,
        nominalDelayMs: 0,
        maximumDelayMs: 0,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[3],
        available: geometryMatches,
        reason: geometryReason,
        output: { width: 1080, height: 1080 },
        stabilization: 'off',
        gpu: null,
        nominalDelayMs: 0,
        maximumDelayMs: 0,
      }),
    ]),
    output: Object.freeze({ width: 1920, height: 1080 }),
    geometry: Object.freeze({
      detected: Object.freeze({ ...displaySize }),
      calibrated: Object.freeze({ ...parsed.calibratedSource }),
      available: geometryMatches,
      calibrationVerified: false,
    }),
    upstreamVersion: parsed.upstreamVersion,
    forkVersion: parsed.forkVersion,
    gpu: parsed.openclAvailable ? parsed.gpu : null,
    warnings: Object.freeze([
      'Calibrated framing still requires physical Quest 3 and OBS acceptance.',
      ...(geometryReason ? [geometryReason] : []),
    ]),
  });
}

function classifyAdbState(result, serial = null) {
  if (!result || result.success !== true) {
    return {
      available: false,
      code: 'adb_missing',
      reason: 'ADB is unavailable. Configure a valid ADB executable path.',
    };
  }
  const outputLines = String(result.stdout || '').split(/\r?\n/);
  const devices = outputLines
    .filter((line) => !/^List of devices attached/i.test(line.trim()))
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([deviceSerial, status]) => ({ serial: deviceSerial, status }));
  if (devices.length === 0) {
    return {
      available: false,
      code: 'no_device',
      reason: 'No Quest device is connected through ADB.',
    };
  }
  const device = serial
    ? devices.find((candidate) => candidate.serial === serial)
    : devices[0];
  if (!device) {
    return {
      available: false,
      code: 'no_device',
      reason: `ADB device ${serial} was not found.`,
    };
  }
  if (device.status === 'offline') {
    return {
      available: false,
      code: 'device_offline',
      reason: `ADB device ${device.serial} is offline.`,
    };
  }
  if (device.status === 'unauthorized') {
    return {
      available: false,
      code: 'device_unauthorized',
      reason: `ADB device ${device.serial} is unauthorized. Accept the USB debugging prompt in the headset.`,
    };
  }
  if (device.status !== 'device') {
    return {
      available: false,
      code: 'device_unavailable',
      reason: `ADB device ${device.serial} is in unsupported state ${device.status}.`,
    };
  }
  return {
    available: true,
    code: 'ready',
    reason: null,
    serial: device.serial,
    isWireless: device.serial.includes(':'),
  };
}

module.exports = {
  buildLockedProfilePreflight,
  classifyAdbState,
  parseNativeCapabilities,
  validateCapabilities,
};
