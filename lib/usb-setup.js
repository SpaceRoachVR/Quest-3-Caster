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

const LEGACY_TCPIP_PORT_HEX = '15B3'; // 5555
const TCP_STATE_LISTEN = '0A';

// True when /proc/net/tcp{,6} output shows a socket listening on port 5555.
function isListeningOnLegacyPort(procNetTcp) {
  return String(procNetTcp || '').split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length > 3
      && fields[1].toUpperCase().endsWith(`:${LEGACY_TCPIP_PORT_HEX}`)
      && fields[3].toUpperCase() === TCP_STATE_LISTEN;
  });
}

// `adb tcpip` restarts the headset's ADB service even when it is already
// listening, and the restart forgets a one-time USB debugging approval. Only
// run it when port 5555 is not open, so repeating setup cannot keep
// re-prompting the headset.
async function enableLegacyTcpIp({ serial, runAdb }) {
  if (typeof runAdb !== 'function') {
    throw new TypeError('runAdb must be a function.');
  }
  const safeSerial = validateAdbSerial(serial);
  // `cat` exits non-zero if one of the files is missing but still prints the
  // other, so the output is inspected regardless of the exit status.
  const probe = await runAdb(['-s', safeSerial, 'shell', 'cat', '/proc/net/tcp6', '/proc/net/tcp']);
  if (isListeningOnLegacyPort(probe.stdout)) {
    return { success: true, alreadyListening: true };
  }
  const result = await runAdb(['-s', safeSerial, 'tcpip', '5555']);
  if (result.success) {
    return { success: true, alreadyListening: false };
  }
  const state = classifyAdbState(await runAdb(['devices']), safeSerial);
  if (!state.available) {
    return { success: false, code: state.code, error: state.reason };
  }
  const failure = {
    success: false,
    code: 'adb_command_failed',
    error: 'Could not enable ADB over Wi-Fi. Reconnect the USB cable and scan again.'
  };
  const diagnostic = getCommandDiagnostic(result);
  if (diagnostic) failure.diagnostic = diagnostic;
  return failure;
}

module.exports = {
  enableLegacyTcpIp,
  isListeningOnLegacyPort,
  readHeadsetIp,
};
