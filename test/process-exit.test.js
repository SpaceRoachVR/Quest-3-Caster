'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { waitForProcessExit } = require('../lib/process-exit');

function schedulerFixture() {
  let callback;
  return {
    scheduler: {
      setTimeout(next) { callback = next; return 1; },
      clearTimeout() { callback = null; },
    },
    expire() {
      const next = callback;
      callback = null;
      next();
    },
  };
}

test('termination timeout is deterministic and reports not exited', async () => {
  const fixture = schedulerFixture();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const pending = waitForProcessExit(child, {
    timeoutMs: 100,
    scheduler: fixture.scheduler,
  });
  fixture.expire();
  assert.equal(await pending, false);
});

test('observed exit wins before the termination timeout', async () => {
  const fixture = schedulerFixture();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const pending = waitForProcessExit(child, {
    timeoutMs: 100,
    scheduler: fixture.scheduler,
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  assert.equal(await pending, true);
});

test('child error does not prove termination and remains pending until exit', async () => {
  const fixture = schedulerFixture();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const pending = waitForProcessExit(child, {
    timeoutMs: 100,
    scheduler: fixture.scheduler,
  });
  let settled = false;
  pending.then(() => { settled = true; });
  child.emit('error', new Error('pipe failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.exitCode = 1;
  child.emit('exit', 1, null);
  assert.equal(await pending, true);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('error followed by timeout returns false and removes every listener', async () => {
  const fixture = schedulerFixture();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const pending = waitForProcessExit(child, {
    timeoutMs: 100,
    scheduler: fixture.scheduler,
  });
  child.emit('error', new Error('not an exit'));
  fixture.expire();
  assert.equal(await pending, false);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.listenerCount('error'), 0);
});
