'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createStreamChildOwnership } = require('../lib/stream-child-ownership');

function createChild(name) {
  return { name, killCalls: 0, kill() { this.killCalls += 1; } };
}

test('terminates the microphone when the current primary stream exits', () => {
  const ownership = createStreamChildOwnership();
  const primary = createChild('primary');
  const microphone = createChild('microphone');
  ownership.begin(5);
  ownership.setPrimary(5, primary);
  ownership.setMicrophone(5, microphone);
  microphone.kill = () => {
    microphone.killCalls += 1;
    microphone.wasRegisteredDuringKill = ownership.snapshot().microphone === microphone;
  };

  assert.equal(ownership.clearPrimaryAndTerminateMicrophone(5, primary), true);
  assert.equal(microphone.killCalls, 1);
  assert.equal(microphone.wasRegisteredDuringKill, true);
  assert.deepEqual(ownership.snapshot(), { primary: null, microphone: null, generation: 5 });
});

test('does not let a stale primary exit terminate a newer microphone stream', () => {
  const ownership = createStreamChildOwnership();
  const stalePrimary = createChild('stale-primary');
  const currentMicrophone = createChild('current-microphone');
  ownership.begin(2);
  ownership.setPrimary(2, stalePrimary);
  ownership.begin(3);
  ownership.setMicrophone(3, currentMicrophone);

  assert.equal(ownership.clearPrimaryAndTerminateMicrophone(2, stalePrimary), false);
  assert.equal(currentMicrophone.killCalls, 0);
  assert.equal(ownership.snapshot().microphone, currentMicrophone);
});

test('replaces an existing microphone without leaking the fixed-port process', () => {
  const ownership = createStreamChildOwnership();
  const firstMicrophone = createChild('first-microphone');
  const replacementMicrophone = createChild('replacement-microphone');
  ownership.begin(7);
  ownership.setMicrophone(7, firstMicrophone);

  assert.equal(ownership.setMicrophone(7, replacementMicrophone), true);
  assert.equal(firstMicrophone.killCalls, 1);
  assert.equal(ownership.snapshot().microphone, replacementMicrophone);
});
