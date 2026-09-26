'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS,
  buildBundleManifest,
  inspectNativeBundleSnapshot,
  loadNativeBundleSnapshot,
  parseBundleManifest,
  parsePortableExecutableArchitecture,
  resolveNativeBundleDirectory,
  validateDependencyManifest,
  validateManifestRelativePath,
  validateNativeExecutionResults,
  validateReplacementSnapshot,
  verifyNativeBundleDirectory,
} = require('../lib/native-bundle');
const {
  loadReplacementSnapshot,
  parseSourceArgument,
} = require('../scripts/replace-native-libraries');

const SCRCPY_COMMIT = '2926c06c5dc3064ae6d8db706f1a98a37cfcf3f0';

function createPortableExecutable(machine = 0x8664) {
  const binary = Buffer.alloc(256);
  binary.write('MZ', 0, 'ascii');
  binary.writeUInt32LE(128, 0x3c);
  binary.write('PE\0\0', 128, 'binary');
  binary.writeUInt16LE(machine, 132);
  return binary;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createValidFixture() {
  const files = new Map([
    ['scrcpy.exe', createPortableExecutable()],
    ['ffmpeg-opencl-probe.exe', createPortableExecutable()],
    ['q3c-native-tests.exe', createPortableExecutable()],
    ['q3c-stabilization-probe.exe', createPortableExecutable()],
    ['adb.exe', createPortableExecutable(0x14c)],
    ['AdbWinApi.dll', createPortableExecutable(0x14c)],
    ['AdbWinUsbApi.dll', createPortableExecutable(0x14c)],
    ['libavfilter-11.dll', createPortableExecutable()],
    ['scrcpy-server', Buffer.from('server')],
    ['LICENSES/scrcpy-Apache-2.0.txt', Buffer.from('Apache')],
    ['LICENSES/ffmpeg-LGPL-2.1.txt', Buffer.from('LGPL')],
    ['THIRD_PARTY_NOTICES.md', Buffer.from('notices')],
    ['SOURCE_OFFER.md', Buffer.from('source offer')],
  ]);
  const roles = new Map([
    ['scrcpy.exe', 'client'],
    ['ffmpeg-opencl-probe.exe', 'opencl-filter-probe'],
    ['q3c-native-tests.exe', 'native-unit-tests'],
    ['q3c-stabilization-probe.exe', 'stabilization-probe'],
    ['adb.exe', 'native-tool'],
    ['AdbWinApi.dll', 'native-tool'],
    ['AdbWinUsbApi.dll', 'native-tool'],
    ['libavfilter-11.dll', 'shared-library'],
    ['scrcpy-server', 'server'],
    ['LICENSES/scrcpy-Apache-2.0.txt', 'license'],
    ['LICENSES/ffmpeg-LGPL-2.1.txt', 'license'],
    ['THIRD_PARTY_NOTICES.md', 'notice'],
    ['SOURCE_OFFER.md', 'source-offer'],
  ]);
  const manifest = {
    schemaVersion: 1,
    target: 'win32-x64',
    upstream: {
      name: 'scrcpy',
      version: '4.1',
      tag: 'v4.1',
      commit: SCRCPY_COMMIT,
    },
    ffmpeg: {
      version: '8.1.2',
      license: 'LGPL-2.1-or-later',
      linkage: 'shared',
      libavfilter: true,
      opencl: true,
      requiredFilter: 'deshake_opencl',
    },
    files: [...files].map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256(content),
      role: roles.get(filePath),
    })),
  };

  return {
    files,
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function createValidExecutionResults() {
  return {
    client: {
      status: 0,
      stdout: [
        'scrcpy 4.1 <https://github.com/Genymobile/scrcpy>',
        'Dependencies (compiled / linked):',
        ' - libavfilter: 11.12.100 / 11.12.100',
      ].join('\n'),
      stderr: '',
    },
    openclFilterProbe: {
      status: 0,
      stdout: [
        'ffmpeg_version=8.1.2',
        'deshake_opencl available via libavfilter 11.12.100',
      ].join('\n'),
      stderr: '',
    },
    capabilities: {
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        upstreamVersion: '4.1',
        forkVersion: 'quest3caster-stabilization-1',
        openclAvailable: true,
        gpu: 'Test GPU',
        output: { width: 1920, height: 1080 },
        delays: {
          lowLatencyNominalMs: 0,
          stabilizedNominalMs: 100,
          stabilizedMaximumMs: 120,
        },
        profiles: [
          'obsLowLatency1080p60',
          'obsStabilized1080p60',
          'obsLowLatencySquareLeft1080p60',
          'obsLowLatencySquareRight1080p60',
        ],
        stabilizationModes: ['off', 'openclFeaturePoint'],
        calibratedSource: { width: 4128, height: 2208 },
        diagnostic: 'ready',
      }),
      stderr: '',
    },
    nativeUnitTests: {
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        status: 'passed',
        assertions: 48,
        lifecycle: {
          filterBypass: true,
          initializationFailure: true,
          sessionReset: true,
          renderAcknowledgement: true,
          frameValidation: true,
          shutdownCleanup: true,
          utf8Sanitization: true,
          liveStabilizedGraph: true,
          delayedFramesDisposed: true,
          concurrentAckLifecycle: true,
          renderFailureSuppressed: true,
          gpuSelection: true,
          pausedStaleEventSafe: true,
          publicationOverlap: true,
          borderExposureGuard: true,
        },
      }),
      stderr: '',
    },
    syntheticProbe: {
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        gpu: 'Test GPU',
        smallMotionInputRms: 4.3,
        smallMotionOutputRms: 2.7,
        smallMotionReductionPercent: 35,
        sustainedMotionReturnMs: 133,
        submissionToOutputMs: 100,
        outputWidth: 1920,
        outputHeight: 1080,
        borderPixels: 0,
        mirroredBorderPixels: 0,
        borderDepthsChecked: 32,
        borderSamples: 60,
        mirrorPositiveControls: 16,
        mirrorNegativeControl: true,
        sustainedRunFrames: 3600,
        peakQueueDepth: 6,
        peakWorkingSetBytes: 150000000,
        workingSetGrowthBytes: 50000000,
        memorySlopeBytesPerFrame: 6000,
        secondHalfWorkingSetGrowthBytes: 11000000,
        boundedMemory: true,
        cleanup: true,
      }),
      stderr: '',
    },
    forcedFailureProbe: {
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        forcedFailure: true,
        cleanup: 'passed',
        code: 'stabilization_unavailable',
      }),
      stderr: '',
    },
    invalidLockedProfileArguments: Array.from(
      { length: LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS.length },
      () => ({
        status: 1,
        stdout: '',
        stderr: 'Locked OBS profiles require exactly one generation and '
          + 'reject custom codec/crop/rate/buffer options',
      }),
    ),
  };
}

function createFullDependencyManifest() {
  return {
    schemaVersion: 1,
    target: 'win32-x64',
    toolchain: {
      wslDistribution: 'Ubuntu',
      targetTriplet: 'x86_64-w64-mingw32',
      aptPackages: ['cmake', 'mingw-w64', 'ninja-build'],
    },
    sources: [
      {
        id: 'scrcpy',
        kind: 'git',
        version: '4.1',
        tag: 'v4.1',
        commit: SCRCPY_COMMIT,
        url: 'https://github.com/Genymobile/scrcpy.git',
        license: 'Apache-2.0',
      },
      {
        id: 'ffmpeg',
        kind: 'archive',
        version: '8.1.2',
        url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
        filename: 'ffmpeg-8.1.2.tar.xz',
        sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
        license: 'LGPL-2.1-or-later',
      },
    ],
  };
}

function writeFixtureToDirectory(directory, fixture) {
  for (const [relativePath, content] of fixture.files) {
    const absolutePath = path.join(directory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  fs.writeFileSync(
    path.join(directory, 'bundle-manifest.json'),
    fixture.manifestText,
  );
}

test('resolves the development native bundle below the application root', () => {
  const result = resolveNativeBundleDirectory({
    isPackaged: false,
    appPath: 'C:\\workspace\\quest-caster',
    resourcesPath: 'C:\\ignored',
    pathModule: path.win32,
  });

  assert.equal(
    result,
    'C:\\workspace\\quest-caster\\resources\\native\\win32-x64',
  );
});

test('resolves the packaged native bundle below process.resourcesPath', () => {
  const result = resolveNativeBundleDirectory({
    isPackaged: true,
    appPath: 'C:\\ignored',
    resourcesPath: 'C:\\Program Files\\Quest 3 Caster\\resources',
    pathModule: path.win32,
  });

  assert.equal(
    result,
    'C:\\Program Files\\Quest 3 Caster\\resources\\native\\win32-x64',
  );
});

test('rejects invalid bundle resolution inputs', () => {
  assert.throws(
    () => resolveNativeBundleDirectory({
      isPackaged: true,
      appPath: 'C:\\app',
      resourcesPath: '',
      pathModule: path.win32,
    }),
    /resourcesPath/,
  );
  assert.throws(
    () => resolveNativeBundleDirectory({
      isPackaged: 'yes',
      appPath: 'C:\\app',
      resourcesPath: 'C:\\resources',
      pathModule: path.win32,
    }),
    /isPackaged/,
  );
});

test('accepts canonical manifest-relative paths', () => {
  assert.equal(
    validateManifestRelativePath('LICENSES/ffmpeg-LGPL-2.1.txt'),
    'LICENSES/ffmpeg-LGPL-2.1.txt',
  );
});

test('rejects path traversal and non-canonical manifest paths', () => {
  for (const candidate of [
    '../scrcpy.exe',
    'bin/../../scrcpy.exe',
    '/scrcpy.exe',
    'C:/scrcpy.exe',
    'bin\\scrcpy.exe',
    'bin//scrcpy.exe',
    './scrcpy.exe',
    '.',
    '',
  ]) {
    assert.throws(
      () => validateManifestRelativePath(candidate),
      /path/i,
      candidate,
    );
  }
});

test('rejects malformed bundle manifest JSON', () => {
  assert.throws(() => parseBundleManifest('{'), /JSON/);
  assert.throws(() => parseBundleManifest('[]'), /object/);
});

test('accepts a pinned dependency manifest', () => {
  const dependencyManifest = createFullDependencyManifest();

  assert.equal(validateDependencyManifest(dependencyManifest), dependencyManifest);
});

test('rejects floating, insecure, unhashed, or duplicate dependency sources', () => {
  const base = {
    schemaVersion: 1,
    target: 'win32-x64',
    toolchain: {
      wslDistribution: 'Ubuntu',
      targetTriplet: 'x86_64-w64-mingw32',
      aptPackages: ['cmake'],
    },
  };
  const validArchive = {
    id: 'ffmpeg',
    kind: 'archive',
    version: '8.1.2',
    url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
    filename: 'ffmpeg-8.1.2.tar.xz',
    sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    license: 'LGPL-2.1-or-later',
  };

  const invalidSources = [
    [{ ...validArchive, url: 'http://ffmpeg.org/ffmpeg.tar.xz' }],
    [{ ...validArchive, url: 'https://example.test/latest.tar.xz' }],
    [{ ...validArchive, sha256: undefined }],
    [validArchive, { ...validArchive }],
  ];

  for (const sources of invalidSources) {
    assert.throws(
      () => validateDependencyManifest({ ...base, sources }),
      /source|URL|SHA-256|duplicate/i,
    );
  }
});

test('builds a deterministic bundle manifest from pinned dependencies', () => {
  const fixture = createValidFixture();
  const generated = buildBundleManifest({
    dependencyManifest: createFullDependencyManifest(),
    files: fixture.files,
  });

  assert.deepEqual(generated.upstream, fixture.manifest.upstream);
  assert.deepEqual(generated.ffmpeg, fixture.manifest.ffmpeg);
  assert.deepEqual(
    generated.files.map((file) => file.path),
    [...fixture.files.keys()].sort(),
  );
  assert.equal(
    generated.files.find((file) => file.path === 'scrcpy.exe').role,
    'client',
  );
  for (const adbPath of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    assert.equal(
      generated.files.find((file) => file.path === adbPath).role,
      'native-tool',
    );
  }
});

test('rejects an unrecognized staged file while building a manifest', () => {
  const fixture = createValidFixture();
  fixture.files.set('mystery.bin', Buffer.from('mystery'));

  assert.throws(
    () => buildBundleManifest({
      dependencyManifest: createFullDependencyManifest(),
      files: fixture.files,
    }),
    /unrecognized.*mystery\.bin/i,
  );
});

test('classifies upstream portable launchers and image resources', () => {
  const fixture = createValidFixture();
  fixture.files.set('scrcpy-noconsole.vbs', Buffer.from('launcher'));
  fixture.files.set('open_a_terminal_here.bat', Buffer.from('launcher'));
  fixture.files.set('scrcpy.png', Buffer.from('png'));
  fixture.files.set('disconnected.png', Buffer.from('png'));

  const generated = buildBundleManifest({
    dependencyManifest: createFullDependencyManifest(),
    files: fixture.files,
  });
  const roleByPath = new Map(
    generated.files.map((file) => [file.path, file.role]),
  );
  assert.equal(roleByPath.get('scrcpy-noconsole.vbs'), 'launcher');
  assert.equal(roleByPath.get('open_a_terminal_here.bat'), 'launcher');
  assert.equal(roleByPath.get('scrcpy.png'), 'asset');
  assert.equal(roleByPath.get('disconnected.png'), 'asset');
});

test('loads a bundle snapshot recursively without following symbolic links', (t) => {
  const fixture = createValidFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-native-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixtureToDirectory(directory, fixture);

  const loaded = loadNativeBundleSnapshot(directory);
  assert.equal(loaded.manifestText, fixture.manifestText);
  assert.deepEqual([...loaded.files.keys()].sort(), [...fixture.files.keys()].sort());

  const linkPath = path.join(directory, 'linked-notice.txt');
  try {
    fs.symlinkSync(path.join(directory, 'THIRD_PARTY_NOTICES.md'), linkPath);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Creating symlinks is not permitted for this Windows account');
      return;
    }
    throw error;
  }
  assert.throws(() => loadNativeBundleSnapshot(directory), /symbolic link/i);
});

test('verifies all static bundle evidence before executing checked files', (t) => {
  const fixture = createValidFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-native-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixtureToDirectory(directory, fixture);

  const calls = [];
  const results = createValidExecutionResults();
  const verified = verifyNativeBundleDirectory(directory, {
    runExecutable(executablePath, args, options) {
      calls.push({ executablePath, args, options });
      return [
        results.client,
        results.openclFilterProbe,
        results.capabilities,
        results.nativeUnitTests,
        results.syntheticProbe,
        results.forcedFailureProbe,
        ...results.invalidLockedProfileArguments,
      ][calls.length - 1];
    },
  });

  assert.equal(verified.manifest.upstream.version, '4.1');
  assert.deepEqual(calls.map((call) => call.args), [
    ['--version'],
    [],
    ['--q3c-capabilities'],
    [],
    ['--synthetic'],
    ['--forced-failure'],
    ...LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS.map((incompatibleArguments) => [
      '--q3c-profile=obsStabilized1080p60',
      '--q3c-generation=1',
      ...incompatibleArguments,
      '--help',
    ]),
  ]);
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.ok(calls.every((call) => call.options.cwd === path.resolve(directory)));
});

test('does not execute a staged binary when static verification fails', (t) => {
  const fixture = createValidFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-native-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixtureToDirectory(directory, fixture);
  fs.writeFileSync(path.join(directory, 'scrcpy-server'), 'tampered');

  let executionCount = 0;
  assert.throws(
    () => verifyNativeBundleDirectory(directory, {
      runExecutable() {
        executionCount += 1;
        return createValidExecutionResults().client;
      },
    }),
    /hash mismatch/,
  );
  assert.equal(executionCount, 0);
});

test('parses x64 PE files and rejects a non-PE buffer', () => {
  assert.equal(
    parsePortableExecutableArchitecture(createPortableExecutable()),
    'x64',
  );
  assert.equal(
    parsePortableExecutableArchitecture(createPortableExecutable(0x14c)),
    'x86',
  );
  assert.throws(
    () => parsePortableExecutableArchitecture(Buffer.from('not a PE')),
    /Portable Executable/,
  );
});

test('accepts a complete x64 bundle with pinned upstream x86 ADB tools', () => {
  const fixture = createValidFixture();
  const inspected = inspectNativeBundleSnapshot({
    manifestText: fixture.manifestText,
    files: fixture.files,
  });

  assert.equal(inspected.clientPath, 'scrcpy.exe');
  assert.equal(inspected.openclFilterProbePath, 'ffmpeg-opencl-probe.exe');
  assert.equal(inspected.manifest.upstream.version, '4.1');
});

test('rejects a missing staged file', () => {
  const fixture = createValidFixture();
  fixture.files.delete('scrcpy-server');

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /missing.*scrcpy-server/i,
  );
});

test('rejects an unexpected staged file', () => {
  const fixture = createValidFixture();
  fixture.files.set('unexpected.dll', createPortableExecutable());

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /unexpected.*unexpected\.dll/i,
  );
});

test('rejects a malformed bundle manifest', () => {
  const fixture = createValidFixture();
  fixture.manifest.files[0].sha256 = 'not-a-hash';
  fixture.manifestText = JSON.stringify(fixture.manifest);

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /SHA-256/i,
  );
});

test('rejects duplicate paths using Windows case-insensitive semantics', () => {
  const fixture = createValidFixture();
  fixture.manifest.files.push({
    ...fixture.manifest.files[0],
    path: 'SCRCPY.EXE',
  });
  fixture.manifestText = JSON.stringify(fixture.manifest);

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /duplicate/i,
  );
});

test('rejects a hash mismatch', () => {
  const fixture = createValidFixture();
  fixture.files.set('scrcpy-server', Buffer.from('tampered server'));

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /hash mismatch.*scrcpy-server/i,
  );
});

test('rejects a non-x64 executable or DLL', () => {
  const fixture = createValidFixture();
  const x86Client = createPortableExecutable(0x14c);
  fixture.files.set('scrcpy.exe', x86Client);
  fixture.manifest.files.find((file) => file.path === 'scrcpy.exe').sha256 =
    sha256(x86Client);
  fixture.manifestText = JSON.stringify(fixture.manifest);

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /scrcpy\.exe.*x86.*x64/i,
  );
});

test('rejects an upstream version other than scrcpy 4.1', () => {
  const fixture = createValidFixture();
  fixture.manifest.upstream.version = '4.0';
  fixture.manifestText = JSON.stringify(fixture.manifest);

  assert.throws(
    () => inspectNativeBundleSnapshot(fixture),
    /scrcpy 4\.1/,
  );
});

test('accepts successful client and OpenCL filter probe execution', () => {
  const fixture = createValidFixture();
  assert.doesNotThrow(() => validateNativeExecutionResults(
    fixture.manifest,
    createValidExecutionResults(),
  ));
});

test('rejects a client that cannot execute --version', () => {
  const fixture = createValidFixture();
  const results = createValidExecutionResults();
  results.client = {
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('The specified module could not be found'),
  };

  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, results),
    /could not execute.*--version/i,
  );
});

test('rejects client output that is not scrcpy 4.1 with libavfilter', () => {
  const fixture = createValidFixture();
  const wrongVersion = createValidExecutionResults();
  wrongVersion.client.stdout = 'scrcpy 4.0\n';
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, wrongVersion),
    /reported version.*4\.1/i,
  );

  const missingAvfilter = createValidExecutionResults();
  missingAvfilter.client.stdout = 'scrcpy 4.1\n';
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, missingAvfilter),
    /libavfilter/i,
  );
});

test('rejects a staged probe that cannot prove deshake_opencl', () => {
  const fixture = createValidFixture();
  const results = createValidExecutionResults();
  results.openclFilterProbe = {
    status: 1,
    stdout: '',
    stderr: 'deshake_opencl is unavailable',
  };

  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, results),
    /deshake_opencl/i,
  );
});

test('rejects a staged probe that loads a different FFmpeg version', () => {
  const fixture = createValidFixture();
  const results = createValidExecutionResults();
  results.openclFilterProbe.stdout = [
    'ffmpeg_version=8.1.20',
    'deshake_opencl available via libavfilter 11.14.102',
  ].join('\n');

  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, results),
    /FFmpeg 8\.1\.2/i,
  );
});

test('rejects malformed capabilities and failed stabilization metrics', () => {
  const fixture = createValidFixture();

  const unavailable = createValidExecutionResults();
  unavailable.capabilities.stdout = JSON.stringify({
    ...JSON.parse(unavailable.capabilities.stdout),
    openclAvailable: false,
    gpu: null,
  });
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, unavailable),
    /capability probe/i,
  );

  const weak = createValidExecutionResults();
  weak.syntheticProbe.stdout = JSON.stringify({
    ...JSON.parse(weak.syntheticProbe.stdout),
    smallMotionReductionPercent: 29.99,
  });
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, weak),
    /synthetic stabilization metrics/i,
  );

  const malformed = createValidExecutionResults();
  malformed.forcedFailureProbe.stdout = '{';
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, malformed),
    /invalid JSON/i,
  );

  const extraCapabilityField = createValidExecutionResults();
  extraCapabilityField.capabilities.stdout = JSON.stringify({
    ...JSON.parse(extraCapabilityField.capabilities.stdout),
    unexpected: true,
  });
  assert.throws(
    () => validateNativeExecutionResults(
      fixture.manifest,
      extraCapabilityField,
    ),
    /missing or unexpected fields/i,
  );

  const acceptedCli = createValidExecutionResults();
  acceptedCli.invalidLockedProfileArguments[2] = {
    status: 0,
    stdout: '',
    stderr: '',
  };
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, acceptedCli),
    /real CLI parser/i,
  );

  const unrelatedFailure = createValidExecutionResults();
  unrelatedFailure.invalidLockedProfileArguments[0] = {
    status: 1,
    stdout: '',
    stderr: 'ERROR: Could not find any ADB device',
  };
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, unrelatedFailure),
    /real CLI parser/i,
  );
});

function createMissingGpuExecutionResults() {
  const results = createValidExecutionResults();
  results.capabilities.stdout = JSON.stringify({
    ...JSON.parse(results.capabilities.stdout),
    openclAvailable: false,
    gpu: null,
    diagnostic: 'OpenCL stabilization unavailable',
  });
  results.nativeUnitTests = null;
  results.syntheticProbe = null;
  return results;
}

test('a machine without an OpenCL GPU fails strict verification with a pointer to the flag', () => {
  const fixture = createValidFixture();
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, createMissingGpuExecutionResults()),
    /no usable OpenCL GPU.*--allow-missing-gpu/i,
  );
});

test('allowMissingGpu accepts the exact no-GPU report and records what was skipped', () => {
  const fixture = createValidFixture();
  const execution = validateNativeExecutionResults(
    fixture.manifest,
    createMissingGpuExecutionResults(),
    { allowMissingGpu: true },
  );
  assert.deepEqual(execution, {
    gpuVerified: false,
    gpu: null,
    skippedChecks: ['nativeUnitTests', 'syntheticProbe'],
  });

  const withGpu = validateNativeExecutionResults(
    fixture.manifest,
    createValidExecutionResults(),
    { allowMissingGpu: true },
  );
  assert.deepEqual(withGpu, { gpuVerified: true, gpu: 'Test GPU', skippedChecks: [] });
});

test('allowMissingGpu never relaxes anything but the GPU-bound checks', () => {
  const fixture = createValidFixture();

  // A GPU is present, so the synthetic gates still apply in full.
  const weak = createValidExecutionResults();
  weak.syntheticProbe.stdout = JSON.stringify({
    ...JSON.parse(weak.syntheticProbe.stdout),
    smallMotionReductionPercent: 29.99,
  });
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, weak, { allowMissingGpu: true }),
    /synthetic stabilization metrics/i,
  );

  // A GPU is present, so the GPU-bound results may not be omitted.
  const omitted = createValidExecutionResults();
  omitted.nativeUnitTests = null;
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, omitted, { allowMissingGpu: true }),
    /may only be skipped when the capability probe reports no OpenCL GPU/i,
  );

  // Only the probe's own no-GPU wording counts; a GPU-less report with the
  // wrong diagnostic or a GPU name is still a broken bundle.
  const wrongDiagnostic = createMissingGpuExecutionResults();
  wrongDiagnostic.capabilities.stdout = JSON.stringify({
    ...JSON.parse(wrongDiagnostic.capabilities.stdout),
    diagnostic: 'ready',
  });
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, wrongDiagnostic, { allowMissingGpu: true }),
    /required native contract/i,
  );

  // The forced-failure probe and CLI parser checks are not GPU-bound and
  // still gate a no-GPU run.
  const brokenCleanup = createMissingGpuExecutionResults();
  brokenCleanup.forcedFailureProbe.stdout = JSON.stringify({
    schemaVersion: 1, forcedFailure: true, cleanup: 'failed', code: 'stabilization_unavailable',
  });
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, brokenCleanup, { allowMissingGpu: true }),
    /safe cleanup/i,
  );
  const acceptedCli = createMissingGpuExecutionResults();
  acceptedCli.invalidLockedProfileArguments[0] = { status: 0, stdout: '', stderr: '' };
  assert.throws(
    () => validateNativeExecutionResults(fixture.manifest, acceptedCli, { allowMissingGpu: true }),
    /real CLI parser/i,
  );
});

test('a no-GPU run never launches the executables that need an OpenCL filter', (t) => {
  const fixture = createValidFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-native-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixtureToDirectory(directory, fixture);

  const results = createMissingGpuExecutionResults();
  const calls = [];
  const verified = verifyNativeBundleDirectory(directory, {
    allowMissingGpu: true,
    runExecutable(executablePath, args) {
      calls.push(args);
      return [
        results.client,
        results.openclFilterProbe,
        results.capabilities,
        results.forcedFailureProbe,
        ...results.invalidLockedProfileArguments,
      ][calls.length - 1];
    },
  });

  assert.deepEqual(verified.execution, {
    gpuVerified: false,
    gpu: null,
    skippedChecks: ['nativeUnitTests', 'syntheticProbe'],
  });
  assert.ok(!calls.some((args) => args[0] === '--synthetic'));
  assert.deepEqual(calls.slice(0, 4), [['--version'], [], ['--q3c-capabilities'], ['--forced-failure']]);
  assert.equal(calls.length, 4 + LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS.length);

  // Without the option the same machine is a hard failure before any
  // GPU-bound executable would have been launched.
  const strictCalls = [];
  assert.throws(
    () => verifyNativeBundleDirectory(directory, {
      runExecutable(executablePath, args) {
        strictCalls.push(args);
        return [
          results.client,
          results.openclFilterProbe,
          results.capabilities,
          { status: 3, stdout: '', stderr: 'assertion failed' },
          { status: 1, stdout: '', stderr: 'filter initialization failed' },
          results.forcedFailureProbe,
          ...results.invalidLockedProfileArguments,
        ][strictCalls.length - 1];
      },
    }),
    /no usable OpenCL GPU/i,
  );
});

test('the verify script only enables the no-GPU mode through its flag or environment variable', () => {
  const { parseArguments, ALLOW_MISSING_GPU_FLAG } = require('../scripts/verify-native-bundle');
  assert.equal(ALLOW_MISSING_GPU_FLAG, '--allow-missing-gpu');
  assert.deepEqual(parseArguments([], {}), { bundleDirectory: null, allowMissingGpu: false });
  assert.deepEqual(
    parseArguments(['--allow-missing-gpu', 'bundle'], {}),
    { bundleDirectory: 'bundle', allowMissingGpu: true },
  );
  assert.deepEqual(
    parseArguments([], { Q3C_NATIVE_VERIFY_ALLOW_MISSING_GPU: '1' }),
    { bundleDirectory: null, allowMissingGpu: true },
  );
  assert.deepEqual(
    parseArguments([], { Q3C_NATIVE_VERIFY_ALLOW_MISSING_GPU: 'yes' }),
    { bundleDirectory: null, allowMissingGpu: false },
  );
  assert.throws(() => parseArguments(['--skip-gpu'], {}), /Unknown option/);
  assert.throws(() => parseArguments(['a', 'b'], {}), /at most one/);
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run native:verify -- --allow-missing-gpu/);
});

test('accepts a hash-covered compatible FFmpeg shared-library replacement', () => {
  const files = new Map([
    ['avcodec-62.dll', createPortableExecutable()],
    ['avfilter-11.dll', createPortableExecutable()],
    ['avformat-62.dll', createPortableExecutable()],
    ['avutil-60.dll', createPortableExecutable()],
    ['swresample-6.dll', createPortableExecutable()],
  ]);
  const manifest = {
    schemaVersion: 1,
    ffmpegVersion: '8.1.2',
    files: [...files].map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256(content),
    })),
  };

  assert.deepEqual(
    validateReplacementSnapshot({
      manifestText: JSON.stringify(manifest),
      files,
    }),
    manifest,
  );
});

test('rejects an unsafe or incompatible shared-library replacement', () => {
  const files = new Map([
    ['avcodec-62.dll', createPortableExecutable()],
    ['avfilter-11.dll', createPortableExecutable()],
    ['avformat-62.dll', createPortableExecutable()],
    ['avutil-60.dll', createPortableExecutable()],
    ['swresample-6.dll', createPortableExecutable()],
  ]);
  const createManifest = () => ({
    schemaVersion: 1,
    ffmpegVersion: '8.1.2',
    files: [...files].map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256(content),
    })),
  });

  const wrongVersion = createManifest();
  wrongVersion.ffmpegVersion = '8.1.3';
  assert.throws(
    () => validateReplacementSnapshot({
      manifestText: JSON.stringify(wrongVersion),
      files,
    }),
    /FFmpeg 8\.1\.2/,
  );

  const missingFiles = new Map(files);
  missingFiles.delete('avfilter-11.dll');
  assert.throws(
    () => validateReplacementSnapshot({
      manifestText: JSON.stringify(createManifest()),
      files: missingFiles,
    }),
    /missing.*avfilter-11\.dll/i,
  );

  const unexpectedFiles = new Map(files);
  unexpectedFiles.set('evil.dll', createPortableExecutable());
  assert.throws(
    () => validateReplacementSnapshot({
      manifestText: JSON.stringify(createManifest()),
      files: unexpectedFiles,
    }),
    /unexpected.*evil\.dll/i,
  );

  const tamperedFiles = new Map(files);
  tamperedFiles.set('avutil-60.dll', Buffer.from('tampered'));
  assert.throws(
    () => validateReplacementSnapshot({
      manifestText: JSON.stringify(createManifest()),
      files: tamperedFiles,
    }),
    /hash mismatch.*avutil-60\.dll/i,
  );

  const x86Files = new Map(files);
  const x86 = createPortableExecutable(0x14c);
  x86Files.set('avcodec-62.dll', x86);
  const x86Manifest = createManifest();
  x86Manifest.files.find((file) => file.path === 'avcodec-62.dll').sha256 =
    sha256(x86);
  assert.throws(
    () => validateReplacementSnapshot({
      manifestText: JSON.stringify(x86Manifest),
      files: x86Files,
    }),
    /avcodec-62\.dll.*x86.*x64/i,
  );
});

test('loads only an explicit manifest-covered replacement directory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'q3c-replacement-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new Map([
    ['avcodec-62.dll', createPortableExecutable()],
    ['avfilter-11.dll', createPortableExecutable()],
    ['avformat-62.dll', createPortableExecutable()],
    ['avutil-60.dll', createPortableExecutable()],
    ['swresample-6.dll', createPortableExecutable()],
  ]);
  for (const [fileName, content] of files) {
    fs.writeFileSync(path.join(directory, fileName), content);
  }
  fs.writeFileSync(
    path.join(directory, 'replacement-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      ffmpegVersion: '8.1.2',
      files: [...files].map(([filePath, content]) => ({
        path: filePath,
        sha256: sha256(content),
      })),
    }),
  );

  assert.equal(
    loadReplacementSnapshot(directory).manifest.ffmpegVersion,
    '8.1.2',
  );
  fs.writeFileSync(path.join(directory, 'unexpected.txt'), 'not authorized');
  assert.throws(
    () => loadReplacementSnapshot(directory),
    /unexpected.*unexpected\.txt/i,
  );
});

test('requires an explicit replacement source argument', () => {
  assert.equal(
    parseSourceArgument(['--source', '.']),
    path.resolve('.'),
  );
  assert.throws(() => parseSourceArgument([]), /Usage/);
  assert.throws(() => parseSourceArgument(['--source', '.', '--force']), /Usage/);
});
