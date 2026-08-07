'use strict';

const { contextBridge } = require('electron');

let streamStatusListener = () => {};
let streamExitListener = () => {};
let lastStartPayload = null;
let devices = [{
  id: 'inspection-device-0001', name: 'Inspection Quest', host: '192.168.50.25', port: 5555,
  createdAt: '2026-07-26T00:00:00.000Z', lastConnectedAt: null
}];

function preflight() {
  return {
    success: true,
    profiles: [
      { id: 'obsLowLatency1080p60', available: true, reason: null, output: { width: 1920, height: 1080 }, gpu: null, nominalDelayMs: 0 },
      { id: 'obsStabilized1080p60', available: true, reason: null, output: { width: 1920, height: 1080 }, gpu: 'Inspection OpenCL GPU', nominalDelayMs: 100 }
    ]
  };
}

contextBridge.exposeInMainWorld('api', {
  scanDevices: async () => ({ success: true, devices: [{ serial: '1WMHH00000', status: 'device', isWireless: false }] }),
  getHeadsetIP: async () => ({ success: true, ip: '192.168.50.25' }),
  enableTcpIp: async () => ({ success: true }),
  connectWireless: async () => ({ success: true, message: 'inspection connection' }),
  listSavedDevices: async () => ({ success: true, devices }),
  saveDevice: async (device) => {
    const saved = { id: 'inspection-device-0002', name: device.name || `Quest at ${device.host}`, host: device.host, port: 5555, createdAt: '2026-07-26T00:00:00.000Z', lastConnectedAt: null };
    devices = [saved, ...devices.filter((item) => item.host !== saved.host)];
    return { success: true, device: saved };
  },
  updateSavedDevice: async (id, update) => {
    const index = devices.findIndex((device) => device.id === id);
    if (index < 0) return { success: false, error: 'Not found' };
    devices[index] = { ...devices[index], ...update, port: Number(update.port) };
    return { success: true, device: devices[index] };
  },
  removeSavedDevice: async (id) => { devices = devices.filter((device) => device.id !== id); return { success: true }; },
  markDeviceConnected: async () => ({ success: true }),
  openLogFolder: async () => ({ success: true }),
  preflightStream: async () => preflight(),
  startStream: async (payload) => { lastStartPayload = payload; return { success: true, generation: 41, requestedProfile: payload.profileId, effectiveProfile: payload.profileId }; },
  stopStream: async () => ({ success: true }),
  requestReconnect: async () => ({ scheduled: false, retry: 0, delayMs: null }),
  toggleProximitySensor: async () => ({ success: true }),
  checkPaths: async () => ({ adb: true, scrcpy: true }),
  onLogMessage: () => {},
  onStreamStatus: (listener) => { streamStatusListener = listener; },
  onStreamExit: (listener) => { streamExitListener = listener; }
});

contextBridge.exposeInMainWorld('rendererInspection', {
  getLastStartPayload: () => lastStartPayload,
  emitStatus: (status) => streamStatusListener(status),
  emitExit: (event) => streamExitListener(event)
});
