'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createNativeRuntime,
  runCapabilityProbe,
} = require('../lib/native-runtime');

test('runtime resolves dev and packaged bundle only after verification', () => {
  const calls = [];
  const runtime = createNativeRuntime({
    isPackaged: false,
    appPath: 'C:\\app',
    resourcesPath: 'C:\\resources',
    inspectBundle(directory) {
      calls.push(directory);
      return {
        bundleDirectory: directory,
        clientPath: 'scrcpy.exe',
        manifest: { upstream: { version: '4.1' } },
      };
    },
  });
  assert.deepEqual(calls, [path.join('C:\\app', 'resources', 'native', 'win32-x64')]);
  assert.equal(runtime.clientPath, path.join(runtime.bundleDirectory, 'scrcpy.exe'));
  assert.equal(runtime.spawnOptions.shell, false);
  assert.equal(runtime.spawnOptions.windowsHide, true);
  assert.equal(runtime.spawnOptions.cwd, runtime.bundleDirectory);
  assert.match(runtime.spawnOptions.env.PATH, new RegExp(
    runtime.bundleDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ));
});

test('capability probe is bounded, shell-free, and parses exact output', async () => {
  const calls = [];
  const capabilities = await runCapabilityProbe({
    clientPath: 'C:\\bundle\\scrcpy.exe',
    spawnOptions: { cwd: 'C:\\bundle', env: {}, shell: false, windowsHide: true },
  }, {
    runFile(executable, args, options) {
      calls.push({ executable, args, options });
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          schemaVersion: 1,
          upstreamVersion: '4.1',
          forkVersion: 'quest3caster-stabilization-1',
          profiles: [
            'obsLowLatency1080p60', 'obsStabilized1080p60',
            'obsLowLatencySquareLeft1080p60', 'obsLowLatencySquareRight1080p60',
          ],
          stabilizationModes: ['off', 'openclFeaturePoint'],
          openclAvailable: true,
          gpu: 'GPU',
          output: { width: 1920, height: 1080 },
          delays: {
            lowLatencyNominalMs: 0,
            stabilizedNominalMs: 100,
            stabilizedMaximumMs: 120,
          },
          calibratedSource: { width: 4128, height: 2208 },
          diagnostic: 'ready',
        }),
      });
    },
  });
  assert.equal(capabilities.gpu, 'GPU');
  assert.deepEqual(calls[0].args, ['--q3c-capabilities']);
  assert.equal(calls[0].options.timeoutMs, 5000);
});

test('bundle verification failure prevents capability execution', async () => {
  let executed = false;
  assert.throws(() => createNativeRuntime({
    isPackaged: true,
    appPath: 'C:\\app',
    resourcesPath: 'C:\\resources',
    inspectBundle() {
      throw new Error('hash mismatch');
    },
  }), /hash mismatch/);
  assert.equal(executed, false);
});
