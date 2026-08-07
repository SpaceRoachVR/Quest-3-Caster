'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFallbackCoordinator } = require('../lib/fallback-coordinator');
const { createNativeAttemptState } = require('../lib/native-attempt-state');

test('duplicate post-ready stabilization fatals are ignored while fallback is pending', () => {
  const state = createNativeAttemptState(2, 'obsStabilized1080p60');
  const attempt = state.beginAttempt('obsStabilized1080p60');
  let reconnectCancellations = 0;
  const terminalReasons = [];
  const coordinator = createFallbackCoordinator({
    state,
    cancelReconnect: () => { reconnectCancellations += 1; },
    onTerminal: (reason) => terminalReasons.push(reason),
  });
  assert.equal(coordinator.request(attempt.token, 'GPU failed'), 'begin');
  assert.equal(coordinator.request(attempt.token, 'duplicate GPU failed'), 'ignore');
  assert.equal(reconnectCancellations, 1);
  assert.deepEqual(terminalReasons, []);
  assert.equal(state.allowsReconnect(), false);
});

test('termination timeout becomes terminal once and cannot reconnect', () => {
  const state = createNativeAttemptState(3, 'obsStabilized1080p60');
  state.beginAttempt('obsStabilized1080p60');
  let reconnectCancellations = 0;
  const terminalReasons = [];
  const coordinator = createFallbackCoordinator({
    state,
    cancelReconnect: () => { reconnectCancellations += 1; },
    onTerminal: (reason) => terminalReasons.push(reason),
  });
  coordinator.terminate('termination timeout');
  coordinator.terminate('late fallback failure');
  assert.equal(state.snapshot().fallbackStatus, 'terminal');
  assert.equal(state.allowsReconnect(), false);
  assert.deepEqual(terminalReasons, ['termination timeout']);
  assert.equal(reconnectCancellations, 1);
});
