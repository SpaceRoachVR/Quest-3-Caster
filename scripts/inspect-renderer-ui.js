'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const {
  createInspectionProfile,
  removeInspectionProfile
} = require('../lib/inspection-temp-profile');

const root = path.resolve(__dirname, '..');
const electronPath = require('electron');
const tempRoot = os.tmpdir();
const userDataPath = createInspectionProfile(tempRoot);

let result;
try {
  result = spawnSync(electronPath, [path.join(__dirname, 'renderer-inspection-app.js')], {
    cwd: root,
    env: {
      ...process.env,
      Q3C_INSPECTION_USER_DATA: userDataPath
    },
    stdio: 'inherit',
    windowsHide: true
  });
} finally {
  // spawnSync returns only after the owned Electron process tree has exited.
  // Remove this run's exact profile; never enumerate or delete sibling runs.
  removeInspectionProfile(userDataPath, tempRoot);
}

if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`Renderer inspection ended with signal ${result.signal}.`);
}
if (result.status !== 0) {
  process.exitCode = result.status || 1;
}
