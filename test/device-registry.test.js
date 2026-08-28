'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CALIBRATION_TIERS,
  DEVICE_PROFILES,
  findByDisplay,
  findByModel,
  getLockedProfileSupport,
  identifyDevice,
} = require('../lib/device-registry');

const QUEST_3 = { width: 4128, height: 2208 };
const QUEST_3S = { width: 3664, height: 1920 };

test('every registry entry declares a known calibration tier and consistent geometry', () => {
  for (const device of DEVICE_PROFILES) {
    assert.ok(CALIBRATION_TIERS.includes(device.calibration),
      `${device.id}: ${device.calibration} is not a calibration tier`);
    assert.equal(device.display.width, device.eye.width * 2,
      `${device.id}: display width must be two eyes side by side`);
    assert.equal(device.display.height, device.eye.height,
      `${device.id}: display height must equal eye height`);
    assert.ok(device.models.length > 0, `${device.id}: needs at least one model string`);
  }
});

test('only Quest 3 claims measured calibration', () => {
  // Anything else claiming "measured" means someone marked a device calibrated
  // without the hardware pass, which is the exact failure this tier exists to
  // prevent. Change this test deliberately, with the measurement in hand.
  const measured = DEVICE_PROFILES.filter((device) => device.calibration === 'measured');
  assert.deepEqual(measured.map((device) => device.id), ['quest3']);
});

test('model identification beats geometry for the shared Quest 2 / 3S panel', () => {
  // Both report 3664x1920. Geometry alone cannot separate them, and picking
  // the first match would confidently name the wrong headset.
  const bare = findByDisplay(QUEST_3S);
  assert.equal(bare.device, null);
  assert.equal(bare.ambiguous, true);
  assert.deepEqual(bare.candidates.map((device) => device.id), ['quest3s', 'quest2']);

  assert.equal(identifyDevice({ model: 'Quest 3S', displaySize: QUEST_3S }).device.id, 'quest3s');
  assert.equal(identifyDevice({ model: 'Quest 2', displaySize: QUEST_3S }).device.id, 'quest2');
});

test('an ambiguous headset is reported as unidentified rather than guessed', () => {
  const result = identifyDevice({ displaySize: QUEST_3S });
  assert.equal(result.device.id, 'unknown');
  assert.equal(result.ambiguous, true);
  assert.match(result.reason, /Quest 3S or Meta Quest 2/);
  assert.match(result.reason, /model is needed/);
});

test('Quest 3 is identified by geometry alone and supports the locked profiles', () => {
  const result = identifyDevice({ displaySize: QUEST_3 });
  assert.equal(result.device.id, 'quest3');
  assert.equal(result.matchedBy, 'display');
  assert.equal(result.geometryMatches, true);

  const support = getLockedProfileSupport(result);
  assert.equal(support.supported, true);
  assert.equal(support.tier, 'measured');
  assert.equal(support.reason, null);
});

test('a known model reporting the wrong geometry is reported, not trusted', () => {
  // This is what a display-size override on a Quest 3 looks like: the model is
  // right, the geometry is not, and the calibrated crops do not apply.
  const result = identifyDevice({ model: 'Quest 3', displaySize: { width: 1280, height: 720 } });
  assert.equal(result.device.id, 'quest3');
  assert.equal(result.matchedBy, 'model');
  assert.equal(result.geometryMatches, false);
  assert.match(result.reason, /normally reports 4128x2208/);
  assert.match(result.reason, /reports 1280x720/);

  const support = getLockedProfileSupport(result);
  assert.equal(support.supported, false);
});

test('a recognized but uncalibrated headset is named and pointed at the wizard', () => {
  const support = getLockedProfileSupport(
    identifyDevice({ model: 'Quest 3S', displaySize: QUEST_3S }),
  );
  assert.equal(support.supported, false);
  assert.equal(support.tier, 'uncalibrated');
  assert.match(support.reason, /Meta Quest 3S is recognized but not calibrated/);
  assert.match(support.reason, /calibration wizard/);
  // The old behaviour named a resolution the headset does not have.
  assert.doesNotMatch(support.reason, /4128x2208/);
});

test('an unknown headset still yields a usable eye geometry and an honest reason', () => {
  const result = identifyDevice({ displaySize: { width: 5000, height: 2500 } });
  assert.equal(result.device.id, 'unknown');
  assert.deepEqual(result.device.eye, { width: 2500, height: 2500 });
  assert.equal(result.device.calibration, 'uncalibrated');
  assert.match(getLockedProfileSupport(result).reason, /would mis-frame this headset/);
});

test('identification requires a real display geometry', () => {
  for (const displaySize of [null, undefined, {}, { width: 0, height: 100 },
    { width: 100.5, height: 100 }]) {
    assert.throws(() => identifyDevice({ displaySize }), /valid display geometry/);
  }
});

test('model lookup ignores case and surrounding whitespace', () => {
  assert.equal(findByModel('  quest 3s  ').id, 'quest3s');
  assert.equal(findByModel('QUEST 3').id, 'quest3');
  assert.equal(findByModel(''), null);
  assert.equal(findByModel(null), null);
  assert.equal(findByModel('Pico 4'), null);
});
