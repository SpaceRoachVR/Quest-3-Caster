'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { launchCalibratedAttempt } = require('../lib/calibrated-startup');

// Real scrcpy 4.1 startup output, captured from a Quest 3S over USB with the
// calibrated crop. The readiness line and its position among ordinary log
// lines are what this module keys on, so the fixture is the genuine article
// rather than an idealised version of it.
const REAL_STARTUP_OUTPUT = [
  'scrcpy 4.1 <https://github.com/Genymobile/scrcpy>',
  'INFO: ADB device found:',
  'INFO:     -->   (usb)  340YC20G7102BQ                  device  Quest_3S',
  '[server] INFO: Device: [Oculus] oculus Quest 3S (Android 14)',
  'INFO: Renderer: direct3d11',
  'INFO: Texture: 1674x942',
];

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function createScheduler() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimeout(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fire() {
      for (const callback of [...timers.values()]) callback();
      timers.clear();
    },
    pending: () => timers.size,
  };
}

function harness(overrides = {}) {
  const child = createChild();
  const scheduler = createScheduler();
  const logs = [];
  const events = [];
  const exits = [];
  const promise = launchCalibratedAttempt({
    child,
    generation: 7,
    profileId: 'calibratedWidescreenRight',
    expectedOutput: { width: 1674, height: 942 },
    scheduler,
    onLog: (line) => logs.push(line),
    onRuntimeEvent: (event) => events.push(event),
    onRuntimeExit: (event) => exits.push(event),
    ...overrides,
  });
  return { child, scheduler, logs, events, exits, promise };
}

function emit(child, lines) {
  child.stdout.emit('data', Buffer.from(`${lines.join('\n')}\n`));
}

test('readiness comes from the real scrcpy texture line', async () => {
  const h = harness();
  emit(h.child, REAL_STARTUP_OUTPUT);
  const handle = await h.promise;
  assert.equal(handle.ready.effectiveProfile, 'calibratedWidescreenRight');
  assert.deepEqual(handle.ready.output, { width: 1674, height: 942 });
  assert.equal(handle.ready.generation, 7);
  assert.equal(handle.ready.stabilization.active, false);
  assert.equal(handle.ready.gpu, null);
  assert.equal(handle.isAlive(), true);
  assert.equal(h.scheduler.pending(), 0, 'the startup timer must be cleared');
  // Everything that is not the readiness line is ordinary logging.
  assert.equal(h.logs.length, REAL_STARTUP_OUTPUT.length - 1);
  assert.ok(h.logs.includes('INFO: Renderer: direct3d11'));
});

test('a texture line split across chunks still registers', () => {
  const h = harness();
  h.child.stdout.emit('data', Buffer.from('INFO: Rend'));
  h.child.stdout.emit('data', Buffer.from('erer: direct3d11\nINFO: Text'));
  h.child.stdout.emit('data', Buffer.from('ure: 1674x942\n'));
  return h.promise.then((handle) => {
    assert.deepEqual(handle.ready.output, { width: 1674, height: 942 });
  });
});

test('geometry that does not match the measured crop is refused, not reported ready', async () => {
  // The entire point of confirming readiness is that the app never says a
  // stream is live until it is framed as measured.
  const h = harness();
  emit(h.child, ['INFO: Texture: 1920x1080']);
  await assert.rejects(h.promise, (error) => {
    assert.equal(error.code, 'calibrated_geometry_mismatch');
    assert.match(error.message, /delivered 1920x1080/);
    assert.match(error.message, /measured crop is 1674x942/);
    return true;
  });
  assert.equal(h.child.killed, true, 'a mismatched stream must be terminated');
});

test('exiting before readiness fails rather than hanging', async () => {
  const h = harness();
  emit(h.child, ['INFO: Renderer: direct3d11']);
  h.child.emit('exit', 1, null);
  await assert.rejects(h.promise, (error) => {
    assert.equal(error.code, 'calibrated_pre_ready_exit');
    return true;
  });
});

test('a spawn failure is reported as a spawn failure', async () => {
  const h = harness();
  h.child.emit('error', new Error('ENOENT'));
  await assert.rejects(h.promise, (error) => {
    assert.equal(error.code, 'calibrated_spawn_failed');
    assert.match(error.message, /ENOENT/);
    return true;
  });
});

test('a stream that never produces a frame times out', async () => {
  const h = harness();
  emit(h.child, ['INFO: ADB device found:']);
  h.scheduler.fire();
  await assert.rejects(h.promise, (error) => {
    assert.equal(error.code, 'calibrated_startup_timeout');
    return true;
  });
  assert.equal(h.child.killed, true);
});

test('exit after readiness is a runtime exit, not a startup failure', async () => {
  const h = harness();
  emit(h.child, REAL_STARTUP_OUTPUT);
  const handle = await h.promise;
  h.child.emit('exit', 0, null);
  assert.deepEqual(h.exits, [{ code: 0, signal: null, error: null }]);
  assert.equal(handle.isAlive(), false);
});

test('the same texture size announced again is ignored', async () => {
  const h = harness();
  emit(h.child, REAL_STARTUP_OUTPUT);
  await h.promise;
  emit(h.child, ['INFO: Texture: 1674x942']);
  assert.deepEqual(h.events, []);
  assert.equal(h.child.killed, false);
});

test('geometry changing after readiness is fatal', async () => {
  // scrcpy re-announces the texture when the source geometry changes. The
  // stream is then no longer framed the way it was confirmed, so continuing
  // to report it as a good stream would be a lie.
  const h = harness();
  emit(h.child, REAL_STARTUP_OUTPUT);
  const handle = await h.promise;
  emit(h.child, ['INFO: Texture: 1920x1080']);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'fatal');
  assert.equal(h.events[0].code, 'unexpected_output_geometry');
  assert.match(h.events[0].message, /changed to 1920x1080/);
  assert.equal(handle.isAlive(), false);
  assert.equal(h.child.killed, true);
});

test('dependencies and expected geometry are validated up front', async () => {
  await assert.rejects(launchCalibratedAttempt({ child: null }), /child process is invalid/);
  await assert.rejects(
    launchCalibratedAttempt({ child: createChild(), generation: 0 }), /generation is invalid/);
  await assert.rejects(
    launchCalibratedAttempt({ child: createChild(), generation: 1, expectedOutput: null }),
    /expected output is invalid/);
  await assert.rejects(
    launchCalibratedAttempt({
      child: createChild(), generation: 1,
      expectedOutput: { width: 1674, height: 942 }, startupTimeoutMs: 90000,
    }), /timeout is invalid/);
  await assert.rejects(
    launchCalibratedAttempt({
      child: createChild(), generation: 1,
      expectedOutput: { width: 1674, height: 942 },
    }), /dependencies are invalid/);
});

test('listeners are released once the attempt settles', async () => {
  const h = harness();
  emit(h.child, REAL_STARTUP_OUTPUT);
  const handle = await h.promise;
  handle.dispose();
  assert.equal(h.child.stdout.listenerCount('data'), 0);
  assert.equal(h.child.stderr.listenerCount('data'), 0);
  assert.equal(h.child.listenerCount('exit'), 0);
  assert.equal(h.child.listenerCount('error'), 0);
});
