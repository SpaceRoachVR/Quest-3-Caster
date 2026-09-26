'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { enableLegacyTcpIp, isListeningOnLegacyPort, readHeadsetIp } = require('../lib/usb-setup');

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

const LISTENING_5555 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000000000000000000000000000:15B3 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 88109 1 0000000000000000 99 0 0 10 0',
  '   4: 0000000000000000FFFF00004D01A8C0:15B3 0000000000000000FFFF00004901A8C0:CE49 01 00000000:00000000 00:00000000 00000000  2000        0 88110 1 0000000000000000 20 3 30 10 -1',
].join('\n');

test('detects a socket listening on port 5555 and ignores established or other ports', () => {
  assert.equal(isListeningOnLegacyPort(LISTENING_5555), true);
  assert.equal(isListeningOnLegacyPort(LISTENING_5555.split('\n').filter((line) => !line.includes(' 0A ')).join('\n')), false);
  assert.equal(isListeningOnLegacyPort('   0: 00000000:15B4 00000000:0000 0A 00000000:00000000'), false);
  assert.equal(isListeningOnLegacyPort(''), false);
});

test('leaves the headset ADB service alone when port 5555 is already listening', async () => {
  const calls = [];
  const result = await enableLegacyTcpIp({
    serial: SERIAL,
    runAdb: async (args) => {
      calls.push(args);
      return adbResult(LISTENING_5555);
    },
  });

  assert.deepEqual(result, { success: true, alreadyListening: true });
  assert.deepEqual(calls, [['-s', SERIAL, 'shell', 'cat', '/proc/net/tcp6', '/proc/net/tcp']]);
});

test('enables legacy TCP/IP when port 5555 is not listening, even if one proc file is missing', async () => {
  const calls = [];
  const result = await enableLegacyTcpIp({
    serial: SERIAL,
    runAdb: async (args) => {
      calls.push(args);
      if (args[2] === 'shell') {
        return { success: false, stdout: '   0: 00000000:13AD 00000000:0000 0A', stderr: 'cat: /proc/net/tcp6: No such file', error: 'Command failed' };
      }
      return adbResult('restarting in TCP mode port: 5555\n');
    },
  });

  assert.deepEqual(result, { success: true, alreadyListening: false });
  assert.deepEqual(calls[1], ['-s', SERIAL, 'tcpip', '5555']);
});

test('reports an unauthorized headset when enabling legacy TCP/IP fails', async () => {
  const result = await enableLegacyTcpIp({
    serial: SERIAL,
    runAdb: async (args) => {
      if (args[0] === 'devices') return adbResult(`List of devices attached\n${SERIAL}\tunauthorized\n`);
      return adbFailure('error: device unauthorized.');
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'device_unauthorized');
  assert.match(result.error, /Always allow from this computer/);
});

test('requires a valid serial before enabling legacy TCP/IP', async () => {
  const calls = [];
  await assert.rejects(enableLegacyTcpIp({ serial: '', runAdb: async (args) => calls.push(args) }));
  await assert.rejects(enableLegacyTcpIp({ serial: 'bad serial; rm', runAdb: async (args) => calls.push(args) }));
  assert.deepEqual(calls, []);
});
