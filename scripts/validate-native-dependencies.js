#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateDependencyManifest } = require('../lib/native-bundle');

function main() {
  const repositoryRoot = path.resolve(__dirname, '..');
  const manifestPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryRoot, 'native', 'dependencies.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Dependency manifest contains invalid JSON: ${error.message}`);
  }

  validateDependencyManifest(manifest);
  process.stdout.write(
    `Validated ${manifest.sources.length} pinned native sources for ${manifest.target}.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Native dependency validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
