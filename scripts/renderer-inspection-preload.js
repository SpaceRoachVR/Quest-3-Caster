'use strict';

const { contextBridge } = require('electron');

// Mirrors every method preload.js exposes, backed by canned answers, so the
// production renderer runs its real USB-scan-to-cast flow without ADB, scrcpy,
// or a headset. Keep this list in step with preload.js: the renderer calls any
// method missing here as undefined and the inspection fails.

let streamStatusListener = () => {};
let streamExitListener = () => {};
let lastStartPayload = null;

const INSPECTION_SERIAL = '1WMHH00000';
const INSPECTION_IP = '192.168.50.25';

function preflight() {
  return {
    success: true,
    profiles: [
      { id: 'obsLowLatency1080p60', available: true, reason: null, output: { width: 1920, height: 1080 }, gpu: null, nominalDelayMs: 0 },
      { id: 'obsStabilized1080p60', available: true, reason: null, output: { width: 1920, height: 1080 }, gpu: 'Inspection OpenCL GPU', nominalDelayMs: 100 },
      { id: 'obsLowLatencySquareLeft1080p60', available: true, reason: null, output: { width: 1080, height: 1080 }, gpu: null, nominalDelayMs: 0 },
      { id: 'obsLowLatencySquareRight1080p60', available: true, reason: null, output: { width: 1080, height: 1080 }, gpu: null, nominalDelayMs: 0 }
    ]
  };
}

contextBridge.exposeInMainWorld('api', {
  scanDevices: async () => ({ success: true, devices: [{ serial: INSPECTION_SERIAL, status: 'device', isWireless: false }] }),
  getHeadsetIP: async () => ({ success: true, ip: INSPECTION_IP }),
  enableTcpIp: async () => ({ success: true }),
  connectWireless: async (target) => ({ success: true, endpoint: target, message: 'inspection connection' }),
  openLogFolder: async () => ({ success: true }),
  disconnectDevices: async () => ({ success: true }),
  preflightStream: async () => preflight(),
  startStream: async (payload) => {
    lastStartPayload = payload;
    return { success: true, generation: 41, requestedProfile: payload.profileId, effectiveProfile: payload.profileId };
  },
  stopStream: async () => ({ success: true }),
  requestReconnect: async () => ({ scheduled: false, retry: 0, delayMs: null }),
  checkPaths: async () => ({ adb: true, scrcpy: true }),
  toggleProximitySensor: async () => ({ success: true }),
  onStreamExit: (listener) => { streamExitListener = listener; return () => { streamExitListener = () => {}; }; },
  onStreamStatus: (listener) => { streamStatusListener = listener; return () => { streamStatusListener = () => {}; }; },
  onLogMessage: () => {},
  setGameVolume: async () => ({ success: true }),
  setMicVolume: async () => ({ success: true })
});

contextBridge.exposeInMainWorld('rendererInspection', {
  getLastStartPayload: () => lastStartPayload,
  emitStatus: (status) => streamStatusListener(status),
  emitExit: (event) => streamExitListener(event)
});
