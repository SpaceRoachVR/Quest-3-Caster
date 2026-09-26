const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const {
  buildVolumeScript,
  createVolumeProcessResult,
  isMissingAudioSession,
  validateVolume
} = require('./lib/audio-volume');

const VOLUME_ATTEMPTS = 5;
const VOLUME_RETRY_DELAY_MS = 400;
const {
  buildScrcpyArguments,
  calculateOutputSize,
  filterH264Encoders,
  formatOutputEstimate,
  getProductionProfile,
  parseCrop,
  validateAdbSerial,
  validateStreamConfig
} = require('./lib/stream-config');
const { createStreamSession } = require('./lib/stream-session');
const { createStreamChildOwnership } = require('./lib/stream-child-ownership');
const {
  createStartFailureResult,
  hasCurrentLivePrimary,
  shouldCleanupFailedStart
} = require('./lib/stream-start-outcome');
const {
  LOCKED_PROFILE_IDS,
  buildLockedMicrophoneArguments,
  buildLockedPrimaryArguments,
  isLockedProfileId,
  normalizeLockedStreamRequest
} = require('./lib/locked-native-profiles');
const { getProfileGeometry } = require('./lib/locked-profile-geometry');
const { getLockedProfileSupport, identifyDevice } = require('./lib/device-registry');
const {
  buildCalibratedMicrophoneArguments,
  buildCalibratedPrimaryArguments,
  getCalibratedProfileAvailability,
  isCalibratedProfileId,
  normalizeCalibratedStreamRequest,
  resolveCalibratedProfile
} = require('./lib/calibrated-profiles');
const { launchCalibratedAttempt } = require('./lib/calibrated-startup');
const {
  assertCalibrationMatchesDisplay,
  loadCalibration
} = require('./lib/calibration-store');
const { describeDisplayOverride, parseWmSizes } = require('./lib/display-geometry');
const { describeRefreshRate, parseRefreshRateHz } = require('./lib/display-refresh');
const { connectWirelessTarget } = require('./lib/wireless-adb');
const { enableLegacyTcpIp, readHeadsetIp } = require('./lib/usb-setup');
const {
  buildLockedProfilePreflight,
  classifyAdbState
} = require('./lib/native-preflight');
const { createNativeAttemptState } = require('./lib/native-attempt-state');
const { createNativeRuntime, runCapabilityProbe } = require('./lib/native-runtime');
const { resolveNativeBundleDirectory } = require('./lib/native-bundle');
const { launchNativeAttempt } = require('./lib/native-startup');
const { createStartOperationGate } = require('./lib/start-operation-gate');
const { createNativeContextAuthority } = require('./lib/native-context-authority');
const { waitForProcessExit } = require('./lib/process-exit');
const { createFallbackCoordinator } = require('./lib/fallback-coordinator');
const {
  createTerminationRegistry
} = require('./lib/termination-registry');

const { RollingFileLogger } = require('./lib/file-logger');

let mainWindow = null;
const childOwnership = createStreamChildOwnership();
let lastStreamRequest = null;
const startOperationGate = createStartOperationGate();
let currentNativeContext = null;
let pendingStart = null;
const terminationRegistry = createTerminationRegistry();
let fileLogger = null;
let activeProximityBypass = null;
let restoringProximityBeforeQuit = false;

const streamSession = createStreamSession({
  scheduler: global,
  reconnectDelaysMs: [2000, 5000, 10000],
  onReconnect: (generation) => {
    if (!streamSession.isCurrent(generation) || !lastStreamRequest) {
      return;
    }

    sendLog(`[System] Reconnecting stream (attempt ${streamSession.getRetryState().retryCount}).`);
    const reconnect = lastStreamRequest.locked === true
      ? relaunchLockedStream(lastStreamRequest.context)
      : launchStream(generation, lastStreamRequest.streamConfig, lastStreamRequest.runtimeConfig);
    reconnect
      .catch((error) => {
        if (!streamSession.isCurrent(generation)) return;
        sendLog(`[System-Error] Reconnect failed: ${error.message}`);
        sendPrimaryExit(generation, -1, null);
      });
  }
});
const nativeContextAuthority = createNativeContextAuthority({
  streamSession,
  operationGate: startOperationGate,
  getCurrentContext: () => currentNativeContext,
  getOwnership: () => childOwnership.snapshot()
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 700,
    title: 'Quest 3 Caster',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    backgroundColor: '#10151d'
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanup();
  });
}

function sendLog(message) {
  fileLogger?.write(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', String(message));
  }
}

function terminateProcess(child, name) {
  if (!child) {
    return;
  }

  try {
    child.kill();
  } catch (error) {
    console.error(`Failed to kill ${name} process`, error);
  }
}

function terminateStreamHandles() {
  childOwnership.stop();
}

function cleanup() {
  startOperationGate.invalidate();
  cancelPendingStart();
  cancelCurrentNativeAttempt();
  streamSession.stop();
  lastStreamRequest = null;
  terminateStreamHandles();
}

function cancelCurrentNativeAttempt() {
  const context = currentNativeContext;
  if (!context) return;
  const owned = childOwnership.snapshot();
  if (owned.generation === context.generation) {
    context.terminatingChildren.retain(owned.primary);
    context.terminatingChildren.retain(owned.microphone);
  }
  context.terminatingChildren.retryTermination();
  context.state.cancel();
  if (context.attemptHandle) {
    context.attemptHandle.dispose();
  }
  context.attemptHandle = null;
  currentNativeContext = null;
  context.terminationLease.dispose();
}

function cancelInFlightFallback() {
  const context = currentNativeContext;
  if (!context?.fallbackInFlight) return false;
  const owned = childOwnership.snapshot();
  if (owned.generation === context.generation) {
    context.terminatingChildren.retain(owned.primary);
    context.terminatingChildren.retain(owned.microphone);
  }
  context.state.cancel();
  if (context.attemptHandle) context.attemptHandle.dispose();
  context.attemptHandle = null;
  if (context.terminatingChildren.canLaunchReplacement()) {
    clearOwnedNativeChildren(context);
  }
  if (streamSession.isCurrent(context.generation)) {
    streamSession.stop();
  }
  currentNativeContext = null;
  if (lastStreamRequest?.context === context) {
    lastStreamRequest = null;
  }
  context.terminationLease.dispose();
  return true;
}

async function requireRetainedChildrenExited() {
  const result = await terminationRegistry.terminateAndWait({
    waitForExit: (child) => waitForProcessExit(child)
  });
  if (!result.allExited) {
    throw new Error(
      'A previous native process has not exited; replacement is blocked to prevent port overlap.'
    );
  }
}

function cancelPendingStart() {
  const pending = pendingStart;
  pendingStart = null;
  if (pending && typeof pending.cancel === 'function') {
    pending.cancel();
    return true;
  }
  return false;
}

function registerPendingStart(operationToken, generation, nativeContext = null) {
  const terminationLease = nativeContext?.terminationLease
    || terminationRegistry.createContextLease();
  const terminatingChildren = terminationLease.collection;
  pendingStart = {
    operationToken,
    generation,
    nativeContext,
    terminationLease,
    terminatingChildren,
    cancel() {
      const owned = childOwnership.snapshot();
      if (owned.generation === generation) {
        terminatingChildren.retain(owned.primary);
        terminatingChildren.retain(owned.microphone);
      }
      if (nativeContext && currentNativeContext === nativeContext) {
        nativeContext.state.cancel();
        if (nativeContext.attemptHandle) nativeContext.attemptHandle.dispose();
        nativeContext.attemptHandle = null;
        currentNativeContext = null;
      }
      if (owned.generation === generation) {
        childOwnership.stop();
      }
      if (streamSession.isCurrent(generation)) {
        streamSession.stop();
      }
      terminationLease.dispose();
    }
  };
}

function completePendingStart(operationToken) {
  if (pendingStart?.operationToken === operationToken) {
    if (!pendingStart.nativeContext) {
      pendingStart.terminationLease.dispose();
    }
    pendingStart = null;
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const dataDirectory = app.getPath('userData');
  fileLogger = new RollingFileLogger({ fs, directory: path.join(dataDirectory, 'logs') });
  sendLog('[System] Quest 3 Caster started.');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// The headset keeps a bypassed proximity sensor after this process exits, so
// hold the quit open just long enough to hand the headset back in a sane state.
app.on('will-quit', (event) => {
  if (restoringProximityBeforeQuit || !activeProximityBypass) {
    return;
  }
  restoringProximityBeforeQuit = true;
  event.preventDefault();
  restoreProximityBypass().finally(() => app.quit());
});

function normalizeExecutablePath(value, fallback, label) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value !== 'string' || value.length > 32767 || value.trim() !== value) {
    throw new Error(`Invalid ${label} path.`);
  }
  return value;
}

function normalizeRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Runtime configuration is required.');
  }

  const bundled = getBundledToolPaths();
  return {
    adbPath: normalizeExecutablePath(config.adbPath, bundled.adbPath, 'ADB'),
    scrcpyPath: normalizeExecutablePath(config.scrcpyPath, bundled.scrcpyPath, 'scrcpy')
  };
}

// Falling back to a bare "adb" runs whatever happens to be on PATH, which is
// often an unrelated tool's old copy. Mismatched adb versions kill each other's
// server, so prefer the binaries shipped alongside this app.
let cachedBundledToolPaths = null;

function getBundledToolPaths() {
  if (cachedBundledToolPaths) {
    return cachedBundledToolPaths;
  }
  let resolved = { adbPath: 'adb', scrcpyPath: 'scrcpy' };
  try {
    const bundleDirectory = resolveNativeBundleDirectory({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    });
    const adbPath = path.join(bundleDirectory, 'adb.exe');
    const scrcpyPath = path.join(bundleDirectory, 'scrcpy.exe');
    resolved = {
      adbPath: fs.existsSync(adbPath) ? adbPath : 'adb',
      scrcpyPath: fs.existsSync(scrcpyPath) ? scrcpyPath : 'scrcpy'
    };
  } catch (_error) {
    // A missing or unreadable bundle falls back to PATH lookup below.
  }
  cachedBundledToolPaths = resolved;
  return cachedBundledToolPaths;
}

function runFile(executable, args, timeoutMs = 10000) {
  const executionOptions = typeof timeoutMs === 'object' && timeoutMs !== null
    ? timeoutMs
    : { timeoutMs };
  return new Promise((resolve) => {
    execFile(executable, args, {
      cwd: executionOptions.cwd,
      env: executionOptions.env,
      timeout: executionOptions.timeoutMs ?? 10000,
      maxBuffer: executionOptions.maxBuffer ?? 64 * 1024,
      windowsHide: executionOptions.windowsHide !== false,
      shell: false
    }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: stdout ? String(stdout) : '',
        stderr: stderr ? String(stderr) : '',
        error: error ? error.message : null
      });
    });
  });
}

function getVerifiedNativeRuntime() {
  try {
    return createNativeRuntime({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    });
  } catch (error) {
    throw new Error(
      `Bundled OBS casting is unavailable: ${error.message}. Run npm run native:build or restore the verified native bundle.`
    );
  }
}

function sendStreamStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stream-status', status);
  }
}

function createLockedStatus(requestedProfile, readyEvent, generation, fallbackWarning = null) {
  return Object.freeze({
    requestedProfile,
    effectiveProfile: readyEvent.effectiveProfile,
    output: Object.freeze({ width: readyEvent.output.width, height: readyEvent.output.height }),
    stabilization: readyEvent.stabilization.active ? 'openclFeaturePoint' : 'off',
    gpu: readyEvent.gpu,
    nominalDelayMs: readyEvent.nominalDelayMs,
    estimatedDelayMs: readyEvent.nominalDelayMs,
    generation,
    fallbackWarning
  });
}

function runAdb(args, config) {
  const runtimeConfig = normalizeRuntimeConfig(config);
  return runFile(runtimeConfig.adbPath, args);
}

async function readDisplayGeometry(serial, runtimeConfig) {
  const result = await runFile(runtimeConfig.adbPath, ['-s', serial, 'shell', 'wm', 'size']);
  const { physical, override } = parseWmSizes(result.stdout);
  const effective = override || physical;
  if (!effective) {
    throw new Error(result.stderr || result.error || 'Unable to determine headset display size.');
  }
  return {
    displaySize: { width: effective.width, height: effective.height },
    physical,
    override
  };
}

async function getDisplaySize(serial, runtimeConfig) {
  return (await readDisplayGeometry(serial, runtimeConfig)).displaySize;
}

// Best-effort: a headset that will not answer, or a dump in a shape the parser
// does not know, yields null and the cast proceeds without the cadence warning.
// `dumpsys display` runs well past runFile's default 64 KiB buffer.
async function readDisplayRefreshRate(serial, runtimeConfig) {
  try {
    const result = await runFile(
      runtimeConfig.adbPath,
      ['-s', serial, 'shell', 'dumpsys', 'display'],
      { timeoutMs: 10000, maxBuffer: 4 * 1024 * 1024 }
    );
    return result.success ? parseRefreshRateHz(result.stdout) : null;
  } catch (_error) {
    return null;
  }
}

// Two headsets share a panel resolution, so geometry alone cannot name the
// device. The model turns "your display must be 4128x2208" into "your Quest 3S
// is not calibrated yet". Best-effort: a headset that will not answer still
// preflights, it just gets identified by geometry.
// A user's own measurement of their own headset outranks anything shipped,
// because a calibration is per-unit rather than per-model. `app.getPath` is
// unavailable outside Electron, so the user directory is best-effort.
function getCalibrationDirectories() {
  const directories = [];
  try {
    directories.push(path.join(app.getPath('userData'), 'calibration'));
  } catch (_error) {
    // Falls through to the bundled directory below.
  }
  directories.push(path.join(__dirname, 'calibration'));
  return directories;
}

async function readDeviceModel(serial, runtimeConfig) {
  try {
    const result = await runFile(
      runtimeConfig.adbPath, ['-s', serial, 'shell', 'getprop', 'ro.product.model']);
    const model = String(result.stdout || '').trim();
    return model && model.length <= 64 ? model : null;
  } catch (_error) {
    return null;
  }
}

function getStreamPresentationArgs(streamConfig) {
  const args = [];
  const renderDrivers = new Set(['default', 'direct3d', 'opengl', 'software']);
  if (streamConfig.renderDriver !== undefined && streamConfig.renderDriver !== null) {
    if (!renderDrivers.has(streamConfig.renderDriver)) {
      throw new Error('Unsupported render driver.');
    }
    if (streamConfig.renderDriver !== 'default') {
      args.push('--render-driver', streamConfig.renderDriver);
    }
  }

  if (streamConfig.displayId !== undefined && streamConfig.displayId !== null && streamConfig.displayId !== 'default') {
    if (!Number.isSafeInteger(Number(streamConfig.displayId)) || Number(streamConfig.displayId) < 0) {
      throw new Error('Display ID must be a non-negative integer.');
    }
    args.push('--display-id', String(Number(streamConfig.displayId)));
  }

  return args;
}

function normalizeStreamConfig(streamConfig, displaySize) {
  if (!streamConfig || typeof streamConfig !== 'object' || Array.isArray(streamConfig)) {
    throw new Error('Stream configuration is required.');
  }

  const configWithFullDisplayCrop = streamConfig.crop === 'none'
    ? { ...streamConfig, crop: `${displaySize.width}:${displaySize.height}:0:0` }
    : streamConfig;
  const validated = validateStreamConfig(configWithFullDisplayCrop, displaySize);
  if (streamConfig.streamMic !== undefined && typeof streamConfig.streamMic !== 'boolean') {
    throw new Error('Microphone stream state must be a boolean.');
  }
  if (streamConfig.micSource !== undefined && !['mic', 'mic-unprocessed', 'mic-voice-recognition', 'mic-voice-communication'].includes(streamConfig.micSource)) {
    throw new Error('Unsupported microphone source.');
  }
  getStreamPresentationArgs(streamConfig);
  return validated;
}

async function detectScrcpyMajorVersion(scrcpyPath) {
  const versionResult = await runFile(scrcpyPath, ['--version']);
  const match = /scrcpy\s+([0-9]+)/i.exec(versionResult.stdout);
  return match ? Number(match[1]) : 2;
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function attachChildLogListeners(child, label, generation) {
  if (child.stdout) {
    child.stdout.on('data', (data) => {
      if (streamSession.isCurrent(generation)) {
        sendLog(`[${label}] ${String(data).trim()}`);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (data) => {
      if (streamSession.isCurrent(generation)) {
        sendLog(`[${label}] ${String(data).trim()}`);
      }
    });
  }
}

function sendPrimaryExit(generation, code, signal) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stream-exit', { generation, code, signal });
  }
}

function attachPrimaryLifecycle(child, generation) {
  let exitSent = false;
  child.on('error', (error) => {
    if (!streamSession.isCurrent(generation)) return;
    if (!childOwnership.clearPrimaryAndTerminateMicrophone(generation, child)) return;
    sendLog(`[System-Error] Failed to launch scrcpy process: ${error.message}. Check your scrcpy path in Settings!`);
    if (!exitSent) {
      exitSent = true;
      sendPrimaryExit(generation, -1, null);
    }
  });
  child.on('exit', (code, signal) => {
    if (!streamSession.isCurrent(generation)) return;
    if (!childOwnership.clearPrimaryAndTerminateMicrophone(generation, child)) return;
    sendLog(`[System] scrcpy stream exited with code ${code} and signal ${signal}`);
    if (!exitSent) {
      exitSent = true;
      sendPrimaryExit(generation, code, signal);
    }
  });
  attachChildLogListeners(child, 'scrcpy', generation);
}

function attachMicrophoneLifecycle(child, generation) {
  child.on('error', (error) => {
    if (!streamSession.isCurrent(generation)) return;
    if (!childOwnership.clearMicrophone(generation, child)) return;
    sendLog(`[System-Error] Failed to launch microphone stream: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (!streamSession.isCurrent(generation)) return;
    if (!childOwnership.clearMicrophone(generation, child)) return;
    sendLog(`[System] Microphone stream exited with code ${code} and signal ${signal}`);
  });
  attachChildLogListeners(child, 'scrcpy-mic', generation);
}

async function launchMicrophoneStream(generation, streamConfig, runtimeConfig) {
  if (!streamConfig.streamMic || !streamSession.isCurrent(generation)) {
    return;
  }

  const micArgs = [
    '-s', streamConfig.serial,
    '--port', '27190',
    '--no-video',
    '--no-control',
    // Defaults to VOICE_RECOGNITION for the same reason as the locked
    // profiles: MIC is echo-cancelled against the headset speakers, which
    // suppresses the wearer's voice whenever game audio is loud.
    '--audio-source', streamConfig.micSource || 'mic-voice-recognition',
    '--audio-codec', 'aac',
    // The 128 kbps default smears a close microphone once the wearer raises
    // their voice over loud game audio. See the locked profile arguments.
    '--audio-bit-rate=256K'
  ];
  sendLog(`[System] Launching secondary scrcpy instance to stream headset microphone.`);
  const child = spawn(runtimeConfig.scrcpyPath, micArgs, { windowsHide: true });
  if (!childOwnership.setMicrophone(generation, child)) {
    terminateProcess(child, 'scrcpy microphone');
    return;
  }
  attachMicrophoneLifecycle(child, generation);
  try {
    await waitForChildSpawn(child);
  } catch (error) {
    // The lifecycle listener reports microphone launch failures without ending the primary stream.
  }
}

function isNativeContextCurrent(context) {
  return nativeContextAuthority.isContextCurrent(context);
}

function isNativeAttemptCurrent(context, attemptRecord) {
  return nativeContextAuthority.isAttemptCurrent(context, attemptRecord);
}

function clearOwnedNativeChildren(context, primaryChild = null) {
  const owned = childOwnership.snapshot();
  if (owned.generation !== context.generation) return;
  if (primaryChild && owned.primary !== primaryChild) return;
  if (owned.primary) {
    childOwnership.clearPrimaryAndTerminateMicrophone(
      context.generation,
      owned.primary
    );
  } else if (owned.microphone) {
    childOwnership.clearMicrophone(context.generation, owned.microphone);
    terminateProcess(owned.microphone, 'bundled scrcpy microphone');
  }
}

function markNativeTerminal(context, message) {
  if (!isNativeContextCurrent(context) || context.terminal) return;
  context.state.markFallbackTerminal();
  streamSession.cancelReconnect();
  finalizeNativeTerminal(context, message);
}

function finalizeNativeTerminal(context, message) {
  if (!isNativeContextCurrent(context) || context.terminal) return;
  context.terminal = true;
  context.fallbackInFlight = false;
  const owned = childOwnership.snapshot();
  if (owned.generation === context.generation) {
    context.terminatingChildren.retain(owned.primary);
    context.terminatingChildren.retain(owned.microphone);
  }
  if (context.terminatingChildren.canLaunchReplacement()) {
    clearOwnedNativeChildren(context);
  } else {
    context.terminatingChildren.retryTermination();
  }
  if (context.attemptHandle) {
    context.attemptHandle.dispose();
    context.attemptHandle = null;
  }
  sendLog(`[System-Error] ${message}`);
  if (!context.exitSent) {
    context.exitSent = true;
    sendPrimaryExit(context.generation, -1, null);
  }
}

function handleNativeRuntimeExit(context, attemptRecord, child, event) {
  if (!isNativeAttemptCurrent(context, attemptRecord)) return;
  clearOwnedNativeChildren(context, child);
  if (context.attemptHandle === attemptRecord.handle) {
    context.attemptHandle = null;
  }
  if (!attemptRecord.published) {
    attemptRecord.boundaryFailure = new Error(
      event.error || `Native client exited at readiness (code ${event.code}, signal ${event.signal}).`
    );
    attemptRecord.boundaryFailure.code = 'native_ready_boundary_exit';
    return;
  }
  sendLog(event.error
    ? `[System-Error] Bundled native stream failed: ${event.error}`
    : `[System] Bundled native stream exited with code ${event.code} and signal ${event.signal}.`);
  if (!attemptRecord.exitSent) {
    attemptRecord.exitSent = true;
    sendPrimaryExit(context.generation, event.code, event.signal);
  }
}

async function launchLockedMicrophoneStream(context, attemptRecord, primaryChild) {
  if (!context.request.streamMic) return null;
  const micArgs = context.mode === 'calibrated'
    ? buildCalibratedMicrophoneArguments(context.request)
    : buildLockedMicrophoneArguments(
      context.request,
      attemptRecord.attempt.profileId
    );
  sendLog('[System] Launching verified bundled microphone stream.');
  let child;
  try {
    child = spawn(
      context.nativeRuntime.clientPath,
      micArgs,
      context.nativeRuntime.spawnOptions
    );
  } catch (error) {
    throw new Error(`Failed to launch bundled microphone stream: ${error.message}`);
  }
  if (!childOwnership.setMicrophone(context.generation, child)) {
    terminateProcess(child, 'bundled scrcpy microphone');
    throw new Error('Stream generation is no longer active.');
  }
  attachMicrophoneLifecycle(child, context.generation);
  try {
    await waitForChildSpawn(child);
  } catch (error) {
    terminateProcess(child, 'bundled scrcpy microphone');
    throw new Error(`Failed to launch bundled microphone stream: ${error.message}`);
  }
  const owned = childOwnership.snapshot();
  if (
    !isNativeAttemptCurrent(context, attemptRecord)
    || owned.generation !== context.generation
    || owned.primary !== primaryChild
    || owned.microphone !== child
  ) {
    const termination = await context.terminatingChildren.terminateAndWait(
      [child],
      { waitForExit: (candidate) => waitForProcessExit(candidate) }
    );
    if (
      termination.allExited
      && childOwnership.clearMicrophone(context.generation, child)
    ) {
      terminateProcess(child, 'stale bundled scrcpy microphone');
    }
    throw new Error('Microphone launch was superseded.');
  }
  return child;
}

async function performRuntimeFallback(context, attemptRecord, reason) {
  if (!isNativeAttemptCurrent(context, attemptRecord)) return;
  const action = context.fallback.request(attemptRecord.attempt.token, reason);
  if (action !== 'begin') return;

  context.fallbackInFlight = true;
  const owned = childOwnership.snapshot();
  const currentChild = owned.generation === context.generation ? owned.primary : null;
  const currentMicrophone = owned.generation === context.generation
    ? owned.microphone
    : null;
  if (context.attemptHandle) {
    context.attemptHandle.dispose();
    context.attemptHandle = null;
  }
  const termination = await context.terminatingChildren.terminateAndWait(
    [currentChild, currentMicrophone],
    { waitForExit: (child) => waitForProcessExit(child) }
  );
  if (!isNativeContextCurrent(context)) return;
  if (!termination.allExited) {
    context.fallback.terminate(
      'Previous native processes did not terminate; Low Latency fallback was blocked.'
    );
    return;
  }
  clearOwnedNativeChildren(context, currentChild);
  const fallbackAttempt = context.state.beginFallback(attemptRecord.attempt.token);
  if (!isNativeContextCurrent(context)) return;
  if (!fallbackAttempt) {
    context.fallback.terminate('Low Latency fallback could not begin.');
    return;
  }
  sendLog(`[System-Warning] ${reason} Falling back once to OBS Low Latency.`);
  try {
    const result = await launchLockedProfileAttempt(context, fallbackAttempt);
    if (!isNativeContextCurrent(context) || context.terminal) return;
    nativeContextAuthority.assertAttemptCompletion({
      context,
      attemptRecord: result.attemptRecord,
      primaryChild: result.primaryChild
    });
    result.attemptRecord.published = true;
    context.fallbackInFlight = false;
    context.effectiveProfile = result.status.effectiveProfile;
    sendStreamStatus(result.status);
  } catch (error) {
    if (!isNativeContextCurrent(context)) return;
    context.fallback.terminate(`Low Latency fallback failed: ${error.message}`);
  }
}

async function launchLockedProfileAttempt(context, attempt) {
  if (!isNativeContextCurrent(context)
      || !context.state.accepts(attempt.token, context.generation)) {
    throw new Error('Stream attempt is no longer active.');
  }
  const attemptRecord = {
    attempt,
    state: context.state,
    handle: null,
    published: false,
    boundaryFailure: null,
    exitSent: false
  };
  const attemptRequest = Object.freeze({
    ...context.request,
    profileId: attempt.profileId
  });
  const calibrated = context.mode === 'calibrated';
  const args = calibrated
    ? buildCalibratedPrimaryArguments(attemptRequest, context.calibration)
    : buildLockedPrimaryArguments(attemptRequest, context.generation);
  sendLog(calibrated
    ? `[System] Launching ${attempt.profileId} from this headset's calibration.`
    : `[System] Launching verified bundled ${attempt.profileId} with trusted native arguments.`);
  let child;
  try {
    child = spawn(
      context.nativeRuntime.clientPath,
      args,
      context.nativeRuntime.spawnOptions
    );
  } catch (error) {
    throw new Error(`Failed to launch bundled scrcpy: ${error.message}`);
  }
  if (!childOwnership.setPrimary(context.generation, child)) {
    terminateProcess(child, 'bundled scrcpy');
    throw new Error('Stream generation is no longer active.');
  }

  let attemptHandle;
  try {
    // Both paths resolve to the same handle shape. They differ only in what
    // counts as proof the stream is live: the fork's own ready event, or
    // scrcpy's texture line matched against the measured crop.
    const awaitAttempt = calibrated ? launchCalibratedAttempt : launchNativeAttempt;
    attemptHandle = await awaitAttempt({
      child,
      generation: context.generation,
      profileId: attempt.profileId,
      expectedOutput: calibrated ? context.expectedOutput : undefined,
      expectedGpu: attempt.profileId === 'obsStabilized1080p60'
        ? context.capabilities.gpu
        : null,
      startupTimeoutMs: calibrated ? 15000 : 10000,
      onLog: (line) => {
        if (isNativeAttemptCurrent(context, attemptRecord)) {
          sendLog(`[scrcpy] ${line}`);
        }
      },
      onRuntimeEvent: (nativeEvent) => {
        if (!isNativeAttemptCurrent(context, attemptRecord)) return;
        if (nativeEvent.type === 'fatal'
            && nativeEvent.code === 'stabilization_unavailable') {
          void performRuntimeFallback(context, attemptRecord, nativeEvent.message);
        } else if (nativeEvent.type === 'warning') {
          sendLog(`[Native-Warning] ${nativeEvent.message}`);
        } else {
          markNativeTerminal(context, `Native fatal: ${nativeEvent.message}`);
        }
      },
      onRuntimeExit: (event) => {
        handleNativeRuntimeExit(context, attemptRecord, child, event);
      }
    });
    attemptRecord.handle = attemptHandle;
  } catch (error) {
    const owned = childOwnership.snapshot();
    const termination = await context.terminatingChildren.terminateAndWait(
      [
        child,
        owned.generation === context.generation ? owned.microphone : null
      ],
      { waitForExit: (candidate) => waitForProcessExit(candidate) }
    );
    if (!termination.allExited) {
      const terminationError = new Error(
        'Native client did not terminate after the failed startup attempt.'
      );
      terminationError.code = 'native_shutdown_failed';
      throw terminationError;
    }
    clearOwnedNativeChildren(context, child);
    throw error;
  }

  try {
    nativeContextAuthority.assertAttemptCompletion({
      context,
      attemptRecord,
      primaryChild: child
    });
  } catch (error) {
    attemptHandle.dispose();
    clearOwnedNativeChildren(context, child);
    throw error;
  }
  if (context.attemptHandle) context.attemptHandle.dispose();
  context.attemptHandle = attemptHandle;
  context.state.markReady(attempt.token);
  let microphoneChild = null;
  try {
    microphoneChild = await launchLockedMicrophoneStream(
      context,
      attemptRecord,
      child
    );
  } catch (error) {
    attemptHandle.dispose();
    if (context.attemptHandle === attemptHandle) context.attemptHandle = null;
    const owned = childOwnership.snapshot();
    const termination = await context.terminatingChildren.terminateAndWait(
      [
        child,
        owned.generation === context.generation ? owned.microphone : null
      ],
      { waitForExit: (candidate) => waitForProcessExit(candidate) }
    );
    if (!termination.allExited) {
      const terminationError = new Error(
        'Native processes did not terminate after microphone launch failure.'
      );
      terminationError.code = 'native_shutdown_failed';
      throw terminationError;
    }
    clearOwnedNativeChildren(context, child);
    throw error;
  }
  const ownedAfterMicrophone = childOwnership.snapshot();
  try {
    nativeContextAuthority.assertAttemptCompletion({
      context,
      attemptRecord,
      primaryChild: child,
      microphoneChild,
      requireMicrophone: context.request.streamMic
    });
  } catch (error) {
    clearOwnedNativeChildren(context, child);
    attemptHandle.dispose();
    throw error;
  }
  const attemptSnapshot = context.state.snapshot();
  return {
    status: createLockedStatus(
      attemptSnapshot.requestedProfile,
      attemptHandle.ready,
      context.generation,
      attemptSnapshot.fallbackWarning
    ),
    attemptRecord,
    primaryChild: child
  };
}

async function launchLockedStream(context) {
  let attempt = context.state.beginAttempt(context.request.profileId);
  try {
    return await launchLockedProfileAttempt(context, attempt);
  } catch (error) {
    if (error.code !== 'stabilization_unavailable') throw error;
    const action = context.state.requestFallback(attempt.token, error.message);
    if (action !== 'begin') throw error;
    streamSession.cancelReconnect();
    attempt = context.state.beginFallback(attempt.token);
    if (!attempt || !isNativeContextCurrent(context)) {
      throw new Error('Low Latency fallback was cancelled.');
    }
    sendLog(`[System-Warning] ${error.message} Falling back once to OBS Low Latency.`);
    try {
      return await launchLockedProfileAttempt(context, attempt);
    } catch (fallbackError) {
      context.state.markFallbackTerminal();
      context.terminal = true;
      throw fallbackError;
    }
  }
}

async function relaunchLockedStream(context) {
  if (!isNativeContextCurrent(context) || !context.state.allowsReconnect()) {
    throw new Error('Native stream is terminal or no longer active.');
  }
  const attempt = context.state.beginAttempt(context.effectiveProfile);
  const result = await launchLockedProfileAttempt(context, attempt);
  if (!isNativeContextCurrent(context)) {
    throw new Error('Reconnect was superseded.');
  }
  nativeContextAuthority.assertAttemptCompletion({
    context,
    attemptRecord: result.attemptRecord,
    primaryChild: result.primaryChild
  });
  result.attemptRecord.published = true;
  sendStreamStatus(result.status);
  return result.status;
}

async function prepareStreamLaunch(requestedStreamConfig, runtimeConfig) {
  const displaySize = await getDisplaySize(requestedStreamConfig.serial, runtimeConfig);
  const streamConfig = normalizeStreamConfig(requestedStreamConfig, displaySize);
  return { displaySize, streamConfig };
}

async function launchStream(
  generation,
  requestedStreamConfig,
  runtimeConfig,
  preparedStream = null,
  assertStillCurrent = () => {}
) {
  if (!streamSession.isCurrent(generation)) {
    throw new Error('Stream generation is no longer active.');
  }

  const { displaySize, streamConfig } = preparedStream || await prepareStreamLaunch(requestedStreamConfig, runtimeConfig);
  assertStillCurrent();
  const scrcpyVersion = await detectScrcpyMajorVersion(runtimeConfig.scrcpyPath);
  assertStillCurrent();
  const args = [
    ...buildScrcpyArguments({ ...streamConfig, displaySize }, scrcpyVersion),
    ...getStreamPresentationArgs(requestedStreamConfig),
    '--window-title',
    'Quest 3 Stream (Caster)'
  ];
  const expectedOutput = formatOutputEstimate(calculateOutputSize(parseCrop(streamConfig.crop), streamConfig.maxSize, 2));

  sendLog(`[System] Launching scrcpy with ${args.length} validated arguments.`);
  let child;
  try {
    child = spawn(runtimeConfig.scrcpyPath, args, { windowsHide: true });
  } catch (error) {
    throw new Error(`Failed to launch scrcpy: ${error.message}`);
  }

  if (!childOwnership.setPrimary(generation, child)) {
    terminateProcess(child, 'scrcpy');
    throw new Error('Stream generation is no longer active.');
  }
  attachPrimaryLifecycle(child, generation);

  try {
    await waitForChildSpawn(child);
    assertStillCurrent();
  } catch (error) {
    throw new Error(`Failed to launch scrcpy: ${error.message}`);
  }

  await launchMicrophoneStream(generation, streamConfig, runtimeConfig);
  assertStillCurrent();
  return { expectedOutput };
}

ipcMain.handle('scan-devices', async (_event, config) => {
  try {
    const result = await runAdb(['devices'], config);
    if (!result.success) {
      return { success: false, error: result.error, devices: [] };
    }
    const devices = result.stdout.split('\n').slice(1).reduce((list, line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        list.push({ serial: parts[0], status: parts[1], isWireless: parts[0].includes(':') });
      }
      return list;
    }, []);
    return { success: true, devices };
  } catch (error) {
    return { success: false, error: error.message, devices: [] };
  }
});

ipcMain.handle('get-headset-ip', async (_event, serial, config) => {
  try {
    const result = await readHeadsetIp({ serial, runAdb: (args) => runAdb(args, config) });
    if (!result.success) {
      sendLog(`[System-Warning] Headset IP lookup failed (${result.code}): ${result.diagnostic || result.error}`);
    }
    return result;
  } catch (error) {
    sendLog(`[System-Error] Headset IP lookup failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('enable-tcpip', async (_event, serial, config) => {
  try {
    const result = await enableLegacyTcpIp({ serial, runAdb: (args) => runAdb(args, config) });
    sendLog(result.success
      ? `[System] ${result.alreadyListening
        ? 'Headset ADB is already listening on port 5555; left it running.'
        : 'Enabled legacy ADB TCP/IP on port 5555.'}`
      : `[System-Warning] Enabling legacy ADB TCP/IP failed (${result.code}): ${result.diagnostic || result.error}`);
    return result;
  } catch (error) {
    sendLog(`[System-Error] Enabling legacy ADB TCP/IP failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('connect-wireless', async (_event, ip, config) => {
  try {
    const target = typeof ip === 'string' && ip.includes(':') ? ip : `${ip}:5555`;
    const result = await connectWirelessTarget({
      target,
      runAdb: (args) => runAdb(args, config),
    });
    sendLog(result.success
      ? `[System] Wireless ADB connected to ${result.endpoint || target}.`
      : `[System-Warning] Wireless ADB connection to ${target} failed: ${result.diagnostic || result.error}`);
    return result;
  } catch (error) {
    sendLog(`[System-Error] Wireless ADB connection failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('open-log-folder', async () => {
  try {
    const logDirectory = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    const error = await shell.openPath(logDirectory);
    return error ? { success: false, error } : { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('disconnect-devices', async (_event, config) => {
  const result = await runAdb(['disconnect'], config);
  return result.success ? { success: true } : { success: false, error: result.stderr || result.error };
});

ipcMain.handle('preflight-stream', async (_event, serial, config) => {
  try {
    const safeSerial = validateAdbSerial(serial);
    const runtimeConfig = normalizeRuntimeConfig(config);
    const adbDevicesResult = await runFile(runtimeConfig.adbPath, ['devices']);
    const adbState = classifyAdbState(adbDevicesResult, safeSerial);
    if (!adbState.available) {
      return {
        success: false,
        code: adbState.code,
        error: adbState.reason,
        displaySize: null,
        profiles: [],
        warnings: []
      };
    }
    const displayGeometry = await readDisplayGeometry(safeSerial, runtimeConfig);
    const displaySize = displayGeometry.displaySize;
    const deviceModel = await readDeviceModel(safeSerial, runtimeConfig);
    const displayOverrideWarning = describeDisplayOverride(displayGeometry);
    const refreshRateHz = await readDisplayRefreshRate(safeSerial, runtimeConfig);
    const refreshRateWarning = describeRefreshRate(refreshRateHz);
    sendLog(refreshRateHz === null
      ? '[System] Headset display refresh rate could not be read.'
      : `[System] Headset display refresh rate: ${refreshRateHz} Hz (cast is 60 FPS).`);
    if (refreshRateWarning) {
      sendLog(`[System-Warning] ${refreshRateWarning}`);
    }
    const productionProfile = getProductionProfile(displaySize);
    const expectedOutput = productionProfile
      ? formatOutputEstimate(calculateOutputSize(parseCrop(productionProfile.crop), productionProfile.maxSize, 2))
      : null;
    const encodersResult = await runFile(runtimeConfig.scrcpyPath, ['--list-encoders']);
    const warnings = [];
    if (displayOverrideWarning) {
      warnings.push(displayOverrideWarning);
    }
    if (!encodersResult.success) {
      warnings.push('Unable to enumerate scrcpy encoders; Automatic H.264 remains available.');
    }
    let lockedPreflight = null;
    let nativeBundleError = null;
    try {
      const nativeRuntime = getVerifiedNativeRuntime();
      const capabilities = await runCapabilityProbe(nativeRuntime, { runFile });
      lockedPreflight = buildLockedProfilePreflight({ capabilities, displaySize, model: deviceModel });
      warnings.push(...lockedPreflight.warnings);
    } catch (error) {
      nativeBundleError = error.message;
      // Every profile is unavailable here, but each still reports the size and
      // delay it would deliver, so the UI describes the same stream whether or
      // not the native bundle loaded. Built from the shared geometry rather
      // than written out, which is what let this list fall behind: it named
      // two of the four profiles and gave Low Latency the wrong output.
      lockedPreflight = {
        profiles: LOCKED_PROFILE_IDS.map((id) => {
          const geometry = getProfileGeometry(id);
          return {
            id,
            available: false,
            reason: nativeBundleError,
            output: geometry.output,
            stabilization: geometry.stabilization,
            gpu: null,
            nominalDelayMs: geometry.nominalDelayMs,
            maximumDelayMs: geometry.maximumDelayMs
          };
        }),
        output: getProfileGeometry(LOCKED_PROFILE_IDS[0]).output,
        geometry: {
          detected: displaySize,
          calibrated: { width: 4128, height: 2208 },
          available: false,
          calibrationVerified: false
        },
        device: (() => {
          const identification = identifyDevice({ model: deviceModel, displaySize });
          return {
            id: identification.device.id,
            name: identification.device.name,
            model: deviceModel,
            calibration: getLockedProfileSupport(identification).tier,
            matchedBy: identification.matchedBy,
            eye: identification.device.eye
          };
        })(),
        upstreamVersion: null,
        forkVersion: null,
        gpu: null,
        warnings: []
      };
      warnings.push(nativeBundleError);
    }
    let calibratedProfiles = null;
    let calibrationTier = null;
    try {
      const identification = identifyDevice({ model: deviceModel, displaySize });
      const found = loadCalibration(identification.device.id, getCalibrationDirectories());
      if (found) {
        assertCalibrationMatchesDisplay(found.calibration, displaySize);
        calibratedProfiles = getCalibratedProfileAvailability(found.calibration);
        calibrationTier = found.calibration.calibration;
      }
    } catch (error) {
      // A measured headset silently reverting to "uncalibrated" looks like the
      // wizard did not work, so say what is wrong with the file instead.
      warnings.push(error.message);
    }
    return {
      success: true,
      adbState,
      displaySize,
      refreshRateHz,
      refreshRateWarning,
      calibratedProfiles,
      calibrationTier,
      productionProfile,
      h264Encoders: encodersResult.success ? filterH264Encoders(encodersResult.stdout.split(/\r?\n/)) : [],
      expectedOutput,
      profiles: lockedPreflight.profiles,
      output: lockedPreflight.output,
      geometry: lockedPreflight.geometry,
      upstreamVersion: lockedPreflight.upstreamVersion,
      forkVersion: lockedPreflight.forkVersion,
      gpu: lockedPreflight.gpu,
      nativeBundleError,
      warnings
    };
  } catch (error) {
    return {
      success: false,
      displaySize: null,
      productionProfile: null,
      h264Encoders: [],
      expectedOutput: null,
      profiles: [],
      warnings: [],
      error: error.message
    };
  }
});

ipcMain.handle('start-stream', async (_event, requestedStreamConfig, config) => {
  const operationToken = startOperationGate.begin();
  cancelPendingStart();
  cancelInFlightFallback();
  pendingStart = { operationToken, cancel() {} };
  let hadActiveStream = false;
  let replacementStarted = false;
  let startedGeneration = null;
  try {
    hadActiveStream = hasCurrentLivePrimary(
      streamSession.getRetryState(),
      childOwnership.snapshot()
    ) && (
      currentNativeContext === null
      || currentNativeContext.state.snapshot().ready
    );
    const runtimeConfig = normalizeRuntimeConfig(config);
    startOperationGate.assertCurrent(operationToken);
    if (requestedStreamConfig && isLockedProfileId(requestedStreamConfig.profileId)) {
      const request = normalizeLockedStreamRequest(requestedStreamConfig);
      startOperationGate.assertCurrent(operationToken);
      const adbDevicesResult = await runFile(runtimeConfig.adbPath, ['devices']);
      startOperationGate.assertCurrent(operationToken);
      const adbState = classifyAdbState(adbDevicesResult, request.serial);
      if (!adbState.available) {
        throw new Error(adbState.reason);
      }
      const displaySize = await getDisplaySize(request.serial, runtimeConfig);
      startOperationGate.assertCurrent(operationToken);
      const nativeRuntime = getVerifiedNativeRuntime();
      startOperationGate.assertCurrent(operationToken);
      const capabilities = await runCapabilityProbe(nativeRuntime, { runFile });
      startOperationGate.assertCurrent(operationToken);
      const model = await readDeviceModel(request.serial, runtimeConfig);
      startOperationGate.assertCurrent(operationToken);
      const preflight = buildLockedProfilePreflight({ capabilities, displaySize, model });
      const selectedProfile = preflight.profiles.find(
        (profile) => profile.id === request.profileId
      );
      if (!selectedProfile?.available) {
        throw new Error(selectedProfile?.reason || 'Selected OBS profile is unavailable.');
      }
      startOperationGate.assertCurrent(operationToken);
      await requireRetainedChildrenExited();
      startOperationGate.assertCurrent(operationToken);
      if (childOwnership.snapshot().primary) replacementStarted = true;
      cancelCurrentNativeAttempt();
      await requireRetainedChildrenExited();
      startOperationGate.assertCurrent(operationToken);
      const generation = streamSession.begin();
      startedGeneration = generation;
      replacementStarted = true;
      childOwnership.begin(generation);
      const nativeContext = {
        generation,
        operationToken,
        request,
        capabilities,
        nativeRuntime,
        mode: 'locked',
        calibration: null,
        expectedOutput: null,
        state: createNativeAttemptState(
          generation,
          request.profileId,
          { gpu: capabilities.gpu }
        ),
        attemptHandle: null,
        effectiveProfile: request.profileId,
        published: false,
        terminal: false,
        exitSent: false,
        fallbackInFlight: false
      };
      nativeContext.terminationLease = terminationRegistry.createContextLease();
      nativeContext.terminatingChildren = nativeContext.terminationLease.collection;
      nativeContext.fallback = createFallbackCoordinator({
        state: nativeContext.state,
        cancelReconnect: () => streamSession.cancelReconnect(),
        onTerminal: (message) => finalizeNativeTerminal(nativeContext, message)
      });
      currentNativeContext = nativeContext;
      registerPendingStart(operationToken, generation, nativeContext);
      const result = await launchLockedStream(nativeContext);
      startOperationGate.assertCurrent(operationToken);
      if (!isNativeContextCurrent(nativeContext) || nativeContext.terminal) {
        throw new Error('Native stream start was superseded.');
      }
      nativeContextAuthority.assertAttemptCompletion({
        context: nativeContext,
        attemptRecord: result.attemptRecord,
        primaryChild: result.primaryChild
      });
      result.attemptRecord.published = true;
      const status = result.status;
      nativeContext.effectiveProfile = status.effectiveProfile;
      nativeContext.published = true;
      lastStreamRequest = { locked: true, context: nativeContext };
      completePendingStart(operationToken);
      sendStreamStatus(status);
      return {
        success: true,
        ...status,
        expectedOutput: 'Expected stream: 1920x1080 (1080p)'
      };
    }
    if (requestedStreamConfig && isCalibratedProfileId(requestedStreamConfig.profileId)) {
      const request = normalizeCalibratedStreamRequest(requestedStreamConfig);
      startOperationGate.assertCurrent(operationToken);
      const adbDevicesResult = await runFile(runtimeConfig.adbPath, ['devices']);
      startOperationGate.assertCurrent(operationToken);
      const adbState = classifyAdbState(adbDevicesResult, request.serial);
      if (!adbState.available) {
        throw new Error(adbState.reason);
      }
      const displaySize = await getDisplaySize(request.serial, runtimeConfig);
      startOperationGate.assertCurrent(operationToken);
      const model = await readDeviceModel(request.serial, runtimeConfig);
      startOperationGate.assertCurrent(operationToken);
      const identification = identifyDevice({ model, displaySize });
      const found = loadCalibration(identification.device.id, getCalibrationDirectories());
      if (!found) {
        throw new Error(
          `${identification.device.name} has no calibration on this machine. `
          + 'Run the calibration wizard to measure it.');
      }
      // The crops are absolute display coordinates, so a calibration measured
      // on a different geometry frames the wrong region rather than failing.
      assertCalibrationMatchesDisplay(found.calibration, displaySize);
      const resolved = resolveCalibratedProfile(found.calibration, request.profileId);
      if (!resolved.available) {
        throw new Error(resolved.reason);
      }
      // The calibrated path runs stock scrcpy, so it needs the bundled runtime
      // for the binary and the patched server, but not the capability probe --
      // there is no fork protocol to negotiate.
      const nativeRuntime = getVerifiedNativeRuntime();
      startOperationGate.assertCurrent(operationToken);
      await requireRetainedChildrenExited();
      startOperationGate.assertCurrent(operationToken);
      if (childOwnership.snapshot().primary) replacementStarted = true;
      cancelCurrentNativeAttempt();
      await requireRetainedChildrenExited();
      startOperationGate.assertCurrent(operationToken);
      const generation = streamSession.begin();
      startedGeneration = generation;
      replacementStarted = true;
      childOwnership.begin(generation);
      const nativeContext = {
        generation,
        operationToken,
        request,
        capabilities: { gpu: null },
        nativeRuntime,
        mode: 'calibrated',
        calibration: found.calibration,
        expectedOutput: resolved.output,
        state: createNativeAttemptState(
          generation,
          request.profileId,
          { gpu: null, expectedOutput: resolved.output }
        ),
        attemptHandle: null,
        effectiveProfile: request.profileId,
        published: false,
        terminal: false,
        exitSent: false,
        fallbackInFlight: false
      };
      nativeContext.terminationLease = terminationRegistry.createContextLease();
      nativeContext.terminatingChildren = nativeContext.terminationLease.collection;
      nativeContext.fallback = createFallbackCoordinator({
        state: nativeContext.state,
        cancelReconnect: () => streamSession.cancelReconnect(),
        onTerminal: (message) => finalizeNativeTerminal(nativeContext, message)
      });
      currentNativeContext = nativeContext;
      registerPendingStart(operationToken, generation, nativeContext);
      const result = await launchLockedStream(nativeContext);
      startOperationGate.assertCurrent(operationToken);
      if (!isNativeContextCurrent(nativeContext) || nativeContext.terminal) {
        throw new Error('Calibrated stream start was superseded.');
      }
      nativeContextAuthority.assertAttemptCompletion({
        context: nativeContext,
        attemptRecord: result.attemptRecord,
        primaryChild: result.primaryChild
      });
      result.attemptRecord.published = true;
      const status = result.status;
      nativeContext.effectiveProfile = status.effectiveProfile;
      nativeContext.published = true;
      lastStreamRequest = { locked: true, context: nativeContext };
      completePendingStart(operationToken);
      if (!resolved.angleConfirmed) {
        sendLog('[System-Warning] This calibration has no confirmed presentation '
          + 'angle, so the stream is unrotated. Sweep the angle and re-run the '
          + 'wizard with --angle to confirm it.');
      }
      sendStreamStatus(status);
      return {
        success: true,
        ...status,
        expectedOutput: `Expected stream: ${resolved.output.width}x${resolved.output.height}`
      };
    }
    const safeSerial = validateAdbSerial(requestedStreamConfig && requestedStreamConfig.serial);
    const streamConfig = { ...requestedStreamConfig, serial: safeSerial };
    const preparedStream = await prepareStreamLaunch(streamConfig, runtimeConfig);
    startOperationGate.assertCurrent(operationToken);
    await requireRetainedChildrenExited();
    startOperationGate.assertCurrent(operationToken);
    if (childOwnership.snapshot().primary) replacementStarted = true;
    cancelCurrentNativeAttempt();
    await requireRetainedChildrenExited();
    startOperationGate.assertCurrent(operationToken);
    const generation = streamSession.begin();
    startedGeneration = generation;
    replacementStarted = true;
    childOwnership.begin(generation);
    registerPendingStart(operationToken, generation);
    const { expectedOutput } = await launchStream(
      generation,
      streamConfig,
      runtimeConfig,
      preparedStream,
      () => startOperationGate.assertCurrent(operationToken)
    );
    startOperationGate.assertCurrent(operationToken);
    if (
      childOwnership.snapshot().generation !== generation
      || !hasCurrentLivePrimary(streamSession.getRetryState(), childOwnership.snapshot())
    ) {
      throw new Error('Legacy stream start was superseded or exited.');
    }
    lastStreamRequest = { streamConfig, runtimeConfig };
    completePendingStart(operationToken);
    return { success: true, generation, expectedOutput };
  } catch (error) {
    if (pendingStart?.operationToken === operationToken) {
      cancelPendingStart();
    } else {
      const sessionState = streamSession.getRetryState();
      if (shouldCleanupFailedStart({
        replacementStarted,
        startedGeneration,
        currentGeneration: sessionState.generation,
        sessionActive: sessionState.isActive
      })) {
        if (childOwnership.snapshot().generation === startedGeneration) {
          childOwnership.stop();
        }
        streamSession.stop();
      }
    }
    return createStartFailureResult(error, hadActiveStream, replacementStarted);
  }
});

ipcMain.handle('stop-stream', async () => {
  startOperationGate.invalidate();
  const cancelledPending = cancelPendingStart();
  if (!streamSession.getRetryState().isActive) {
    return cancelledPending
      ? { success: true }
      : { success: false, error: 'No active stream process found.' };
  }
  cancelCurrentNativeAttempt();
  streamSession.stop();
  lastStreamRequest = null;
  terminateStreamHandles();
  return { success: true };
});

ipcMain.handle('request-reconnect', async (_event, generation) => {
  if (!Number.isSafeInteger(generation)) {
    return { scheduled: false, retry: 0, delayMs: null };
  }
  if (
    currentNativeContext
    && currentNativeContext.generation === generation
    && !currentNativeContext.state.allowsReconnect()
  ) {
    return { scheduled: false, retry: 0, delayMs: null };
  }
  const state = streamSession.getRetryState();
  const delayMs = state.retryCount < state.retryLimit ? [2000, 5000, 10000][state.retryCount] : null;
  const scheduled = streamSession.scheduleReconnect(generation);
  const nextState = streamSession.getRetryState();
  return { scheduled, retry: nextState.retryCount, delayMs: scheduled ? delayMs : null };
});

function buildProximityArguments(safeSerial, bypass) {
  const action = bypass
    ? 'com.oculus.vrpowermanager.prox_close'
    : 'com.oculus.vrpowermanager.automation_disable';
  return safeSerial
    ? ['-s', safeSerial, 'shell', 'am', 'broadcast', '-a', action]
    : ['shell', 'am', 'broadcast', '-a', action];
}

// Bypassing the proximity sensor changes headset state that outlives this
// process. Remember an applied bypass so it can be undone on quit; leaving it
// set drains the headset battery until the user reboots it.
async function restoreProximityBypass() {
  const bypass = activeProximityBypass;
  activeProximityBypass = null;
  if (!bypass) {
    return;
  }
  try {
    const result = await runAdb(buildProximityArguments(bypass.serial, false), bypass.config);
    sendLog(result.success
      ? '[System] Restored the headset proximity sensor.'
      : `[System-Warning] Could not restore the headset proximity sensor: ${result.stderr || result.error}`);
  } catch (error) {
    sendLog(`[System-Warning] Could not restore the headset proximity sensor: ${error.message}`);
  }
}

ipcMain.handle('toggle-proximity-sensor', async (_event, serial, bypass, config) => {
  try {
    if (typeof bypass !== 'boolean') {
      return { success: false, error: 'Proximity sensor state must be a boolean.' };
    }
    const safeSerial = serial ? validateAdbSerial(serial) : null;
    const result = await runAdb(buildProximityArguments(safeSerial, bypass), config);
    if (!result.success) {
      return { success: false, error: result.stderr || result.error };
    }
    activeProximityBypass = bypass
      ? { serial: safeSerial, config: normalizeRuntimeConfig(config) }
      : null;
    return { success: true, stdout: result.stdout };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ─── Audio Volume Control via Windows WASAPI ───────────────────────────────

/**
 * Set the Windows audio session volume for a given process PID.
 * @param {number} pid  - The process ID to target
 * @param {number} volume - 0–100 integer
 */
async function setProcessVolume(pid, volume) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { success: false, error: 'No valid process ID is available for volume control' };
  }

  let validatedVolume;
  try {
    validatedVolume = validateVolume(volume);
  } catch (error) {
    return { success: false, error: error.message };
  }

  // A freshly launched scrcpy has no Windows audio session until it starts
  // playing, so retry briefly rather than reporting a failure the user cannot
  // act on.
  let result = null;
  for (let attempt = 0; attempt < VOLUME_ATTEMPTS; attempt += 1) {
    result = await runVolumeScript(pid, validatedVolume);
    if (result.success || !isMissingAudioSession(result)) {
      break;
    }
    if (attempt < VOLUME_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, VOLUME_RETRY_DELAY_MS));
    }
  }
  if (!result.success) {
    sendLog(`[System-Warning] Could not set volume: ${result.error}`);
  }
  return result;
}

function runVolumeScript(pid, validatedVolume) {
  const script = buildVolumeScript(pid, validatedVolume);
  // PowerShell -EncodedCommand expects UTF-16LE base64 — avoids ALL quoting issues
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell', [
      '-NonInteractive', '-NoProfile', '-NoLogo',
      '-EncodedCommand', encoded
    ], { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      resolve(createVolumeProcessResult(error, stdout, stderr));
    });
  });
}

function setActiveStreamVolume(streamType, volume) {
  try {
    validateVolume(volume);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const streamHandles = childOwnership.snapshot();
  const processHandle = streamType === 'game' ? streamHandles.primary : streamHandles.microphone;
  if (!processHandle || !Number.isSafeInteger(processHandle.pid) || processHandle.pid <= 0) {
    return { success: false, error: `No active ${streamType} stream process` };
  }
  return setProcessVolume(processHandle.pid, volume);
}

ipcMain.handle('set-game-volume', async (_event, volume) => setActiveStreamVolume('game', volume));
ipcMain.handle('set-mic-volume', async (_event, volume) => setActiveStreamVolume('microphone', volume));

// ───────────────────────────────────────────────────────────────────────────

ipcMain.handle('check-paths', async (_event, config) => {
  try {
    const runtimeConfig = normalizeRuntimeConfig(config);
    const [adbResult, scrcpyResult] = await Promise.all([
      runFile(runtimeConfig.adbPath, ['version']),
      runFile(runtimeConfig.scrcpyPath, ['--version'])
    ]);
    return { adb: adbResult.success, scrcpy: scrcpyResult.success };
  } catch (_error) {
    return { adb: false, scrcpy: false };
}
});

module.exports = { runFile };
