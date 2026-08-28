'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeDisplayOverride,
  parseWmSize,
  parseWmSizes
} = require('../lib/display-geometry');

const QUEST_3 = 'Physical size: 4128x2208\n';
const OVERRIDDEN = 'Physical size: 4128x2208\nOverride size: 1280x720\n';

test('an active override wins over the physical panel', () => {
  // `wm size` prints Physical first, so matching either line took the panel and
  // ignored the resolution the device was actually rendering. The calibrated
  // crops were then validated against geometry that was not on screen.
  assert.deepEqual(parseWmSize(OVERRIDDEN), { width: 1280, height: 720 });
  assert.deepEqual(parseWmSizes(OVERRIDDEN), {
    physical: { width: 4128, height: 2208 },
    override: { width: 1280, height: 720 }
  });
});

test('the physical panel is used when no override is set', () => {
  assert.deepEqual(parseWmSize(QUEST_3), { width: 4128, height: 2208 });
  assert.deepEqual(parseWmSize('Physical size: 3664x1920'), { width: 3664, height: 1920 });
  assert.deepEqual(parseWmSizes(QUEST_3), {
    physical: { width: 4128, height: 2208 },
    override: null
  });
});

test('unusable wm output yields no geometry rather than a partial guess', () => {
  for (const output of [null, undefined, 42, '', 'wm: not found', 'Physical size: 0x0',
    'Physical size: x2208']) {
    assert.equal(parseWmSize(output), null);
  }
  assert.deepEqual(parseWmSizes(undefined), { physical: null, override: null });
});

test('an override is explained with the panel size and the command that clears it', () => {
  const message = describeDisplayOverride(parseWmSizes(OVERRIDDEN));
  assert.match(message, /override of 1280x720/);
  assert.match(message, /panel is 4128x2208/);
  assert.match(message, /wm size reset/);
});

test('no override produces no warning', () => {
  assert.equal(describeDisplayOverride(parseWmSizes(QUEST_3)), null);
  assert.equal(describeDisplayOverride(null), null);
  assert.equal(describeDisplayOverride({}), null);
});

test('an override with no readable physical line still warns', () => {
  const message = describeDisplayOverride(parseWmSizes('Override size: 1920x1080'));
  assert.match(message, /override of 1920x1080/);
  assert.doesNotMatch(message, /panel is/);
});
