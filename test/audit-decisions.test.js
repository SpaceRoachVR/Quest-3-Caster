'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createStreamSession } = require('../lib/stream-session');
const { hasCurrentLivePrimary, isChildRunning } = require('../lib/stream-start-outcome');
const { getLockedProfileSupport, identifyDevice } = require('../lib/device-registry');
const { getUserCalibrationDirectory } = require('../lib/calibration-store');

function createScheduler() {
  const timers = [];
  return {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    delays: () => timers.map((timer) => timer.delay),
    fireLast: () => timers[timers.length - 1].callback(),
  };
}

test('a recovered stream starts its next outage from the first reconnect delay', () => {
  const scheduler = createScheduler();
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000, 5000, 10000] });
  const generation = session.begin();

  assert.equal(session.scheduleReconnect(generation), true);
  scheduler.fireLast();
  assert.equal(session.markRecovered(generation), true);
  assert.equal(session.getRetryState().retryCount, 0);

  assert.equal(session.scheduleReconnect(generation), true);
  assert.deepEqual(scheduler.delays(), [2000, 2000]);
});

test('without a recovery the retry budget still runs out after the configured attempts', () => {
  const scheduler = createScheduler();
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000, 5000, 10000] });
  const generation = session.begin();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(session.scheduleReconnect(generation), true);
    scheduler.fireLast();
  }
  assert.equal(session.scheduleReconnect(generation), false);
  assert.deepEqual(scheduler.delays(), [2000, 5000, 10000]);
});

test('markRecovered ignores a stale generation and a reconnect that is still pending', () => {
  const scheduler = createScheduler();
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000, 5000] });
  const generation = session.begin();
  session.scheduleReconnect(generation);
  assert.equal(session.markRecovered(generation), false);
  assert.equal(session.getRetryState().retryCount, 1);
  scheduler.fireLast();
  assert.equal(session.markRecovered(generation + 1), false);
  assert.equal(session.getRetryState().retryCount, 1);
});

test('a process killed by a signal is not running', () => {
  const running = { pid: 5, killed: false, exitCode: null, signalCode: null };
  assert.equal(isChildRunning(running), true);
  assert.equal(isChildRunning({ ...running, signalCode: 'SIGTERM' }), false);
  assert.equal(isChildRunning({ ...running, exitCode: 0 }), false);
  assert.equal(isChildRunning({ ...running, killed: true }), false);
  assert.equal(isChildRunning({ ...running, pid: undefined }), false);
  assert.equal(isChildRunning(null), false);

  const session = { isActive: true, generation: 3, hasPendingReconnect: false };
  assert.equal(hasCurrentLivePrimary(session, { generation: 3, primary: running }), true);
  assert.equal(
    hasCurrentLivePrimary(session, { generation: 3, primary: { ...running, signalCode: 'SIGTERM' } }),
    false);
});

test('a headset with a calibration file is not told to run the wizard', () => {
  const quest3s = identifyDevice({ model: 'Quest 3S', displaySize: { width: 3664, height: 1920 } });
  const withFile = getLockedProfileSupport(quest3s, { calibrationTier: 'measured' });
  assert.equal(withFile.supported, false);
  assert.equal(withFile.tier, 'measured');
  assert.match(withFile.reason, /casts from its own calibration file/);
  assert.doesNotMatch(withFile.reason, /wizard|not calibrated/);

  const withoutFile = getLockedProfileSupport(quest3s);
  assert.equal(withoutFile.tier, 'uncalibrated');
  assert.match(withoutFile.reason, /not calibrated yet/);
});

test('a calibration file does not change the answer for a Quest 3 or an unknown headset', () => {
  const quest3 = identifyDevice({ model: 'Quest 3', displaySize: { width: 4128, height: 2208 } });
  assert.deepEqual(
    getLockedProfileSupport(quest3, { calibrationTier: 'provisional' }),
    getLockedProfileSupport(quest3));
  const unknown = identifyDevice({ model: 'Mystery', displaySize: { width: 1000, height: 500 } });
  assert.match(
    getLockedProfileSupport(unknown, { calibrationTier: 'measured' }).reason,
    /would mis-frame this headset/);
});

test('the per-user calibration folder is under APPDATA, and absent without it', () => {
  assert.equal(
    getUserCalibrationDirectory({ APPDATA: 'C:\\Users\\streamer\\AppData\\Roaming' }),
    path.join('C:\\Users\\streamer\\AppData\\Roaming', 'Quest 3 Caster', 'calibration'));
  assert.equal(getUserCalibrationDirectory({}), null);
  assert.equal(getUserCalibrationDirectory({ APPDATA: '' }), null);
});
