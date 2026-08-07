'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createActiveStreamOwnership,
  requestReconnectForCurrentOwnership
} = require('../lib/renderer-lifecycle');

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

test('a deferred old reconnect result cannot mutate a stopped or newer stream UI', async () => {
  let ownership = createActiveStreamOwnership(7, 'obsLowLatency1080p60', false);
  const reconnect = deferred();
  const pending = requestReconnectForCurrentOwnership({
    generation: 7,
    requestedProfile: 'obsLowLatency1080p60',
    getCurrentOwnership: () => ownership,
    requestReconnect: () => reconnect.promise
  });

  ownership = null;
  reconnect.resolve({ scheduled: false, retry: 3, delayMs: null });
  assert.deepEqual(await pending, { accepted: false, result: null });

  ownership = createActiveStreamOwnership(8, 'obsStabilized1080p60', true);
  const newerReady = deferred();
  const oldPending = requestReconnectForCurrentOwnership({
    generation: 8,
    requestedProfile: 'obsStabilized1080p60',
    getCurrentOwnership: () => ownership,
    requestReconnect: () => newerReady.promise
  });
  ownership = createActiveStreamOwnership(9, 'obsLowLatency1080p60', false);
  newerReady.resolve({ scheduled: false, retry: 3, delayMs: null });
  assert.deepEqual(await oldPending, { accepted: false, result: null });
});

test('accepted microphone state is immutable across toggle changes, fallback, and reconnect', () => {
  const ownership = createActiveStreamOwnership(12, 'obsStabilized1080p60', true);
  assert.equal(ownership.streamMic, true);
  assert.equal(Object.isFrozen(ownership), true);
  assert.equal(ownership.generation, 12);
  assert.equal(ownership.requestedProfile, 'obsStabilized1080p60');
});

test('a matching reconnect result is accepted', async () => {
  const ownership = createActiveStreamOwnership(5, 'obsLowLatency1080p60', false);
  const result = await requestReconnectForCurrentOwnership({
    generation: 5,
    requestedProfile: 'obsLowLatency1080p60',
    getCurrentOwnership: () => ownership,
    requestReconnect: async () => ({ scheduled: true, retry: 1, delayMs: 2000 })
  });
  assert.deepEqual(result, {
    accepted: true,
    result: { scheduled: true, retry: 1, delayMs: 2000 }
  });
});
