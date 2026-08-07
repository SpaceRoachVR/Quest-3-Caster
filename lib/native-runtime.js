'use strict';

const path = require('node:path');
const {
  inspectNativeBundleSnapshot,
  loadNativeBundleSnapshot,
  resolveNativeBundleDirectory,
} = require('./native-bundle');
const { parseNativeCapabilities } = require('./native-preflight');

function defaultInspectBundle(bundleDirectory) {
  const inspected = inspectNativeBundleSnapshot(
    loadNativeBundleSnapshot(bundleDirectory),
  );
  return { ...inspected, bundleDirectory };
}

function createNativeRuntime({
  isPackaged,
  appPath,
  resourcesPath,
  inspectBundle = defaultInspectBundle,
}) {
  if (typeof inspectBundle !== 'function') {
    throw new TypeError('inspectBundle must be a function.');
  }
  const bundleDirectory = resolveNativeBundleDirectory({
    isPackaged,
    appPath,
    resourcesPath,
  });
  // This performs exact file-set, hash, architecture, and role validation
  // before any executable path is returned to a caller.
  const inspected = inspectBundle(bundleDirectory);
  if (
    !inspected
    || inspected.bundleDirectory !== bundleDirectory
    || typeof inspected.clientPath !== 'string'
  ) {
    throw new Error('Native bundle verification returned an invalid runtime.');
  }
  const currentPath = process.env.PATH || process.env.Path || '';
  return Object.freeze({
    bundleDirectory,
    clientPath: path.join(bundleDirectory, inspected.clientPath),
    manifest: inspected.manifest,
    spawnOptions: Object.freeze({
      cwd: bundleDirectory,
      windowsHide: true,
      shell: false,
      env: Object.freeze({
        ...process.env,
        PATH: `${bundleDirectory}${path.delimiter}${currentPath}`,
        SCRCPY_SERVER_PATH: path.join(bundleDirectory, 'scrcpy-server'),
      }),
    }),
  });
}

async function runCapabilityProbe(runtime, { runFile, timeoutMs = 5000 } = {}) {
  if (!runtime || typeof runtime.clientPath !== 'string') {
    throw new Error('A verified native runtime is required.');
  }
  if (typeof runFile !== 'function') {
    throw new TypeError('runFile must be a function.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) {
    throw new Error('Capability timeout must be between 1000 and 15000 milliseconds.');
  }
  const result = await runFile(
    runtime.clientPath,
    ['--q3c-capabilities'],
    { ...runtime.spawnOptions, timeoutMs },
  );
  if (!result || result.success !== true) {
    const detail = result?.stderr || result?.error || 'unknown execution failure';
    throw new Error(`Native capability probe failed: ${detail}`);
  }
  return parseNativeCapabilities(result.stdout);
}

module.exports = {
  createNativeRuntime,
  runCapabilityProbe,
};
