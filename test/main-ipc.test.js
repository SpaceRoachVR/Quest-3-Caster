'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FAKE_CLIENT_PATH, REPO_ROOT, loadMain, settle } = require('../test-support/main-harness');
const shippedCalibration = require('../calibration/quest3s.json');

const SERIAL = '192.168.50.25:5555';
const RUNTIME_CONFIG = {};
const WIDESCREEN = shippedCalibration.profiles.widescreenRight.output;
const TEXTURE_LINE = `INFO: Texture: ${WIDESCREEN.width}x${WIDESCREEN.height}`;
const DISPLAY = shippedCalibration.device.display;

// Answers the adb calls a Quest 3S on legacy TCP/IP makes during a start.
function quest3sAdb(args) {
  if (args[0] === 'devices') return { stdout: `List of devices attached\n${SERIAL}\tdevice\n` };
  if (args[0] === 'connect') return { stdout: `connected to ${SERIAL}\n` };
  if (args.includes('wm')) return { stdout: `Physical size: ${DISPLAY.width}x${DISPLAY.height}\n` };
  if (args.includes('getprop')) return { stdout: 'Quest 3S\n' };
  return { stdout: '' };
}

function calibratedRequest(overrides = {}) {
  return { serial: SERIAL, profileId: 'calibratedWidescreenRight', streamMic: false, ...overrides };
}

async function withMain(options, run) {
  const main = loadMain(options);
  try {
    await settle();
    await run(main);
  } finally {
    await main.dispose();
  }
}

test('every preload invoke channel has a main-process handler, and the reverse', async () => {
  await withMain({}, async (main) => {
    const preload = fs.readFileSync(path.join(REPO_ROOT, 'preload.js'), 'utf8');
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
    assert.ok(invoked.length > 0);
    assert.deepEqual([...main.handlers.keys()].sort(), [...new Set(invoked)].sort());
  });
});

test('a second instance quits without opening a window', async () => {
  await withMain({ singleInstanceLock: false }, async (main) => {
    assert.equal(main.quitCount(), 1);
    assert.equal(main.windows.length, 0);
  });
  await withMain({}, async (main) => {
    assert.equal(main.quitCount(), 0);
    assert.equal(main.windows.length, 1);
  });
});

test('scan-devices reports ready, unauthorized and offline devices and an empty list', async () => {
  const stdout = [
    'List of devices attached',
    '2G0YC1ZF8B04RK\tdevice',
    'ABC123\tunauthorized',
    'DEF456\toffline',
    `${SERIAL}\tdevice`,
    '',
  ].join('\r\n');
  await withMain({ adb: () => ({ stdout }) }, async (main) => {
    const result = await main.invoke('scan-devices', RUNTIME_CONFIG);
    assert.equal(result.success, true);
    assert.deepEqual(result.devices, [
      { serial: '2G0YC1ZF8B04RK', status: 'device', isWireless: false },
      { serial: 'ABC123', status: 'unauthorized', isWireless: false },
      { serial: 'DEF456', status: 'offline', isWireless: false },
      { serial: SERIAL, status: 'device', isWireless: true },
    ]);
  });
  await withMain({ adb: () => ({ stdout: 'List of devices attached\n\n' }) }, async (main) => {
    assert.deepEqual(await main.invoke('scan-devices', RUNTIME_CONFIG), { success: true, devices: [] });
  });
  await withMain({ adb: () => ({ error: 'spawn adb ENOENT' }) }, async (main) => {
    const result = await main.invoke('scan-devices', RUNTIME_CONFIG);
    assert.equal(result.success, false);
    assert.deepEqual(result.devices, []);
  });
});

test('connect-wireless rejects a target that is not an IPv4 endpoint without running adb', async () => {
  await withMain({}, async (main) => {
    for (const target of [undefined, 'evil.example.com:5555', 'abc:def', '1.2.3.4:555555']) {
      const result = await main.invoke('connect-wireless', target, RUNTIME_CONFIG);
      assert.equal(result.success, false, String(target));
    }
    assert.deepEqual(main.adbCalls, []);
  });
});

test('a custom ADB path that is not a local adb.exe is rejected before anything runs', async () => {
  await withMain({}, async (main) => {
    for (const adbPath of ['adb-custom', '\\\\server\\share\\adb.exe', 'C:\\tools\\notadb.exe', 'C:\\missing\\adb.exe']) {
      const scan = await main.invoke('scan-devices', { adbPath });
      assert.equal(scan.success, false, adbPath);
      assert.match(scan.error, /custom ADB path/, adbPath);
      const check = await main.invoke('check-paths', { adbPath });
      assert.equal(check.adb, false, adbPath);
      assert.match(check.adbError, /custom ADB path/, adbPath);
    }
    assert.deepEqual(main.adbCalls, []);
    assert.deepEqual(main.otherCalls, []);
  });
});

test('check-paths reports the bundled casting engine separately from ADB', async () => {
  await withMain({ adb: () => ({ stdout: 'Android Debug Bridge version 1.0.41\n' }) }, async (main) => {
    const result = await main.invoke('check-paths', RUNTIME_CONFIG);
    assert.equal(result.adb, true);
    assert.equal(result.scrcpy, true);
  });
  await withMain({ nativeRuntimeError: 'manifest hash mismatch' }, async (main) => {
    const result = await main.invoke('check-paths', RUNTIME_CONFIG);
    assert.equal(result.scrcpy, false);
    assert.match(result.scrcpyError, /manifest hash mismatch/);
  });
});

test('a stream request without a locked or calibrated profile is rejected and nothing is spawned', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const requests = [
      { serial: SERIAL },
      { serial: SERIAL, profileId: 'custom' },
      { serial: SERIAL, bitRate: 50, videoCodec: 'h265', crop: '100:100:0:0', maxFps: 120 },
      null,
    ];
    for (const request of requests) {
      const result = await main.invoke('start-stream', request, RUNTIME_CONFIG);
      assert.equal(result.success, false);
      assert.match(result.error, /supported casting profile is required/);
    }
    assert.equal(main.children.length, 0);
    assert.deepEqual(await main.invoke('stop-stream'), { success: false, error: 'No active stream process found.' });
  });
});

test('a profile request carrying extra renderer settings is rejected', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke(
      'start-stream', calibratedRequest({ bitRate: 80 }), RUNTIME_CONFIG);
    assert.equal(result.success, false);
    assert.equal(main.children.length, 0);
  });
});

test('a start succeeds only once the stream is confirmed, and stop ends it', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);
    assert.equal(result.effectiveProfile, 'calibratedWidescreenRight');
    assert.deepEqual(result.output, WIDESCREEN);
    assert.equal(result.expectedOutput, `Expected stream: ${WIDESCREEN.width}x${WIDESCREEN.height}`);
    assert.equal(main.children.length, 1);
    assert.equal(main.children[0].executable, FAKE_CLIENT_PATH);
    assert.equal(main.children[0].killed, false);
    assert.deepEqual(main.sentOn('stream-status').map((status) => status.generation), [result.generation]);

    assert.deepEqual(await main.invoke('stop-stream'), { success: true });
    assert.equal(main.children[0].killed, true);
    await settle();
    // A stop the user asked for is not reported as the stream dying.
    assert.deepEqual(main.sentOn('stream-exit'), []);
    assert.deepEqual(await main.invoke('stop-stream'), { success: false, error: 'No active stream process found.' });
  });
});

test('a start that never confirms its geometry is not reported as active', async () => {
  const onSpawn = (child) => {
    child.emit('spawn');
    child.stdout.emit('data', Buffer.from('INFO: Texture: 640x480\n'));
  };
  await withMain({ adb: quest3sAdb, onSpawn }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, false);
    assert.match(result.error, /640x480/);
    assert.equal(main.children[0].killed, true);
    assert.deepEqual(main.sentOn('stream-status'), []);
    assert.deepEqual(await main.invoke('stop-stream'), { success: false, error: 'No active stream process found.' });
  });
});

test('a failed executable launch returns an error and leaves no active stream', async () => {
  const onSpawn = (child) => child.emit('error', new Error('spawn scrcpy.exe ENOENT'));
  await withMain({ adb: quest3sAdb, onSpawn }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, false);
    assert.match(result.error, /ENOENT/);
    assert.deepEqual(main.sentOn('stream-status'), []);
    assert.deepEqual(main.sentOn('stream-exit'), []);
    assert.deepEqual(await main.invoke('stop-stream'), { success: false, error: 'No active stream process found.' });
  });
});

test('an unexpected exit sends exactly one stream-exit and ends the microphone', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke(
      'start-stream', calibratedRequest({ streamMic: true }), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);
    assert.equal(main.children.length, 2);
    const [primary, microphone] = main.children;

    primary.exitUnexpectedly(1);
    await settle();
    assert.deepEqual(main.sentOn('stream-exit'), [{ generation: result.generation, code: 1, signal: null }]);
    assert.equal(microphone.killed, true);
    // The microphone was ended by the app, so it is not reported as a fault.
    assert.deepEqual(main.sentOn('microphone-exit'), []);
  });
});

test('a microphone that dies during a cast is reported once and the cast continues', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke(
      'start-stream', calibratedRequest({ streamMic: true }), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);
    const [primary, microphone] = main.children;

    microphone.exitUnexpectedly(1);
    await settle();
    assert.deepEqual(main.sentOn('microphone-exit'), [{ generation: result.generation }]);
    assert.deepEqual(main.sentOn('stream-exit'), []);
    assert.equal(primary.killed, false);
    assert.deepEqual(await main.invoke('stop-stream'), { success: true });
  });
});

test('a reconnect restores the ADB transport first, and a recovered cast gets its full retry budget back', async (t) => {
  // Only setTimeout is faked, so the 2-second reconnect delay can be stepped
  // through; the harness itself runs on setImmediate.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);

    main.children[0].exitUnexpectedly(1);
    await settle();
    assert.deepEqual(
      await main.invoke('request-reconnect', result.generation),
      { scheduled: true, retry: 1, delayMs: 2000 });
    main.adbCalls.length = 0;

    t.mock.timers.tick(2000);
    await settle(12);
    assert.deepEqual(main.adbCalls.slice(0, 2), [['connect', SERIAL], ['devices']]);
    assert.equal(main.children.length, 2);
    assert.equal(main.children[1].killed, false);
    assert.equal(main.sentOn('stream-status').length, 2);

    // The second drop is a new outage: first delay again, not the 5-second one.
    main.children[1].exitUnexpectedly(1);
    await settle();
    assert.deepEqual(
      await main.invoke('request-reconnect', result.generation),
      { scheduled: true, retry: 1, delayMs: 2000 });
  });
});

test('a reconnect that cannot reach the headset reports the cast as ended without relaunching', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let refuse = false;
  const adb = (args) => {
    if (refuse && args[0] === 'connect') {
      return { stdout: `cannot connect to ${SERIAL}: No connection could be made because the target machine actively refused it.\n` };
    }
    if (refuse && args[0] === 'devices') return { stdout: 'List of devices attached\n\n' };
    return quest3sAdb(args);
  };
  await withMain({ adb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);
    main.children[0].exitUnexpectedly(1);
    await settle();
    await main.invoke('request-reconnect', result.generation);
    refuse = true;

    t.mock.timers.tick(2000);
    await settle(12);
    assert.equal(main.children.length, 1);
    assert.deepEqual(main.sentOn('stream-exit').map((exit) => exit.code), [1, -1]);
  });
});

test('a reconnect is refused while the stream is running and scheduled once it has exited', async () => {
  await withMain({ adb: quest3sAdb, textureLine: TEXTURE_LINE }, async (main) => {
    const result = await main.invoke('start-stream', calibratedRequest(), RUNTIME_CONFIG);
    assert.equal(result.success, true, result.error);

    assert.deepEqual(
      await main.invoke('request-reconnect', result.generation),
      { scheduled: false, retry: 0, delayMs: null });
    assert.equal(main.children[0].killed, false);
    assert.deepEqual(
      await main.invoke('request-reconnect', 'not-a-generation'),
      { scheduled: false, retry: 0, delayMs: null });

    main.children[0].exitUnexpectedly(1);
    await settle();
    assert.deepEqual(
      await main.invoke('request-reconnect', result.generation),
      { scheduled: true, retry: 1, delayMs: 2000 });
    // Stopping (in dispose) cancels the pending reconnect timer.
  });
});
