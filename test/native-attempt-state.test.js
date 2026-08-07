'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNativeAttemptState } = require('../lib/native-attempt-state');

test('stabilized fallback is exactly once and retains effective profile', () => {
  const state = createNativeAttemptState(5, 'obsStabilized1080p60');
  const first = state.beginAttempt('obsStabilized1080p60');
  assert.equal(state.requestFallback(first.token, 'GPU initialization failed'), 'begin');
  assert.equal(state.requestFallback(first.token, 'duplicate fatal'), 'pending');
  assert.equal(state.snapshot().fallbackStatus, 'pending');
  assert.equal(state.allowsReconnect(), false);
  const fallback = state.beginFallback(first.token);
  assert.equal(fallback.profileId, 'obsLowLatency1080p60');
  state.markReady(fallback.token);
  assert.equal(state.snapshot().effectiveProfile, 'obsLowLatency1080p60');
  assert.equal(state.requestFallback(fallback.token, 'again'), 'terminal');
});

test('stop and replacement cancel pending fallback and stale attempts', () => {
  const state = createNativeAttemptState(8, 'obsStabilized1080p60');
  const first = state.beginAttempt('obsStabilized1080p60');
  state.requestFallback(first.token, 'failure');
  state.cancel();
  assert.equal(state.beginFallback(first.token), null);
  assert.equal(state.accepts(first.token, 8), false);
});

test('ready validation rejects wrong profile, generation, output, delay, and GPU', () => {
  const state = createNativeAttemptState(9, 'obsStabilized1080p60', {
    gpu: 'GPU',
  });
  const attempt = state.beginAttempt('obsStabilized1080p60');
  const base = {
    schemaVersion: 1,
    type: 'ready',
    code: 'stream_ready',
    effectiveProfile: 'obsStabilized1080p60',
    output: { width: 1920, height: 1080 },
    stabilization: { active: true },
    gpu: 'GPU',
    nominalDelayMs: 100,
    generation: 9,
  };
  assert.equal(state.validateReady(attempt.token, base), true);
  for (const event of [
    { ...base, generation: 10 },
    { ...base, effectiveProfile: 'obsLowLatency1080p60' },
    { ...base, output: { width: 1280, height: 720 } },
    { ...base, nominalDelayMs: 0 },
    { ...base, gpu: 'other' },
  ]) {
    assert.throws(() => state.validateReady(attempt.token, event));
  }
});

test('fallback simulation accepts one replacement and rejects a later GPU failure', () => {
  const launches = [];
  const state = createNativeAttemptState(12, 'obsStabilized1080p60', { gpu: 'GPU' });
  const stabilized = state.beginAttempt('obsStabilized1080p60');
  launches.push(stabilized.profileId);
  assert.equal(
    state.requestFallback(stabilized.token, 'stabilization unavailable'),
    'begin',
  );
  const lowLatency = state.beginFallback(stabilized.token);
  launches.push(lowLatency.profileId);
  state.markReady(lowLatency.token);
  assert.equal(state.requestFallback(lowLatency.token, 'second failure'), 'terminal');
  assert.deepEqual(launches, [
    'obsStabilized1080p60',
    'obsLowLatency1080p60',
  ]);
  assert.equal(state.snapshot().fallbackUsed, true);
  assert.equal(state.snapshot().effectiveProfile, 'obsLowLatency1080p60');
});

test('stale fallback events are harmless and terminal fallback blocks reconnect', () => {
  const state = createNativeAttemptState(14, 'obsStabilized1080p60');
  const first = state.beginAttempt('obsStabilized1080p60');
  assert.equal(state.requestFallback({}, 'stale'), 'stale');
  assert.equal(state.requestFallback(first.token, 'GPU failed'), 'begin');
  state.markFallbackTerminal();
  assert.equal(state.snapshot().fallbackStatus, 'terminal');
  assert.equal(state.allowsReconnect(), false);
  assert.equal(state.requestFallback(first.token, 'late duplicate'), 'terminal');
});

test('square-eye attempts require their locked 1080x1080 ready event', () => {
  const state = createNativeAttemptState(15, 'obsLowLatencySquareLeft1080p60');
  const attempt = state.beginAttempt('obsLowLatencySquareLeft1080p60');
  const ready = {
    effectiveProfile: 'obsLowLatencySquareLeft1080p60',
    output: { width: 1080, height: 1080 }, stabilization: { active: false },
    gpu: null, nominalDelayMs: 0, generation: 15,
  };
  assert.equal(state.validateReady(attempt.token, ready), true);
  assert.throws(() => state.validateReady(attempt.token, {
    ...ready, output: { width: 1920, height: 1080 },
  }));
});
