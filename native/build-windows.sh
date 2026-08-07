#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
    echo "Usage: $0 <repository-root> <cache-root> <stage-root> <dependency-manifest>" >&2
    exit 2
fi

REPOSITORY_ROOT="$(realpath -m "$1")"
CACHE_ROOT="$(realpath -m "$2")"
STAGE_ROOT="$(realpath -m "$3")"
DEPENDENCY_MANIFEST="$(realpath -m "$4")"
DOWNLOAD_ROOT="$CACHE_ROOT/downloads"
SCRCPY_SOURCE_ROOT="$CACHE_ROOT/scrcpy-v4.1"
OPENCL_SOURCE_ROOT="$CACHE_ROOT/opencl-headers"
ZLIB_SOURCE_ROOT="$CACHE_ROOT/zlib-1.3.1"
ZLIB_BUILD_ROOT="$CACHE_ROOT/zlib-build"
PATCH_ROOT="$REPOSITORY_ROOT/native/patches"
OVERLAY_ROOT="$REPOSITORY_ROOT/native/overlay"
TARGET_TRIPLET="x86_64-w64-mingw32"

export LC_ALL=C
export TZ=UTC
export ZERO_AR_DATE=1

required_tools=(
    cmake
    curl
    git
    make
    meson
    nasm
    ninja
    pkg-config
    python3
    unzip
    x86_64-w64-mingw32-dlltool
    x86_64-w64-mingw32-gcc
)

for tool in "${required_tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Required WSL build tool is unavailable: $tool" >&2
        exit 1
    fi
done

if [[ ! -f "$DEPENDENCY_MANIFEST" ]]; then
    echo "Dependency manifest is unavailable: $DEPENDENCY_MANIFEST" >&2
    exit 1
fi

safe_recreate_directory() {
    local target
    local allowed_parent
    target="$(realpath -m "$1")"
    allowed_parent="$(realpath -m "$2")"
    case "$target" in
        "$allowed_parent"/*)
            ;;
        *)
            echo "Refusing to reset path outside $allowed_parent: $target" >&2
            exit 1
            ;;
    esac
    rm -rf -- "$target"
    mkdir -p -- "$target"
}

source_field() {
    local source_id="$1"
    local field_name="$2"
    python3 - "$DEPENDENCY_MANIFEST" "$source_id" "$field_name" <<'PY'
import json
import sys

manifest_path, source_id, field_name = sys.argv[1:]
with open(manifest_path, "r", encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)

for source in manifest["sources"]:
    if source["id"] == source_id:
        value = source[field_name]
        if not isinstance(value, str) or not value:
            raise SystemExit(f"{source_id}.{field_name} is not a non-empty string")
        print(value)
        break
else:
    raise SystemExit(f"Missing dependency source: {source_id}")
PY
}

verify_checksum() {
    local file_path="$1"
    local expected_hash="$2"
    local actual_hash
    actual_hash="$(sha256sum "$file_path" | cut -d' ' -f1)"
    if [[ "$actual_hash" != "$expected_hash" ]]; then
        echo "SHA-256 mismatch for $file_path" >&2
        echo "Expected: $expected_hash" >&2
        echo "Actual:   $actual_hash" >&2
        return 1
    fi
}

download_source() {
    local source_id="$1"
    local url
    local filename
    local expected_hash
    local destination
    local temporary
    url="$(source_field "$source_id" url)"
    filename="$(source_field "$source_id" filename)"
    expected_hash="$(source_field "$source_id" sha256)"
    destination="$DOWNLOAD_ROOT/$filename"
    temporary="$destination.partial"

    if [[ -f "$destination" ]]; then
        verify_checksum "$destination" "$expected_hash"
        echo "Verified cached $source_id: $destination"
        return
    fi

    rm -f -- "$temporary"
    echo "Downloading pinned $source_id from $url"
    curl \
        --fail \
        --location \
        --proto '=https' \
        --retry 3 \
        --show-error \
        --silent \
        --tlsv1.2 \
        --output "$temporary" \
        "$url"
    verify_checksum "$temporary" "$expected_hash"
    mv -- "$temporary" "$destination"
    echo "Verified downloaded $source_id: $destination"
}

mkdir -p -- "$CACHE_ROOT" "$DOWNLOAD_ROOT"
for source_id in \
    ffmpeg \
    zlib \
    sdl \
    dav1d \
    libusb \
    platform-tools \
    scrcpy-server \
    opencl-headers; do
    download_source "$source_id"
done

SCRCPY_URL="$(source_field scrcpy url)"
SCRCPY_TAG="$(source_field scrcpy tag)"
SCRCPY_COMMIT="$(source_field scrcpy commit)"
safe_recreate_directory "$SCRCPY_SOURCE_ROOT" "$CACHE_ROOT"
git clone \
    --branch "$SCRCPY_TAG" \
    --depth 1 \
    --filter=blob:none \
    --no-checkout \
    "$SCRCPY_URL" \
    "$SCRCPY_SOURCE_ROOT"
git -C "$SCRCPY_SOURCE_ROOT" checkout --detach "$SCRCPY_COMMIT"

ACTUAL_COMMIT="$(git -C "$SCRCPY_SOURCE_ROOT" rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$SCRCPY_COMMIT" ]]; then
    echo "scrcpy source commit mismatch: expected $SCRCPY_COMMIT, got $ACTUAL_COMMIT" >&2
    exit 1
fi
if ! git -C "$SCRCPY_SOURCE_ROOT" tag --points-at HEAD | grep -Fx "$SCRCPY_TAG" >/dev/null; then
    echo "scrcpy tag $SCRCPY_TAG does not point to $SCRCPY_COMMIT" >&2
    exit 1
fi
if [[ -n "$(git -C "$SCRCPY_SOURCE_ROOT" status --porcelain)" ]]; then
    echo "scrcpy source tree is not clean before patch application" >&2
    exit 1
fi

git -C "$SCRCPY_SOURCE_ROOT" config user.name "Quest 3 Caster Build"
git -C "$SCRCPY_SOURCE_ROOT" config user.email "build@quest3caster.invalid"
PATCH_COUNT=0
while IFS= read -r patch_name || [[ -n "$patch_name" ]]; do
    [[ -z "$patch_name" ]] && continue
    if [[ ! "$patch_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.patch$ ]]; then
        echo "Invalid patch series entry: $patch_name" >&2
        exit 1
    fi
    patch_path="$PATCH_ROOT/$patch_name"
    if [[ ! -f "$patch_path" ]]; then
        echo "Patch is unavailable: $patch_path" >&2
        exit 1
    fi
    git -C "$SCRCPY_SOURCE_ROOT" am --keep-cr "$patch_path"
    PATCH_COUNT=$((PATCH_COUNT + 1))
done < "$PATCH_ROOT/series"

if [[ "$PATCH_COUNT" -eq 0 ]]; then
    echo "Patch series is empty" >&2
    exit 1
fi
PATCH_BASE="$(git -C "$SCRCPY_SOURCE_ROOT" rev-parse "HEAD~$PATCH_COUNT")"
if [[ "$PATCH_BASE" != "$SCRCPY_COMMIT" ]]; then
    echo "Patch series base mismatch: expected $SCRCPY_COMMIT, got $PATCH_BASE" >&2
    exit 1
fi
if [[ -n "$(git -C "$SCRCPY_SOURCE_ROOT" status --porcelain)" ]]; then
    echo "scrcpy source tree is not clean after patch application" >&2
    exit 1
fi

export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH="$(git -C "$SCRCPY_SOURCE_ROOT" show -s --format=%ct "$SCRCPY_COMMIT")"

UPSTREAM_SOURCE_ROOT="$SCRCPY_SOURCE_ROOT/app/deps/work/sources"
mkdir -p -- "$UPSTREAM_SOURCE_ROOT"
for source_id in ffmpeg zlib sdl dav1d libusb platform-tools; do
    filename="$(source_field "$source_id" filename)"
    cp -- "$DOWNLOAD_ROOT/$filename" "$UPSTREAM_SOURCE_ROOT/$filename"
done

DEPS_INSTALL_ROOT="$SCRCPY_SOURCE_ROOT/app/deps/work/install/win64-cross-shared"
mkdir -p \
    "$DEPS_INSTALL_ROOT/include" \
    "$DEPS_INSTALL_ROOT/lib/pkgconfig"

safe_recreate_directory "$ZLIB_SOURCE_ROOT" "$CACHE_ROOT"
safe_recreate_directory "$ZLIB_BUILD_ROOT" "$CACHE_ROOT"
ZLIB_ARCHIVE="$DOWNLOAD_ROOT/$(source_field zlib filename)"
tar -xf "$ZLIB_ARCHIVE" -C "$ZLIB_SOURCE_ROOT" --strip-components=1
(
    cd "$ZLIB_BUILD_ROOT"
    CHOST="$TARGET_TRIPLET" \
        CC="$TARGET_TRIPLET-gcc" \
        AR="$TARGET_TRIPLET-ar" \
        RANLIB="$TARGET_TRIPLET-ranlib" \
        "$ZLIB_SOURCE_ROOT/configure" \
            --static \
            --prefix="$DEPS_INSTALL_ROOT"
    make -j
    make install
)
if [[ ! -f "$DEPS_INSTALL_ROOT/lib/libz.a" ]]; then
    echo "Pinned zlib build did not produce libz.a" >&2
    exit 1
fi
if ! grep -Fx "Version: $(source_field zlib version)" \
    "$DEPS_INSTALL_ROOT/lib/pkgconfig/zlib.pc" >/dev/null; then
    echo "Pinned zlib pkg-config metadata has an unexpected version" >&2
    exit 1
fi

safe_recreate_directory "$OPENCL_SOURCE_ROOT" "$CACHE_ROOT"
OPENCL_ARCHIVE="$DOWNLOAD_ROOT/$(source_field opencl-headers filename)"
tar -xf "$OPENCL_ARCHIVE" -C "$OPENCL_SOURCE_ROOT" --strip-components=1
if [[ ! -d "$OPENCL_SOURCE_ROOT/CL" ]]; then
    echo "Pinned OpenCL header archive does not contain CL/" >&2
    exit 1
fi
cp -R -- "$OPENCL_SOURCE_ROOT/CL" "$DEPS_INSTALL_ROOT/include/"
"$TARGET_TRIPLET-dlltool" \
    --input-def "$OVERLAY_ROOT/OpenCL.def" \
    --dllname OpenCL.dll \
    --output-lib "$DEPS_INSTALL_ROOT/lib/libOpenCL.a"
cat > "$DEPS_INSTALL_ROOT/lib/pkgconfig/OpenCL.pc" <<EOF
prefix=$DEPS_INSTALL_ROOT
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: OpenCL
Description: Windows system OpenCL loader import library
Version: 3.0
Libs: -L\${libdir} -lOpenCL
Cflags: -I\${includedir}
EOF

(
    cd "$SCRCPY_SOURCE_ROOT"
    release/build_windows.sh 64
)

FFMPEG_VERSION="$(source_field ffmpeg version)"
FFMPEG_BUILD_ROOT="$SCRCPY_SOURCE_ROOT/app/deps/work/build/ffmpeg-$FFMPEG_VERSION/win64-cross-shared"
require_ffmpeg_define() {
    local config_path="$1"
    local expected_define="$2"
    if [[ ! -f "$config_path" ]]; then
        echo "FFmpeg build configuration is unavailable: $config_path" >&2
        exit 1
    fi
    if ! grep -Fx "#define $expected_define" "$config_path" >/dev/null; then
        echo "FFmpeg build configuration did not prove $expected_define" >&2
        exit 1
    fi
}
require_ffmpeg_define "$FFMPEG_BUILD_ROOT/config.h" "CONFIG_GPL 0"
require_ffmpeg_define "$FFMPEG_BUILD_ROOT/config.h" "CONFIG_NONFREE 0"
require_ffmpeg_define "$FFMPEG_BUILD_ROOT/config.h" "CONFIG_OPENCL 1"
require_ffmpeg_define "$FFMPEG_BUILD_ROOT/config.h" "CONFIG_ZLIB 1"
require_ffmpeg_define \
    "$FFMPEG_BUILD_ROOT/config_components.h" \
    "CONFIG_DESHAKE_OPENCL_FILTER 1"
for required_filter in \
    CROP_FILTER \
    FORMAT_FILTER \
    HWDOWNLOAD_FILTER \
    HWUPLOAD_FILTER; do
    require_ffmpeg_define \
        "$FFMPEG_BUILD_ROOT/config_components.h" \
        "CONFIG_${required_filter} 1"
done

EXPECTED_STAGE_PARENT="$(realpath -m "$REPOSITORY_ROOT/resources/native")"
mkdir -p -- "$EXPECTED_STAGE_PARENT"
safe_recreate_directory "$STAGE_ROOT" "$EXPECTED_STAGE_PARENT"
mkdir -p -- "$STAGE_ROOT/LICENSES"

SCRCPY_BUILD_ROOT="$SCRCPY_SOURCE_ROOT/release/work/build-win64"
install -m 0755 "$SCRCPY_BUILD_ROOT/app/scrcpy.exe" "$STAGE_ROOT/scrcpy.exe"
install -m 0644 \
    "$SCRCPY_SOURCE_ROOT/app/data/scrcpy-noconsole.vbs" \
    "$SCRCPY_SOURCE_ROOT/app/data/scrcpy.png" \
    "$SCRCPY_SOURCE_ROOT/app/data/disconnected.png" \
    "$SCRCPY_SOURCE_ROOT/app/data/open_a_terminal_here.bat" \
    "$STAGE_ROOT/"

DLL_COUNT=0
while IFS= read -r -d '' dll_path; do
    install -m 0755 "$dll_path" "$STAGE_ROOT/$(basename "$dll_path")"
    DLL_COUNT=$((DLL_COUNT + 1))
done < <(find "$DEPS_INSTALL_ROOT/bin" -maxdepth 1 -type f -name '*.dll' -print0 | sort -z)
if [[ "$DLL_COUNT" -eq 0 ]]; then
    echo "Native dependency build did not produce shared DLLs" >&2
    exit 1
fi

ADB_INSTALL_ROOT="$SCRCPY_SOURCE_ROOT/app/deps/work/install/adb-windows"
for adb_file in adb.exe AdbWinApi.dll AdbWinUsbApi.dll; do
    if [[ ! -f "$ADB_INSTALL_ROOT/$adb_file" ]]; then
        echo "Pinned platform-tools archive did not produce $adb_file" >&2
        exit 1
    fi
    install -m 0755 "$ADB_INSTALL_ROOT/$adb_file" "$STAGE_ROOT/$adb_file"
done

install -m 0644 \
    "$DOWNLOAD_ROOT/$(source_field scrcpy-server filename)" \
    "$STAGE_ROOT/scrcpy-server"

PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
    "$TARGET_TRIPLET-gcc" \
    -O2 \
    -static-libgcc \
    -o "$STAGE_ROOT/ffmpeg-opencl-probe.exe" \
    "$OVERLAY_ROOT/ffmpeg-opencl-probe.c" \
    $(PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
        pkg-config --cflags --libs libavfilter libavutil)

PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
    "$TARGET_TRIPLET-gcc" \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Werror \
    -DQ3C_NATIVE_TESTS \
    -I"$SCRCPY_SOURCE_ROOT/app/src" \
    -I"$SCRCPY_BUILD_ROOT/app" \
    -static-libgcc \
    -o "$STAGE_ROOT/q3c-native-tests.exe" \
    "$OVERLAY_ROOT/q3c-native-tests.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/profile.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/native_event.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/render_ack.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/render_path.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/stabilization_filter.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/stabilization_sink.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/frame_buffer.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/trait/frame_source.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/util/sdl.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/util/thread.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/util/tick.c" \
    $(PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
        pkg-config --cflags --libs libavfilter libavcodec libavutil sdl3)

PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
    "$TARGET_TRIPLET-gcc" \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Werror \
    -static-libgcc \
    -I"$SCRCPY_SOURCE_ROOT/app/src" \
    -o "$STAGE_ROOT/q3c-stabilization-probe.exe" \
    "$OVERLAY_ROOT/q3c-stabilization-probe.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/stabilization_filter.c" \
    "$SCRCPY_SOURCE_ROOT/app/src/q3c/native_event.c" \
    $(PKG_CONFIG_LIBDIR="$DEPS_INSTALL_ROOT/lib/pkgconfig" \
        pkg-config --cflags --libs libavfilter libavutil) \
    -lpsapi \
    -lm

# Verification executes these exact production-C paths on Windows:
# q3c-stabilization-probe.exe --synthetic
# q3c-stabilization-probe.exe --forced-failure

install -m 0644 \
    "$REPOSITORY_ROOT/native/licenses/Apache-2.0.txt" \
    "$STAGE_ROOT/LICENSES/Apache-2.0.txt"
install -m 0644 \
    "$REPOSITORY_ROOT/native/licenses/LGPL-2.1.txt" \
    "$STAGE_ROOT/LICENSES/LGPL-2.1.txt"
install -m 0644 \
    "$ZLIB_SOURCE_ROOT/LICENSE" \
    "$STAGE_ROOT/LICENSES/Zlib.txt"
SDL_VERSION="$(source_field sdl version)"
DAV1D_VERSION="$(source_field dav1d version)"
install -m 0644 \
    "$UPSTREAM_SOURCE_ROOT/sdl-$SDL_VERSION/LICENSE.txt" \
    "$STAGE_ROOT/LICENSES/SDL-Zlib.txt"
install -m 0644 \
    "$UPSTREAM_SOURCE_ROOT/dav1d-$DAV1D_VERSION/COPYING" \
    "$STAGE_ROOT/LICENSES/dav1d-BSD-2-Clause.txt"
PLATFORM_TOOLS_ARCHIVE="$DOWNLOAD_ROOT/$(source_field platform-tools filename)"
unzip -p \
    "$PLATFORM_TOOLS_ARCHIVE" \
    platform-tools/NOTICE.txt \
    > "$STAGE_ROOT/LICENSES/Android-Platform-Tools-NOTICE.txt"
install -m 0644 \
    "$REPOSITORY_ROOT/native/THIRD_PARTY_NOTICES.md" \
    "$STAGE_ROOT/THIRD_PARTY_NOTICES.md"
install -m 0644 \
    "$REPOSITORY_ROOT/native/SOURCE_OFFER.md" \
    "$STAGE_ROOT/SOURCE_OFFER.md"

echo "Staged native runtime at $STAGE_ROOT"
find "$STAGE_ROOT" -type f -printf '%P\n' | sort
