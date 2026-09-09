#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
MACHINE_ARCH="$(uname -m)"

FFMPEG_VERSION="6.1.6"
FFMPEG_SHA256="d4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a"
MPV_VERSION="0.41.0"
MPV_SHA256="ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209"
DVDREAD_VERSION="7.1.1"
DVDREAD_SHA256="01a690d1b442dfbbf66e5bbe58604ddc42d5aba4334b7c9680d9d4dbd116c74d"
DVDNAV_VERSION="7.0.0"
DVDNAV_SHA256="15d28086937647a95c3d6b083f0a86678cd4dd428914e319c64adf52cadec786"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${MSYSTEM:-}" == "UCRT64" ]] || fail "Windows media preparation must run in an MSYS2 UCRT64 environment. Use npm run media:prepare from PowerShell."
[[ "$MACHINE_ARCH" == "x86_64" ]] || fail "The Windows media bundle currently targets x64, not $MACHINE_ARCH."

required_packages=(
  mingw-w64-ucrt-x86_64-gcc
  mingw-w64-ucrt-x86_64-meson
  mingw-w64-ucrt-x86_64-nasm
  mingw-w64-ucrt-x86_64-ninja
  mingw-w64-ucrt-x86_64-pkgconf
  mingw-w64-ucrt-x86_64-zlib
  mingw-w64-ucrt-x86_64-ffmpeg
  mingw-w64-ucrt-x86_64-libass
  mingw-w64-ucrt-x86_64-libiconv
  mingw-w64-ucrt-x86_64-libplacebo
  mingw-w64-ucrt-x86_64-lua51
  mingw-w64-ucrt-x86_64-shaderc
  mingw-w64-ucrt-x86_64-spirv-cross
)
missing_packages=()
for package_name in "${required_packages[@]}"; do
  pacman -Q "$package_name" >/dev/null 2>&1 || missing_packages+=("$package_name")
done
if (( ${#missing_packages[@]} > 0 )); then
  printf 'The one-time MSYS2 UCRT64 build prerequisites are missing:\n  %s\n' "${missing_packages[*]}" >&2
  printf 'Open the MSYS2 UCRT64 terminal and run:\n\n  pacman -Syu\n  pacman -S --needed base-devel %s\n\n' "${missing_packages[*]}" >&2
  exit 1
fi

for command_name in curl make meson nasm ninja node objdump patch pkgconf sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is missing: $command_name"
done

export PATH="/ucrt64/bin:/usr/bin:${PATH:-}"
export PKG_CONFIG="/ucrt64/bin/pkgconf.exe"

# Stay in MSYS2's POSIX namespace by default. A raw Windows TEMP value can
# contain backslashes and a drive colon, which POSIX build tools do not all
# interpret consistently. Developers can still supply an explicit cache path.
CACHE_PARENT="${MYNDA_MEDIA_BUILD_CACHE:-${TMPDIR:-/tmp}/mynda-media-tools-cache-win-x64}"
mkdir -p "$CACHE_PARENT/downloads"
WORK_ROOT="$(mktemp -d "$CACHE_PARENT/work.XXXXXX")"
DOWNLOAD_ROOT="$CACHE_PARENT/downloads"
STAGE_PARENT="$PROJECT_ROOT/vendor/media-tools"
FINAL_STAGE="$STAGE_PARENT/win-x64"
CANDIDATE_STAGE="$STAGE_PARENT/.win-x64.candidate"
NEW_STAGE="$STAGE_PARENT/.win-x64.new.$$"
PACKAGE_INVENTORY="$WORK_ROOT/msys2-packages.txt"
printf '%s\n' \
  mingw-w64-ucrt-x86_64-zlib \
  mingw-w64-ucrt-x86_64-ffmpeg \
  mingw-w64-ucrt-x86_64-libass \
  mingw-w64-ucrt-x86_64-libiconv \
  mingw-w64-ucrt-x86_64-libplacebo \
  mingw-w64-ucrt-x86_64-lua51 \
  mingw-w64-ucrt-x86_64-shaderc \
  mingw-w64-ucrt-x86_64-spirv-cross > "$PACKAGE_INVENTORY"

cleanup() {
  rm -rf "$WORK_ROOT" "$NEW_STAGE"
}
trap cleanup EXIT

promote_candidate() {
  local old_stage="$STAGE_PARENT/.win-x64.old.$$"
  if [[ -d "$FINAL_STAGE" ]]; then mv "$FINAL_STAGE" "$old_stage"; fi
  mv "$CANDIDATE_STAGE" "$FINAL_STAGE"
  rm -rf "$old_stage"
}

mkdir -p "$STAGE_PARENT"
if [[ -d "$CANDIDATE_STAGE" ]]; then
  printf 'Checking the completed Windows media build preserved from the previous attempt...\n'
  if node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
    --stage "$CANDIDATE_STAGE" --platform win32 --arch x64 \
    --write-info "$CANDIDATE_STAGE/build-info.json"; then
    promote_candidate
    printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
    printf 'The preserved build passed; no recompilation was needed.\n'
    exit 0
  fi
  printf 'The preserved build is not valid under the current policy; rebuilding it.\n' >&2
  rm -rf "$CANDIDATE_STAGE"
fi

download() {
  local url="$1"
  local destination="$2"
  local expected="$3"
  local actual=""
  if [[ -f "$destination" ]]; then actual="$(sha256sum "$destination" | awk '{print $1}')"; fi
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$destination"
    printf 'Downloading %s\n' "$url"
    curl -fL --retry 3 --progress-bar -o "$destination" "$url"
    actual="$(sha256sum "$destination" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]] || fail "Checksum mismatch for $destination"
}

FFMPEG_ARCHIVE="$DOWNLOAD_ROOT/ffmpeg-$FFMPEG_VERSION.tar.xz"
MPV_ARCHIVE="$DOWNLOAD_ROOT/mpv-$MPV_VERSION.tar.gz"
DVDREAD_ARCHIVE="$DOWNLOAD_ROOT/libdvdread-$DVDREAD_VERSION.tar.gz"
DVDNAV_ARCHIVE="$DOWNLOAD_ROOT/libdvdnav-$DVDNAV_VERSION.tar.gz"
download "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_ARCHIVE" "$FFMPEG_SHA256"
download "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" "$MPV_ARCHIVE" "$MPV_SHA256"
download "https://code.videolan.org/videolan/libdvdread/-/archive/$DVDREAD_VERSION/libdvdread-$DVDREAD_VERSION.tar.gz" "$DVDREAD_ARCHIVE" "$DVDREAD_SHA256"
download "https://code.videolan.org/videolan/libdvdnav/-/archive/$DVDNAV_VERSION/libdvdnav-$DVDNAV_VERSION.tar.gz" "$DVDNAV_ARCHIVE" "$DVDNAV_SHA256"

tar -xJf "$FFMPEG_ARCHIVE" -C "$WORK_ROOT"
tar -xzf "$MPV_ARCHIVE" -C "$WORK_ROOT"
tar -xzf "$DVDREAD_ARCHIVE" -C "$WORK_ROOT"
tar -xzf "$DVDNAV_ARCHIVE" -C "$WORK_ROOT"

JOBS="${NUMBER_OF_PROCESSORS:-4}"
FFMPEG_SOURCE="$WORK_ROOT/ffmpeg-$FFMPEG_VERSION"
FFMPEG_PREFIX="$WORK_ROOT/ffmpeg-install"
printf '\nBuilding LGPL-only Windows FFmpeg and FFprobe %s...\n' "$FFMPEG_VERSION"
(
  cd "$FFMPEG_SOURCE"
  ./configure \
    --prefix="$FFMPEG_PREFIX" \
    --target-os=mingw32 \
    --arch=x86_64 \
    --disable-gpl \
    --disable-nonfree \
    --disable-version3 \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-autodetect \
    --enable-static \
    --disable-shared \
    --enable-zlib
  make -j"$JOBS"
  make install
)

DVD_PREFIX="$WORK_ROOT/dvd-install"
DVDREAD_SOURCE="$WORK_ROOT/libdvdread-$DVDREAD_VERSION"
DVDREAD_BUILD="$WORK_ROOT/libdvdread-build"
DVDNAV_SOURCE="$WORK_ROOT/libdvdnav-$DVDNAV_VERSION"
DVDNAV_BUILD="$WORK_ROOT/libdvdnav-build"
DVDREAD_PATCH="$PROJECT_ROOT/vendor/media-tools/patches/libdvdread-no-libdvdcss.patch"
[[ -f "$DVDREAD_PATCH" ]] || fail "Required libdvdread patch is missing: $DVDREAD_PATCH"

printf '\nBuilding Windows libdvdread %s without libdvdcss...\n' "$DVDREAD_VERSION"
(
  cd "$DVDREAD_SOURCE"
  patch -p1 < "$DVDREAD_PATCH"
)
meson setup "$DVDREAD_BUILD" "$DVDREAD_SOURCE" \
  --prefix="$DVD_PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Dc_args=-DMYNDA_DISABLE_LIBDVDCSS -Dlibdvdcss=disabled -Denable_docs=false
meson compile -C "$DVDREAD_BUILD"
meson install -C "$DVDREAD_BUILD"

printf '\nBuilding Windows libdvdnav %s...\n' "$DVDNAV_VERSION"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson setup "$DVDNAV_BUILD" "$DVDNAV_SOURCE" \
  --prefix="$DVD_PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Denable_docs=false -Denable_examples=false
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson compile -C "$DVDNAV_BUILD"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson install -C "$DVDNAV_BUILD"

MPV_SOURCE="$WORK_ROOT/mpv-$MPV_VERSION"
MPV_BUILD="$WORK_ROOT/mpv-build"
MPV_PREFIX="$WORK_ROOT/mpv-install"
printf '\nBuilding Windows MPV %s with Direct3D 11 and unencrypted-DVD support...\n' "$MPV_VERSION"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig" meson setup "$MPV_BUILD" "$MPV_SOURCE" \
    --prefix="$MPV_PREFIX" --buildtype=release --auto-features=disabled \
    -Dbuild-date=false -Dgpl=true -Dcplayer=true -Dlibmpv=false -Dtests=false \
    -Ddvdnav=enabled -Dwasapi=enabled -Dwin32-threads=enabled \
    -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
    -Dgl=disabled -Dvulkan=disabled -Diconv=enabled -Dzlib=enabled -Dlua=lua51 \
    -Dhtml-build=disabled -Dmanpage-build=disabled -Dpdf-build=disabled
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig" meson compile -C "$MPV_BUILD"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig" meson install -C "$MPV_BUILD"

mkdir -p "$NEW_STAGE/licenses" "$NEW_STAGE/licenses/msys2"
install -m 755 "$FFMPEG_PREFIX/bin/ffmpeg.exe" "$NEW_STAGE/ffmpeg.exe"
install -m 755 "$FFMPEG_PREFIX/bin/ffprobe.exe" "$NEW_STAGE/ffprobe.exe"
install -m 755 "$MPV_PREFIX/bin/mpv.exe" "$NEW_STAGE/mpv.exe"
find "$DVD_PREFIX/bin" -maxdepth 1 -type f -iname '*.dll' -exec install -m 755 {} "$NEW_STAGE/" \;

find_dll() {
  local wanted="${1,,}"
  find "$NEW_STAGE" /ucrt64/bin -maxdepth 1 -type f -iname "$wanted" -print -quit
}

# Recursively copy every non-Windows DLL imported by the three executables and
# their private DLLs. The independent verifier performs the authoritative
# allow-list check after this collector finishes.
changed=1
while (( changed )); do
  changed=0
  while IFS= read -r binary; do
    while IFS= read -r dependency; do
      dependency="${dependency//$'\r'/}"
      [[ -n "$dependency" ]] || continue
      [[ "$dependency" =~ ^(api-ms-win-|ext-ms-win-) ]] && continue
      if find "$NEW_STAGE" -maxdepth 1 -type f -iname "$dependency" -print -quit | grep -q .; then
        continue
      fi
      source_dll="$(find_dll "$dependency")"
      if [[ -n "$source_dll" && "$source_dll" == /ucrt64/bin/* ]]; then
        [[ "${dependency,,}" != *libdvdcss* ]] || fail "MPV unexpectedly imports prohibited $dependency"
        install -m 755 "$source_dll" "$NEW_STAGE/$(basename "$source_dll")"
        pacman -Qqo "$source_dll" >> "$PACKAGE_INVENTORY" 2>/dev/null || true
        changed=1
      fi
    done < <(objdump -p "$binary" | awk 'tolower($0) ~ /dll name:/ {print tolower($3)}')
  done < <(find "$NEW_STAGE" -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.dll' \))
done

install -m 644 "$PROJECT_ROOT/vendor/media-tools/THIRD_PARTY_NOTICES.md" "$NEW_STAGE/THIRD_PARTY_NOTICES.md"
install -m 644 "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$NEW_STAGE/licenses/FFmpeg-COPYING.LGPLv2.1"
install -m 644 "$FFMPEG_SOURCE/LICENSE.md" "$NEW_STAGE/licenses/FFmpeg-LICENSE.md"
install -m 644 "$MPV_SOURCE/LICENSE.GPL" "$NEW_STAGE/licenses/MPV-LICENSE.GPL"
install -m 644 "$MPV_SOURCE/Copyright" "$NEW_STAGE/licenses/MPV-Copyright"
install -m 644 "$DVDREAD_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdread-COPYING"
install -m 644 "$DVDNAV_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdnav-COPYING"
install -m 644 "$DVDREAD_PATCH" "$NEW_STAGE/licenses/libdvdread-no-libdvdcss.patch"
find "$NEW_STAGE" -maxdepth 1 -type f -iname '*.dll' -printf '%f\n' | sort > "$NEW_STAGE/licenses/msys2/bundled-dlls.txt"

if [[ -s "$PACKAGE_INVENTORY" ]]; then
  sort -u "$PACKAGE_INVENTORY" -o "$PACKAGE_INVENTORY"
  while IFS= read -r package_name; do
    pacman -Q "$package_name" >> "$NEW_STAGE/licenses/msys2/packages.txt"
    short_name="${package_name#mingw-w64-ucrt-x86_64-}"
    license_source="/ucrt64/share/licenses/$short_name"
    if [[ -d "$license_source" ]]; then
      mkdir -p "$NEW_STAGE/licenses/msys2/$short_name"
      cp -R "$license_source/." "$NEW_STAGE/licenses/msys2/$short_name/"
    fi
  done < "$PACKAGE_INVENTORY"
fi

rm -rf "$CANDIDATE_STAGE"
mv "$NEW_STAGE" "$CANDIDATE_STAGE"
node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
  --stage "$CANDIDATE_STAGE" --platform win32 --arch x64 \
  --write-info "$CANDIDATE_STAGE/build-info.json"
promote_candidate

printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
printf 'Run: npm run media:status && npm run test:media && npm run test:package\n'
