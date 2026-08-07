'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTerminationRegistry } = require('../lib/termination-registry');

function child(name) {
  const result = new EventEmitter();
  result.name = name;
  result.exitCode = null;
  result.signalCode = null;
  result.killCalls = 0;
  result.kill = () => { result.killCalls += 1; };
  return result;
}

test('published context remains registered through later fallback timeout and disposal', async () => {
  const registry = createTerminationRegistry();
  const contextLease = registry.createContextLease();
  let replacementLaunches = 0;
  async function attemptReplacementLaunch() {
    const termination = await registry.terminateAndWait({
      waitForExit: async () => false,
    });
    if (!termination.allExited) return false;
    replacementLaunches += 1;
    return true;
  }

  // Initial publish is successful while no children are terminating.
  assert.equal(contextLease.collection.canLaunchReplacement(), true);
  assert.equal(registry.registeredContextCount(), 1);
  assert.equal(registry.canLaunchReplacement(), true);

  // A later post-ready fallback times out terminating primary and microphone.
  const primary = child('primary');
  const microphone = child('microphone');
  const fallback = await contextLease.collection.terminateAndWait(
    [primary, microphone],
    { waitForExit: async () => false },
  );
  assert.equal(fallback.allExited, false);
  assert.equal(registry.canLaunchReplacement(), false);
  assert.equal(registry.registeredContextCount(), 1);

  // Stop disposes the context. A new start retries termination but remains
  // blocked before allocating the replacement's fixed ports.
  contextLease.dispose();
  assert.equal(await attemptReplacementLaunch(), false);
  assert.equal(replacementLaunches, 0);
  assert.equal(primary.killCalls, 4);
  assert.equal(microphone.killCalls, 4);
  assert.equal(registry.canLaunchReplacement(), false);
  assert.equal(registry.registeredContextCount(), 1);

  // Each authoritative process end removes only its own retained handle.
  primary.exitCode = 1;
  primary.emit('exit', 1, null);
  assert.equal(registry.canLaunchReplacement(), false);
  assert.equal(registry.registeredContextCount(), 1);
  microphone.signalCode = 'SIGTERM';
  microphone.emit('close', null, 'SIGTERM');

  // Only both exits permit replacement/port launch and release the empty lease.
  assert.equal(registry.canLaunchReplacement(), true);
  assert.equal(registry.registeredContextCount(), 0);
  assert.equal(await attemptReplacementLaunch(), true);
  assert.equal(replacementLaunches, 1);
});

test('disposed empty context lease is removed without a permanent registry leak', () => {
  const registry = createTerminationRegistry();
  const lease = registry.createContextLease();
  assert.equal(registry.registeredContextCount(), 1);
  lease.dispose();
  assert.equal(registry.registeredContextCount(), 0);
  lease.dispose();
  assert.equal(registry.registeredContextCount(), 0);
});

test('late cleanup retain re-registers a disposed lease until actual exit', () => {
  const registry = createTerminationRegistry();
  const lease = registry.createContextLease();
  lease.dispose();
  assert.equal(registry.registeredContextCount(), 0);

  const lateChild = child('late cleanup');
  lease.collection.retain(lateChild);
  assert.equal(registry.registeredContextCount(), 1);
  assert.equal(registry.canLaunchReplacement(), false);

  lateChild.exitCode = 1;
  lateChild.emit('exit', 1, null);
  assert.equal(registry.canLaunchReplacement(), true);
  assert.equal(registry.registeredContextCount(), 0);
});
