#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  EXPECTED_FFMPEG_REPLACEMENT_PATHS,
  buildBundleManifest,
  collectNativeBundleFiles,
  validateDependencyManifest,
  validateReplacementSnapshot,
  verifyNativeBundleDirectory,
} = require('../lib/native-bundle');

function parseSourceArgument(argv) {
  if (
    argv.length !== 2
    || argv[0] !== '--source'
    || typeof argv[1] !== 'string'
    || argv[1].trim() !== argv[1]
    || argv[1].length === 0
  ) {
    throw new Error(
      'Usage: npm run native:replace-libraries -- --source <replacement-directory>',
    );
  }
  return path.resolve(argv[1]);
}

function requireRealDirectory(directory, label) {
  let stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${directory}: ${error.message}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function loadReplacementSnapshot(sourceDirectory) {
  requireRealDirectory(sourceDirectory, 'Replacement source directory');
  const manifestName = 'replacement-manifest.json';
  const allowedNames = new Set([
    manifestName,
    ...EXPECTED_FFMPEG_REPLACEMENT_PATHS,
  ]);
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !allowedNames.has(entry.name)) {
      throw new Error(`Replacement source contains unexpected entry: ${entry.name}`);
    }
  }

  const manifestPath = path.join(sourceDirectory, manifestName);
  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`replacement-manifest.json is unavailable: ${error.message}`);
  }
  const files = new Map();
  for (const fileName of EXPECTED_FFMPEG_REPLACEMENT_PATHS) {
    const absolutePath = path.join(sourceDirectory, fileName);
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (error) {
      throw new Error(`Replacement file is unavailable: ${fileName}: ${error.message}`);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Replacement path must be a real file: ${fileName}`);
    }
    files.set(fileName, fs.readFileSync(absolutePath));
  }

  const manifest = validateReplacementSnapshot({ manifestText, files });
  return { files, manifest };
}

function loadDependencyManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse dependency manifest: ${error.message}`);
  }
  return validateDependencyManifest(manifest);
}

function writeCandidateManifest(candidateDirectory, dependencyManifest) {
  const { files } = collectNativeBundleFiles(candidateDirectory);
  const manifest = buildBundleManifest({ dependencyManifest, files });
  fs.writeFileSync(
    path.join(candidateDirectory, 'bundle-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'w' },
  );
}

function assertTemporaryPath(parentDirectory, candidatePath) {
  const relativePath = path.relative(parentDirectory, candidatePath);
  if (
    relativePath.length === 0
    || relativePath.startsWith('..')
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing unsafe temporary path: ${candidatePath}`);
  }
}

function removeTemporaryDirectory(parentDirectory, temporaryPath) {
  assertTemporaryPath(parentDirectory, temporaryPath);
  fs.rmSync(temporaryPath, { recursive: true, force: true });
}

function createTransactionError(message, cause, rollbackError) {
  const details = [
    message,
    `Cause: ${cause.message}`,
  ];
  if (rollbackError) {
    details.push(`Rollback error: ${rollbackError.message}`);
  }
  const error = new Error(details.join(' '));
  error.cause = cause;
  if (rollbackError) {
    error.rollbackError = rollbackError;
  }
  return error;
}

function installVerifiedCandidate({
  nativeParent,
  bundleDirectory,
  candidateDirectory,
  backupDirectory,
  fileSystem = fs,
  verifyBundle = verifyNativeBundleDirectory,
  removeDirectory = removeTemporaryDirectory,
}) {
  if (!fileSystem || typeof fileSystem.renameSync !== 'function') {
    throw new TypeError('fileSystem must provide renameSync()');
  }
  if (typeof verifyBundle !== 'function') {
    throw new TypeError('verifyBundle must be a function');
  }
  if (typeof removeDirectory !== 'function') {
    throw new TypeError('removeDirectory must be a function');
  }

  fileSystem.renameSync(bundleDirectory, backupDirectory);
  try {
    fileSystem.renameSync(candidateDirectory, bundleDirectory);
  } catch (installError) {
    try {
      fileSystem.renameSync(backupDirectory, bundleDirectory);
    } catch (restoreError) {
      throw createTransactionError(
        'Candidate install failed and automatic restore failed. '
          + `The original bundle is preserved at ${backupDirectory}; `
          + `the candidate is preserved at ${candidateDirectory}; `
          + `the installed path ${bundleDirectory} is unavailable. `
          + 'Stop casting and restore the original directory manually.',
        installError,
        restoreError,
      );
    }
    throw createTransactionError(
      'Candidate install failed; the original bundle was restored.',
      installError,
    );
  }

  let verified;
  try {
    verified = verifyBundle(bundleDirectory);
  } catch (verificationError) {
    try {
      fileSystem.renameSync(bundleDirectory, candidateDirectory);
    } catch (quarantineError) {
      throw createTransactionError(
        'Installed replacement failed verification and automatic rollback failed. '
          + `The original bundle is preserved at ${backupDirectory}; `
          + `the failed replacement remains at ${bundleDirectory}. `
          + 'Stop casting and restore the original directory manually.',
        verificationError,
        quarantineError,
      );
    }

    try {
      fileSystem.renameSync(backupDirectory, bundleDirectory);
    } catch (restoreError) {
      try {
        fileSystem.renameSync(candidateDirectory, bundleDirectory);
      } catch (reinstallError) {
        const combinedRollbackError = new Error(
          `${restoreError.message}; replacement-path recovery also failed: `
            + reinstallError.message,
        );
        throw createTransactionError(
          'Installed replacement failed verification and automatic rollback failed. '
            + `The original bundle is preserved at ${backupDirectory}; `
            + `the failed replacement is preserved at ${candidateDirectory}; `
            + `the installed path ${bundleDirectory} is unavailable. `
            + 'Stop casting and restore the original directory manually.',
          verificationError,
          combinedRollbackError,
        );
      }
      throw createTransactionError(
        'Installed replacement failed verification and automatic rollback failed. '
          + `The original bundle is preserved at ${backupDirectory}; `
          + `the replacement was restored to the installed path ${bundleDirectory}. `
          + 'Stop casting and restore the original directory manually.',
        verificationError,
        restoreError,
      );
    }

    try {
      removeDirectory(nativeParent, candidateDirectory);
    } catch (cleanupError) {
      throw createTransactionError(
        'Installed replacement failed verification; the original bundle was '
          + `restored, but the failed candidate could not be removed from `
          + `${candidateDirectory}. Remove it manually before retrying.`,
        verificationError,
        cleanupError,
      );
    }
    throw createTransactionError(
      'Installed replacement failed verification; the original bundle was restored.',
      verificationError,
    );
  }

  try {
    removeDirectory(nativeParent, backupDirectory);
  } catch (cleanupError) {
    throw createTransactionError(
      'The replacement is installed and verified, but the original backup could '
        + `not be removed from ${backupDirectory}. Preserve or remove that backup `
        + 'manually before retrying.',
      cleanupError,
    );
  }
  return verified;
}

function replaceLibraries({ sourceDirectory, repositoryRoot }) {
  const nativeParent = path.join(repositoryRoot, 'resources', 'native');
  const bundleDirectory = path.join(nativeParent, 'win32-x64');
  const dependencyManifestPath = path.join(
    repositoryRoot,
    'native',
    'dependencies.json',
  );
  requireRealDirectory(nativeParent, 'Native resource directory');
  verifyNativeBundleDirectory(bundleDirectory);

  const replacement = loadReplacementSnapshot(sourceDirectory);
  const dependencyManifest = loadDependencyManifest(dependencyManifestPath);
  if (replacement.manifest.ffmpegVersion !== dependencyManifest.sources
    .find((source) => source.id === 'ffmpeg')?.version) {
    throw new Error('Replacement FFmpeg version does not match the pinned build');
  }

  const nonce = `${process.pid}-${Date.now()}`;
  const candidateDirectory = path.join(nativeParent, `.replace-${nonce}`);
  const backupDirectory = path.join(nativeParent, `.backup-${nonce}`);
  assertTemporaryPath(nativeParent, candidateDirectory);
  assertTemporaryPath(nativeParent, backupDirectory);
  if (fs.existsSync(candidateDirectory) || fs.existsSync(backupDirectory)) {
    throw new Error('Native replacement temporary path already exists');
  }

  try {
    fs.cpSync(bundleDirectory, candidateDirectory, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    for (const [fileName, content] of replacement.files) {
      fs.writeFileSync(path.join(candidateDirectory, fileName), content, {
        flag: 'w',
      });
    }
    fs.rmSync(path.join(candidateDirectory, 'bundle-manifest.json'));
    writeCandidateManifest(candidateDirectory, dependencyManifest);

    // This derives the actual loaded FFmpeg version and filter availability
    // from the candidate DLLs before they can replace the current bundle.
    verifyNativeBundleDirectory(candidateDirectory);
  } catch (error) {
    if (fs.existsSync(candidateDirectory)) {
      removeTemporaryDirectory(nativeParent, candidateDirectory);
    }
    throw error;
  }

  return installVerifiedCandidate({
    nativeParent,
    bundleDirectory,
    candidateDirectory,
    backupDirectory,
  });
}

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const sourceDirectory = parseSourceArgument(process.argv.slice(2));
  const verified = replaceLibraries({ sourceDirectory, repositoryRoot });
  process.stdout.write(
    `Replaced and verified FFmpeg ${verified.manifest.ffmpeg.version} shared libraries; `
      + `${verified.manifest.files.length} bundle hashes regenerated.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Native library replacement failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  installVerifiedCandidate,
  loadReplacementSnapshot,
  parseSourceArgument,
  replaceLibraries,
};
