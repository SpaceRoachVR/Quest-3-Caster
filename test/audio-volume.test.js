const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildVolumeScript,
  createVolumeProcessResult,
  validateVolume
} = require('../lib/audio-volume');

test('accepts integer volume percentages at both bounds', () => {
  assert.equal(validateVolume(0), 0);
  assert.equal(validateVolume(100), 100);
  assert.equal(validateVolume(80), 80);
});

test('rejects renderer volume values that are not bounded integers', () => {
  for (const value of [-1, 101, 80.5, NaN, Infinity, '80', null, undefined]) {
    assert.throws(() => validateVolume(value), /integer between 0 and 100/);
  }
});

test('builds a WASAPI script with the correct session-manager vtable order', () => {
  const script = buildVolumeScript(2468, 80);
  const managerInterface = /interface IAudioSessionManager2\s*\{([\s\S]*?)\n\}/.exec(script)[1];

  assert.match(script, /GetAudioSessionControl[\s\S]*GetSimpleAudioVolume[\s\S]*GetSessionEnumerator/);
  assert.doesNotMatch(managerInterface, /NotImpl\d/);
  assert.match(script, /SetMasterVolume\(level, ref eventContext\) == 0/);
  assert.match(script, /VOLUME_UPDATED/);
  assert.match(script, /exit 1/);
});

test('accepts only an explicit PowerShell volume-update confirmation', () => {
  assert.deepEqual(createVolumeProcessResult(null, 'VOLUME_UPDATED\r\n', ''), { success: true });
  assert.deepEqual(createVolumeProcessResult(null, '', ''), {
    success: false,
    error: 'Volume update was not confirmed by PowerShell.'
  });
  assert.deepEqual(createVolumeProcessResult(new Error('process failed'), '', 'session not found'), {
    success: false,
    error: 'session not found'
  });
});

const {
  isMissingAudioSession,
  readPowerShellError
} = require('../lib/audio-volume');

test('recovers the readable message from CLIXML-serialized PowerShell stderr', () => {
  // Verified against a real -EncodedCommand run: PowerShell wraps redirected
  // stderr in CLIXML, which otherwise reaches the UI as an XML blob.
  const clixml = '#< CLIXML\r\nNo matching audio session was updated.\r\n'
    + '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
    + '<Obj S="progress"><MS><AV>Preparing modules for first use.</AV></MS></Obj></Objs>';
  assert.equal(readPowerShellError(clixml), 'No matching audio session was updated.');
  const result = createVolumeProcessResult(new Error('exit 1'), '', clixml);
  assert.equal(result.success, false);
  assert.doesNotMatch(result.error, /CLIXML|<Objs/);
});

test('leaves plain stderr untouched and falls back to the error message', () => {
  assert.equal(readPowerShellError('  boom  '), 'boom');
  assert.equal(createVolumeProcessResult(new Error('spawn failed'), '', '').error, 'spawn failed');
});

test('identifies a missing audio session as retryable', () => {
  assert.equal(isMissingAudioSession(createVolumeProcessResult(
    new Error('exit 1'), '', '#< CLIXML\r\nNo matching audio session was updated.\r\n'
  )), true);
  assert.equal(isMissingAudioSession(createVolumeProcessResult(
    new Error('exit 1'), '', 'Access is denied.'
  )), false);
  assert.equal(isMissingAudioSession(createVolumeProcessResult(null, 'VOLUME_UPDATED', '')), false);
});
