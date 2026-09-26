'use strict';

const { LOCKED_PROFILE_IDS } = require('./locked-native-profiles');
const { getProfileGeometry } = require('./locked-profile-geometry');
const { getLockedProfileSupport, identifyDevice } = require('./device-registry');

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

// Everything except availability comes from the profile's own geometry, so a
// record cannot claim a size, crop or delay the native runtime does not
// deliver. Only `available`, `reason` and `gpu` depend on this machine.
function profileRecord({ id, available, reason, gpu }) {
  const geometry = getProfileGeometry(id);
  return Object.freeze({
    id,
    available,
    reason,
    output: geometry.output,
    stabilization: geometry.stabilization,
    gpu,
    nominalDelayMs: geometry.nominalDelayMs,
    maximumDelayMs: geometry.maximumDelayMs,
  });
}

function buildLockedProfilePreflight({ capabilities, displaySize, model = null }) {
  const parsed = validateCapabilities(capabilities);
  if (
    !displaySize
    || !Number.isSafeInteger(displaySize.width)
    || !Number.isSafeInteger(displaySize.height)
  ) {
    throw new Error('A valid physical display geometry is required.');
  }
  // The registry decides which headset this is and whether its framing was
  // ever measured. The old check compared the display against one hardcoded
  // resolution, so a Quest 3S owner was told their headset must be 4128x2208 --
  // naming a size their hardware does not have and no action they could take.
  const identification = identifyDevice({ model, displaySize });
  const support = getLockedProfileSupport(identification);
  const geometryMatches = support.supported;
  const geometryReason = support.reason;
  const openclReason = parsed.openclAvailable
    ? null
    : 'Stabilized capture requires a supported OpenCL GPU.';
  return Object.freeze({
    profiles: Object.freeze([
      profileRecord({
        id: LOCKED_PROFILE_IDS[0],
        available: geometryMatches,
        reason: geometryReason,
        gpu: null,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[1],
        available: geometryMatches && parsed.openclAvailable,
        reason: geometryReason || openclReason,
        gpu: parsed.openclAvailable ? parsed.gpu : null,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[2],
        available: geometryMatches,
        reason: geometryReason,
        gpu: null,
      }),
      profileRecord({
        id: LOCKED_PROFILE_IDS[3],
        available: geometryMatches,
        reason: geometryReason,
        gpu: null,
      }),
    ]),
    // The default profile's delivered size. Profiles no longer share one
    // output, so consumers wanting a specific profile's size must read that
    // profile's record rather than this field.
    output: getProfileGeometry(LOCKED_PROFILE_IDS[0]).output,
    geometry: Object.freeze({
      detected: Object.freeze({ ...displaySize }),
      calibrated: Object.freeze({ ...parsed.calibratedSource }),
      available: geometryMatches,
      calibrationVerified: false,
    }),
    device: Object.freeze({
      id: identification.device.id,
      name: identification.device.name,
      model: typeof model === 'string' && model ? model : null,
      calibration: support.tier,
      matchedBy: identification.matchedBy,
      eye: identification.device.eye,
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
      // `adb tcpip` restarts the headset's ADB service, which forgets a
      // one-time approval, so the prompt reappears inside the headset.
      reason: `The headset is asking to allow USB debugging (${device.serial}). Put it on, tick “Always allow from this computer”, and tap Allow.`,
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
