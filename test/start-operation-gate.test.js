'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStartOperationGate } = require('../lib/start-operation-gate');

test('new starts and stop immediately invalidate every older async operation', () => {
  const gate = createStartOperationGate();
  const slowOld = gate.begin();
  assert.equal(gate.isCurrent(slowOld), true);
  const newer = gate.begin();
  assert.equal(gate.isCurrent(slowOld), false);
  assert.throws(() => gate.assertCurrent(slowOld), /superseded/i);
  assert.equal(gate.isCurrent(newer), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(newer), false);
});

test('a deferred old preparation cannot publish after a newer start', async () => {
  const gate = createStartOperationGate();
  let releaseOld;
  const oldDeferred = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const published = [];
  const oldToken = gate.begin();
  const oldStart = (async () => {
    await oldDeferred;
    gate.assertCurrent(oldToken);
    published.push('old');
  })();
  const newToken = gate.begin();
  gate.assertCurrent(newToken);
  published.push('new');
  releaseOld();
  await assert.rejects(oldStart, /superseded/i);
  assert.deepEqual(published, ['new']);
});

test('stop during deferred preflight prevents generation allocation', async () => {
  const gate = createStartOperationGate();
  let release;
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  let generations = 0;
  const token = gate.begin();
  const start = (async () => {
    await deferred;
    gate.assertCurrent(token);
    generations += 1;
  })();
  gate.invalidate();
  release();
  await assert.rejects(start, /superseded/i);
  assert.equal(generations, 0);
});
