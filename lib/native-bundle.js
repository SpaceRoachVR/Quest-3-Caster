'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_SCRCPY_COMMIT =
  '2926c06c5dc3064ae6d8db706f1a98a37cfcf3f0';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;
const UPSTREAM_ADB_TOOL_PATHS = new Set([
  'adb.exe',
  'AdbWinApi.dll',
  'AdbWinUsbApi.dll',
]);
const EXPECTED_FFMPEG_REPLACEMENT_PATHS = Object.freeze([
  'avcodec-62.dll',
  'avfilter-11.dll',
  'avformat-62.dll',
  'avutil-60.dll',
  'swresample-6.dll',
]);
const LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS = Object.freeze([
  Object.freeze(['--video-bit-rate=1M']),
  Object.freeze(['--crop=100:100:0:0']),
  Object.freeze(['--max-fps=30']),
  Object.freeze(['--max-size=1024']),
  Object.freeze(['--video-buffer=10']),
  Object.freeze(['--video-codec=h265']),
  Object.freeze(['--video-codec-options=i-frame-interval=1']),
  Object.freeze(['--video-encoder=bogus']),
  Object.freeze(['--no-video']),
  Object.freeze(['--no-video-playback']),
  Object.freeze(['--no-window']),
  Object.freeze(['--no-playback']),
  Object.freeze(['--audio-bit-rate=64K']),
  Object.freeze(['--audio-codec=aac']),
  Object.freeze(['--audio-codec-options=bitrate=64000']),
  Object.freeze(['--audio-encoder=c2.android.aac.encoder']),
  Object.freeze(['--audio-source=mic']),
  Object.freeze(['--audio-buffer=50']),
  Object.freeze(['--audio-output-buffer=10']),
  Object.freeze(['--audio-dup']),
  Object.freeze(['--no-audio']),
  Object.freeze(['--no-audio-playback']),
  Object.freeze(['--require-audio']),
  Object.freeze(['--port=27199']),
  Object.freeze(['--force-adb-forward']),
  Object.freeze(['--record=q3c-test.mkv']),
  Object.freeze(['--record-format=mkv']),
  Object.freeze(['--record-orientation=0']),
  Object.freeze(['--no-control']),
  Object.freeze(['--keyboard=sdk']),
  Object.freeze(['--mouse=sdk']),
  Object.freeze(['--gamepad=disabled']),
]);
const LOCKED_PROFILE_REJECTION =
  'Locked OBS profiles require exactly one generation and '
  + 'reject custom codec/crop/rate/buffer options';

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty trimmed string`);
  }

  return value;
}

function requirePlainObject(value, fieldName) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value;
}

function resolveNativeBundleDirectory({
  isPackaged,
  appPath,
  resourcesPath,
  pathModule = path,
}) {
  if (typeof isPackaged !== 'boolean') {
    throw new TypeError('isPackaged must be a boolean');
  }
  if (!pathModule || typeof pathModule.join !== 'function') {
    throw new TypeError('pathModule must provide join()');
  }

  if (isPackaged) {
    requireNonEmptyString(resourcesPath, 'resourcesPath');
    return pathModule.join(resourcesPath, 'native', 'win32-x64');
  }

  requireNonEmptyString(appPath, 'appPath');
  return pathModule.join(appPath, 'resources', 'native', 'win32-x64');
}

function validateManifestRelativePath(relativePath) {
  requireNonEmptyString(relativePath, 'Manifest path');

  if (
    relativePath.includes('\\')
    || relativePath.startsWith('/')
    || WINDOWS_DRIVE_PATTERN.test(relativePath)
    || path.posix.isAbsolute(relativePath)
  ) {
    throw new Error(`Manifest path is not a portable relative path: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(`Manifest path is not canonical: ${relativePath}`);
  }

  return relativePath;
}

function parseBundleManifest(manifestText) {
  if (typeof manifestText !== 'string') {
    throw new TypeError('Bundle manifest JSON must be a string');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Bundle manifest contains invalid JSON: ${error.message}`);
  }

  return requirePlainObject(manifest, 'Bundle manifest');
}

function validateDependencyManifest(manifest) {
  requirePlainObject(manifest, 'Dependency manifest');
  if (manifest.schemaVersion !== 1) {
    throw new Error('Dependency manifest schemaVersion must be 1');
  }
  if (manifest.target !== 'win32-x64') {
    throw new Error('Dependency manifest target must be win32-x64');
  }

  const toolchain = requirePlainObject(
    manifest.toolchain,
    'Dependency manifest toolchain',
  );
  requireNonEmptyString(toolchain.wslDistribution, 'toolchain.wslDistribution');
  if (toolchain.targetTriplet !== 'x86_64-w64-mingw32') {
    throw new Error('toolchain.targetTriplet must be x86_64-w64-mingw32');
  }
  if (!Array.isArray(toolchain.aptPackages) || toolchain.aptPackages.length === 0) {
    throw new Error('toolchain.aptPackages must be a non-empty array');
  }
  const packageNames = new Set();
  for (const packageName of toolchain.aptPackages) {
    requireNonEmptyString(packageName, 'APT package');
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)) {
      throw new Error(`Invalid APT package name: ${packageName}`);
    }
    if (packageNames.has(packageName)) {
      throw new Error(`Duplicate APT package: ${packageName}`);
    }
    packageNames.add(packageName);
  }

  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new Error('Dependency manifest sources must be a non-empty array');
  }

  const sourceIds = new Set();
  for (const source of manifest.sources) {
    requirePlainObject(source, 'Dependency source');
    const sourceId = requireNonEmptyString(source.id, 'Dependency source id');
    if (!SOURCE_ID_PATTERN.test(sourceId)) {
      throw new Error(`Invalid dependency source id: ${sourceId}`);
    }
    if (sourceIds.has(sourceId)) {
      throw new Error(`Duplicate dependency source id: ${sourceId}`);
    }
    sourceIds.add(sourceId);

    requireNonEmptyString(source.version, `Dependency source ${sourceId} version`);
    requireNonEmptyString(source.license, `Dependency source ${sourceId} license`);
    const sourceUrl = requireNonEmptyString(
      source.url,
      `Dependency source ${sourceId} URL`,
    );
    let parsedUrl;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      throw new Error(`Dependency source ${sourceId} URL is invalid`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Dependency source ${sourceId} URL must use HTTPS`);
    }
    if (/(?:^|[-_/])(latest|master|main)(?:[-_/.]|$)/i.test(parsedUrl.pathname)) {
      throw new Error(`Dependency source ${sourceId} URL must not be floating`);
    }

    if (source.kind === 'git') {
      if (!/^[a-f0-9]{40}$/.test(source.commit)) {
        throw new Error(`Dependency source ${sourceId} commit must be a full SHA-1`);
      }
      requireNonEmptyString(source.tag, `Dependency source ${sourceId} tag`);
    } else if (source.kind === 'archive' || source.kind === 'file') {
      validateManifestRelativePath(
        requireNonEmptyString(
          source.filename,
          `Dependency source ${sourceId} filename`,
        ),
      );
      if (!SHA256_PATTERN.test(source.sha256)) {
        throw new Error(
          `Dependency source ${sourceId} SHA-256 must be 64 lowercase hexadecimal characters`,
        );
      }
    } else {
      throw new Error(`Dependency source ${sourceId} has unsupported kind`);
    }
  }

  return manifest;
}

function validateBundleManifest(manifest) {
  requirePlainObject(manifest, 'Bundle manifest');
  if (manifest.schemaVersion !== 1) {
    throw new Error('Bundle manifest schemaVersion must be 1');
  }
  if (manifest.target !== 'win32-x64') {
    throw new Error('Bundle manifest target must be win32-x64');
  }

  const upstream = requirePlainObject(manifest.upstream, 'Bundle upstream');
  if (
    upstream.name !== 'scrcpy'
    || upstream.version !== '4.1'
    || upstream.tag !== 'v4.1'
    || upstream.commit !== EXPECTED_SCRCPY_COMMIT
  ) {
    throw new Error(
      `Bundle must identify scrcpy 4.1 (${EXPECTED_SCRCPY_COMMIT})`,
    );
  }

  const ffmpeg = requirePlainObject(manifest.ffmpeg, 'Bundle FFmpeg metadata');
  if (!/^8\.1\.\d+$/.test(ffmpeg.version)) {
    throw new Error('Bundle FFmpeg version must be in the 8.1.x series');
  }
  if (ffmpeg.license !== 'LGPL-2.1-or-later') {
    throw new Error('Bundle FFmpeg license must be LGPL-2.1-or-later');
  }
  if (
    ffmpeg.linkage !== 'shared'
    || ffmpeg.libavfilter !== true
    || ffmpeg.opencl !== true
    || ffmpeg.requiredFilter !== 'deshake_opencl'
  ) {
    throw new Error(
      'Bundle FFmpeg must use shared libraries with libavfilter and deshake_opencl',
    );
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Bundle manifest files must be a non-empty array');
  }

  const pathsByLowercase = new Set();
  const roleCounts = new Map();
  for (const file of manifest.files) {
    requirePlainObject(file, 'Bundle file record');
    const relativePath = validateManifestRelativePath(file.path);
    const lowercasePath = relativePath.toLowerCase();
    if (lowercasePath === 'bundle-manifest.json') {
      throw new Error('Bundle manifest must not hash itself');
    }
    if (pathsByLowercase.has(lowercasePath)) {
      throw new Error(`Bundle manifest contains duplicate path: ${relativePath}`);
    }
    pathsByLowercase.add(lowercasePath);

    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error(
        `Bundle file ${relativePath} SHA-256 must be 64 lowercase hexadecimal characters`,
      );
    }
    const role = requireNonEmptyString(file.role, `Bundle file ${relativePath} role`);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
  }

  for (const requiredRole of [
    'client',
    'opencl-filter-probe',
    'native-unit-tests',
    'stabilization-probe',
    'server',
    'source-offer',
  ]) {
    if (roleCounts.get(requiredRole) !== 1) {
      throw new Error(`Bundle manifest must contain exactly one ${requiredRole}`);
    }
  }
  if (!roleCounts.has('shared-library')) {
    throw new Error('Bundle manifest must contain shared libraries');
  }
  if (!roleCounts.has('license')) {
    throw new Error('Bundle manifest must contain license files');
  }
  if (!roleCounts.has('notice')) {
    throw new Error('Bundle manifest must contain third-party notices');
  }

  return manifest;
}

function parsePortableExecutableArchitecture(binary) {
  if (!Buffer.isBuffer(binary) || binary.length < 134) {
    throw new Error('File is not a valid Portable Executable');
  }
  if (binary.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('File is not a valid Portable Executable');
  }

  const peOffset = binary.readUInt32LE(0x3c);
  if (
    peOffset > binary.length - 6
    || binary.toString('binary', peOffset, peOffset + 4) !== 'PE\u0000\u0000'
  ) {
    throw new Error('File is not a valid Portable Executable');
  }

  const machine = binary.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) {
    return 'x64';
  }
  if (machine === 0x14c) {
    return 'x86';
  }

  return `unknown-0x${machine.toString(16).padStart(4, '0')}`;
}

function hashBuffer(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function classifyBundleFile(relativePath) {
  if (UPSTREAM_ADB_TOOL_PATHS.has(relativePath)) {
    return 'native-tool';
  }
  if (relativePath === 'scrcpy.exe') {
    return 'client';
  }
  if (relativePath === 'ffmpeg-opencl-probe.exe') {
    return 'opencl-filter-probe';
  }
  if (relativePath === 'q3c-native-tests.exe') {
    return 'native-unit-tests';
  }
  if (relativePath === 'q3c-stabilization-probe.exe') {
    return 'stabilization-probe';
  }
  if (relativePath === 'scrcpy-server') {
    return 'server';
  }
  if (relativePath === 'SOURCE_OFFER.md') {
    return 'source-offer';
  }
  if (relativePath === 'THIRD_PARTY_NOTICES.md') {
    return 'notice';
  }
  if (relativePath.startsWith('LICENSES/') && /\.txt$/i.test(relativePath)) {
    return 'license';
  }
  if (/\.(?:bat|vbs)$/i.test(relativePath)) {
    return 'launcher';
  }
  if (/\.png$/i.test(relativePath)) {
    return 'asset';
  }
  if (/\.dll$/i.test(relativePath)) {
    return 'shared-library';
  }
  throw new Error(`Unrecognized staged bundle file: ${relativePath}`);
}

function buildBundleManifest({ dependencyManifest, files }) {
  validateDependencyManifest(dependencyManifest);
  if (!(files instanceof Map) || files.size === 0) {
    throw new TypeError('Bundle files must be a non-empty Map');
  }

  const scrcpy = dependencyManifest.sources.find((source) => source.id === 'scrcpy');
  const ffmpeg = dependencyManifest.sources.find((source) => source.id === 'ffmpeg');
  if (!scrcpy || scrcpy.kind !== 'git') {
    throw new Error('Dependency manifest must contain the pinned scrcpy Git source');
  }
  if (!ffmpeg || ffmpeg.kind !== 'archive') {
    throw new Error('Dependency manifest must contain the pinned FFmpeg archive');
  }

  const fileRecords = [...files]
    .map(([relativePath, content]) => {
      validateManifestRelativePath(relativePath);
      if (!Buffer.isBuffer(content)) {
        throw new TypeError(`Bundle file must be a Buffer: ${relativePath}`);
      }
      return {
        path: relativePath,
        sha256: hashBuffer(content),
        role: classifyBundleFile(relativePath),
      };
    })
    .sort((left, right) => {
      if (left.path < right.path) {
        return -1;
      }
      if (left.path > right.path) {
        return 1;
      }
      return 0;
    });

  const manifest = {
    schemaVersion: 1,
    target: dependencyManifest.target,
    upstream: {
      name: 'scrcpy',
      version: scrcpy.version,
      tag: scrcpy.tag,
      commit: scrcpy.commit,
    },
    ffmpeg: {
      version: ffmpeg.version,
      license: ffmpeg.license,
      linkage: 'shared',
      libavfilter: true,
      opencl: true,
      requiredFilter: 'deshake_opencl',
    },
    files: fileRecords,
  };

  return validateBundleManifest(manifest);
}

function collectNativeBundleFiles(bundleDirectory) {
  requireNonEmptyString(bundleDirectory, 'Native bundle directory');
  const absoluteBundleDirectory = path.resolve(bundleDirectory);
  let rootStats;
  try {
    rootStats = fs.lstatSync(absoluteBundleDirectory);
  } catch (error) {
    throw new Error(
      `Native bundle directory is unavailable: ${absoluteBundleDirectory}: ${error.message}`,
    );
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(
      `Native bundle path must be a real directory: ${absoluteBundleDirectory}`,
    );
  }

  const files = new Map();
  const lowercasePaths = new Set();

  function visitDirectory(absoluteDirectory, relativeDirectory) {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      validateManifestRelativePath(relativePath);
      const absolutePath = path.join(absoluteDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error(`Native bundle must not contain a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visitDirectory(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Native bundle contains unsupported entry: ${relativePath}`);
      }
      if (relativePath === 'bundle-manifest.json') {
        continue;
      }

      const lowercasePath = relativePath.toLowerCase();
      if (lowercasePaths.has(lowercasePath)) {
        throw new Error(
          `Native bundle contains duplicate case-insensitive path: ${relativePath}`,
        );
      }
      lowercasePaths.add(lowercasePath);
      files.set(relativePath, fs.readFileSync(absolutePath));
    }
  }

  visitDirectory(absoluteBundleDirectory, '');
  return {
    files,
    bundleDirectory: absoluteBundleDirectory,
  };
}

function loadNativeBundleSnapshot(bundleDirectory) {
  const collected = collectNativeBundleFiles(bundleDirectory);
  const manifestPath = path.join(
    collected.bundleDirectory,
    'bundle-manifest.json',
  );
  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Native bundle manifest is unavailable: ${error.message}`);
  }

  return {
    manifestText,
    files: collected.files,
    bundleDirectory: collected.bundleDirectory,
  };
}

function inspectNativeBundleSnapshot({ manifestText, files }) {
  if (!(files instanceof Map)) {
    throw new TypeError('Bundle snapshot files must be a Map');
  }

  const manifest = validateBundleManifest(parseBundleManifest(manifestText));
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = new Set(files.keys());

  for (const expectedPath of expectedPaths) {
    if (!actualPaths.has(expectedPath)) {
      throw new Error(`Bundle is missing staged file: ${expectedPath}`);
    }
  }
  for (const actualPath of actualPaths) {
    validateManifestRelativePath(actualPath);
    if (!expectedPaths.has(actualPath)) {
      throw new Error(`Bundle contains unexpected staged file: ${actualPath}`);
    }
  }

  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (!Buffer.isBuffer(content)) {
      throw new Error(`Bundle file is not binary content: ${file.path}`);
    }
    const actualHash = hashBuffer(content);
    if (actualHash !== file.sha256) {
      throw new Error(
        `Bundle hash mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`,
      );
    }

    if (/\.(?:exe|dll)$/i.test(file.path)) {
      const architecture = parsePortableExecutableArchitecture(content);
      const isPinnedUpstreamAdbTool =
        file.role === 'native-tool'
        && UPSTREAM_ADB_TOOL_PATHS.has(file.path)
        && architecture === 'x86';
      if (architecture !== 'x64' && !isPinnedUpstreamAdbTool) {
        throw new Error(
          `Bundle file ${file.path} is ${architecture}, expected x64`,
        );
      }
    }
  }

  const client = manifest.files.find((file) => file.role === 'client');
  const openclFilterProbe = manifest.files.find(
    (file) => file.role === 'opencl-filter-probe',
  );
  const nativeUnitTests = manifest.files.find(
    (file) => file.role === 'native-unit-tests',
  );
  const stabilizationProbe = manifest.files.find(
    (file) => file.role === 'stabilization-probe',
  );
  return {
    manifest,
    clientPath: client.path,
    openclFilterProbePath: openclFilterProbe.path,
    nativeUnitTestsPath: nativeUnitTests.path,
    stabilizationProbePath: stabilizationProbe.path,
  };
}

function formatExecutionFailure(label, result) {
  if (result && result.error) {
    return `${label} could not execute: ${result.error.message}`;
  }
  if (!result) {
    return `${label} did not return an execution result`;
  }

  return `${label} exited with status ${String(result.status)}: ${
    result.stderr || result.stdout || 'no diagnostic output'
  }`;
}

const MISSING_GPU_DIAGNOSTIC = 'OpenCL stabilization unavailable';
const GPU_BOUND_CHECKS = Object.freeze(['nativeUnitTests', 'syntheticProbe']);

// The capability probe's exact wording when scrcpy.exe could not open an
// OpenCL device. Only this precise combination counts as "no GPU here"; any
// other deviation from the ready contract is still a broken bundle.
function capabilitiesReportMissingGpu(capabilities) {
  return Boolean(capabilities)
    && typeof capabilities === 'object'
    && capabilities.openclAvailable === false
    && capabilities.gpu === null
    && capabilities.diagnostic === MISSING_GPU_DIAGNOSTIC;
}

function parseCapabilitiesOutput(result) {
  if (!result || result.error || result.status !== 0) return null;
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    return JSON.parse(lines[0]);
  } catch {
    return null;
  }
}

// allowMissingGpu exists for machines without an OpenCL GPU, such as hosted
// CI runners. Static hashes, the client, the libavfilter link probe, the
// forced-failure cleanup probe and the CLI parser checks stay mandatory; only
// the two executables that need a live OpenCL filter may be skipped, and only
// when the capability probe itself says no GPU is present. On a machine with
// a GPU the option changes nothing.
function validateNativeExecutionResults(
  manifest,
  results,
  { allowMissingGpu = false } = {},
) {
  validateBundleManifest(manifest);
  requirePlainObject(results, 'Native execution results');

  const clientResult = results.client;
  if (!clientResult || clientResult.error || clientResult.status !== 0) {
    const failure = formatExecutionFailure('Staged client', clientResult);
    throw new Error(failure.replace('could not execute', 'could not execute --version'));
  }
  const clientOutput = `${clientResult.stdout || ''}\n${clientResult.stderr || ''}`;
  if (!/(?:^|\n)scrcpy 4\.1(?:\s|$)/.test(clientOutput)) {
    throw new Error('Staged client reported version other than scrcpy 4.1');
  }
  if (!/libavfilter/i.test(clientOutput)) {
    throw new Error('Staged client --version did not prove libavfilter linkage');
  }

  const probeResult = results.openclFilterProbe;
  if (!probeResult || probeResult.error || probeResult.status !== 0) {
    throw new Error(
      `${manifest.ffmpeg.requiredFilter} probe failed: ${
        formatExecutionFailure('staged OpenCL filter probe', probeResult)
      }`,
    );
  }
  const probeOutput = `${probeResult.stdout || ''}\n${probeResult.stderr || ''}`;
  if (!probeOutput.includes(manifest.ffmpeg.requiredFilter)) {
    throw new Error(
      `Staged probe did not report ${manifest.ffmpeg.requiredFilter}`,
    );
  }
  const probeLines = probeOutput.split(/\r?\n/);
  if (!probeLines.includes(`ffmpeg_version=${manifest.ffmpeg.version}`)) {
    throw new Error(
      `Staged probe did not report FFmpeg ${manifest.ffmpeg.version}`,
    );
  }

  const parseSuccessfulJson = (label, result) => {
    if (!result || result.error || result.status !== 0) {
      throw new Error(formatExecutionFailure(label, result));
    }
    const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) {
      throw new Error(`${label} must emit exactly one JSON line`);
    }
    try {
      return JSON.parse(lines[0]);
    } catch (error) {
      throw new Error(`${label} emitted invalid JSON: ${error.message}`);
    }
  };

  const requireExactKeys = (label, value, expectedKeys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (
      actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
    ) {
      throw new Error(`${label} has missing or unexpected fields`);
    }
  };

  const capabilities = parseSuccessfulJson(
    'Capability probe',
    results.capabilities,
  );
  requireExactKeys('Capability probe', capabilities, [
    'schemaVersion',
    'upstreamVersion',
    'forkVersion',
    'profiles',
    'stabilizationModes',
    'openclAvailable',
    'gpu',
    'output',
    'delays',
    'calibratedSource',
    'diagnostic',
  ]);
  requireExactKeys('Capability output', capabilities.output, ['width', 'height']);
  requireExactKeys('Capability delays', capabilities.delays, [
    'lowLatencyNominalMs',
    'stabilizedNominalMs',
    'stabilizedMaximumMs',
  ]);
  requireExactKeys('Capability calibrated source', capabilities.calibratedSource, [
    'width',
    'height',
  ]);
  const gpuMissing = capabilitiesReportMissingGpu(capabilities);
  if (gpuMissing && !allowMissingGpu) {
    throw new Error(
      'Capability probe reported no usable OpenCL GPU on this machine; '
      + 'pass --allow-missing-gpu to verify everything except the GPU-bound checks',
    );
  }
  if (
    capabilities.schemaVersion !== 1
    || capabilities.upstreamVersion !== '4.1'
    || capabilities.forkVersion !== 'quest3caster-stabilization-1'
    || !Array.isArray(capabilities.profiles)
    || capabilities.profiles.length !== 4
    || capabilities.profiles[0] !== 'obsLowLatency1080p60'
    || capabilities.profiles[1] !== 'obsStabilized1080p60'
    || capabilities.profiles[2] !== 'obsLowLatencySquareLeft1080p60'
    || capabilities.profiles[3] !== 'obsLowLatencySquareRight1080p60'
    || !Array.isArray(capabilities.stabilizationModes)
    || capabilities.stabilizationModes.length !== 2
    || capabilities.stabilizationModes[0] !== 'off'
    || capabilities.stabilizationModes[1] !== 'openclFeaturePoint'
    || (!gpuMissing && capabilities.openclAvailable !== true)
    || (!gpuMissing && (typeof capabilities.gpu !== 'string' || !capabilities.gpu))
    || capabilities.output?.width !== 1920
    || capabilities.output?.height !== 1080
    || capabilities.delays?.lowLatencyNominalMs !== 0
    || capabilities.delays?.stabilizedNominalMs !== 100
    || capabilities.delays?.stabilizedMaximumMs !== 120
    || capabilities.calibratedSource?.width !== 4128
    || capabilities.calibratedSource?.height !== 2208
    || (!gpuMissing && capabilities.diagnostic !== 'ready')
  ) {
    throw new Error('Capability probe did not report the required native contract');
  }

  // A GPU-bound result may be absent only when the probe reported no GPU; a
  // result that was produced is always held to the full acceptance gates.
  const skippedChecks = GPU_BOUND_CHECKS.filter(
    (check) => gpuMissing && results[check] === null,
  );
  const missingWithoutReason = GPU_BOUND_CHECKS.filter(
    (check) => !gpuMissing && results[check] === null,
  );
  if (missingWithoutReason.length > 0) {
    throw new Error(
      missingWithoutReason.join(', ')
      + ' may only be skipped when the capability probe reports no OpenCL GPU',
    );
  }

  if (!skippedChecks.includes('nativeUnitTests')) {
  const nativeTests = parseSuccessfulJson(
    'Native unit tests',
    results.nativeUnitTests,
  );
  requireExactKeys('Native unit tests', nativeTests, [
    'schemaVersion',
    'status',
    'assertions',
    'lifecycle',
  ]);
  requireExactKeys('Native lifecycle results', nativeTests.lifecycle, [
    'filterBypass',
    'initializationFailure',
    'sessionReset',
    'renderAcknowledgement',
    'frameValidation',
    'shutdownCleanup',
    'utf8Sanitization',
    'liveStabilizedGraph',
    'delayedFramesDisposed',
    'concurrentAckLifecycle',
    'renderFailureSuppressed',
    'gpuSelection',
    'pausedStaleEventSafe',
    'publicationOverlap',
    'borderExposureGuard',
  ]);
  if (
    nativeTests.schemaVersion !== 1
    || nativeTests.status !== 'passed'
    || !Number.isInteger(nativeTests.assertions)
    || nativeTests.assertions < 40
    || Object.values(nativeTests.lifecycle).some((value) => value !== true)
  ) {
    throw new Error('Native production-C unit tests did not pass');
  }
  }

  if (!skippedChecks.includes('syntheticProbe')) {
  const synthetic = parseSuccessfulJson(
    'Synthetic stabilization probe',
    results.syntheticProbe,
  );
  requireExactKeys('Synthetic stabilization probe', synthetic, [
    'schemaVersion',
    'gpu',
    'smallMotionInputRms',
    'smallMotionOutputRms',
    'smallMotionReductionPercent',
    'sustainedMotionReturnMs',
    'submissionToOutputMs',
    'outputWidth',
    'outputHeight',
    'borderPixels',
    'mirroredBorderPixels',
    'borderDepthsChecked',
    'borderSamples',
    'mirrorPositiveControls',
    'mirrorNegativeControl',
    'sustainedRunFrames',
    'peakQueueDepth',
    'peakWorkingSetBytes',
    'workingSetGrowthBytes',
    'memorySlopeBytesPerFrame',
    'secondHalfWorkingSetGrowthBytes',
    'boundedMemory',
    'cleanup',
  ]);
  const syntheticNumericFields = [
    'smallMotionInputRms',
    'smallMotionOutputRms',
    'smallMotionReductionPercent',
    'sustainedMotionReturnMs',
    'submissionToOutputMs',
    'outputWidth',
    'outputHeight',
    'borderPixels',
    'mirroredBorderPixels',
    'borderDepthsChecked',
    'borderSamples',
    'mirrorPositiveControls',
    'sustainedRunFrames',
    'peakQueueDepth',
    'peakWorkingSetBytes',
    'workingSetGrowthBytes',
    'memorySlopeBytesPerFrame',
    'secondHalfWorkingSetGrowthBytes',
  ];
  if (
    synthetic.schemaVersion !== 1
    || typeof synthetic.gpu !== 'string'
    || !synthetic.gpu
    || syntheticNumericFields.some(
      (field) => !Number.isFinite(synthetic[field]),
    )
    || synthetic.smallMotionReductionPercent < 30
    || synthetic.sustainedMotionReturnMs > 150
    || synthetic.submissionToOutputMs !== 100
    || synthetic.outputWidth !== 1920
    || synthetic.outputHeight !== 1080
    || synthetic.borderPixels !== 0
    || synthetic.mirroredBorderPixels !== 0
    || synthetic.borderDepthsChecked !== 32
    || synthetic.borderSamples < 60
    || synthetic.mirrorPositiveControls !== 16
    || synthetic.mirrorNegativeControl !== true
    || synthetic.sustainedRunFrames !== 3600
    || synthetic.peakQueueDepth > 12
    || synthetic.boundedMemory !== true
    || synthetic.cleanup !== true
  ) {
    throw new Error('Synthetic stabilization metrics did not meet acceptance gates');
  }
  }

  const forced = parseSuccessfulJson(
    'Forced failure probe',
    results.forcedFailureProbe,
  );
  requireExactKeys('Forced failure probe', forced, [
    'schemaVersion',
    'forcedFailure',
    'cleanup',
    'code',
  ]);
  if (
    forced.schemaVersion !== 1
    || forced.forcedFailure !== true
    || forced.cleanup !== 'passed'
    || forced.code !== 'stabilization_unavailable'
  ) {
    throw new Error('Forced failure probe did not prove safe cleanup');
  }

  if (
    !Array.isArray(results.invalidLockedProfileArguments)
    || results.invalidLockedProfileArguments.length
      !== LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS.length
    || results.invalidLockedProfileArguments.some(
      (result) => !result
        || result.error
        || result.status === 0
        || typeof result.stderr !== 'string'
        || !result.stderr.includes(LOCKED_PROFILE_REJECTION),
    )
  ) {
    throw new Error('Real CLI parser accepted an incompatible locked profile');
  }

  return Object.freeze({
    gpuVerified: !gpuMissing,
    gpu: gpuMissing ? null : capabilities.gpu,
    skippedChecks: Object.freeze(skippedChecks),
  });
}

function validateReplacementSnapshot({ manifestText, files }) {
  if (typeof manifestText !== 'string') {
    throw new TypeError('Replacement manifest JSON must be a string');
  }
  if (!(files instanceof Map)) {
    throw new TypeError('Replacement files must be a Map');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Replacement manifest contains invalid JSON: ${error.message}`);
  }
  requirePlainObject(manifest, 'Replacement manifest');
  if (manifest.schemaVersion !== 1) {
    throw new Error('Replacement manifest schemaVersion must be 1');
  }
  if (manifest.ffmpegVersion !== '8.1.2') {
    throw new Error('Replacement manifest must identify FFmpeg 8.1.2');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Replacement manifest files must be an array');
  }

  const expectedPaths = new Set(EXPECTED_FFMPEG_REPLACEMENT_PATHS);
  const manifestPaths = new Set();
  for (const file of manifest.files) {
    requirePlainObject(file, 'Replacement file record');
    const relativePath = validateManifestRelativePath(file.path);
    if (!expectedPaths.has(relativePath)) {
      throw new Error(`Replacement manifest contains unexpected file: ${relativePath}`);
    }
    if (manifestPaths.has(relativePath)) {
      throw new Error(`Replacement manifest contains duplicate file: ${relativePath}`);
    }
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Replacement file ${relativePath} has an invalid SHA-256`);
    }
    manifestPaths.add(relativePath);
  }

  for (const expectedPath of expectedPaths) {
    if (!manifestPaths.has(expectedPath) || !files.has(expectedPath)) {
      throw new Error(`Replacement is missing required file: ${expectedPath}`);
    }
  }
  for (const actualPath of files.keys()) {
    validateManifestRelativePath(actualPath);
    if (!expectedPaths.has(actualPath)) {
      throw new Error(`Replacement contains unexpected file: ${actualPath}`);
    }
  }

  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (!Buffer.isBuffer(content)) {
      throw new Error(`Replacement file is not binary content: ${file.path}`);
    }
    const actualHash = hashBuffer(content);
    if (actualHash !== file.sha256) {
      throw new Error(
        `Replacement hash mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`,
      );
    }
    const architecture = parsePortableExecutableArchitecture(content);
    if (architecture !== 'x64') {
      throw new Error(
        `Replacement file ${file.path} is ${architecture}, expected x64`,
      );
    }
  }

  return manifest;
}

function defaultRunExecutable(executablePath, args, options) {
  return spawnSync(executablePath, args, options);
}

function verifyNativeBundleDirectory(
  bundleDirectory,
  { runExecutable = defaultRunExecutable, allowMissingGpu = false } = {},
) {
  if (typeof runExecutable !== 'function') {
    throw new TypeError('runExecutable must be a function');
  }

  const snapshot = loadNativeBundleSnapshot(bundleDirectory);
  const inspected = inspectNativeBundleSnapshot(snapshot);
  const executionOptions = {
    cwd: snapshot.bundleDirectory,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  };
  const clientResult = runExecutable(
    path.join(snapshot.bundleDirectory, inspected.clientPath),
    ['--version'],
    executionOptions,
  );
  const openclFilterProbeResult = runExecutable(
    path.join(snapshot.bundleDirectory, inspected.openclFilterProbePath),
    [],
    executionOptions,
  );
  const capabilitiesResult = runExecutable(
    path.join(snapshot.bundleDirectory, inspected.clientPath),
    ['--q3c-capabilities'],
    executionOptions,
  );
  // Without a GPU the native unit tests and the synthetic probe cannot open
  // their OpenCL filter and abort, so they are not executed at all. Their
  // null results are accepted below only because the probe said no GPU.
  const skipGpuBoundChecks = allowMissingGpu
    && capabilitiesReportMissingGpu(parseCapabilitiesOutput(capabilitiesResult));
  const nativeUnitTestsResult = skipGpuBoundChecks ? null : runExecutable(
    path.join(snapshot.bundleDirectory, inspected.nativeUnitTestsPath),
    [],
    executionOptions,
  );
  const syntheticProbeResult = skipGpuBoundChecks ? null : runExecutable(
    path.join(snapshot.bundleDirectory, inspected.stabilizationProbePath),
    ['--synthetic'],
    executionOptions,
  );
  const forcedFailureProbeResult = runExecutable(
    path.join(snapshot.bundleDirectory, inspected.stabilizationProbePath),
    ['--forced-failure'],
    executionOptions,
  );
  const invalidLockedProfileResults = LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS.map(
    (incompatibleArguments) => runExecutable(
      path.join(snapshot.bundleDirectory, inspected.clientPath),
      [
        '--q3c-profile=obsStabilized1080p60',
        '--q3c-generation=1',
        ...incompatibleArguments,
        '--help',
      ],
      executionOptions,
    ),
  );

  const execution = validateNativeExecutionResults(inspected.manifest, {
    client: clientResult,
    openclFilterProbe: openclFilterProbeResult,
    capabilities: capabilitiesResult,
    nativeUnitTests: nativeUnitTestsResult,
    syntheticProbe: syntheticProbeResult,
    forcedFailureProbe: forcedFailureProbeResult,
    invalidLockedProfileArguments: invalidLockedProfileResults,
  }, { allowMissingGpu });

  return { ...inspected, execution };
}

module.exports = {
  GPU_BOUND_CHECKS,
  capabilitiesReportMissingGpu,
  EXPECTED_FFMPEG_REPLACEMENT_PATHS,
  LOCKED_PROFILE_INCOMPATIBLE_ARGUMENTS,
  buildBundleManifest,
  collectNativeBundleFiles,
  inspectNativeBundleSnapshot,
  loadNativeBundleSnapshot,
  parseBundleManifest,
  parsePortableExecutableArchitecture,
  resolveNativeBundleDirectory,
  validateBundleManifest,
  validateDependencyManifest,
  validateManifestRelativePath,
  validateNativeExecutionResults,
  validateReplacementSnapshot,
  verifyNativeBundleDirectory,
};
