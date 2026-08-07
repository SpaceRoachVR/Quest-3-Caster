'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_PREFIX = 'q3c-ui-inspection-';

function resolveTempRoot(tempRoot) {
  if (typeof tempRoot !== 'string' || !tempRoot) {
    throw new Error('Inspection temp root is required.');
  }
  return path.resolve(tempRoot);
}

function createInspectionProfile(tempRoot) {
  const root = resolveTempRoot(tempRoot);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, PROFILE_PREFIX));
}

function removeInspectionProfile(profilePath, tempRoot) {
  const root = resolveTempRoot(tempRoot);
  if (typeof profilePath !== 'string' || !profilePath) {
    throw new Error('An owned inspection profile is required.');
  }
  const resolved = path.resolve(profilePath);
  if (
    path.dirname(resolved) !== root
    || !path.basename(resolved).startsWith(PROFILE_PREFIX)
    || resolved === root
  ) {
    throw new Error('Refusing to remove a path that is not an owned inspection profile.');
  }
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50
  });
}

module.exports = {
  PROFILE_PREFIX,
  createInspectionProfile,
  removeInspectionProfile
};
