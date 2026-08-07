'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  installVerifiedCandidate,
} = require('../scripts/replace-native-libraries');

const PATHS = Object.freeze({
  parent: 'C:\\app\\resources\\native',
  bundle: 'C:\\app\\resources\\native\\win32-x64',
  candidate: 'C:\\app\\resources\\native\\.replace-test',
  backup: 'C:\\app\\resources\\native\\.backup-test',
});

function createInjectedFileSystem(failingRenames = new Set()) {
  const directories = new Map([
    [PATHS.bundle, 'original'],
    [PATHS.candidate, 'candidate'],
  ]);
  const calls = [];
  return {
    calls,
    directories,
    existsSync(targetPath) {
      return directories.has(targetPath);
    },
    renameSync(sourcePath, destinationPath) {
      const operation = `${sourcePath}->${destinationPath}`;
      calls.push(operation);
      if (failingRenames.has(operation)) {
        throw new Error(`injected rename failure: ${operation}`);
      }
      if (!directories.has(sourcePath) || directories.has(destinationPath)) {
        throw new Error(`invalid injected rename: ${operation}`);
      }
      const value = directories.get(sourcePath);
      directories.delete(sourcePath);
      directories.set(destinationPath, value);
    },
  };
}

function createRemoveDirectory(fileSystem) {
  return (_parentDirectory, targetPath) => {
    fileSystem.directories.delete(targetPath);
  };
}

function installWith({
  fileSystem,
  verifyBundle = () => ({ verified: true }),
}) {
  return installVerifiedCandidate({
    nativeParent: PATHS.parent,
    bundleDirectory: PATHS.bundle,
    candidateDirectory: PATHS.candidate,
    backupDirectory: PATHS.backup,
    fileSystem,
    verifyBundle,
    removeDirectory: createRemoveDirectory(fileSystem),
  });
}

test('candidate rename failure restores the original installed bundle', () => {
  const failedOperation = `${PATHS.candidate}->${PATHS.bundle}`;
  const fileSystem = createInjectedFileSystem(new Set([failedOperation]));

  assert.throws(
    () => installWith({ fileSystem }),
    /candidate install failed.*original bundle was restored/i,
  );
  assert.equal(fileSystem.directories.get(PATHS.bundle), 'original');
  assert.equal(fileSystem.directories.get(PATHS.candidate), 'candidate');
  assert.equal(fileSystem.directories.has(PATHS.backup), false);
});

test('installed verification failure rolls back to the original bundle', () => {
  const fileSystem = createInjectedFileSystem();

  assert.throws(
    () => installWith({
      fileSystem,
      verifyBundle() {
        throw new Error('injected installed verification failure');
      },
    }),
    /installed replacement failed verification.*original bundle was restored/i,
  );
  assert.equal(fileSystem.directories.get(PATHS.bundle), 'original');
  assert.equal(fileSystem.directories.has(PATHS.candidate), false);
  assert.equal(fileSystem.directories.has(PATHS.backup), false);
});

test('successful installed verification removes the backup only afterward', () => {
  const fileSystem = createInjectedFileSystem();
  const observations = [];

  const result = installWith({
    fileSystem,
    verifyBundle(targetPath) {
      observations.push({
        targetPath,
        installed: fileSystem.directories.get(PATHS.bundle),
        backup: fileSystem.directories.get(PATHS.backup),
      });
      return { verified: true };
    },
  });

  assert.deepEqual(result, { verified: true });
  assert.deepEqual(observations, [{
    targetPath: PATHS.bundle,
    installed: 'candidate',
    backup: 'original',
  }]);
  assert.equal(fileSystem.directories.get(PATHS.bundle), 'candidate');
  assert.equal(fileSystem.directories.has(PATHS.backup), false);
});

test('rollback failure preserves both original and replacement with recovery paths', () => {
  const failedRestore = `${PATHS.backup}->${PATHS.bundle}`;
  const fileSystem = createInjectedFileSystem(new Set([failedRestore]));

  assert.throws(
    () => installWith({
      fileSystem,
      verifyBundle() {
        throw new Error('injected installed verification failure');
      },
    }),
    (error) => {
      assert.match(error.message, /automatic rollback failed/i);
      assert.match(error.message, new RegExp(PATHS.backup.replace(/\\/g, '\\\\')));
      assert.match(error.message, /original bundle is preserved/i);
      assert.match(error.message, /replacement was restored to the installed path/i);
      return true;
    },
  );
  assert.equal(fileSystem.directories.get(PATHS.bundle), 'candidate');
  assert.equal(fileSystem.directories.get(PATHS.backup), 'original');
});
