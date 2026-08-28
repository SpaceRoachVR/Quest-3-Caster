'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseCalibrationFile } = require('./calibration-file');

// Where calibrations live and which one wins.
//
// A calibration is per-unit -- it came off one headset -- so a user's own
// measurement of their own hardware must outrank anything shipped with the
// app. Search order is therefore user directory first, then the repository's
// `calibration/` directory, which is where a contributed measurement lands.
//
// A calibration file that fails validation is reported rather than skipped
// silently: a headset that quietly falls back to "uncalibrated" after someone
// measured it looks like the wizard did not work.

function calibrationFileName(deviceId) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) {
    throw new Error('A calibration device id must be a short alphanumeric name.');
  }
  return `${deviceId}.json`;
}

function readCalibrationAt(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
  return parseCalibrationFile(text);
}

// `directories` is searched in order; the first hit wins. Returns null when no
// directory holds a calibration for the device, and throws when one does but
// the file is unusable -- those are different situations and only the second
// is something the user needs to fix.
function loadCalibration(deviceId, directories) {
  const fileName = calibrationFileName(deviceId);
  const searched = [];
  for (const directory of directories || []) {
    if (typeof directory !== 'string' || !directory) continue;
    const filePath = path.join(directory, fileName);
    searched.push(filePath);
    let calibration;
    try {
      calibration = readCalibrationAt(filePath);
    } catch (error) {
      const failure = new Error(
        `The calibration for this headset is unusable: ${error.message}`);
      failure.code = 'calibration_invalid';
      failure.path = filePath;
      throw failure;
    }
    if (calibration) {
      return { calibration, path: filePath, searched };
    }
  }
  return null;
}

// A calibration measured on a display of one size cannot be applied to another
// -- an override, a different headset revision, or the wrong file copied in.
// The crops are absolute display coordinates, so this is not a warning.
function assertCalibrationMatchesDisplay(calibration, displaySize) {
  if (
    !displaySize
    || calibration.device.display.width !== displaySize.width
    || calibration.device.display.height !== displaySize.height
  ) {
    const error = new Error(
      `This calibration was measured on a `
      + `${calibration.device.display.width}x${calibration.device.display.height} display, `
      + `but the headset reports `
      + `${displaySize ? `${displaySize.width}x${displaySize.height}` : 'nothing usable'}. `
      + 'Re-run the calibration wizard.');
    error.code = 'calibration_geometry_mismatch';
    throw error;
  }
  return calibration;
}

function saveCalibration(directory, deviceId, calibration) {
  const filePath = path.join(directory, calibrationFileName(deviceId));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(calibration, null, 2)}\n`);
  return filePath;
}

module.exports = {
  assertCalibrationMatchesDisplay,
  calibrationFileName,
  loadCalibration,
  readCalibrationAt,
  saveCalibration,
};
