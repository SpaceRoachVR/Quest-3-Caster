'use strict';

const path = require('node:path');

const ADB_FILE_NAME = 'adb.exe';
// The Windows limit for an extended-length path.
const MAX_PATH_LENGTH = 32767;

// The custom ADB path comes from the renderer and is replayed from
// localStorage on every launch, so it is untrusted. The main process runs
// whatever this returns, which is why it must be a specific local file rather
// than a name resolved through the working directory, PATH or a network share.
function normalizeAdbPath(value, { fallback, fs }) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (!fs || typeof fs.statSync !== 'function') {
    throw new TypeError('A filesystem implementation is required.');
  }
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value.trim() !== value
      || value.includes('\0')) {
    throw new Error('The custom ADB path is not a valid path.');
  }
  if (/^[\\/]{2}/.test(value)) {
    throw new Error('The custom ADB path must be on this computer, not a network share.');
  }
  if (!path.win32.isAbsolute(value) || !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('The custom ADB path must be a full path, such as C:\\platform-tools\\adb.exe.');
  }
  if (path.win32.basename(value).toLowerCase() !== ADB_FILE_NAME) {
    throw new Error('The custom ADB path must point to a file named adb.exe.');
  }
  let stats;
  try {
    stats = fs.statSync(value);
  } catch (_error) {
    throw new Error('The custom ADB path does not exist.');
  }
  if (!stats.isFile()) {
    throw new Error('The custom ADB path is not a file.');
  }
  return value;
}

module.exports = { normalizeAdbPath };
