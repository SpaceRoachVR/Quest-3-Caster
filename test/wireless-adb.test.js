'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { connectWirelessTarget } = require('../lib/wireless-adb');

function adbResult(stdout) {
  return { success: true, stdout, stderr: '', error: null };
}

test('recovers a stale offline wireless transport before reporting connection success', async () => {
  const calls = [];
  const responses = [
    adbResult('already connected to 192.168.1.77:5555\n'),
    adbResult('List of devices attached\n192.168.1.77:5555\toffline\n'),
    adbResult('disconnected everything\n'),
    adbResult('connected to 192.168.1.77:5555\n'),
    adbResult('List of devices attached\n192.168.1.77:5555\tdevice\n'),
  ];
  const result = await connectWirelessTarget({
    target: '192.168.1.77:5555',
    runAdb: async (args) => {
      calls.push(args);
      return responses.shift();
    },
  });

  assert.deepEqual(calls, [
    ['connect', '192.168.1.77:5555'],
    ['devices'],
    ['disconnect', '192.168.1.77:5555'],
    ['connect', '192.168.1.77:5555'],
    ['devices'],
  ]);
  assert.equal(result.success, true);
  assert.equal(result.recoveredStaleTransport, true);
});

test('rejects an endpoint that remains offline after stale-transport recovery', async () => {
  const responses = [
    adbResult('already connected to 192.168.1.77:5555\n'),
    adbResult('List of devices attached\n192.168.1.77:5555\toffline\n'),
    adbResult('disconnected everything\n'),
    adbResult('connected to 192.168.1.77:5555\n'),
    adbResult('List of devices attached\n192.168.1.77:5555\toffline\n'),
  ];
  const result = await connectWirelessTarget({
    target: '192.168.1.77:5555',
    runAdb: async () => responses.shift(),
  });

  assert.deepEqual(result, {
    success: false,
    error: 'ADB device 192.168.1.77:5555 is offline.',
    recoveredStaleTransport: true,
  });
});

test('accepts an already-connected endpoint only after ADB reports it as ready', async () => {
  const calls = [];
  const result = await connectWirelessTarget({
    target: '192.168.1.77:5555',
    runAdb: async (args) => {
      calls.push(args);
      if (args[0] === 'connect') return adbResult('already connected to 192.168.1.77:5555\n');
      return adbResult('List of devices attached\n192.168.1.77:5555\tdevice\n');
    },
  });

  assert.deepEqual(calls, [
    ['connect', '192.168.1.77:5555'],
    ['devices'],
  ]);
  assert.equal(result.success, true);
  assert.equal(result.recoveredStaleTransport, false);
});

test('reports a refused legacy TCP/IP connection with the required recovery action', async () => {
  const result = await connectWirelessTarget({
    target: '192.168.1.77:5555',
    runAdb: async (args) => args[0] === 'connect'
      ? { success: false, stdout: '', stderr: 'cannot connect: actively refused', error: null }
      : adbResult('List of devices attached\n'),
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Reconnect the headset by USB/i);
  assert.match(result.error, /port 5555/i);
  assert.match(result.diagnostic, /actively refused/i);
});
