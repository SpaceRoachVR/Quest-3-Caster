'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createTerminatingChildCollection,
} = require('../lib/terminating-children');

function child(name) {
  const result = new EventEmitter();
  result.name = name;
  result.exitCode = null;
  result.signalCode = null;
  result.killCalls = 0;
  result.kill = () => { result.killCalls += 1; };
  return result;
}

test('fallback timeout retains handles and blocks replacement without port overlap', async () => {
  const primary = child('primary');
  const microphone = child('microphone');
  const collection = createTerminatingChildCollection();
  const result = await collection.terminateAndWait(
    [primary, microphone],
    { waitForExit: async () => false },
  );
  assert.equal(result.allExited, false);
  assert.deepEqual(collection.snapshot(), [primary, microphone]);
  assert.equal(collection.canLaunchReplacement(), false);
  assert.equal(primary.killCalls, 1);
  assert.equal(microphone.killCalls, 1);
});

test('later stop retries termination and actual exit removes retained handles', async () => {
  const primary = child('primary');
  const microphone = child('microphone');
  const collection = createTerminatingChildCollection();
  await collection.terminateAndWait(
    [primary, microphone],
    { waitForExit: async () => false },
  );
  collection.retryTermination();
  assert.equal(primary.killCalls, 2);
  assert.equal(microphone.killCalls, 2);
  primary.exitCode = 1;
  primary.emit('exit', 1, null);
  assert.deepEqual(collection.snapshot(), [microphone]);
  assert.equal(collection.canLaunchReplacement(), false);
  microphone.signalCode = 'SIGTERM';
  microphone.emit('close', null, 'SIGTERM');
  assert.deepEqual(collection.snapshot(), []);
  assert.equal(collection.canLaunchReplacement(), true);
});
