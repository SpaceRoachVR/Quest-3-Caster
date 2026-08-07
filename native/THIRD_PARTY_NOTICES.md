# Quest 3 Caster native bundle notices

The Windows native bundle is produced from the exact source records in
`native/dependencies.json`. The generated `bundle-manifest.json` records every
staged runtime file and its SHA-256.

## scrcpy

scrcpy 4.1 is Copyright (C) 2018 Genymobile and Copyright (C) 2018-2026
Romain Vimont. It is licensed under Apache License 2.0. The checked-in patch
enables the LGPL FFmpeg `libavfilter` dependency and `deshake_opencl` filter,
adds the locked Quest 3 Caster profile pipeline and native diagnostics, and
reports the linked library versions.

## FFmpeg

FFmpeg 8.1.2 is built from source as shared libraries under the GNU Lesser
General Public License version 2.1 or later. This build disables GPL and
nonfree components. It enables only the codec, muxer, demuxer, parser, zlib,
libdav1d, swresample, libavfilter, and OpenCL features required by scrcpy and
the filter probe. The patch series also corrects the lifetime of
`FFFrameQueueGlobal` in `deshake_opencl`, which otherwise leaves its frame
queue referencing a stack object after input configuration. FFmpeg source and
configuration are reproducible from the manifest and patch series.

## zlib

zlib 1.3.1 is built from the pinned official source archive and linked
statically into the FFmpeg shared libraries. It is Copyright (C) 1995-2024
Jean-loup Gailly and Mark Adler and is distributed under the zlib license. The
complete license is staged as `LICENSES/Zlib.txt`.

## OpenCL

OpenCL headers are from KhronosGroup OpenCL-Headers v2024.10.24 under Apache
License 2.0. `OpenCL.def` contains standardized OpenCL loader export names and
is used only to generate a MinGW import library for the Windows system
`OpenCL.dll`; the Microsoft/NVIDIA OpenCL runtime is not redistributed.

## Other runtime components

- SDL 3.4.12 is licensed under the zlib license.
- dav1d 1.5.3 is licensed under the BSD 2-clause license.
- libusb 1.0.30 is licensed under LGPL-2.1-or-later.
- Android SDK Platform Tools 37.0.0 are redistributed subject to the Android
  SDK license included by Google in that distribution.
- The unmodified scrcpy server 4.1 is the official upstream release artifact
  and is licensed under Apache License 2.0.

Exact source URLs, artifact filenames, versions, and SHA-256 values are in
`native/dependencies.json`. See `native/SOURCE_OFFER.md` for complete rebuild
and shared-library replacement instructions.
