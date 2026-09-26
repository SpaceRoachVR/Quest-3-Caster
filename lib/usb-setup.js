'use strict';

const { validateAdbSerial } = require('./stream-config');
const { classifyAdbState } = require('./native-preflight');

const NO_WIFI_ERROR = 'Could not retrieve IP address. Ensure headset is connected to Wi-Fi.';

function getCommandDiagnostic(result) {
  const detail = [result?.stderr, result?.error]
    .find((value) => typeof value === 'string' && value.trim());
  return detail ? detail.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240) : null;
}

// Reads the headset's Wi-Fi IPv4 address over its USB transport. The device's
// ADB state is checked first so that a headset which has stopped trusting this
// PC is reported as waiting for permission rather than as a Wi-Fi problem.
async function readHeadsetIp({ serial, runAdb }) {
  if (typeof runAdb !== 'function') {
    throw new TypeError('runAdb must be a function.');
  }
  const safeSerial = serial ? validateAdbSerial(serial) : null;
  const state = classifyAdbState(await runAdb(['devices']), safeSerial);
  if (!state.available) {
    return { success: false, code: state.code, error: state.reason };
  }
  const target = ['-s', state.serial];

  const primary = await runAdb([...target, 'shell', 'ip', '-o', '-4', 'addr', 'show', 'wlan0']);
  const match = primary.success && primary.stdout.match(/inet\s+([0-9.]+)/);
  if (match) return { success: true, ip: match[1] };

  const fallback = await runAdb([...target, 'shell', 'ifconfig', 'wlan0']);
  const fallbackMatch = fallback.success
    && (fallback.stdout.match(/inet\s+addr:([0-9.]+)/) || fallback.stdout.match(/inet\s+([0-9.]+)/));
  if (fallbackMatch) return { success: true, ip: fallbackMatch[1] };

  // Both commands ran and found no address: the headset has no Wi-Fi. If a
  // command itself failed, the device changed state mid-lookup, so say that.
  if (primary.success || fallback.success) {
    return { success: false, code: 'no_wifi', error: NO_WIFI_ERROR };
  }
  const recheck = classifyAdbState(await runAdb(['devices']), state.serial);
  if (!recheck.available) {
    return { success: false, code: recheck.code, error: recheck.reason };
  }
  const diagnostic = getCommandDiagnostic(fallback) || getCommandDiagnostic(primary);
  const failure = {
    success: false,
    code: 'adb_command_failed',
    error: 'ADB could not read the headset IP address. Reconnect the USB cable and scan again.'
  };
  if (diagnostic) failure.diagnostic = diagnostic;
  return failure;
}

module.exports = {
  readHeadsetIp,
};
