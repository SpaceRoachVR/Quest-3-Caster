'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const screenshotPath = process.env.Q3C_INSPECTION_SCREENSHOT || path.join(root, '.superpowers', 'sdd', 'task-production-ui-inspection.png');
const userDataPath = process.env.Q3C_INSPECTION_USER_DATA;
const consoleProblems = [];

app.setPath('userData', userDataPath);
app.disableHardwareAcceleration();

async function waitFor(window, expression, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function click(window, selector) {
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function inspect() {
  const window = new BrowserWindow({ width: 1200, height: 1050, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(root, 'scripts', 'renderer-inspection-preload.js') } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) consoleProblems.push(message); });
  await window.loadFile(path.join(root, 'index.html'));
  await waitFor(window, "document.querySelector('#saved-device-list').children.length === 1", 'saved headset');
  const initial = await window.webContents.executeJavaScript(`({ title: document.querySelector('#selected-device-title').textContent, profile: document.querySelector('.profile-option.selected').dataset.profile, terminal: document.querySelector('#console-output-box') })`);
  assert.equal(initial.title, 'Inspection Quest');
  assert.equal(initial.profile, 'obsLowLatency1080p60');
  assert.equal(initial.terminal, null);

  await click(window, '#square-output');
  const squareOutput = await window.webContents.executeJavaScript(`({
    selectedFormat: document.querySelector('.output-format-option.selected').dataset.outputFormat,
    rightEyeVisible: !document.querySelector('#right-eye-option').classList.contains('hidden'),
    stabilizedDisabled: document.querySelector('#stabilized-profile').disabled
  })`);
  assert.deepEqual(squareOutput, {
    selectedFormat: 'square', rightEyeVisible: true, stabilizedDisabled: true
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, (await window.capturePage()).toPNG());

  await click(window, '#widescreen-output');
  await click(window, '#stabilized-profile');
  await click(window, '#start-cast-button');
  await waitFor(window, "document.querySelector('#start-cast-button').textContent === 'Stop casting'", 'active cast');
  const ready = await window.webContents.executeJavaScript(`window.rendererInspection.getLastStartPayload()`);
  assert.deepEqual(Object.keys(ready).sort(), ['profileId', 'serial', 'streamMic']);
  assert.equal(ready.profileId, 'obsStabilized1080p60');

  await click(window, '#start-cast-button');
  await waitFor(window, "document.querySelector('#start-cast-button').textContent === 'Start casting'", 'stopped cast');
  assert.deepEqual(consoleProblems, []);
  console.log(JSON.stringify({ initial, squareOutput, ready, screenshotPath }, null, 2));
  window.destroy();
}

app.whenReady().then(inspect).then(() => app.exit(0)).catch((error) => { console.error(error.stack || error.message); app.exit(1); });
