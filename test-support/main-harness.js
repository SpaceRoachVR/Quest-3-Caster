'use strict';

// Loads the real main.js under plain Node with Electron, child_process and the
// native bundle replaced by fakes, so its IPC handlers and stream lifecycle can
// be driven from node --test without a headset, adb, scrcpy or a window.
//
// main.js registers its handlers and reads `execFile`/`spawn` when it is first
// required, so every fake has to be in place before that. Each call to
// loadMain() evicts main.js from the require cache and loads a fresh copy with
// fresh module state. This file lives outside test/ because node --test runs
// every .js file under that directory as a test.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(REPO_ROOT, 'main.js');
const NATIVE_RUNTIME_PATH = path.join(REPO_ROOT, 'lib', 'native-runtime.js');
const FAKE_CLIENT_PATH = 'C:\\fake-bundle\\scrcpy.exe';

// A child process as main.js sees one. `kill()` behaves like a real process
// that dies from the signal: it sets signalCode and emits exit and close on a
// later tick, which is what waitForProcessExit and the lifecycle listeners
// depend on.
function createFakeChild(executable, args) {
  const child = new EventEmitter();
  child.executable = executable;
  child.args = args;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = createFakeChild.nextPid++;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    if (child.killed || child.exitCode !== null || child.signalCode !== null) return true;
    child.killed = true;
    setImmediate(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    });
    return true;
  };
  // Simulates the process ending without being asked to.
  child.exitUnexpectedly = (code = 1) => {
    child.exitCode = code;
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
  return child;
}
createFakeChild.nextPid = 5000;

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await nextTick();
}

// `adb` maps the argument list of an adb call to { stdout } or { error }.
// `onSpawn(child)` decides what a freshly spawned process does; the default
// starts cleanly and prints the scrcpy texture line `textureLine` names.
function loadMain({
  adb = () => ({ stdout: '' }),
  onSpawn = null,
  textureLine = null,
  singleInstanceLock = true,
  nativeRuntimeError = null,
} = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-main-'));
  const userData = path.join(temporaryRoot, 'userData');
  const handlers = new Map();
  const sent = [];
  const adbCalls = [];
  const otherCalls = [];
  const children = [];
  const windows = [];
  let quitCount = 0;

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (channel, payload) => sent.push({ channel, payload }),
        setWindowOpenHandler: () => {},
      });
      windows.push(this);
    }
    loadFile() { return Promise.resolve(); }
    show() {}
    focus() {}
    restore() {}
    isMinimized() { return false; }
    isDestroyed() { return this.destroyed; }
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  }

  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    getAppPath: () => REPO_ROOT,
    getPath: () => userData,
    requestSingleInstanceLock: () => singleInstanceLock,
    whenReady: () => Promise.resolve(),
    quit: () => { quitCount += 1; },
  });
  const fakeElectron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    Menu: { setApplicationMenu() {} },
    shell: { openPath: async () => '' },
  };

  const fakeNativeRuntime = {
    createNativeRuntime: () => {
      if (nativeRuntimeError) throw new Error(nativeRuntimeError);
      return Object.freeze({
        bundleDirectory: path.dirname(FAKE_CLIENT_PATH),
        clientPath: FAKE_CLIENT_PATH,
        manifest: {},
        spawnOptions: Object.freeze({ windowsHide: true, shell: false }),
      });
    },
    runCapabilityProbe: async () => {
      throw new Error('The capability probe is not available in the test harness.');
    },
  };

  const fakeExecFile = (executable, args, _options, callback) => {
    const isAdb = /(^|[\\/])adb(\.exe)?$/i.test(executable);
    if (!isAdb) {
      otherCalls.push([executable, ...args]);
      setImmediate(() => callback(new Error(`spawn ${executable} ENOENT`), '', ''));
      return;
    }
    adbCalls.push(args);
    const answer = adb(args) || { stdout: '' };
    setImmediate(() => callback(
      answer.error ? new Error(answer.error) : null,
      answer.stdout || '',
      answer.stderr || ''
    ));
  };
  const fakeSpawn = (executable, args) => {
    const child = createFakeChild(executable, args);
    children.push(child);
    setImmediate(() => {
      if (onSpawn) {
        onSpawn(child);
        return;
      }
      child.emit('spawn');
      if (textureLine) child.stdout.emit('data', Buffer.from(`${textureLine}\n`));
    });
    return child;
  };

  const electronPath = require.resolve('electron', { paths: [REPO_ROOT] });
  const saved = {
    execFile: childProcess.execFile,
    spawn: childProcess.spawn,
    electron: require.cache[electronPath],
    nativeRuntime: require.cache[NATIVE_RUNTIME_PATH],
    appData: process.env.APPDATA,
  };
  // The app also searches %APPDATA% for a user calibration. Pointing it at the
  // temporary directory keeps a developer's own calibration out of the tests.
  process.env.APPDATA = path.join(temporaryRoot, 'appData');
  childProcess.execFile = fakeExecFile;
  childProcess.spawn = fakeSpawn;
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron };
  require.cache[NATIVE_RUNTIME_PATH] = {
    id: NATIVE_RUNTIME_PATH, filename: NATIVE_RUNTIME_PATH, loaded: true, exports: fakeNativeRuntime,
  };
  delete require.cache[MAIN_PATH];
  try {
    require(MAIN_PATH);
  } finally {
    // main.js has captured its references; put the shared modules back so the
    // rest of the test process sees the real ones.
    childProcess.execFile = saved.execFile;
    childProcess.spawn = saved.spawn;
    if (saved.electron) require.cache[electronPath] = saved.electron;
    else delete require.cache[electronPath];
    if (saved.nativeRuntime) require.cache[NATIVE_RUNTIME_PATH] = saved.nativeRuntime;
    else delete require.cache[NATIVE_RUNTIME_PATH];
    delete require.cache[MAIN_PATH];
  }

  return {
    app,
    handlers,
    sent,
    adbCalls,
    otherCalls,
    children,
    windows,
    quitCount: () => quitCount,
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}.`);
      return handler({}, ...args);
    },
    sentOn: (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload),
    async dispose() {
      // Stops any stream and cancels reconnect timers so the test process can exit.
      if (handlers.has('stop-stream')) await handlers.get('stop-stream')({});
      await settle();
      if (saved.appData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved.appData;
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

module.exports = { FAKE_CLIENT_PATH, REPO_ROOT, loadMain, settle };
