'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createInspectionProfile,
  removeInspectionProfile
} = require('../lib/inspection-temp-profile');

test('inspection cleanup removes only the exact owned profile and preserves concurrent siblings', () => {
  const first = createInspectionProfile(os.tmpdir());
  const second = createInspectionProfile(os.tmpdir());
  fs.writeFileSync(path.join(first, 'owned.txt'), 'first');
  fs.writeFileSync(path.join(second, 'owned.txt'), 'second');

  removeInspectionProfile(first, os.tmpdir());
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(second, 'owned.txt'), 'utf8'), 'second');

  removeInspectionProfile(second, os.tmpdir());
  assert.equal(fs.existsSync(second), false);
});

test('inspection cleanup rejects non-owned and parent paths', () => {
  assert.throws(() => removeInspectionProfile(os.tmpdir(), os.tmpdir()), /owned inspection profile/);
  assert.throws(
    () => removeInspectionProfile(path.join(os.tmpdir(), 'unrelated-profile'), os.tmpdir()),
    /owned inspection profile/
  );
});
