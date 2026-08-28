const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStartFailureResult,
  hasCurrentLivePrimary,
  shouldCleanupFailedStart
} = require('../lib/stream-start-outcome');

test('reports that a failed preparation preserved an existing stream', () => {
  assert.deepEqual(createStartFailureResult(new Error('display unavailable'), true, false), {
    success: false,
    error: 'display unavailable',
    preservedExistingStream: true
  });
});

test('does not report a preserved stream before the first start or after replacement begins', () => {
  assert.equal(createStartFailureResult(new Error('display unavailable'), false, false).preservedExistingStream, false);
  assert.equal(createStartFailureResult(new Error('spawn failed'), true, true).preservedExistingStream, false);
});

test('does not preserve Streaming after a primary exit while reconnect is pending', () => {
  const pendingReconnect = { generation: 7, isActive: true, hasPendingReconnect: true };
  const exitedPrimaryOwnership = { generation: 7, primary: null };

  const hadLivePrimary = hasCurrentLivePrimary(pendingReconnect, exitedPrimaryOwnership);
  assert.equal(hadLivePrimary, false);
  assert.equal(
    createStartFailureResult(new Error('display unavailable'), hadLivePrimary, false).preservedExistingStream,
    false
  );
});

test('does not report a live primary while a reconnect is already pending for its generation', () => {
  const pendingReconnect = { generation: 7, isActive: true, hasPendingReconnect: true };
  const stillOwnedPrimary = {
    generation: 7,
    primary: { pid: 2468, killed: false, exitCode: null }
  };

  assert.equal(hasCurrentLivePrimary(pendingReconnect, stillOwnedPrimary), false);
});

test('requires the live primary ownership generation to match the active stream generation', () => {
  const session = { generation: 7, isActive: true, hasPendingReconnect: false };
  const stalePrimaryOwnership = {
    generation: 6,
    primary: { pid: 2468, killed: false, exitCode: null }
  };

  assert.equal(hasCurrentLivePrimary(session, stalePrimaryOwnership), false);
});

test('recognizes the current owned live primary as preservable', () => {
  const session = { generation: 7, isActive: true, hasPendingReconnect: false };
  const ownership = {
    generation: 7,
    primary: { pid: 2468, killed: false, exitCode: null }
  };

  assert.equal(hasCurrentLivePrimary(session, ownership), true);
});

test('a stale failed start cannot clean up a newer generation', () => {
  assert.equal(shouldCleanupFailedStart({
    replacementStarted: true,
    startedGeneration: 4,
    currentGeneration: 5,
    sessionActive: true
  }), false);
  assert.equal(shouldCleanupFailedStart({
    replacementStarted: true,
    startedGeneration: 5,
    currentGeneration: 5,
    sessionActive: true
  }), true);
  assert.equal(shouldCleanupFailedStart({
    replacementStarted: true,
    startedGeneration: 5,
    currentGeneration: 5,
    sessionActive: false
  }), false);
});
