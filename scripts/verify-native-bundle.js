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
//
// --allow-missing-gpu (or Q3C_NATIVE_VERIFY_ALLOW_MISSING_GPU=1) is for
// machines with no OpenCL GPU, such as hosted CI runners. Hashes, the client,
// the libavfilter link probe, the forced-failure cleanup probe and the CLI
// parser checks still run in full; only the native unit tests and the
// synthetic stabilization probe are skipped, and only when the capability
// probe itself reports no GPU. Release verification must run without it on a
// machine with a GPU.

const ALLOW_MISSING_GPU_FLAG = '--allow-missing-gpu';

function parseArguments(argv, env) {
  const positional = argv.filter((argument) => argument !== ALLOW_MISSING_GPU_FLAG);
  const unknownFlag = positional.find((argument) => argument.startsWith('--'));
  if (unknownFlag) {
    throw new Error(`Unknown option ${unknownFlag}`);
  }
  if (positional.length > 1) {
    throw new Error('Expected at most one bundle directory argument');
  }
  return {
    bundleDirectory: positional[0] || null,
    allowMissingGpu: argv.includes(ALLOW_MISSING_GPU_FLAG)
      || env.Q3C_NATIVE_VERIFY_ALLOW_MISSING_GPU === '1',
  };
}

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const options = parseArguments(process.argv.slice(2), process.env);
  const bundleDirectory = options.bundleDirectory
    ? path.resolve(options.bundleDirectory)
    : path.join(repositoryRoot, 'resources', 'native', 'win32-x64');
  const verified = verifyNativeBundleDirectory(bundleDirectory, {
    allowMissingGpu: options.allowMissingGpu,
  });

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
  if (verified.execution.gpuVerified) {
    process.stdout.write(`OpenCL stabilization verified on ${verified.execution.gpu}\n`);
  } else {
    process.stdout.write(
      'No OpenCL GPU on this machine; skipped GPU-bound checks: '
      + `${verified.execution.skippedChecks.join(', ')}. `
      + 'Run again on a machine with a GPU before a release.\n',
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Native bundle verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { ALLOW_MISSING_GPU_FLAG, parseArguments };
