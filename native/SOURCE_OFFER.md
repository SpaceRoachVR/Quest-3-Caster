# Native bundle source and rebuild offer

Quest 3 Caster includes a Windows x64 scrcpy client and dynamically linked
FFmpeg libraries. The corresponding source information, exact versions,
download URLs, hashes, build package list, OpenCL import overlay, and complete
scrcpy and FFmpeg patch sources are included in this repository under
`native/`.

Run `npm run native:build` from a Windows x64 checkout with WSL2 Ubuntu. The
entry point validates the host, installs the declared noninteractive Ubuntu
package set as WSL root, downloads only HTTPS sources, rejects any checksum or
scrcpy commit mismatch, applies the patch series to a clean source tree, and
cross-builds the client and its dependencies with MinGW. Generated sources and
build products are kept outside Git.

The FFmpeg build uses zlib 1.3.1 from the immutable, checksum-pinned official
source archive in `native/dependencies.json`. It does not link the mutable WSL
APT zlib package. The zlib source, license, and rebuild inputs are available
through the same manifest and build command.

The build stages `resources/native/win32-x64` and writes a SHA-256 manifest for
every runtime file. Run `npm run native:verify` after a rebuild.

You may replace a shared library in the LGPL-covered FFmpeg or libusb runtime
with a compatible Windows x64 build. FFmpeg replacements use the
explicit `npm run native:replace-libraries -- --source <directory>` command.
The source directory must contain exactly the five FFmpeg DLLs and a
`replacement-manifest.json` that identifies FFmpeg 8.1.2 and records the
SHA-256 of every DLL. The command validates hashes and x64 PE architecture,
loads the candidate in an isolated bundle to derive its actual FFmpeg version
and `deshake_opencl` availability, regenerates all bundle hashes, and completes
a verified transactional swap with rollback. It never changes bundle metadata merely
because a DLL was copied into place.

Stop casting before replacement. Node.js on Windows has no atomic
directory-exchange operation, so the command performs two short same-volume
renames. It keeps the original directory at a unique backup path through final
verification of the installed replacement. A verification failure restores
the original. If Windows file locking prevents restoration, the command
preserves both directories and reports their exact manual-recovery locations.

The matching scrcpy server is built from the same pinned 4.1 source as the
client, with the same patch series applied, rather than downloaded from the
upstream release. Patch 0004 makes the Android playback capture match every
audio usage that can carry application audio. Upstream matches `USAGE_MEDIA`
alone, and Meta Quest titles emit `USAGE_GAME`, so on a headset the upstream
server builds an empty capture mix and forwards digital silence without
reporting an error. The server build runs under the checksum-pinned JDK and
Android SDK platform and build-tools archives declared in
`native/dependencies.json`, and uses the upstream `build_without_gradle.sh`
entry point, so it needs no Gradle, no Android Studio, and no network access
beyond the pinned downloads. Replacing the server with another version is
unsupported because it changes the client/server protocol contract and is
rejected by the bundle metadata checks.
