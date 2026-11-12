'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAdbPath } = require('../lib/executable-path');

const FALLBACK = 'C:\\bundle\\adb.exe';

function fakeFs(entries) {
  return {
    statSync(filePath) {
      if (!(filePath in entries)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => entries[filePath] === 'file' };
    },
  };
}

const fs = fakeFs({
  'C:\\platform-tools\\adb.exe': 'file',
  'C:\\platform-tools\\ADB.EXE': 'file',
  'D:/tools/adb.exe': 'file',
  'C:\\platform-tools\\scrcpy.exe': 'file',
  'C:\\folder\\adb.exe': 'directory',
});

test('an empty custom path falls back to the bundled ADB', () => {
  for (const value of [undefined, null, '']) {
    assert.equal(normalizeAdbPath(value, { fallback: FALLBACK, fs }), FALLBACK);
  }
});

test('a full local path to an existing adb.exe is accepted', () => {
  for (const value of ['C:\\platform-tools\\adb.exe', 'C:\\platform-tools\\ADB.EXE', 'D:/tools/adb.exe']) {
    assert.equal(normalizeAdbPath(value, { fallback: FALLBACK, fs }), value);
  }
});

test('relative names, network shares, other executables and missing files are rejected', () => {
  const cases = [
    ['adb', /full path/],
    ['adb.exe', /full path/],
    ['.\\adb.exe', /full path/],
    ['\\platform-tools\\adb.exe', /full path/],
    ['\\\\server\\share\\adb.exe', /network share/],
    ['//server/share/adb.exe', /network share/],
    ['C:\\platform-tools\\scrcpy.exe', /named adb\.exe/],
    ['C:\\platform-tools\\adb.exe.bak', /named adb\.exe/],
    ['C:\\missing\\adb.exe', /does not exist/],
    ['C:\\folder\\adb.exe', /not a file/],
    [' C:\\platform-tools\\adb.exe', /not a valid path/],
    ['C:\\platform-tools\\adb.exe\0', /not a valid path/],
    [42, /not a valid path/],
    [{}, /not a valid path/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(
      () => normalizeAdbPath(value, { fallback: FALLBACK, fs }), pattern, String(value));
  }
});
