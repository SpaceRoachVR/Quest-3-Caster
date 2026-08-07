'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNativeLineParser,
  validateNativeEvent,
} = require('../lib/native-events');

const PREFIX = 'Q3C_NATIVE_EVENT ';
const ready = {
  schemaVersion: 1,
  type: 'ready',
  code: 'stream_ready',
  effectiveProfile: 'obsStabilized1080p60',
  output: { width: 1920, height: 1080 },
  stabilization: { active: true },
  gpu: 'NVIDIA GeForce RTX 3060',
  nominalDelayMs: 100,
  generation: 4,
};

test('accepts the bundled client Low Latency readiness schema', () => {
  const lowLatencyReady = {
    schemaVersion: 1,
    type: 'ready',
    code: 'stream_ready',
    effectiveProfile: 'obsLowLatency1080p60',
    output: { width: 1792, height: 1008 },
    stabilization: { active: false },
    gpu: null,
    nominalDelayMs: 0,
    generation: 9001,
  };
  assert.deepEqual(validateNativeEvent(lowLatencyReady), lowLatencyReady);
});

test('accepts fixed square-eye readiness with its exact 1080x1080 output', () => {
  const squareReady = {
    schemaVersion: 1, type: 'ready', code: 'stream_ready',
    effectiveProfile: 'obsLowLatencySquareRight1080p60',
    output: { width: 1080, height: 1080 }, stabilization: { active: false },
    gpu: null, nominalDelayMs: 0, generation: 9002,
  };
  assert.deepEqual(validateNativeEvent(squareReady), squareReady);
  assert.throws(() => validateNativeEvent({
    ...squareReady, output: { width: 1792, height: 1008 },
  }), /1080x1080/);
});

test('incremental native parser handles fragments, multiple lines, and ordinary logs', () => {
  const events = [];
  const logs = [];
  const parser = createNativeLineParser({
    onEvent: (event) => events.push(event),
    onLog: (line) => logs.push(line),
  });
  const line = `${PREFIX}${JSON.stringify(ready)}\n`;
  parser.push(line.slice(0, 20));
  parser.push(`${line.slice(20)}ordinary log\r\n`);
  assert.deepEqual(events, [ready]);
  assert.deepEqual(logs, ['ordinary log']);
  parser.end();
});

test('native parser rejects malformed prefixed and oversized unterminated data', () => {
  const parser = createNativeLineParser({ onEvent() {}, onLog() {} });
  assert.throws(() => parser.push(`${PREFIX}{bad}\n`), /protocol/i);

  const oversized = createNativeLineParser({ onEvent() {}, onLog() {} });
  assert.throws(() => oversized.push('x'.repeat(5000)), /oversized/i);

  const invalidUtf8 = createNativeLineParser({ onEvent() {}, onLog() {} });
  assert.throws(
    () => invalidUtf8.push(Buffer.from([0xc3, 0x28])),
    /UTF-8/i,
  );
});

test('native event validation enforces exact schemas and consistency', () => {
  assert.deepEqual(validateNativeEvent(ready), ready);
  assert.throws(() => validateNativeEvent({ ...ready, extra: 1 }), /unexpected/i);
  assert.throws(() => validateNativeEvent({
    ...ready,
    output: { width: 1919, height: 1080 },
  }), /1920x1080/);
  assert.throws(() => validateNativeEvent({
    ...ready,
    stabilization: { active: false },
  }), /stabilization/i);
  assert.throws(() => validateNativeEvent({
    schemaVersion: 1,
    type: 'fatal',
    code: 'stabilization_unavailable',
    message: 'bad\u0001message',
  }), /control/i);
  assert.deepEqual(validateNativeEvent({
    schemaVersion: 1,
    type: 'warning',
    code: 'stabilization_degraded',
    message: 'GPU reset',
  }), {
    schemaVersion: 1,
    type: 'warning',
    code: 'stabilization_degraded',
    message: 'GPU reset',
  });
});

test('native parser accepts the 4096-byte JSON boundary', () => {
  const messageLength = 4096 - Buffer.byteLength(JSON.stringify({
    schemaVersion: 1,
    type: 'warning',
    code: 'stabilization_degraded',
    message: '',
  }));
  const payload = {
    schemaVersion: 1,
    type: 'warning',
    code: 'stabilization_degraded',
    message: 'a'.repeat(messageLength),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), 4096);
  const received = [];
  const parser = createNativeLineParser({
    onEvent: (event) => received.push(event),
    onLog() {},
  });
  parser.push(`${PREFIX}${JSON.stringify(payload)}\n`);
  assert.equal(received.length, 1);
});
