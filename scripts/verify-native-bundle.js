#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { verifyNativeBundleDirectory } = require('../lib/native-bundle');

// verifyNativeBundleDirectory executes:
// scrcpy.exe --q3c-capabilities, q3c-native-tests.exe, and
// q3c-stabilization-probe.exe --synthetic/--forced-failure. Its strict
// production metrics include smallMotionReductionPercent,
// sustainedMotionReturnMs, borderPixels, and peakQueueDepth.
// It also executes invalidLockedProfileArguments against the real scrcpy CLI
// parser to prove locked profiles reject protected and no-playback options.

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const bundleDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryRoot, 'resources', 'native', 'win32-x64');
  const verified = verifyNativeBundleDirectory(bundleDirectory);

  process.stdout.write(
    [
      `Verified scrcpy ${verified.manifest.upstream.version}`,
      `FFmpeg ${verified.manifest.ffmpeg.version}`,
      verified.manifest.ffmpeg.requiredFilter,
      `${verified.manifest.files.length} hashed files`,
      verified.manifest.target,
    ].join('; '),
  );
  process.stdout.write('\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`Native bundle verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
