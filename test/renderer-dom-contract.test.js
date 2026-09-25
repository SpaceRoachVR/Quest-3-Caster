'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('production home contains USB scan, profile, and diagnostics entry points', () => {
  for (const id of [
    'scan-usb-button', 'start-cast-button', 'usb-device-list', 'headset-ip-input',
    'low-latency-profile', 'stabilized-profile', 'settings-button',
    'open-log-folder-button',
    'widescreen-output', 'square-output', 'right-eye-option', 'right-eye-toggle'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-profile="obsLowLatency1080p60"/);
  assert.match(html, /data-profile="obsStabilized1080p60"/);
  assert.doesNotMatch(html, /Pair device with pairing code|wireless-pair-button|wireless-pairing-port-input/);
  assert.doesNotMatch(html, /id="saved-device-list"|id="add-headset-button"|id="pairing-view"|id="edit-device-modal"/);
});

test('square output reveals a right-eye choice while keeping stream arguments locked', () => {
  assert.match(renderer, /outputFormatButtons/);
  assert.match(renderer, /rightEyeOption\.classList\.toggle/);
  assert.match(renderer, /getLockedProfileId/);
  assert.doesNotMatch(renderer, /crop:\s*elements/);
});

test('retired tuning controls and terminal are absent from the production UI', () => {
  for (const id of [
    'bitrate-slider', 'fps-select', 'max-size-select', 'video-codec-select',
    'crop-select', 'display-id-select', 'audio-codec-select', 'console-output-box'
  ]) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /Terminal Logs/i);
});

test('renderer uses USB scan flow and log-folder IPC without unsafe DOM insertion', () => {
  assert.match(renderer, /window\.api\.enableTcpIp/);
  assert.match(renderer, /window\.api\.connectWireless/);
  assert.match(renderer, /window\.api\.openLogFolder/);
  assert.match(renderer, /requestReconnectForCurrentOwnership/);
  assert.doesNotMatch(renderer, /\.innerHTML\s*=/);
  assert.doesNotMatch(renderer, /window\.api\.listSavedDevices|window\.api\.saveDevice/);
  for (const api of ['enableTcpIp:', 'connectWireless:', 'openLogFolder:']) {
    assert.match(preload, new RegExp(api));
  }
  for (const api of ['listSavedDevices', 'saveDevice', 'updateSavedDevice', 'removeSavedDevice', 'markDeviceConnected']) {
    assert.doesNotMatch(preload, new RegExp(`${api}:`));
  }
});

test('a bypassed proximity sensor is restored on stop, on exit, and on quit', () => {
  // Leaving the bypass applied drains the headset battery until it reboots.
  assert.match(renderer, /async function restoreProximitySensor/);
  const stopBody = /async function stopCasting\(\)[\s\S]*?\n\}/.exec(renderer)[0];
  assert.match(stopBody, /await restoreProximitySensor\(\)/);
  const exitBody = /window\.api\.onStreamExit\([\s\S]*?\n\}\);/.exec(renderer)[0];
  assert.match(exitBody, /await restoreProximitySensor\(\)/);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /app\.on\('will-quit'/);
  assert.match(main, /restoreProximityBypass/);
});

test('ending a cast keeps the wireless endpoint instead of forcing a USB re-scan', () => {
  assert.match(renderer, /function returnToReadyState/);
  const stopBody = /async function stopCasting\(\)[\s\S]*?\n\}/.exec(renderer)[0];
  assert.match(stopBody, /returnToReadyState/);
  assert.doesNotMatch(stopBody, /resetConnectionState/);
  const exitBody = /window\.api\.onStreamExit\([\s\S]*?\n\}\);/.exec(renderer)[0];
  assert.match(exitBody, /returnToReadyState/);
  assert.doesNotMatch(exitBody, /resetConnectionState/);
});

test('1:1 offers an explicit left/right eye choice', () => {
  // This was a checkbox labelled "Right eye", which did not read as a choice
  // between two options, so the capability was effectively undiscoverable.
  for (const id of ['left-eye-button', 'right-eye-button']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-eye="left"/);
  assert.match(html, /data-eye="right"/);
  assert.match(html, /role="radiogroup"[^>]*aria-label="Which eye/);
  assert.match(renderer, /eyeButtons/);
  // The selection must still reach the locked profile id.
  assert.match(renderer, /getLockedProfileId/);
});

test('the eye buttons never fire the output-format handler', () => {
  // The eye buttons reuse .output-format-option for styling. While the format
  // handler was bound by that class alone, clicking an eye also ran it with an
  // undefined format, which normalised to widescreen and snapped 1:1 back to
  // 16:9. Each handler must select by the data attribute it actually reads.
  assert.match(renderer, /outputFormatButtons:[^\n]*\[data-output-format\]/);
  assert.match(renderer, /eyeButtons:[^\n]*\[data-eye\]/);

  // ...which only separates the two groups if no button carries both.
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  const formats = buttons.filter((tag) => /\bdata-output-format=/.test(tag));
  const eyes = buttons.filter((tag) => /\bdata-eye=/.test(tag));
  assert.ok(formats.length >= 2, 'expected widescreen and square format buttons');
  assert.ok(eyes.length >= 2, 'expected left and right eye buttons');
  assert.equal(
    buttons.filter((tag) => /\bdata-output-format=/.test(tag) && /\bdata-eye=/.test(tag)).length,
    0,
    'no button may be both an output format and an eye choice',
  );
});

test('game and microphone levels are adjustable and debounced', () => {
  for (const id of [
    'game-volume-slider', 'game-volume-value',
    'mic-volume-slider', 'mic-volume-value', 'mic-volume-row'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(renderer, /window\.api\.setGameVolume/);
  assert.match(renderer, /window\.api\.setMicVolume/);
  // Every apply spawns PowerShell, so slider input must be coalesced.
  assert.match(renderer, /function commitVolume/);
  assert.match(renderer, /setTimeout/);
  // Levels only mean anything once the stream owns an audio session.
  assert.match(renderer, /async function applyStoredVolumes/);
  for (const api of ['setGameVolume:', 'setMicVolume:']) {
    assert.match(preload, new RegExp(api));
  }
});

test('uses the selected dark consumer workspace visual system without gradients', () => {
  assert.match(styles, /#10151d/);
  assert.match(styles, /\.workspace\s*\{/);
  assert.doesNotMatch(styles, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(styles, /saved-device-row|modal-backdrop/);
});

test('the refresh-rate warning reaches the active status line without blocking the cast', () => {
  // A 72 or 90 Hz headset drops frames unevenly into a 60 FPS cast. The
  // preflight reads the rate and the renderer folds the warning into the
  // "Casting is active." line, which needs a visible warning tone.
  assert.match(renderer, /preflight\.refreshRateWarning/);
  assert.match(styles, /\.availability\[data-tone="warning"\]/);
});
