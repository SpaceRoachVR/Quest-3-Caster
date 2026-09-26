'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { evaluateInspectionRun } = require('../lib/inspection-run-outcome');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const preload = read('preload.js');
const inspectionApp = read('scripts/renderer-inspection-app.js');
const inspectionPreload = read('scripts/renderer-inspection-preload.js');
const launcher = read('scripts/inspect-renderer-ui.js');

function exposedApiMethods(source) {
  const block = /exposeInMainWorld\('api',\s*\{([\s\S]*?)\n\}\);/.exec(source);
  assert.ok(block, 'expected a window.api exposure block');
  return [...block[1].matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
}

test('a run only passes when the child exited 0 and wrote a completed result', () => {
  const good = evaluateInspectionRun({ status: 0, signal: null, resultText: '{"completed":true,"ready":{}}' });
  assert.equal(good.ok, true);
  assert.equal(good.exitCode, 0);
  assert.equal(good.result.completed, true);

  // Exit 0 with no result means the inspection script died before finishing:
  // the case that used to print a renderer error and still look like a pass.
  const silent = evaluateInspectionRun({ status: 0, signal: null, resultText: null });
  assert.equal(silent.ok, false);
  assert.equal(silent.exitCode, 1);
  assert.match(silent.message, /produced no inspection result/);

  assert.equal(evaluateInspectionRun({ status: 0, signal: null, resultText: '{"completed":false}' }).ok, false);
  assert.equal(evaluateInspectionRun({ status: 0, signal: null, resultText: 'not json' }).ok, false);

  const failed = evaluateInspectionRun({ status: 3, signal: null, resultText: '{"completed":true}' });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);

  assert.equal(evaluateInspectionRun({ status: null, signal: null, resultText: null }).exitCode, 1);
  assert.equal(evaluateInspectionRun({ status: null, signal: 'SIGKILL', resultText: null }).ok, false);
  assert.equal(evaluateInspectionRun({ error: new Error('spawn failed'), resultText: null }).ok, false);
});

test('the launcher fails on a missing result and hands the result path to the child', () => {
  assert.match(launcher, /evaluateInspectionRun/);
  assert.match(launcher, /Q3C_INSPECTION_RESULT: resultPath/);
  assert.match(launcher, /process\.exitCode = outcome\.exitCode/);
  assert.match(inspectionApp, /completed: true/);
  assert.match(inspectionApp, /fs\.writeFileSync\(resultPath/);
});

test('the inspection stub exposes exactly the production window.api surface', () => {
  const production = exposedApiMethods(preload).sort();
  const stub = exposedApiMethods(inspectionPreload).sort();
  assert.ok(production.length > 0);
  assert.deepEqual(stub, production);
});

test('the inspection app drives the USB scan flow, not retired UI', () => {
  for (const id of ['scan-usb-button', 'usb-device-list', 'headset-ip-input', 'home-title', 'start-cast-button']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(inspectionApp, new RegExp(`#${id}`));
  }
  for (const id of ['saved-device-list', 'selected-device-title']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    assert.doesNotMatch(inspectionApp, new RegExp(`#${id}(?![\\w-])`));
  }
  assert.match(inspectionApp, /contextIsolation: true/);
  assert.match(inspectionApp, /nodeIntegration: false/);
  assert.doesNotMatch(inspectionApp, /innerHTML/);
});

test('the console listener uses the event-object form Electron 43 expects', () => {
  assert.match(inspectionApp, /on\('console-message', \(event\) =>/);
  assert.match(inspectionApp, /event\.level/);
  assert.doesNotMatch(inspectionApp, /\(_event, level, message\)/);
});
