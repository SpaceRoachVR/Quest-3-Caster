'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { launchNativeAttempt } = require('../lib/native-startup');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
  };
  return child;
}

function fakeScheduler() {
  let callback = null;
  return {
    setTimeout(next) {
      callback = next;
      return 1;
    },
    clearTimeout() {
      callback = null;
    },
    expire() {
      const next = callback;
      callback = null;
      next();
    },
  };
}

const ready = {
  schemaVersion: 1,
  type: 'ready',
  code: 'stream_ready',
  effectiveProfile: 'obsLowLatency1080p60',
  output: { width: 1792, height: 1008 },
  stabilization: { active: false },
  gpu: null,
  nominalDelayMs: 0,
  generation: 3,
};

test('spawn is not success until matching native ready and status follows ready', async () => {
  const child = fakeChild();
  const statuses = [];
  const pending = launchNativeAttempt({
    child,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  child.emit('spawn');
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.stderr.write(`Q3C_NATIVE_EVENT ${JSON.stringify(ready)}\n`);
  const result = await pending;
  statuses.push(result.ready);
  assert.deepEqual(statuses, [ready]);
});

test('pre-ready fatal, malformed protocol, exit, and timeout kill the child', async () => {
  const fatalChild = fakeChild();
  const fatalPending = launchNativeAttempt({
    child: fatalChild,
    generation: 3,
    profileId: 'obsStabilized1080p60',
    expectedGpu: 'GPU',
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  fatalChild.emit('spawn');
  fatalChild.stderr.write('Q3C_NATIVE_EVENT {"schemaVersion":1,"type":"fatal","code":"stabilization_unavailable","message":"GPU failed"}\n');
  await assert.rejects(fatalPending, (error) => error.code === 'stabilization_unavailable');
  assert.equal(fatalChild.killed, true);

  const malformed = fakeChild();
  const malformedPending = launchNativeAttempt({
    child: malformed,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  malformed.emit('spawn');
  malformed.stderr.write('Q3C_NATIVE_EVENT {bad}\n');
  await assert.rejects(malformedPending, /protocol/i);
  assert.equal(malformed.killed, true);

  const exited = fakeChild();
  const exitPending = launchNativeAttempt({
    child: exited,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  exited.emit('spawn');
  exited.emit('exit', 1, null);
  await assert.rejects(exitPending, /before native readiness/i);

  const failedSpawn = fakeChild();
  const spawnPending = launchNativeAttempt({
    child: failedSpawn,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  failedSpawn.emit('error', new Error('ENOENT'));
  await assert.rejects(spawnPending, /ENOENT/);
  assert.equal(failedSpawn.killed, true);

  const scheduler = fakeScheduler();
  const timedOut = fakeChild();
  const timeoutPending = launchNativeAttempt({
    child: timedOut,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    scheduler,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit() {},
  });
  scheduler.expire();
  await assert.rejects(timeoutPending, /timed out/i);
  assert.equal(timedOut.killed, true);
});

test('runtime fatal is delivered only after ready', async () => {
  const child = fakeChild();
  const runtimeEvents = [];
  const pending = launchNativeAttempt({
    child,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent: (event) => runtimeEvents.push(event),
    onRuntimeExit() {},
  });
  child.emit('spawn');
  child.stderr.write(`Q3C_NATIVE_EVENT ${JSON.stringify(ready)}\n`);
  const result = await pending;
  child.stderr.write('Q3C_NATIVE_EVENT {"schemaVersion":1,"type":"fatal","code":"render_failed","message":"lost"}\n');
  assert.equal(runtimeEvents[0].code, 'render_failed');
  result.dispose();
});

test('exit exactly at ready resolution is continuously observed and cannot be live', async () => {
  const child = fakeChild();
  const exits = [];
  const pending = launchNativeAttempt({
    child,
    generation: 3,
    profileId: 'obsLowLatency1080p60',
    expectedGpu: null,
    startupTimeoutMs: 1000,
    onLog() {},
    onRuntimeEvent() {},
    onRuntimeExit: (event) => exits.push(event),
  });
  child.emit('spawn');
  child.stderr.on('data', () => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
  });
  child.stderr.write(`Q3C_NATIVE_EVENT ${JSON.stringify(ready)}\n`);
  const result = await pending;
  assert.equal(result.isAlive(), false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
});
