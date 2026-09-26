'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateDependencyManifest } = require('../lib/native-bundle');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEPENDENCY_MANIFEST_PATH = path.join(
  REPOSITORY_ROOT,
  'native',
  'dependencies.json',
);

function readRepositoryFile(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('pins every native source and downloaded file in one valid manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(DEPENDENCY_MANIFEST_PATH, 'utf8'));
  validateDependencyManifest(manifest);

  const expectedSources = new Map([
    ['scrcpy', {
      kind: 'git',
      version: '4.1',
      commit: '2926c06c5dc3064ae6d8db706f1a98a37cfcf3f0',
    }],
    ['ffmpeg', {
      kind: 'archive',
      version: '8.1.2',
      sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    }],
    ['zlib', {
      kind: 'archive',
      version: '1.3.1',
      sha256: '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23',
    }],
    ['sdl', {
      kind: 'archive',
      version: '3.4.12',
      sha256: 'b68381f06a7580e63400b3b6eb547ec57d8c3ebde70f9f40e0aba530ba05da27',
    }],
    ['dav1d', {
      kind: 'archive',
      version: '1.5.3',
      sha256: 'cbe212b02faf8c6eed5b6d55ef8a6e363aaab83f15112e960701a9c3df813686',
    }],
    ['libusb', {
      kind: 'archive',
      version: '1.0.30',
      sha256: '2ae28adb0bb9558c86135c4e1c11b320b0805461e207a64a6e520a114094bf07',
    }],
    ['platform-tools', {
      kind: 'archive',
      version: '37.0.0',
      sha256: '4fe305812db074cea32903a489d061eb4454cbc90a49e8fea677f4b7af764918',
    }],
    // The device server is built from the patched source tree, so the upstream
    // release binary is no longer downloaded. These three pin that build.
    ['jdk', {
      kind: 'archive',
      version: '17.0.20+8',
      sha256: 'be7668bc030d578b83d6d5ef9221d6d6729bbbca8cf94a7d52e16ac68b5a5a35',
    }],
    ['android-platform', {
      kind: 'archive',
      version: '36-r02',
      sha256: '37607369a28c5b640b3a7998868d45898ebcb777565a0e85f9acf36f29631d2e',
    }],
    ['android-build-tools', {
      kind: 'archive',
      version: '36.0.0',
      sha256: '5d9ac77fb6ff43d9da518a337b4fcf8f9097113df531d99ccefe80ef7ce8250b',
    }],
    ['opencl-headers', {
      kind: 'archive',
      version: '2024.10.24',
      sha256: '159f2a550592bae49859fee83d372acd152328fdf95c0dcd8b9409f8fad5db93',
    }],
  ]);

  assert.deepEqual(
    new Set(manifest.sources.map((source) => source.id)),
    new Set(expectedSources.keys()),
  );
  // Compared key by key rather than with assert.partialDeepStrictEqual,
  // which does not exist on Node 20 and CI still runs on it.
  for (const source of manifest.sources) {
    const expected = expectedSources.get(source.id);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(source[key], value, `${source.id}.${key}`);
    }
  }
  assert.deepEqual(
    manifest.toolchain.aptPackages,
    [...manifest.toolchain.aptPackages].sort(),
    'APT package names must have deterministic ordering',
  );
  assert.ok(!manifest.toolchain.aptPackages.includes('libz-mingw-w64-dev'));
  const zlib = manifest.sources.find((source) => source.id === 'zlib');
  assert.equal(zlib.url, 'https://zlib.net/fossils/zlib-1.3.1.tar.gz');
  assert.equal(zlib.filename, 'zlib-1.3.1.tar.gz');
  assert.equal(zlib.license, 'Zlib');
});

test('keeps the native source patch minimal and focused on avfilter and OpenCL', () => {
  const series = readRepositoryFile('native/patches/series')
    .trim()
    .split(/\r?\n/);
  assert.deepEqual(series, [
    '0001-enable-libavfilter-opencl-link-proof.patch',
    '0002-add-locked-obs-profiles-and-opencl-stabilizer.patch',
    '0003-add-locked-square-eye-profiles.patch',
    '0004-capture-quest-game-audio-usages.patch',
  ]);

  const patch = readRepositoryFile(`native/patches/${series[0]}`);
  assert.match(patch, /dependency\('libavfilter'/);
  assert.match(patch, /--enable-opencl/);
  assert.match(patch, /--enable-filter=deshake_opencl/);
  assert.match(patch, /avfilter_version/);
  assert.match(patch, /libavfilter:/);
});

test('captures the audio usages Quest emits instead of USAGE_MEDIA alone', () => {
  // Upstream builds its loopback mix from USAGE_MEDIA only. Quest titles and the
  // Horizon shell emit USAGE_GAME, so that mix is created empty and the capture
  // succeeds while delivering digital silence, logging nothing. Without this
  // patch the locked profiles ship with no game audio at all.
  const patch = readRepositoryFile(
    'native/patches/0004-capture-quest-game-audio-usages.patch',
  );
  assert.match(patch, /audio\/AudioPlaybackCapture\.java/);
  assert.match(patch, /USAGE_GAME/);
  assert.match(patch, /USAGE_MEDIA/);
  // --audio-dup maps to ROUTE_FLAG_LOOP_BACK_RENDER, which is what keeps the
  // audio playing in the headset. Capturing must not cost the wearer their game
  // sound, so the route flag selection must remain untouched.
  assert.doesNotMatch(patch, /^[-+].*ROUTE_FLAG_LOOP_BACK/m);
});

test('includes the reproducible OpenCL import and filter-probe overlays', () => {
  const openclDefinitions = readRepositoryFile('native/overlay/OpenCL.def');
  const probe = readRepositoryFile('native/overlay/ffmpeg-opencl-probe.c');

  assert.match(openclDefinitions, /^LIBRARY OpenCL\.dll/m);
  assert.match(openclDefinitions, /^\s+clGetPlatformIDs$/m);
  assert.match(probe, /required_filter = "deshake_opencl"/);
  assert.match(probe, /avfilter_get_by_name\(required_filter\)/);
  assert.match(probe, /av_version_info\(\)/);
  assert.match(probe, /ffmpeg_version=/);
});

test('includes license texts, third-party notices, and a shared-library source offer', () => {
  for (const relativePath of [
    'native/licenses/Apache-2.0.txt',
    'native/licenses/LGPL-2.1.txt',
    'native/THIRD_PARTY_NOTICES.md',
    'native/SOURCE_OFFER.md',
  ]) {
    const content = readRepositoryFile(relativePath);
    assert.ok(content.length > 500, `${relativePath} is unexpectedly short`);
  }
  assert.match(readRepositoryFile('native/SOURCE_OFFER.md'), /replace/i);
  assert.match(readRepositoryFile('native/SOURCE_OFFER.md'), /shared librar/i);
  assert.match(readRepositoryFile('native/THIRD_PARTY_NOTICES.md'), /zlib 1\.3\.1/);
  assert.match(readRepositoryFile('native/SOURCE_OFFER.md'), /zlib 1\.3\.1/);
});

test('exposes native build and verification through npm scripts', () => {
  const packageJson = JSON.parse(readRepositoryFile('package.json'));
  assert.equal(
    packageJson.scripts['native:build'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1',
  );
  assert.equal(
    packageJson.scripts['native:verify'],
    'node scripts/verify-native-bundle.js',
  );
  assert.equal(
    packageJson.scripts['native:replace-libraries'],
    'node scripts/replace-native-libraries.js',
  );
});

test('build entry points declare WSL package install, patch, build, and manifest stages', () => {
  const powershell = readRepositoryFile('scripts/build-native.ps1');
  const bash = readRepositoryFile('native/build-windows.sh');

  assert.match(powershell, /Is64BitOperatingSystem/);
  assert.match(powershell, /Replace\('\\', '\/'\)/);
  assert.match(powershell, /apt-get/);
  assert.match(powershell, /create-native-bundle-manifest\.js/);
  assert.match(powershell, /verify-native-bundle\.js/);
  assert.match(bash, /git .* am/);
  assert.match(bash, /git .* status --porcelain/);
  assert.match(bash, /x86_64-w64-mingw32/);
  assert.match(bash, /libOpenCL\.a/);
  assert.doesNotMatch(bash, /libOpenCL\.dll\.a/);
  assert.match(bash, /CONFIG_GPL 0/);
  assert.match(bash, /CONFIG_NONFREE 0/);
  assert.match(bash, /CONFIG_OPENCL 1/);
  assert.match(bash, /CONFIG_DESHAKE_OPENCL_FILTER 1/);
  assert.match(bash, /CONFIG_ZLIB 1/);
  assert.match(bash, /source_field zlib/);
  assert.match(bash, /Zlib\.txt/);
  assert.match(bash, /SDL-Zlib\.txt/);
  assert.match(bash, /dav1d-BSD-2-Clause\.txt/);
  assert.match(bash, /Android-Platform-Tools-NOTICE\.txt/);
});

test('documents an explicit manifest-verified shared-library replacement command', () => {
  const readme = readRepositoryFile('README.md');
  const replacementScript = readRepositoryFile(
    'scripts/replace-native-libraries.js',
  );

  assert.match(readme, /npm run native:replace-libraries -- --source/);
  assert.match(readme, /replacement-manifest\.json/);
  assert.match(replacementScript, /replacement-manifest\.json/);
  assert.match(replacementScript, /ffmpegVersion/);
  assert.match(replacementScript, /renameSync/);
});

function readPatchSeries() {
  const patchDir = path.join(REPOSITORY_ROOT, 'native', 'patches');
  const patches = fs.readFileSync(path.join(patchDir, 'series'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(patches.length > 0, 'series must list at least one patch');
  return { patchDir, patches };
}

test('every patch hunk header matches its actual line counts', () => {
  // A hand-edited patch that adds or removes a line without updating its @@
  // header fails only inside `git am`, part-way through a 12 minute native
  // build. Catch it here instead.
  const { patchDir, patches } = readPatchSeries();

  for (const name of patches) {
    const lines = fs.readFileSync(path.join(patchDir, name), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!header) continue;
      const expectedOld = header[2] === undefined ? 1 : Number(header[2]);
      const expectedNew = header[4] === undefined ? 1 : Number(header[4]);
      let oldCount = 0;
      let newCount = 0;
      for (let j = i + 1; j < lines.length; j += 1) {
        // Count the whole hunk. Stopping once the declared counts are satisfied
        // would catch a hunk that is short of its header but never one that
        // overruns it, which is the half a hand edit usually produces.
        // Terminators: the next hunk, the next file, the format-patch
        // signature, or a truly empty line. An empty line cannot be context —
        // git writes empty context as a single space — so it only ever marks
        // the end of a diff body.
        const line = lines[j];
        if (line === '' || /^@@ /.test(line) || /^diff --git /.test(line)
          || /^-- $/.test(line)) break;
        if (line.startsWith('+')) newCount += 1;
        else if (line.startsWith('-')) oldCount += 1;
        else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
        else { oldCount += 1; newCount += 1; }
      }
      assert.equal(oldCount, expectedOld,
        `${name}: hunk at line ${i + 1} declares ${expectedOld} old lines but has ${oldCount}`);
      assert.equal(newCount, expectedNew,
        `${name}: hunk at line ${i + 1} declares ${expectedNew} new lines but has ${newCount}`);
    }
  }
});

test('the JavaScript profile geometry map matches profile.c', () => {
  // The native client reports each profile's real output size and the renderer
  // validates it. Those numbers live in profile.c and are mirrored in
  // locked-profile-geometry.js; a change to one and not the other rejects
  // every stream for that profile at the readiness handshake, which is how 1:1
  // broke. Crop, angle and window are mirrored too: they are what the app
  // tells the user it is doing, and a stale copy is a lie in the UI rather
  // than a failed handshake, so nothing catches it at runtime.
  const { patchDir, patches } = readPatchSeries();

  const declared = new Map();
  for (const name of patches) {
    const lines = fs.readFileSync(path.join(patchDir, name), 'utf8').split(/\r?\n/);
    let inProfileC = false;
    let current = null;
    for (const line of lines) {
      const fileHeader = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
      if (fileHeader) {
        inProfileC = fileHeader[1] === 'app/src/q3c/profile.c';
        current = null;
        continue;
      }
      if (!inProfileC || !line.startsWith('+')) continue;
      const body = line.slice(1);
      const named = /^\s*\.name\s*=\s*"([^"]+)"/.exec(body);
      if (named) {
        current = named[1];
        declared.set(current, {});
        continue;
      }
      const size = /^\s*\.(output|window)_(width|height)\s*=\s*(\d+)/.exec(body);
      if (size && current) declared.get(current)[`${size[1]}_${size[2]}`] = Number(size[3]);
      const text = /^\s*\.(server_crop|presentation_angle)\s*=\s*"([^"]+)"/.exec(body);
      if (text && current) declared.get(current)[text[1]] = text[2];
    }
  }

  assert.ok(declared.size > 0, 'profile.c must declare at least one profile');
  const mirrored = require('../lib/locked-profile-geometry').LOCKED_PROFILE_GEOMETRY;
  assert.deepEqual(
    Object.keys(mirrored).sort(),
    [...declared.keys()].sort(),
    'locked-profile-geometry.js must list exactly the profiles profile.c defines',
  );
  for (const [profile, native] of declared) {
    assert.deepEqual(
      mirrored[profile].output,
      { width: native.output_width, height: native.output_height },
      `${profile}: profile.c delivers ${native.output_width}x${native.output_height}`);
    assert.deepEqual(
      mirrored[profile].window,
      { width: native.window_width, height: native.window_height },
      `${profile}: profile.c sizes the window ${native.window_width}x${native.window_height}`);
    assert.equal(mirrored[profile].serverCrop, native.server_crop,
      `${profile}: profile.c crops ${native.server_crop}`);
    assert.equal(mirrored[profile].presentationAngle, native.presentation_angle,
      `${profile}: profile.c rotates by ${native.presentation_angle}`);
  }
});

test('every profile sizes its window to its delivered output', () => {
  // SDL scales the decoded frame to the window and OBS captures the window, so
  // a window wider than the output resamples the image on the way out -- after
  // the crops were chosen specifically to avoid resampling. Low Latency
  // shipped 1792x1008 into a 1920x1080 window and lost that property silently.
  const { LOCKED_PROFILE_GEOMETRY } = require('../lib/locked-profile-geometry');
  for (const [profile, geometry] of Object.entries(LOCKED_PROFILE_GEOMETRY)) {
    assert.deepEqual(geometry.window, geometry.output,
      `${profile}: window must equal output`);
  }
});
