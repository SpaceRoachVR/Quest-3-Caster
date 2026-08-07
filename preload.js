const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scanDevices: (config) => ipcRenderer.invoke('scan-devices', config),
  getHeadsetIP: (serial, config) => ipcRenderer.invoke('get-headset-ip', serial, config),
  enableTcpIp: (serial, config) => ipcRenderer.invoke('enable-tcpip', serial, config),
  connectWireless: (ip, config) => ipcRenderer.invoke('connect-wireless', ip, config),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  disconnectDevices: (config) => ipcRenderer.invoke('disconnect-devices', config),
  preflightStream: (serial, config) => ipcRenderer.invoke('preflight-stream', serial, config),
  startStream: (streamConfig, config) => ipcRenderer.invoke('start-stream', streamConfig, config),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  requestReconnect: (generation) => ipcRenderer.invoke('request-reconnect', generation),
  checkPaths: (config) => ipcRenderer.invoke('check-paths', config),
  toggleProximitySensor: (serial, bypass, config) => ipcRenderer.invoke('toggle-proximity-sensor', serial, bypass, config),
  onStreamExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stream-exit', listener);
    return () => ipcRenderer.removeListener('stream-exit', listener);
  },
  onStreamStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stream-status', listener);
    return () => ipcRenderer.removeListener('stream-status', listener);
  },
  onLogMessage: (callback) => ipcRenderer.on('log-message', (event, ...args) => callback(...args)),
  setGameVolume: (volume) => ipcRenderer.invoke('set-game-volume', volume),
  setMicVolume: (volume) => ipcRenderer.invoke('set-mic-volume', volume)
});
