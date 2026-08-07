'use strict';

const rendererQuality = window.RendererQuality;
const rendererLifecycle = window.RendererLifecycle;

const elements = {
  homeView: document.getElementById('home-view'),
  settingsView: document.getElementById('settings-view'),
  connectionStatus: document.getElementById('connection-status'),
  selectedAddress: document.getElementById('selected-device-address'),
  availability: document.getElementById('availability-message'),
  startCast: document.getElementById('start-cast-button'),
  microphone: document.getElementById('microphone-toggle'),
  awake: document.getElementById('awake-toggle'),
  reconnect: document.getElementById('reconnect-toggle'),
  profileNote: document.getElementById('profile-note'),
  profileButtons: [...document.querySelectorAll('.profile-option')],
  // Selected by the data attribute each handler actually reads, not by
  // container class. The eye buttons reuse .output-format-option for styling,
  // so a class-only selector made choosing an eye also fire the output-format
  // handler with an undefined format, snapping 1:1 back to 16:9.
  outputFormatButtons: [...document.querySelectorAll('.output-format-option[data-output-format]')],
  rightEyeOption: document.getElementById('right-eye-option'),
  rightEye: document.getElementById('right-eye-toggle'),
  eyeButtons: [...document.querySelectorAll('.output-format-option[data-eye]')],
  outputFormatNote: document.getElementById('output-format-note'),
  usbDevices: document.getElementById('usb-device-list'),
  headsetIp: document.getElementById('headset-ip-input'),
  pairingMessage: document.getElementById('pairing-message'),
  adbPath: document.getElementById('adb-path-input'),
  scrcpyPath: document.getElementById('scrcpy-path-input'),
  diagnosticsMessage: document.getElementById('diagnostics-message'),
  gameVolume: document.getElementById('game-volume-slider'),
  gameVolumeValue: document.getElementById('game-volume-value'),
  micVolumeRow: document.getElementById('mic-volume-row'),
  micVolume: document.getElementById('mic-volume-slider'),
  micVolumeValue: document.getElementById('mic-volume-value'),
  micVolumeHint: document.getElementById('mic-volume-hint'),
  volumeNote: document.getElementById('volume-note')
};

const state = {
  selectedUsbDevice: null,
  detectedIp: null,
  selectedProfile: 'obsLowLatency1080p60',
  outputFormat: 'widescreen',
  currentSerial: null,
  streamGeneration: null,
  isCasting: false,
  isProximityBypassed: false,
  activeStreamOwnership: null
};

function setMessage(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function setAvailability(message, tone = 'neutral') {
  elements.availability.textContent = message;
  elements.availability.dataset.tone = tone;
}

function getRuntimeConfig() {
  return { adbPath: elements.adbPath.value.trim(), scrcpyPath: elements.scrcpyPath.value.trim() };
}

function persistSetting(key, value) {
  localStorage.setItem(key, String(value));
}

function loadSettings() {
  elements.adbPath.value = localStorage.getItem('adbPath') || '';
  elements.scrcpyPath.value = localStorage.getItem('scrcpyPath') || '';
  elements.microphone.checked = localStorage.getItem('streamMic') === 'true';
  elements.awake.checked = localStorage.getItem('keepAwake') === 'true';
  elements.reconnect.checked = localStorage.getItem('autoReconnect') !== 'false';
  const savedProfile = rendererQuality.normalizePresetSelection(localStorage.getItem('videoPreset'));
  state.selectedProfile = savedProfile;
  state.outputFormat = rendererQuality.normalizeOutputFormat(localStorage.getItem('outputFormat'));
  elements.rightEye.checked = localStorage.getItem('rightEye') === 'true';
  elements.gameVolume.value = String(readVolume(localStorage.getItem('gameVolume')));
  elements.micVolume.value = String(readVolume(localStorage.getItem('micVolume')));
}

function setView(view) {
  elements.homeView.classList.toggle('hidden', view !== 'home');
  elements.settingsView.classList.toggle('hidden', view !== 'settings');
}

function updateProfileControls() {
  elements.profileButtons.forEach((button) => {
    const selected = button.dataset.profile === state.selectedProfile;
    const unavailableForOutput = state.outputFormat === 'square' && button.dataset.profile === 'obsStabilized1080p60';
    button.classList.toggle('selected', selected);
    button.disabled = unavailableForOutput;
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-disabled', String(unavailableForOutput));
  });
  elements.profileNote.textContent = state.outputFormat === 'square'
    ? 'Square output uses the locked Low Latency profile; Stabilized remains calibrated for 16:9 only.'
    : state.selectedProfile === 'obsStabilized1080p60'
    ? 'Stabilized uses GPU processing and adds approximately 100 ms of synchronized delay.'
    : 'Low Latency is the default for responsive casting.';
  elements.outputFormatButtons.forEach((button) => {
    const selected = button.dataset.outputFormat === state.outputFormat;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  elements.rightEyeOption.classList.toggle('hidden', state.outputFormat !== 'square');
  elements.eyeButtons.forEach((button) => {
    const selected = (button.dataset.eye === 'right') === elements.rightEye.checked;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  elements.outputFormatNote.textContent = state.outputFormat === 'square'
    ? `1:1 captures the ${elements.rightEye.checked ? 'right' : 'left'} eye at 1080\u00d71080.`
    : '16:9 uses the calibrated single-eye output for the selected profile.';
}

function resetConnectionState() {
  state.detectedIp = null;
  state.selectedUsbDevice = null;
  state.currentSerial = null;
  elements.headsetIp.value = '';
  elements.usbDevices.replaceChildren();
  setMessage(elements.pairingMessage, '');
  elements.startCast.disabled = true;
  elements.startCast.textContent = 'Start casting';
  elements.selectedAddress.textContent = 'Connect the headset by USB, accept the debugging prompt in the headset, then scan below.';
  setAvailability('Scan USB devices to begin.');
}

// A cast ending does not invalidate the wireless endpoint, so keep the detected
// address and let the user start again. Wiping it here would force a USB
// re-scan with a cable the user has already unplugged.
function returnToReadyState(message, tone = 'ready') {
  state.isCasting = false;
  state.streamGeneration = null;
  state.activeStreamOwnership = null;
  elements.startCast.textContent = 'Start casting';
  if (!state.detectedIp) {
    elements.connectionStatus.textContent = 'Not connected';
    resetConnectionState();
    return;
  }
  elements.connectionStatus.textContent = 'Connected';
  elements.startCast.disabled = false;
  setAvailability(message, tone);
}

function readVolume(value, fallback = 100) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

function updateVolumeLabels() {
  const micEnabled = elements.microphone.checked;
  elements.gameVolumeValue.textContent = `${readVolume(elements.gameVolume.value)}%`;
  elements.micVolumeValue.textContent = `${readVolume(elements.micVolume.value)}%`;
  // Shown-but-disabled rather than hidden: a control nobody can see is a
  // control nobody knows exists.
  elements.micVolumeRow.classList.toggle('disabled', !micEnabled);
  elements.micVolume.disabled = !micEnabled;
  elements.micVolumeHint.textContent = micEnabled
    ? 'Your voice, balanced against game audio.'
    : 'Turn on “Include headset microphone” to adjust this.';
}

// Each apply spawns a PowerShell process, so coalesce slider movement rather
// than launching one per input event.
const volumeCommits = { game: null, microphone: null };

function commitVolume(kind, apply) {
  window.clearTimeout(volumeCommits[kind]);
  volumeCommits[kind] = window.setTimeout(async () => {
    if (!state.isCasting) return;
    const result = await apply();
    if (!result?.success) {
      setMessage(elements.volumeNote, result?.error || 'Could not change the volume.', true);
      return;
    }
    setMessage(elements.volumeNote, 'Levels are saved and applied to the Windows volume mixer while casting.');
  }, 250);
}

async function applyStoredVolumes() {
  if (!state.isCasting) return;
  await window.api.setGameVolume(readVolume(elements.gameVolume.value));
  if (elements.microphone.checked) {
    await window.api.setMicVolume(readVolume(elements.micVolume.value));
  }
}

async function restoreProximitySensor() {
  if (!state.isProximityBypassed || !state.currentSerial) return;
  const result = await window.api.toggleProximitySensor(state.currentSerial, false, getRuntimeConfig());
  if (result.success) {
    state.isProximityBypassed = false;
  }
}

async function runPreflight(serial) {
  const result = await window.api.preflightStream(serial, getRuntimeConfig());
  if (!result.success) {
    setAvailability(result.error || 'This headset is not ready to cast.', 'error');
    return null;
  }
  const availability = rendererQuality.getProfileAvailability(result);
  const lockedProfileId = rendererQuality.getLockedProfileId(
    state.selectedProfile,
    state.outputFormat,
    elements.rightEye.checked
  );
  const selected = availability[lockedProfileId];
  if (!selected?.available) {
    setAvailability(selected?.reason || 'The selected casting profile is unavailable.', 'error');
    return null;
  }
  return result;
}

async function connectAndStart() {
  if (!state.detectedIp || state.isCasting) return;
  elements.startCast.disabled = true;
  setAvailability('Connecting to headset\u2026', 'connecting');
  const target = `${state.detectedIp}:5555`;
  const connection = await window.api.connectWireless(target, getRuntimeConfig());
  if (!connection.success) {
    setAvailability(connection.error || 'Could not connect to this headset.', 'error');
    elements.startCast.disabled = false;
    return;
  }
  state.currentSerial = connection.endpoint || target;
  let keepAwakeWarning = '';
  if (elements.awake.checked) {
    const keepAwakeResult = await window.api.toggleProximitySensor(state.currentSerial, true, getRuntimeConfig());
    if (keepAwakeResult.success) {
      state.isProximityBypassed = true;
    } else {
      keepAwakeWarning = keepAwakeResult.error || 'Could not enable Keep headset awake.';
    }
  }
  const preflight = await runPreflight(state.currentSerial);
  if (!preflight) {
    elements.startCast.disabled = false;
    return;
  }
  const request = rendererQuality.buildStreamPayload(state.selectedProfile, {
    serial: state.currentSerial,
    streamMic: elements.microphone.checked,
    outputFormat: state.outputFormat,
    rightEye: elements.rightEye.checked
  });
  setAvailability('Starting cast\u2026', 'connecting');
  const stream = await window.api.startStream(request, getRuntimeConfig());
  if (!stream.success) {
    setAvailability(stream.error || 'Quest 3 Caster could not start the stream.', 'error');
    elements.startCast.disabled = false;
    return;
  }
  state.isCasting = true;
  state.streamGeneration = stream.generation;
  state.activeStreamOwnership = rendererLifecycle.createActiveStreamOwnership(
    stream.generation,
    state.selectedProfile,
    elements.microphone.checked
  );
  elements.connectionStatus.textContent = 'Casting';
  elements.startCast.disabled = false;
  elements.startCast.textContent = 'Stop casting';
  setAvailability(keepAwakeWarning ? `Casting is active. ${keepAwakeWarning}` : 'Casting is active.', keepAwakeWarning ? 'warning' : 'ready');
  await applyStoredVolumes();
}

async function stopCasting() {
  elements.startCast.disabled = true;
  const result = await window.api.stopStream();
  if (!result.success) {
    setAvailability(result.error || 'Could not stop the stream.', 'error');
    elements.startCast.disabled = false;
    return;
  }
  await restoreProximitySensor();
  returnToReadyState('Ready to cast.');
}

async function scanUsbDevices() {
  elements.usbDevices.replaceChildren();
  state.detectedIp = null;
  state.selectedUsbDevice = null;
  elements.headsetIp.value = '';
  elements.startCast.disabled = true;
  elements.startCast.textContent = 'Start casting';
  // The two status lines sit next to each other, so they must never describe
  // different states at once. Availability owns "what happens next"; the
  // pairing line owns device detail.
  setMessage(elements.pairingMessage, '');
  setAvailability('Looking for a connected headset\u2026', 'connecting');
  const result = await window.api.scanDevices(getRuntimeConfig());
  if (!result.success) {
    setMessage(elements.pairingMessage, result.error || 'Unable to scan for USB devices.', true);
    setAvailability('Quest 3 Caster could not reach ADB.', 'error');
    return;
  }
  const devices = result.devices.filter((device) => !device.isWireless && device.status === 'device');
  const unauthorized = result.devices.filter((device) => device.status === 'unauthorized');
  if (devices.length === 0) {
    // An unauthorized device is a headset waiting on its own prompt, not a
    // missing one, and it was previously filtered out and reported as absent.
    setMessage(elements.pairingMessage, unauthorized.length > 0
      ? 'Put the headset on and accept the \u201cAllow USB debugging\u201d prompt, then scan again.'
      : 'No headset detected. Check the USB cable, and confirm Developer Mode is enabled in the Meta Horizon phone app.', true);
    setAvailability(unauthorized.length > 0
      ? 'Waiting for you to allow USB debugging.'
      : 'No headset found.', 'error');
    return;
  }
  setMessage(elements.pairingMessage, devices.length === 1
    ? '1 headset found.'
    : `${devices.length} headsets found.`);
  setAvailability('Select your headset below.');
  for (const device of devices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usb-device-button';
    button.textContent = device.serial;
    button.addEventListener('click', async () => {
      state.selectedUsbDevice = device;
      state.detectedIp = null;
      elements.headsetIp.value = '';
      elements.startCast.disabled = true;
      [...elements.usbDevices.children].forEach((child) => child.classList.remove('selected'));
      button.classList.add('selected');
      setMessage(elements.pairingMessage, 'Finding the headset IP address\u2026');
      const ipResult = await window.api.getHeadsetIP(device.serial, getRuntimeConfig());
      if (!ipResult.success) {
        setMessage(elements.pairingMessage, ipResult.error || 'Could not find the headset IP address.', true);
        return;
      }
      setMessage(elements.pairingMessage, 'Enabling ADB over Wi-Fi\u2026');
      const tcp = await window.api.enableTcpIp(device.serial, getRuntimeConfig());
      if (!tcp.success) {
        setMessage(elements.pairingMessage, tcp.error || 'Could not enable ADB over Wi-Fi.', true);
        return;
      }
      elements.headsetIp.value = ipResult.ip;
      state.detectedIp = ipResult.ip;
      elements.startCast.disabled = false;
      setMessage(elements.pairingMessage, 'Ready. The USB cable may now be removed.');
      elements.selectedAddress.textContent = `Detected at ${ipResult.ip} \u2014 USB cable may be removed.`;
      setAvailability('Ready to cast.', 'ready');
    });
    elements.usbDevices.append(button);
  }
}

async function setKeepAwake() {
  persistSetting('keepAwake', elements.awake.checked);
  if (!state.currentSerial) return;
  const result = await window.api.toggleProximitySensor(state.currentSerial, elements.awake.checked, getRuntimeConfig());
  if (!result.success) {
    elements.awake.checked = !elements.awake.checked;
    persistSetting('keepAwake', elements.awake.checked);
    setAvailability(result.error || 'Could not update the headset awake setting.', 'error');
    return;
  }
  state.isProximityBypassed = elements.awake.checked;
}

function wireEvents() {
  document.getElementById('home-button').addEventListener('click', () => setView('home'));
  document.getElementById('settings-button').addEventListener('click', () => setView('settings'));
  document.getElementById('settings-back-button').addEventListener('click', () => setView('home'));
  document.getElementById('scan-usb-button').addEventListener('click', scanUsbDevices);
  elements.startCast.addEventListener('click', () => state.isCasting ? stopCasting() : connectAndStart());
  elements.profileButtons.forEach((button) => button.addEventListener('click', () => {
    if (state.isCasting) return;
    if (state.outputFormat === 'square' && button.dataset.profile === 'obsStabilized1080p60') return;
    state.selectedProfile = button.dataset.profile;
    persistSetting('videoPreset', state.selectedProfile);
    updateProfileControls();
  }));
  elements.outputFormatButtons.forEach((button) => button.addEventListener('click', () => {
    if (state.isCasting) return;
    state.outputFormat = rendererQuality.normalizeOutputFormat(button.dataset.outputFormat);
    if (state.outputFormat === 'square') state.selectedProfile = 'obsLowLatency1080p60';
    persistSetting('outputFormat', state.outputFormat);
    persistSetting('videoPreset', state.selectedProfile);
    updateProfileControls();
  }));
  elements.eyeButtons.forEach((button) => button.addEventListener('click', () => {
    if (state.isCasting) return;
    elements.rightEye.checked = button.dataset.eye === 'right';
    persistSetting('rightEye', elements.rightEye.checked);
    updateProfileControls();
  }));
  elements.microphone.addEventListener('change', () => {
    persistSetting('streamMic', elements.microphone.checked);
    updateVolumeLabels();
  });
  elements.gameVolume.addEventListener('input', () => {
    updateVolumeLabels();
    persistSetting('gameVolume', readVolume(elements.gameVolume.value));
    commitVolume('game', () => window.api.setGameVolume(readVolume(elements.gameVolume.value)));
  });
  elements.micVolume.addEventListener('input', () => {
    updateVolumeLabels();
    persistSetting('micVolume', readVolume(elements.micVolume.value));
    commitVolume('microphone', () => window.api.setMicVolume(readVolume(elements.micVolume.value)));
  });
  elements.awake.addEventListener('change', setKeepAwake);
  elements.reconnect.addEventListener('change', () => persistSetting('autoReconnect', elements.reconnect.checked));
  elements.adbPath.addEventListener('input', () => persistSetting('adbPath', elements.adbPath.value));
  elements.scrcpyPath.addEventListener('input', () => persistSetting('scrcpyPath', elements.scrcpyPath.value));
  document.getElementById('verify-paths-button').addEventListener('click', async () => {
    setMessage(elements.diagnosticsMessage, 'Verifying executables\u2026');
    const result = await window.api.checkPaths(getRuntimeConfig());
    setMessage(elements.diagnosticsMessage, result.adb && result.scrcpy ? 'ADB and scrcpy are ready.' : 'ADB or scrcpy could not be found. Check the paths above.', !(result.adb && result.scrcpy));
  });
  document.getElementById('open-log-folder-button').addEventListener('click', async () => {
    const result = await window.api.openLogFolder();
    setMessage(elements.diagnosticsMessage, result.success ? 'Opened the log folder.' : result.error || 'Could not open the log folder.', !result.success);
  });
}

window.api.onStreamExit(async (payload) => {
  if (!state.streamGeneration || payload.generation !== state.streamGeneration) return;
  if (state.isCasting && elements.reconnect.checked && state.currentSerial) {
    setAvailability('Connection dropped. Reconnecting\u2026', 'connecting');
    const guardedReconnect = await rendererLifecycle.requestReconnectForCurrentOwnership({
      generation: payload.generation,
      requestedProfile: state.selectedProfile,
      getCurrentOwnership: () => state.activeStreamOwnership,
      requestReconnect: (generation) => window.api.requestReconnect(generation)
    });
    if (guardedReconnect.accepted && guardedReconnect.result?.scheduled) return;
  }
  await restoreProximitySensor();
  returnToReadyState('The cast ended. Start casting to reconnect.', 'warning');
});

window.api.onStreamStatus((status) => {
  if (status?.generation !== state.streamGeneration) return;
  const expectedProfile = rendererQuality.getLockedProfileId(
    state.selectedProfile,
    state.outputFormat,
    elements.rightEye.checked
  );
  if (status.effectiveProfile && status.effectiveProfile !== expectedProfile) {
    setAvailability('Stabilized could not start; Low Latency is active.', 'ready');
  }
});

async function initialize() {
  loadSettings();
  wireEvents();
  updateProfileControls();
  updateVolumeLabels();
  elements.awake.checked = localStorage.getItem('keepAwake') === 'true';
}

initialize().catch((error) => setAvailability(`Quest 3 Caster could not initialize: ${error.message}`, 'error'));
