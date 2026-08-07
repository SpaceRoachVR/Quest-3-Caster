const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/stream-config');

test('accepts the calibrated Quest production crop', () => {
  const display = { width: 4128, height: 2208 };
  assert.deepEqual(c.validateCrop(c.parseCrop('1920:1080:2208:564'), display, 2),
    { width: 1920, height: 1080, x: 2208, y: 564 });
  assert.deepEqual(c.getProductionProfile(display), {
    id: 'obs1080p60', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', displayBuffer: 0, crop: '1920:1080:2208:564'
  });
});

test('rejects malformed, unaligned, and out-of-bounds crops', () => {
  const display = { width: 4128, height: 2208 };
  assert.throws(() => c.parseCrop('1920x1080'), /width:height:x:y/);
  assert.throws(() => c.validateCrop(c.parseCrop('1921:1080:2207:564'), display, 2), /alignment/);
  assert.throws(() => c.validateCrop(c.parseCrop('1920:1080:2209:564'), display, 2), /outside display bounds/);
});

test('calculates encoder-aligned legacy 16:9 crop as 1440x810 after max-size', () => {
  assert.deepEqual(c.calculateOutputSize({ width: 1760, height: 990 }, 1440, 2), { width: 1440, height: 810 });
});

test('preserves uncapped 1920x1080 production output', () => {
  assert.deepEqual(c.calculateOutputSize({ width: 1920, height: 1080 }, null, 2), { width: 1920, height: 1080 });
});

test('filters encoders to H.264 only', () => {
  assert.deepEqual(c.filterH264Encoders(['OMX.qcom.video.encoder.avc (h264)', 'c2.qti.hevc.encoder (h265)', 'c2.android.avc.encoder (h264)']), ['OMX.qcom.video.encoder.avc', 'c2.android.avc.encoder']);
});

test('does not falsely label a 1440x810 stream as 1080p', () => {
  assert.equal(c.formatOutputEstimate({ width: 1440, height: 810 }), 'Expected stream: 1440x810');
  assert.equal(c.formatOutputEstimate({ width: 1920, height: 1080 }), 'Expected stream: 1920x1080 (1080p)');
});

test('rejects unsafe crop values and invalid crop dimensions', () => {
  assert.throws(() => c.parseCrop('9007199254740992:1080:0:0'), /safe integer/);
  assert.throws(() => c.parseCrop('0:1080:0:0'), /positive/);
  assert.throws(() => c.parseCrop('1920:-1080:0:0'), /width:height:x:y/);
});

test('rejects invalid stream settings before argument construction', () => {
  const display = { width: 4128, height: 2208 };
  const config = {
    serial: '192.168.1.20:5555', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0
  };

  assert.throws(() => c.validateStreamConfig({ ...config, serial: 'bad serial' }, display), /serial/);
  assert.throws(() => c.validateStreamConfig({ ...config, videoCodec: 'vp9' }, display), /video codec/);
  assert.throws(() => c.validateStreamConfig({ ...config, bitRate: 51 }, display), /bitrate/);
  assert.throws(() => c.validateStreamConfig({ ...config, maxFps: 121 }, display), /FPS/);
  assert.throws(() => c.validateStreamConfig({ ...config, maxSize: 0 }, display), /Maximum size/);
  assert.throws(() => c.validateStreamConfig({ ...config, maxSize: 8193 }, display), /Maximum size/);
  assert.throws(() => c.validateStreamConfig({ ...config, displayBuffer: -1 }, display), /Display buffer/);
  assert.throws(() => c.validateStreamConfig({ ...config, displayBuffer: 1001 }, display), /Display buffer/);
  assert.throws(() => c.validateStreamConfig({ ...config, videoEncoder: 'bad encoder' }, display), /encoder/);
  assert.throws(() => c.validateStreamConfig({ ...config, audioSource: 'speaker' }, display), /audio source/);
  assert.throws(() => c.validateStreamConfig({ ...config, audioCodec: 'flac' }, display), /audio codec/);
  assert.deepEqual(
    c.validateStreamConfig({
      ...config,
      crop: '1760:990:144:608',
      maxSize: 1440,
    }, display),
    {
      ...config,
      crop: '1760:990:144:608',
      maxSize: 1440,
    },
  );
  assert.deepEqual(c.validateStreamConfig(config, display), config);
});

test('rejects invalid wireless IPv4 octets and ports', () => {
  const display = { width: 4128, height: 2208 };
  const config = {
    serial: '192.168.1.20:5555', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0
  };

  assert.throws(() => c.validateStreamConfig({ ...config, serial: '256.168.1.20:5555' }, display), /serial/);
  assert.throws(() => c.validateStreamConfig({ ...config, serial: '192.168.1.20:0' }, display), /serial/);
  assert.throws(() => c.validateStreamConfig({ ...config, serial: '192.168.1.20:65536' }, display), /serial/);
});

test('builds production args without a max-size flag', () => {
  const args = c.buildScrcpyArguments({
    serial: '192.168.1.20:5555', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0,
    noAudio: false, audioSource: 'output', audioBuffer: 0, audioCodec: 'opus',
    displaySize: { width: 4128, height: 2208 }
  }, 3);
  assert.deepEqual(args.slice(0, 10), [
    '-s', '192.168.1.20:5555', '-b', '40M', '--max-fps', '60',
    '--video-codec', 'h264', '--crop', '1920:1080:2208:564'
  ]);
  assert.equal(args.some((item) => item === '-m' || item.startsWith('--max-size')), false);
  assert.ok(args.includes('--video-buffer=0'));
});

test('requires an explicit calibrated display for uncapped production arguments', () => {
  const config = {
    serial: '192.168.1.20:5555', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0
  };

  assert.throws(() => c.buildScrcpyArguments(config, 3), /display size/);
  assert.throws(() => c.buildScrcpyArguments({
    ...config,
    displaySize: { width: 4000, height: 2208 }
  }, 3), /production display/);
});

test('rejects uncapped streams that vary any production profile setting', () => {
  const display = { width: 4128, height: 2208 };
  const production = {
    serial: '192.168.1.20:5555', bitRate: 40, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0
  };

  for (const variation of [
    { bitRate: 39 },
    { maxFps: 90 },
    { videoCodec: 'h265' },
    { crop: '1776:993:2208:608' },
    { displayBuffer: 10 }
  ]) {
    assert.throws(
      () => c.validateStreamConfig({ ...production, ...variation }, display),
      /uncapped production profile/
    );
  }

  assert.deepEqual(c.validateStreamConfig(production, display), production);
});

test('rejects the retired Native preset configuration when it requests an uncapped stream', () => {
  const display = { width: 4128, height: 2208 };
  const retiredNativePreset = {
    serial: '192.168.1.20:5555', bitRate: 50, maxFps: 60, maxSize: null,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0
  };

  assert.throws(
    () => c.validateStreamConfig(retiredNativePreset, display),
    /uncapped production profile/
  );
});

test('uses the compatible video-buffer flag and validates a manual encoder', () => {
  const config = {
    serial: '192.168.1.20:5555', bitRate: 24, maxFps: 60, maxSize: 1440,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 50,
    noAudio: true, videoEncoder: 'OMX.qcom.video.encoder.avc',
    displaySize: { width: 4128, height: 2208 }
  };
  const modern = c.buildScrcpyArguments(config, 3);
  const legacy = c.buildScrcpyArguments(config, 2);

  assert.ok(modern.includes('--video-buffer=50'));
  assert.ok(legacy.includes('--display-buffer=50'));
  assert.ok(modern.includes('--video-encoder'));
  assert.ok(modern.includes('OMX.qcom.video.encoder.avc'));
  assert.ok(modern.includes('--no-audio'));
});

test('emits an explicit zero video buffer for supported scrcpy versions', () => {
  const config = {
    serial: '192.168.1.20:5555', bitRate: 24, maxFps: 60, maxSize: 1440,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0,
    displaySize: { width: 4128, height: 2208 }
  };

  assert.ok(c.buildScrcpyArguments(config, 3).includes('--video-buffer=0'));
  assert.ok(c.buildScrcpyArguments(config, 2).includes('--display-buffer=0'));
});

test('adds explicitly selected audio settings while retaining default audio omission', () => {
  const args = c.buildScrcpyArguments({
    serial: '192.168.1.20:5555', bitRate: 24, maxFps: 60, maxSize: 1440,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0,
    noAudio: false, audioSource: 'mic', audioBuffer: 50, audioCodec: 'aac', audioDup: true,
    displaySize: { width: 4128, height: 2208 }
  }, 3);

  assert.ok(args.includes('--audio-source'));
  assert.ok(args.includes('playback'));
  assert.ok(args.includes('--audio-buffer=50'));
  assert.ok(args.includes('--audio-codec'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('--audio-dup'));
});

test('always duplicates playback audio to preserve headset sound during a cast', () => {
  const args = c.buildScrcpyArguments({
    serial: '192.168.1.20:5555', bitRate: 24, maxFps: 60, maxSize: 1440,
    videoCodec: 'h264', crop: '1920:1080:2208:564', displayBuffer: 0,
    noAudio: false, audioSource: 'output', audioBuffer: 0, audioCodec: 'opus', audioDup: false,
    displaySize: { width: 4128, height: 2208 }
  }, 3);
  assert.deepEqual(args.slice(-3), ['--audio-source', 'playback', '--audio-dup']);
});
