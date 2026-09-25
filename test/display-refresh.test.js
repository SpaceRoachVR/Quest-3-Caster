'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeRefreshRate,
  isEvenCadence,
  parseRefreshRateHz
} = require('../lib/display-refresh');

const DISPLAY_INFO = (activeMode, override = '0.0') => 'Logical Displays: size=2\n'
  + '  Display 0:\n'
  + '    mDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, displayGroupId 0, FLAG_SECURE,'
  + ' real 4128 x 2208, largest app 4128 x 2208, smallest app 4128 x 2208, appVsyncOff 1000000,'
  + ` presDeadline 11111111, mode ${activeMode}, defaultMode 1, modes [`
  + '{id=1, width=4128, height=2208, fps=72.0, alternativeRefreshRates=[]}, '
  + '{id=2, width=4128, height=2208, fps=90.0, alternativeRefreshRates=[]}, '
  + '{id=3, width=4128, height=2208, fps=120.0, alternativeRefreshRates=[]}], '
  + 'rotation 0, state ON, type INTERNAL, app 4128 x 2208, density 320 (320.0 x 320.0) dpi,'
  + ` layerStack 0, removeMode 0, refreshRateOverride ${override}}\n`
  + '  Display 2:\n'
  + '    mDisplayInfo=DisplayInfo{"Virtual", displayId 2, mode 9, modes [{id=9, width=1280, height=720, fps=30.0}]}\n';

test('the active mode of the built-in display decides the refresh rate', () => {
  assert.equal(parseRefreshRateHz(DISPLAY_INFO(1)), 72);
  assert.equal(parseRefreshRateHz(DISPLAY_INFO(2)), 90);
  assert.equal(parseRefreshRateHz(DISPLAY_INFO(3)), 120);
});

test('a refresh rate override outranks the active mode', () => {
  assert.equal(parseRefreshRateHz(DISPLAY_INFO(2, '120.0')), 120);
});

test('a virtual display never answers for the headset panel', () => {
  // The virtual display lists 30 fps; picking the first fps= in the dump
  // would report that instead of the panel.
  assert.equal(parseRefreshRateHz(DISPLAY_INFO(2)), 90);
});

test('older and SurfaceFlinger-style output still yields a rate', () => {
  assert.equal(parseRefreshRateHz('DisplayDeviceInfo{"Built-in", 4128 x 2208, fps=72.0, density 320}'), 72);
  assert.equal(parseRefreshRateHz('  mRefreshRate=90.0\n'), 90);
  assert.equal(parseRefreshRateHz('refresh-rate  : 120.000000 fps\n'), 120);
  assert.equal(parseRefreshRateHz('DisplayInfo{..., refreshRate 80.0, ...}'), 80);
});

test('unusable output reports no rate rather than a guess', () => {
  for (const output of [null, undefined, 42, '', 'dumpsys: not found', 'fps=0.0', 'fps=9999']) {
    assert.equal(parseRefreshRateHz(output), null);
  }
});

test('only rates that divide evenly into 60 FPS are silent', () => {
  assert.equal(isEvenCadence(120), true);
  assert.equal(isEvenCadence(60), true);
  assert.equal(isEvenCadence(90), false);
  assert.equal(isEvenCadence(72), false);
  assert.equal(describeRefreshRate(120), null);
  assert.equal(describeRefreshRate(null), null);
  assert.equal(describeRefreshRate(undefined), null);
  const warning = describeRefreshRate(90);
  assert.match(warning, /90 Hz/);
  assert.match(warning, /120 Hz/);
  assert.match(warning, /games that pick their own refresh rate/);
});
