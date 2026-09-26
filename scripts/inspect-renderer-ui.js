'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createInspectionProfile,
  removeInspectionProfile
} = require('../lib/inspection-temp-profile');
const { evaluateInspectionRun } = require('../lib/inspection-run-outcome');

const root = path.resolve(__dirname, '..');
const electronPath = require('electron');
const tempRoot = os.tmpdir();
const userDataPath = createInspectionProfile(tempRoot);
// The inspection app writes this file only after every assertion passed, so a
// run that stops early cannot be mistaken for a success.
const resultPath = path.join(userDataPath, 'inspection-result.json');

let result;
let resultText = null;
try {
  result = spawnSync(electronPath, [path.join(__dirname, 'renderer-inspection-app.js')], {
    cwd: root,
    env: {
      ...process.env,
      Q3C_INSPECTION_USER_DATA: userDataPath,
      Q3C_INSPECTION_RESULT: resultPath
    },
    stdio: 'inherit',
    windowsHide: true
  });
  if (fs.existsSync(resultPath)) {
    resultText = fs.readFileSync(resultPath, 'utf8');
  }
} finally {
  // spawnSync returns only after the owned Electron process tree has exited.
  // Remove this run's exact profile; never enumerate or delete sibling runs.
  removeInspectionProfile(userDataPath, tempRoot);
}

const outcome = evaluateInspectionRun({
  error: result.error,
  signal: result.signal,
  status: result.status,
  resultText
});

if (!outcome.ok) {
  console.error(outcome.message);
  process.exitCode = outcome.exitCode;
} else {
  console.log(JSON.stringify(outcome.result, null, 2));
}
