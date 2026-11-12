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
  scanUsb: document.getElementById('scan-usb-button'),
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
  castLockNote: document.getElementById('cast-lock-note'),
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
  // Bumped by every scan and headset selection so a slower, older setup
  // attempt cannot overwrite the result of a newer one.
  usbSetupToken: 0,
  selectedProfile: 'obsLowLatency1080p60',
  outputFormat: 'widescreen',
  currentSerial: null,
  streamGeneration: null,
  isCasting: false,
  isProximityBypassed: false,
  activeStreamOwnership: null,
  // Which profile the last preflight settled on, and whether it came from a
  // calibration. Set by runPreflight, consumed when the stream is started.
  resolvedProfile: null
};

function setMessage(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function setAvailability(message, tone = 'neutral') {
  elements.availability.textContent = message;
  elements.availability.dataset.tone = tone;
}

function setConnectionStatus(label, state) {
  elements.connectionStatus.textContent = label;
  elements.connectionStatus.dataset.state = state;
}

function getRuntimeConfig() {
  return { adbPath: elements.adbPath.value.trim() };
}

// A process that could not be spawned reports text such as "spawn … ENOENT",
// which tells the user nothing they can act on. The main process logs the raw
// cause; here it becomes a next step. Anything else is already written for
// the user and passes through.
function describeProcessFailure(error, nextStep) {
  return !error || /\b(ENOENT|EACCES|EPERM|spawn)\b/i.test(error) ? nextStep : error;
}

function persistSetting(key, value) {
  localStorage.setItem(key, String(value));
}

function loadSettings() {
  elements.adbPath.value = localStorage.getItem('adbPath') || '';
  // Left over from the removed custom scrcpy path setting.
  localStorage.removeItem('scrcpyPath');
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
    button.disabled = unavailableForOutput || state.isCasting;
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-disabled', String(unavailableForOutput || state.isCasting));
  });
  // These settings are fixed for the life of a cast. Disabling them says so,
  // where an enabled control that ignores clicks does not.
  [...elements.outputFormatButtons, ...elements.eyeButtons].forEach((button) => {
    button.disabled = state.isCasting;
  });
  elements.microphone.disabled = state.isCasting;
  elements.microphone.closest('.toggle-row').classList.toggle('disabled', state.isCasting);
  elements.castLockNote.classList.toggle('hidden', !state.isCasting);
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
  setConnectionStatus('Not connected', 'disconnected');
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
  elements.scanUsb.disabled = false;
  updateProfileControls();
  if (!state.detectedIp) {
    resetConnectionState();
    return;
  }
  setConnectionStatus('Connected', 'connected');
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
  const gameResult = await window.api.setGameVolume(readVolume(elements.gameVolume.value));
  if (!gameResult?.success) {
    setMessage(elements.volumeNote, gameResult?.error || 'Could not apply the saved game volume.', true);
    return;
  }
  if (elements.microphone.checked) {
    const micResult = await window.api.setMicVolume(readVolume(elements.micVolume.value));
    if (!micResult?.success) {
      setMessage(elements.volumeNote, micResult?.error || 'Could not apply the saved microphone volume.', true);
      return;
    }
  }
  setMessage(elements.volumeNote, 'Levels are saved and applied to the Windows volume mixer while casting.');
}

// Returns an error string when the sensor could not be restored, or '' on
// success/no-op, so callers can fold the warning into their own status message
// instead of it vanishing silently.
async function restoreProximitySensor() {
  if (!state.isProximityBypassed || !state.currentSerial) return '';
  const result = await window.api.toggleProximitySensor(state.currentSerial, false, getRuntimeConfig());
  if (result.success) {
    state.isProximityBypassed = false;
    return '';
  }
  return result.error || 'Could not restore the headset proximity sensor.';
}

async function runPreflight(serial) {
  const result = await window.api.preflightStream(serial, getRuntimeConfig());
  if (!result.success) {
    setAvailability(result.error || 'This headset is not ready to cast.', 'error');
    return null;
  }
  // A headset with a calibration streams from it; one without falls through to
  // the locked profiles, which only fit the headset their crops were measured
  // on. The framing controls mean the same thing either way, so nothing about
  // this choice is exposed to the user beyond the note below.
  const resolved = rendererQuality.resolveStreamProfile({
    profileId: state.selectedProfile,
    outputFormat: state.outputFormat,
    rightEye: elements.rightEye.checked,
    preflight: result
  });
  if (!resolved.availability?.available) {
    setAvailability(
      resolved.availability?.reason || 'The selected casting profile is unavailable.',
      'error'
    );
    return null;
  }
  state.resolvedProfile = resolved;
  return result;
}

function getExpectedProfileId() {
  return state.resolvedProfile?.profileId
    || rendererQuality.getLockedProfileId(
      state.selectedProfile,
      state.outputFormat,
      elements.rightEye.checked
    );
}

// Only the locked path can substitute a profile; a calibrated stream has
// nothing to fall back to, so a mismatch there is not a fallback. Returns ''
// when the stream is running the profile that was asked for.
function getFallbackNotice(status) {
  if (state.resolvedProfile?.calibrated
      || !status?.effectiveProfile
      || status.effectiveProfile === getExpectedProfileId()) {
    return '';
  }
  return status.fallbackWarning
    ? `Stabilized could not start; Low Latency is active. ${status.fallbackWarning}`
    : 'Stabilized could not start; Low Latency is active.';
}

// A start can fail after the keep-awake bypass was applied, so every failure
// exit hands the proximity sensor back rather than leaving the headset awake.
async function failStart(message) {
  const proximityWarning = await restoreProximitySensor();
  setAvailability(proximityWarning ? `${message} ${proximityWarning}` : message, 'error');
  elements.scanUsb.disabled = false;
  elements.startCast.disabled = false;
}

async function connectAndStart() {
  if (!state.detectedIp || state.isCasting) return;
  elements.startCast.disabled = true;
  // A scan resets the connection state this start depends on, and during a
  // cast it would relabel the only control that can stop the stream.
  elements.scanUsb.disabled = true;
  setAvailability('Connecting to headset\u2026', 'connecting');
  const target = `${state.detectedIp}:5555`;
  const connection = await window.api.connectWireless(target, getRuntimeConfig());
  if (!connection.success) {
    if (connection.code === 'connection_refused') {
      // Port 5555 closes when the headset restarts, so the saved address is
      // no longer a working endpoint. Drop it rather than leave "Connected"
      // and an enabled Start button pointing at it.
      resetConnectionState();
      elements.scanUsb.disabled = false;
      setAvailability(
        'The headset stopped accepting Wi-Fi connections, which happens after a headset restart. '
          + 'Plug it in by USB, then press Scan USB devices.',
        'error'
      );
      elements.scanUsb.focus();
      return;
    }
    await failStart(describeProcessFailure(
      connection.error,
      'ADB did not start. Open Settings and choose Verify executables, or clear the custom ADB path.'
    ));
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
    // runPreflight has already put the reason on the availability line.
    await failStart(elements.availability.textContent);
    return;
  }
  const request = rendererQuality.buildResolvedStreamPayload(state.resolvedProfile, {
    serial: state.currentSerial,
    streamMic: elements.microphone.checked,
    outputFormat: state.outputFormat,
    rightEye: elements.rightEye.checked
  });
  const calibratedNote = rendererQuality.getCalibratedNote(state.resolvedProfile);
  if (calibratedNote) {
    elements.profileNote.textContent = calibratedNote;
  }
  setAvailability('Starting cast\u2026', 'connecting');
  const stream = await window.api.startStream(request, getRuntimeConfig());
  if (!stream.success) {
    await failStart(describeProcessFailure(
      stream.error,
      'The casting engine did not start. Open Settings and choose Verify executables; details are in the log folder.'
    ));
    return;
  }
  state.isCasting = true;
  state.streamGeneration = stream.generation;
  state.activeStreamOwnership = rendererLifecycle.createActiveStreamOwnership(
    stream.generation,
    state.selectedProfile,
    elements.microphone.checked
  );
  setConnectionStatus('Casting', 'casting');
  elements.startCast.disabled = false;
  elements.startCast.textContent = 'Stop casting';
  updateProfileControls();
  // The refresh-rate warning is advisory: the cast runs either way, so it
  // shares the active line rather than blocking the start.
  // The fallback notice is read from the start result: the status event for
  // this start arrives before the generation above is known, so it is dropped.
  const castWarnings = [
    getFallbackNotice(stream), keepAwakeWarning, preflight.refreshRateWarning
  ].filter(Boolean);
  setAvailability(
    castWarnings.length > 0 ? `Casting is active. ${castWarnings.join(' ')}` : 'Casting is active.',
    castWarnings.length > 0 ? 'warning' : 'ready'
  );
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
  const proximityWarning = await restoreProximitySensor();
  returnToReadyState(
    proximityWarning ? `Ready to cast. ${proximityWarning}` : 'Ready to cast.',
    proximityWarning ? 'warning' : 'ready'
  );
}

const TCPIP_RESTART_RETRY_DELAYS_MS = [500, 1000, 1500, 2000];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `adb tcpip` restarts the headset's ADB service, so port 5555 briefly refuses
// connections. Retry only that case, a bounded number of times, and stop as
// soon as a newer scan or selection has taken over.
async function verifyWirelessEndpoint(target, isCurrent) {
  let connection = await window.api.connectWireless(target, getRuntimeConfig());
  for (const waitMs of TCPIP_RESTART_RETRY_DELAYS_MS) {
    if (connection.success || connection.code !== 'connection_refused' || !isCurrent()) break;
    await delay(waitMs);
    if (!isCurrent()) break;
    connection = await window.api.connectWireless(target, getRuntimeConfig());
  }
  return connection;
}

function markHeadsetDetected(ip) {
  elements.headsetIp.value = ip;
  state.detectedIp = ip;
  elements.startCast.disabled = false;
  elements.selectedAddress.textContent = `Detected at ${ip} — USB cable may be removed.`;
}

async function setUpUsbHeadset(device, button) {
  const setupToken = ++state.usbSetupToken;
  const isCurrent = () => setupToken === state.usbSetupToken;
  state.selectedUsbDevice = device;
  state.detectedIp = null;
  elements.headsetIp.value = '';
  elements.startCast.disabled = true;
  [...elements.usbDevices.children].forEach((child) => child.classList.remove('selected'));
  button.classList.add('selected');
  setMessage(elements.pairingMessage, 'Finding the headset IP address…');
  const ipResult = await window.api.getHeadsetIP(device.serial, getRuntimeConfig());
  if (!isCurrent()) return;
  if (!ipResult.success) {
    setMessage(elements.pairingMessage, ipResult.error || 'Could not find the headset IP address.', true);
    setAvailability(ipResult.code === 'device_unauthorized'
      ? 'Waiting for you to allow USB debugging. Scan again after tapping Allow.'
      : 'Headset setup did not finish.', 'error');
    return;
  }
  setMessage(elements.pairingMessage, 'Enabling ADB over Wi-Fi…');
  const tcp = await window.api.enableTcpIp(device.serial, getRuntimeConfig());
  if (!isCurrent()) return;
  if (!tcp.success) {
    setMessage(elements.pairingMessage, tcp.error || 'Could not enable ADB over Wi-Fi.', true);
    setAvailability('Headset setup did not finish.', 'error');
    return;
  }
  setMessage(elements.pairingMessage, 'Checking the Wi-Fi connection…');
  const connection = await verifyWirelessEndpoint(`${ipResult.ip}:5555`, isCurrent);
  if (!isCurrent()) return;
  if (connection.success) {
    markHeadsetDetected(ipResult.ip);
    setConnectionStatus('Connected', 'connected');
    setMessage(elements.pairingMessage, 'Ready. The USB cable may now be removed.');
    setAvailability('Ready to cast.', 'ready');
    return;
  }
  if (connection.code === 'device_unauthorized') {
    // Port 5555 is open; only the headset's approval is missing, and Start
    // casting reconnects once it is given, so there is no need to rescan.
    markHeadsetDetected(ipResult.ip);
    setMessage(elements.pairingMessage, connection.error, true);
    setAvailability('Allow USB debugging in the headset, then press Start casting.', 'warning');
    return;
  }
  setMessage(elements.pairingMessage, connection.error || 'Could not connect to the headset over Wi-Fi.', true);
  setAvailability('Headset setup did not finish.', 'error');
}

async function scanUsbDevices() {
  if (state.isCasting) return;
  state.usbSetupToken += 1;
  elements.usbDevices.replaceChildren();
  state.detectedIp = null;
  state.selectedUsbDevice = null;
  elements.headsetIp.value = '';
  elements.startCast.disabled = true;
  elements.startCast.textContent = 'Start casting';
  setConnectionStatus('Not connected', 'disconnected');
  // The two status lines sit next to each other, so they must never describe
  // different states at once. Availability owns "what happens next"; the
  // pairing line owns device detail.
  setMessage(elements.pairingMessage, '');
  setAvailability('Looking for a connected headset\u2026', 'connecting');
  const result = await window.api.scanDevices(getRuntimeConfig());
  if (!result.success) {
    setMessage(elements.pairingMessage, describeProcessFailure(
      result.error,
      'ADB did not start. Open Settings and choose Verify executables, or clear the custom ADB path.'
    ), true);
    setAvailability('Quest 3 Caster could not reach ADB.', 'error');
    return;
  }
  const devices = result.devices.filter((device) => !device.isWireless && device.status === 'device');
  const unauthorized = result.devices.filter((device) => device.status === 'unauthorized');
  const offline = result.devices.filter((device) => !device.isWireless && device.status === 'offline');
  if (devices.length === 0) {
    // An unauthorized or offline device is a headset that is plugged in but
    // not usable yet, not a missing one, so each gets its own next step.
    if (unauthorized.length > 0) {
      setMessage(elements.pairingMessage, 'Put the headset on and accept the \u201cAllow USB debugging\u201d prompt, then scan again.', true);
      setAvailability('Waiting for you to allow USB debugging.', 'error');
    } else if (offline.length > 0) {
      setMessage(elements.pairingMessage, 'Unplug and replug the USB cable, wake the headset, then scan again.', true);
      setAvailability('Headset found, but it is offline.', 'error');
    } else {
      setMessage(elements.pairingMessage, 'No headset detected. Check the USB cable, and confirm Developer Mode is enabled in the Meta Horizon phone app.', true);
      setAvailability('No headset found.', 'error');
    }
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
    button.addEventListener('click', () => setUpUsbHeadset(device, button));
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
  document.getElementById('verify-paths-button').addEventListener('click', async () => {
    setMessage(elements.diagnosticsMessage, 'Verifying executables\u2026');
    const result = await window.api.checkPaths(getRuntimeConfig());
    const problems = [];
    if (!result.adb) {
      problems.push(describeProcessFailure(
        result.adbError,
        'ADB did not run. Clear the custom ADB path to use the bundled copy.'
      ));
    }
    if (!result.scrcpy) {
      problems.push('The bundled casting engine failed verification. Reinstall Quest 3 Caster; details are in the log folder.');
    }
    setMessage(
      elements.diagnosticsMessage,
      problems.length > 0 ? problems.join(' ') : 'ADB and the bundled casting engine are ready.',
      problems.length > 0
    );
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
  const proximityWarning = await restoreProximitySensor();
  returnToReadyState(
    proximityWarning
      ? `The cast ended. Start casting to reconnect. ${proximityWarning}`
      : 'The cast ended. Start casting to reconnect.',
    'warning'
  );
});

// The cast itself is unaffected: video and game audio run in the primary
// process. Only the separate microphone stream is gone.
window.api.onMicrophoneExit((payload) => {
  if (!state.isCasting || payload?.generation !== state.streamGeneration) return;
  setAvailability(
    'Casting is active. The headset microphone stopped; stop and start the cast to restore it.',
    'warning'
  );
});

window.api.onStreamStatus((status) => {
  if (!state.isCasting || status?.generation !== state.streamGeneration) return;
  // A status for the current generation means a stream is live again after a
  // reconnect or a runtime fallback. Clear "Reconnecting…" and re-apply the
  // saved volumes, which belong to the previous scrcpy process.
  const fallbackNotice = getFallbackNotice(status);
  setAvailability(
    fallbackNotice ? `Casting is active. ${fallbackNotice}` : 'Casting is active.',
    fallbackNotice ? 'warning' : 'ready'
  );
  void applyStoredVolumes();
});

async function initialize() {
  loadSettings();
  wireEvents();
  updateProfileControls();
  updateVolumeLabels();
  elements.awake.checked = localStorage.getItem('keepAwake') === 'true';
}

initialize().catch((error) => setAvailability(`Quest 3 Caster could not initialize: ${error.message}`, 'error'));
