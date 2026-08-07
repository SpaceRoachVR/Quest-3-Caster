'use strict';

const { validateAdbSerial } = require('./stream-config');
const { classifyAdbState } = require('./native-preflight');

function requireRunAdb(runAdb) {
  if (typeof runAdb !== 'function') {
    throw new TypeError('runAdb must be a function.');
  }
}

async function getTargetState(runAdb, target) {
  const devicesResult = await runAdb(['devices']);
  return classifyAdbState(devicesResult, target);
}

function getConnectionDiagnostic(result) {
  if (result?.success !== false) return null;
  const detail = [result?.stderr, result?.error, result?.stdout]
    .find((value) => typeof value === 'string' && value.trim());
  return detail ? detail.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240) : null;
}

function failureForState(state, recoveredStaleTransport, connectionResult, target) {
  const diagnostic = getConnectionDiagnostic(connectionResult);
  const connectionRefused = /actively refused|failed to connect|cannot connect/i.test(diagnostic || '');
  const error = connectionRefused
    ? `Wireless ADB is not accepting connections at ${target}. Reconnect the headset by USB and repeat the wireless setup to restore port 5555.`
    : state.reason || 'Wireless ADB connection could not be verified.';
  const failure = {
    success: false,
    error,
    recoveredStaleTransport,
  };
  if (diagnostic) failure.diagnostic = diagnostic;
  return failure;
}

async function connectWirelessTarget({ target, runAdb }) {
  const safeTarget = validateAdbSerial(target);
  if (!safeTarget.includes(':')) {
    throw new Error('A wireless ADB target with a port is required.');
  }
  requireRunAdb(runAdb);

  const initialConnect = await runAdb(['connect', safeTarget]);
  const initialState = await getTargetState(runAdb, safeTarget);
  if (initialState.available) {
    return {
      success: true,
      endpoint: safeTarget,
      message: String(initialConnect.stdout || '').trim(),
      recoveredStaleTransport: false,
    };
  }

  const staleTransport = initialState.code === 'device_offline'
    && /already connected to/i.test(String(initialConnect.stdout || ''));
  if (!staleTransport) {
    return failureForState(initialState, false, initialConnect, safeTarget);
  }

  await runAdb(['disconnect', safeTarget]);
  const retryConnect = await runAdb(['connect', safeTarget]);
  const retryState = await getTargetState(runAdb, safeTarget);
  if (!retryState.available) {
    return failureForState(retryState, true, retryConnect, safeTarget);
  }

  return {
    success: true,
    endpoint: safeTarget,
    message: String(retryConnect.stdout || '').trim(),
    recoveredStaleTransport: true,
  };
}

module.exports = {
  connectWirelessTarget,
};
