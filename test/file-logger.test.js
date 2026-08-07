'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RollingFileLogger, sanitizeLogMessage } = require('../lib/file-logger');

test('sanitizes control characters before writing log records', () => {
  assert.equal(sanitizeLogMessage(' hello\nworld\u0000 '), 'hello world');
});

test('writes timestamped text logs and retains the newest 30 files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-logs-'));
  for (let index = 0; index < 31; index += 1) {
    fs.writeFileSync(path.join(directory, `quest-3-caster-2026-07-25T00-00-${String(index).padStart(2, '0')}-000Z.txt`), 'old');
  }
  const logger = new RollingFileLogger({
    fs,
    directory,
    now: () => new Date('2026-07-26T12:00:00.000Z')
  });
  logger.write('stream started');
  const files = fs.readdirSync(directory).filter((entry) => entry.endsWith('.txt'));
  assert.equal(files.length, 30);
  const current = files.find((entry) => entry.includes('2026-07-26'));
  assert.match(fs.readFileSync(path.join(directory, current), 'utf8'), /stream started/);
});

test('never throws into casting when the filesystem cannot accept logs', () => {
  const logger = new RollingFileLogger({
    fs: {
      mkdirSync() { throw new Error('denied'); },
      appendFileSync() {},
      readdirSync() { return []; }
    },
    directory: 'C:\\logs'
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => logger.write('casting should continue'));
  } finally {
    console.error = originalError;
  }
});
