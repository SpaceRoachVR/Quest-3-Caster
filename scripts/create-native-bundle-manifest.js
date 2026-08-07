#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  buildBundleManifest,
  collectNativeBundleFiles,
  validateDependencyManifest,
} = require('../lib/native-bundle');

function parseDependencyManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse dependency manifest: ${error.message}`);
  }
  return validateDependencyManifest(manifest);
}

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const bundleDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryRoot, 'resources', 'native', 'win32-x64');
  const dependencyManifestPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(repositoryRoot, 'native', 'dependencies.json');

  const dependencyManifest = parseDependencyManifest(dependencyManifestPath);
  const { files } = collectNativeBundleFiles(bundleDirectory);
  const bundleManifest = buildBundleManifest({
    dependencyManifest,
    files,
  });
  const manifestPath = path.join(bundleDirectory, 'bundle-manifest.json');
  const temporaryManifestPath = `${manifestPath}.tmp`;
  fs.writeFileSync(
    temporaryManifestPath,
    `${JSON.stringify(bundleManifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'w' },
  );
  fs.renameSync(temporaryManifestPath, manifestPath);
  process.stdout.write(
    `Wrote ${bundleManifest.files.length} native bundle hashes to ${manifestPath}.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Native bundle manifest creation failed: ${error.message}\n`);
  process.exitCode = 1;
}
