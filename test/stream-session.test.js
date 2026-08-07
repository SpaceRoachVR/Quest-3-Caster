const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamSession } = require('../lib/stream-session');

function fakeScheduler() {
  const tasks = new Map();
  let id = 0;

  return {
    setTimeout(callback, delay) {
      tasks.set(++id, { callback, delay });
      return id;
    },
    clearTimeout(key) {
      tasks.delete(key);
    },
    run() {
      const [key, task] = tasks.entries().next().value;
      tasks.delete(key);
      task.callback();
      return task.delay;
    },
    count() {
      return tasks.size;
    }
  };
}

test('ignores stale exits after a new start', () => {
  const session = createStreamSession({ scheduler: fakeScheduler(), reconnectDelaysMs: [1000] });
  const first = session.begin();
  const second = session.begin();

  assert.equal(session.isCurrent(first), false);
  assert.equal(session.isCurrent(second), true);
});

test('limits retries and uses configured delays', () => {
  const scheduler = fakeScheduler();
  const calls = [];
  const session = createStreamSession({
    scheduler,
    reconnectDelaysMs: [2000, 5000],
    onReconnect: (generation) => calls.push(generation)
  });
  const generation = session.begin();

  assert.equal(session.scheduleReconnect(generation), true);
  assert.equal(scheduler.run(), 2000);
  assert.equal(session.scheduleReconnect(generation), true);
  assert.equal(scheduler.run(), 5000);
  assert.equal(session.scheduleReconnect(generation), false);
  assert.deepEqual(calls, [generation, generation]);
});

test('stop cancels a pending retry', () => {
  const scheduler = fakeScheduler();
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000] });
  const generation = session.begin();

  session.scheduleReconnect(generation);
  session.stop();

  assert.equal(scheduler.count(), 0);
  assert.equal(session.isCurrent(generation), false);
});

test('prevents a duplicate pending reconnect', () => {
  const scheduler = fakeScheduler();
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000] });
  const generation = session.begin();

  assert.equal(session.scheduleReconnect(generation), true);
  assert.equal(session.scheduleReconnect(generation), false);
  assert.equal(scheduler.count(), 1);
});

test('prevents duplicate reconnects when the scheduler returns a null handle', () => {
  const scheduler = {
    setTimeout() {
      return null;
    },
    clearTimeout() {}
  };
  const session = createStreamSession({ scheduler, reconnectDelaysMs: [2000, 5000] });
  const generation = session.begin();

  assert.equal(session.scheduleReconnect(generation), true);
  assert.equal(session.scheduleReconnect(generation), false);
});

test('uses a snapshot of reconnect delays after caller mutation', () => {
  const scheduler = fakeScheduler();
  const reconnectDelaysMs = [2000];
  const session = createStreamSession({ scheduler, reconnectDelaysMs });
  reconnectDelaysMs[0] = 5000;
  const generation = session.begin();

  assert.equal(session.scheduleReconnect(generation), true);
  assert.equal(scheduler.run(), 2000);
});

test('does not treat a session as current before begin', () => {
  const session = createStreamSession({ scheduler: fakeScheduler(), reconnectDelaysMs: [2000] });

  assert.equal(session.isCurrent(0), false);
  assert.equal(session.scheduleReconnect(0), false);
});

test('does not invoke reconnect after a newer generation begins', () => {
  const scheduler = fakeScheduler();
  const calls = [];
  const session = createStreamSession({
    scheduler,
    reconnectDelaysMs: [2000],
    onReconnect: (generation) => calls.push(generation)
  });
  const first = session.begin();

  session.scheduleReconnect(first);
  const second = session.begin();
  assert.equal(second, first + 1);
  assert.equal(scheduler.count(), 0);
  assert.deepEqual(calls, []);
});

test('requires a scheduler with timer functions', () => {
  assert.throws(
    () => createStreamSession({ scheduler: {}, reconnectDelaysMs: [] }),
    /scheduler must provide setTimeout and clearTimeout functions/
  );
});

test('requires finite non-negative reconnect delays', () => {
  const scheduler = fakeScheduler();

  for (const delays of [[-1], [Number.POSITIVE_INFINITY], ['2000'], 'invalid']) {
    assert.throws(
      () => createStreamSession({ scheduler, reconnectDelaysMs: delays }),
      /reconnectDelaysMs must be an array of finite non-negative numbers/
    );
  }
});
