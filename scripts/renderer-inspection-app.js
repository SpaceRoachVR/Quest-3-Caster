'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const screenshotPath = process.env.Q3C_INSPECTION_SCREENSHOT || path.join(root, '.superpowers', 'sdd', 'task-production-ui-inspection.png');
const userDataPath = process.env.Q3C_INSPECTION_USER_DATA;
const resultPath = process.env.Q3C_INSPECTION_RESULT;
const consoleProblems = [];

if (!userDataPath || !resultPath) {
  console.error('Run this through `npm run ui:inspect`; it sets Q3C_INSPECTION_USER_DATA and Q3C_INSPECTION_RESULT.');
  app.exit(1);
}

app.setPath('userData', userDataPath);
app.disableHardwareAcceleration();

function describeConsoleProblems() {
  if (consoleProblems.length === 0) return '';
  return `\nRenderer console:\n${consoleProblems.map((problem) => `  ${problem}`).join('\n')}`;
}

// Every renderer evaluation goes through here so a throw inside the page is
// reported with the step that ran it and whatever the renderer console said,
// instead of Electron's generic "Script failed to execute".
async function evaluate(window, expression, label) {
  try {
    return await window.webContents.executeJavaScript(expression);
  } catch (error) {
    throw new Error(`Renderer inspection step "${label}" failed: ${error.message}${describeConsoleProblems()}`);
  }
}

async function waitFor(window, expression, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(window, expression, `wait for ${label}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.${describeConsoleProblems()}`);
}

async function click(window, selector) {
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`, `click ${selector}`);
}

async function inspect() {
  const window = new BrowserWindow({
    width: 1200,
    height: 1050,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(root, 'scripts', 'renderer-inspection-preload.js')
    }
  });
  window.webContents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return;
    consoleProblems.push(`${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await window.loadFile(path.join(root, 'index.html'));

  const initial = await evaluate(window, `({
    title: document.querySelector('#home-title').textContent,
    profile: document.querySelector('.profile-option.selected').dataset.profile,
    outputFormat: document.querySelector('.output-format-option[data-output-format].selected').dataset.outputFormat,
    startDisabled: document.querySelector('#start-cast-button').disabled,
    connection: document.querySelector('#connection-status').textContent,
    terminal: document.querySelector('#console-output-box')
  })`, 'initial state');
  assert.deepEqual(initial, {
    title: 'Connect your Quest 3',
    profile: 'obsLowLatency1080p60',
    outputFormat: 'widescreen',
    startDisabled: true,
    connection: 'Not connected',
    terminal: null
  });

  await evaluate(window, "window.rendererInspection.setScanScenario('none')", 'set missing-device scenario');
  await click(window, '#scan-usb-button');
  await waitFor(window, "document.querySelector('#availability-message').textContent === 'No headset found.'", 'missing-device message');
  const missingDevice = await evaluate(window, `({
    startDisabled: document.querySelector('#start-cast-button').disabled,
    connection: document.querySelector('#connection-status').textContent,
    connectionState: document.querySelector('#connection-status').dataset.state
  })`, 'missing-device state');
  assert.deepEqual(missingDevice, { startDisabled: true, connection: 'Not connected', connectionState: 'disconnected' });

  await evaluate(window, "window.rendererInspection.setScanScenario('unauthorized')", 'set unauthorized-device scenario');
  await click(window, '#scan-usb-button');
  await waitFor(window, "document.querySelector('#availability-message').textContent === 'Waiting for you to allow USB debugging.'", 'USB approval message');
  const unauthorized = await evaluate(window, `({
    startDisabled: document.querySelector('#start-cast-button').disabled,
    connectionState: document.querySelector('#connection-status').dataset.state
  })`, 'unauthorized-device state');
  assert.deepEqual(unauthorized, { startDisabled: true, connectionState: 'disconnected' });

  // The supported first-time flow: scan USB, pick the headset, get its IP and
  // enable ADB over Wi-Fi. Casting stays disabled until that completes.
  await evaluate(window, "window.rendererInspection.setScanScenario('ready')", 'set authorized-device scenario');
  await click(window, '#scan-usb-button');
  await waitFor(window, "document.querySelectorAll('#usb-device-list .usb-device-button').length === 1", 'scanned USB headset');
  await click(window, '#usb-device-list .usb-device-button');
  await waitFor(window, "document.querySelector('#start-cast-button').disabled === false", 'headset ready to cast');
  const paired = await evaluate(window, `({
    ip: document.querySelector('#headset-ip-input').value,
    pairingMessage: document.querySelector('#pairing-message').textContent,
    availability: document.querySelector('#availability-message').textContent,
    connection: document.querySelector('#connection-status').textContent,
    connectionState: document.querySelector('#connection-status').dataset.state
  })`, 'paired state');
  assert.deepEqual(paired, {
    ip: '192.168.50.25',
    pairingMessage: 'Ready. The USB cable may now be removed.',
    availability: 'Ready to cast.',
    connection: 'Connected',
    connectionState: 'connected'
  });

  await click(window, '#square-output');
  const squareOutput = await evaluate(window, `({
    selectedFormat: document.querySelector('.output-format-option[data-output-format].selected').dataset.outputFormat,
    rightEyeVisible: !document.querySelector('#right-eye-option').classList.contains('hidden'),
    stabilizedDisabled: document.querySelector('#stabilized-profile').disabled
  })`, 'square output state');
  assert.deepEqual(squareOutput, {
    selectedFormat: 'square', rightEyeVisible: true, stabilizedDisabled: true
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());

  const wideLayout = await evaluate(window, `({
    columns: getComputedStyle(document.querySelector('.workspace-grid')).gridTemplateColumns.split(' ').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`, 'wide layout');
  assert.deepEqual(wideLayout, { columns: 2, horizontalOverflow: false });

  window.setSize(900, 1050);
  const compactLayout = await evaluate(window, `({
    columns: getComputedStyle(document.querySelector('.workspace-grid')).gridTemplateColumns.split(' ').length,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`, 'compact layout');
  assert.deepEqual(compactLayout, { columns: 1, horizontalOverflow: false });
  const compactScreenshotPath = screenshotPath.replace(/\.png$/, '-compact.png');
  fs.writeFileSync(compactScreenshotPath, (await window.capturePage()).toPNG());

  await click(window, '#settings-button');
  const settingsLayout = await evaluate(window, `({
    visible: !document.querySelector('#settings-view').classList.contains('hidden'),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  })`, 'settings layout');
  assert.deepEqual(settingsLayout, { visible: true, horizontalOverflow: false });
  await click(window, '#settings-back-button');

  await click(window, '#widescreen-output');
  await click(window, '#stabilized-profile');
  await click(window, '#start-cast-button');
  await waitFor(window, "document.querySelector('#start-cast-button').textContent === 'Stop casting'", 'active cast');
  const ready = await evaluate(window, 'window.rendererInspection.getLastStartPayload()', 'start payload');
  assert.deepEqual(Object.keys(ready).sort(), ['profileId', 'serial', 'streamMic']);
  assert.equal(ready.profileId, 'obsStabilized1080p60');
  assert.equal(ready.serial, '192.168.50.25:5555');
  assert.equal(ready.streamMic, false);
  const casting = await evaluate(window, `({
    connection: document.querySelector('#connection-status').textContent,
    connectionState: document.querySelector('#connection-status').dataset.state,
    availability: document.querySelector('#availability-message').textContent
  })`, 'casting state');
  assert.deepEqual(casting, { connection: 'Casting', connectionState: 'casting', availability: 'Casting is active.' });

  await click(window, '#start-cast-button');
  await waitFor(window, "document.querySelector('#start-cast-button').textContent === 'Start casting'", 'stopped cast');
  const stopped = await evaluate(window, `({
    connection: document.querySelector('#connection-status').textContent,
    connectionState: document.querySelector('#connection-status').dataset.state,
    availability: document.querySelector('#availability-message').textContent,
    startDisabled: document.querySelector('#start-cast-button').disabled
  })`, 'stopped state');
  // Stopping keeps the wireless endpoint so the user can start again without
  // a USB re-scan.
  assert.deepEqual(stopped, { connection: 'Connected', connectionState: 'connected', availability: 'Ready to cast.', startDisabled: false });

  assert.deepEqual(consoleProblems, [], `Renderer reported console problems.${describeConsoleProblems()}`);
  const summary = { completed: true, initial, missingDevice, unauthorized, paired, squareOutput, wideLayout, compactLayout, settingsLayout, ready, casting, stopped, screenshotPath, compactScreenshotPath };
  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  window.destroy();
}

app.whenReady()
  .then(inspect)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
    app.exit(1);
  });
