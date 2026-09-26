'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readHeadsetIp } = require('../lib/usb-setup');

const SERIAL = '2G0YC1ZFCK04Q7';

function adbResult(stdout) {
  return { success: true, stdout, stderr: '', error: null };
}

function adbFailure(stderr) {
  return { success: false, stdout: '', stderr, error: 'Command failed' };
}

function fakeAdb(handlers) {
  const calls = [];
  const runAdb = async (args) => {
    calls.push(args);
    const key = args[0] === 'devices' ? 'devices' : args[3];
    const handler = handlers[key];
    return typeof handler === 'function' ? handler() : handler;
  };
  return { calls, runAdb };
}

test('reads the Wi-Fi address of an authorized USB headset', async () => {
  const { calls, runAdb } = fakeAdb({
    devices: adbResult(`List of devices attached\n${SERIAL}\tdevice\n`),
    ip: adbResult('30: wlan0    inet 192.168.1.77/24 brd 192.168.1.255 scope global wlan0\n'),
  });

  assert.deepEqual(await readHeadsetIp({ serial: SERIAL, runAdb }), { success: true, ip: '192.168.1.77' });
  assert.deepEqual(calls[1], ['-s', SERIAL, 'shell', 'ip', '-o', '-4', 'addr', 'show', 'wlan0']);
});

test('reports an unauthorized headset as waiting for approval, not as a Wi-Fi problem', async () => {
  const { calls, runAdb } = fakeAdb({
    devices: adbResult(`List of devices attached\n${SERIAL}\tunauthorized\n192.168.1.77:5555\tunauthorized\n`),
  });

  const result = await readHeadsetIp({ serial: SERIAL, runAdb });
  assert.equal(result.success, false);
  assert.equal(result.code, 'device_unauthorized');
  assert.match(result.error, /Always allow from this computer/);
  assert.doesNotMatch(result.error, /Wi-Fi/);
  assert.deepEqual(calls, [['devices']]);
});

test('reports a headset that loses authorization during the lookup', async () => {
  let devicesCalls = 0;
  const { runAdb } = fakeAdb({
    devices: () => adbResult(devicesCalls++ === 0
      ? `List of devices attached\n${SERIAL}\tdevice\n`
      : `List of devices attached\n${SERIAL}\tunauthorized\n`),
    ip: adbFailure('error: device unauthorized.'),
    ifconfig: adbFailure('error: device unauthorized.'),
  });

  const result = await readHeadsetIp({ serial: SERIAL, runAdb });
  assert.equal(result.code, 'device_unauthorized');
  assert.doesNotMatch(result.error, /Wi-Fi/);
});

test('reports missing Wi-Fi only when the headset answered without an address', async () => {
  const { runAdb } = fakeAdb({
    devices: adbResult(`List of devices attached\n${SERIAL}\tdevice\n`),
    ip: adbResult(''),
    ifconfig: adbResult('wlan0: flags=4098<BROADCAST,MULTICAST>  mtu 1500\n'),
  });

  const result = await readHeadsetIp({ serial: SERIAL, runAdb });
  assert.equal(result.code, 'no_wifi');
  assert.match(result.error, /Wi-Fi/);
});

test('falls back to ifconfig output when ip is unavailable', async () => {
  const { runAdb } = fakeAdb({
    devices: adbResult(`List of devices attached\n${SERIAL}\tdevice\n`),
    ip: adbFailure('/system/bin/sh: ip: not found'),
    ifconfig: adbResult('wlan0 Link encap:Ethernet\n inet addr:192.168.1.77  Bcast:192.168.1.255\n'),
  });

  assert.deepEqual(await readHeadsetIp({ serial: SERIAL, runAdb }), { success: true, ip: '192.168.1.77' });
});

test('keeps the ADB diagnostic when a command fails on a still-authorized headset', async () => {
  const { runAdb } = fakeAdb({
    devices: adbResult(`List of devices attached\n${SERIAL}\tdevice\n`),
    ip: adbFailure('error: closed'),
    ifconfig: adbFailure('error: closed'),
  });

  const result = await readHeadsetIp({ serial: SERIAL, runAdb });
  assert.equal(result.code, 'adb_command_failed');
  assert.equal(result.diagnostic, 'error: closed');
});

test('rejects an invalid serial before running ADB', async () => {
  const { calls, runAdb } = fakeAdb({});
  await assert.rejects(readHeadsetIp({ serial: 'bad serial; rm', runAdb }));
  assert.deepEqual(calls, []);
});
