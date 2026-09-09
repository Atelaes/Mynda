#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLATFORM="$(uname -s)"
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

if [[ "$PLATFORM" != "Darwin" ]]; then
  fail "media:prepare must be run on macOS."
fi
if [[ "$MACHINE_ARCH" != "arm64" ]]; then
  fail "The macOS media bundle targets Apple Silicon (arm64). Intel/Mojave needs a separately pinned legacy build."
fi

for command_name in brew curl ditto make node patch shasum tar xcode-select xcrun; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is missing: $command_name"
done
xcode-select -p >/dev/null 2>&1 || fail "Install Apple's command-line developer tools first: xcode-select --install"
xcrun --find swiftc >/dev/null 2>&1 || fail "A Swift compiler is required. Install or select Xcode, then retry."

missing_formulae=()
for formula in meson ninja pkgconf ffmpeg libass libplacebo luajit; do
  if ! brew list --versions "$formula" >/dev/null 2>&1; then
    missing_formulae+=("$formula")
  fi
done
if (( ${#missing_formulae[@]} > 0 )); then
  printf 'The one-time MPV build prerequisites are missing: %s\n' "${missing_formulae[*]}" >&2
  printf 'Install them with:\n\n  brew install %s\n\n' "${missing_formulae[*]}" >&2
  exit 1
fi

export HOMEBREW_NO_AUTO_UPDATE=1
BREW_PREFIX="$(brew --prefix)"
MESON="$(brew --prefix meson)/bin/meson"
NINJA_PREFIX="$(brew --prefix ninja)"
PKGCONF_PREFIX="$(brew --prefix pkgconf)"
export PATH="$NINJA_PREFIX/bin:$PKGCONF_PREFIX/bin:$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MACOSX_DEPLOYMENT_TARGET="${MYNDA_MACOS_DEPLOYMENT_TARGET:-11.0}"

CACHE_PARENT="${MYNDA_MEDIA_BUILD_CACHE:-${TMPDIR:-/tmp}/mynda-media-tools-cache-arm64}"
mkdir -p "$CACHE_PARENT/downloads"
WORK_ROOT="$(mktemp -d "$CACHE_PARENT/work.XXXXXX")"
DOWNLOAD_ROOT="$CACHE_PARENT/downloads"
STAGE_PARENT="$PROJECT_ROOT/vendor/media-tools"
FINAL_STAGE="$STAGE_PARENT/mac-arm64"
CANDIDATE_STAGE="$STAGE_PARENT/.mac-arm64.candidate"
NEW_STAGE="$STAGE_PARENT/.mac-arm64.new.$$"

cleanup() {
  rm -rf "$WORK_ROOT" "$NEW_STAGE"
}
trap cleanup EXIT

promote_candidate() {
  local old_stage="$STAGE_PARENT/.mac-arm64.old.$$"
  if [[ -d "$FINAL_STAGE" ]]; then mv "$FINAL_STAGE" "$old_stage"; fi
  mv "$CANDIDATE_STAGE" "$FINAL_STAGE"
  rm -rf "$old_stage"
}

mkdir -p "$STAGE_PARENT"
if [[ -d "$CANDIDATE_STAGE" ]]; then
  printf 'Checking the completed media build preserved from the previous attempt...\n'
  if node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
    --stage "$CANDIDATE_STAGE" \
    --platform darwin \
    --arch arm64 \
    --write-info "$CANDIDATE_STAGE/build-info.json"; then
    promote_candidate
    printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
    printf 'The preserved build passed; no recompilation was needed.\n'
    printf 'You can now run: npm run test:media && npm run test:package\n'
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
  if [[ -f "$destination" ]]; then
    actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
  fi
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$destination"
    printf 'Downloading %s\n' "$url"
    curl -fL --retry 3 --progress-bar -o "$destination" "$url"
    actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
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

JOBS="$(sysctl -n hw.logicalcpu 2>/dev/null || printf '4')"
FFMPEG_SOURCE="$WORK_ROOT/ffmpeg-$FFMPEG_VERSION"
FFMPEG_PREFIX="$WORK_ROOT/ffmpeg-install"

if [[ -d "$FINAL_STAGE" ]] && node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
  --stage "$FINAL_STAGE" \
  --platform darwin \
  --arch arm64 \
  --mode ffmpeg >/dev/null 2>&1; then
  printf '\nReusing the already verified LGPL-only FFmpeg and FFprobe %s sidecars...\n' "$FFMPEG_VERSION"
  mkdir -p "$FFMPEG_PREFIX/bin"
  install -m 755 "$FINAL_STAGE/ffmpeg" "$FFMPEG_PREFIX/bin/ffmpeg"
  install -m 755 "$FINAL_STAGE/ffprobe" "$FFMPEG_PREFIX/bin/ffprobe"
else
  printf '\nBuilding LGPL-only FFmpeg and FFprobe %s...\n' "$FFMPEG_VERSION"
  (
    cd "$FFMPEG_SOURCE"
    ./configure \
      --prefix="$FFMPEG_PREFIX" \
      --disable-gpl \
      --disable-nonfree \
      --disable-version3 \
      --disable-doc \
      --disable-debug \
      --disable-ffplay \
      --disable-autodetect \
      --enable-static \
      --disable-shared \
      --enable-audiotoolbox \
      --enable-avfoundation \
      --enable-videotoolbox \
      --enable-zlib
    make -j"$JOBS"
    make install
  )
fi

DVD_PREFIX="$WORK_ROOT/dvd-install"
DVDREAD_SOURCE="$WORK_ROOT/libdvdread-$DVDREAD_VERSION"
DVDREAD_BUILD="$WORK_ROOT/libdvdread-build"
DVDNAV_SOURCE="$WORK_ROOT/libdvdnav-$DVDNAV_VERSION"
DVDNAV_BUILD="$WORK_ROOT/libdvdnav-build"
DVDREAD_PATCH="$PROJECT_ROOT/vendor/media-tools/patches/libdvdread-no-libdvdcss.patch"

printf '\nBuilding libdvdread %s without libdvdcss...\n' "$DVDREAD_VERSION"
[[ -f "$DVDREAD_PATCH" ]] || fail "Required libdvdread patch is missing: $DVDREAD_PATCH"
(
  cd "$DVDREAD_SOURCE"
  patch -p1 < "$DVDREAD_PATCH"
)
"$MESON" setup "$DVDREAD_BUILD" "$DVDREAD_SOURCE" \
  --prefix="$DVD_PREFIX" \
  --libdir=lib \
  --buildtype=release \
  --default-library=shared \
  -Dc_args=-DMYNDA_DISABLE_LIBDVDCSS \
  -Dlibdvdcss=disabled \
  -Denable_docs=false
"$MESON" compile -C "$DVDREAD_BUILD"
"$MESON" install -C "$DVDREAD_BUILD"

printf '\nBuilding libdvdnav %s...\n' "$DVDNAV_VERSION"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" "$MESON" setup "$DVDNAV_BUILD" "$DVDNAV_SOURCE" \
  --prefix="$DVD_PREFIX" \
  --libdir=lib \
  --buildtype=release \
  --default-library=shared \
  -Denable_docs=false \
  -Denable_examples=false
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" "$MESON" compile -C "$DVDNAV_BUILD"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" "$MESON" install -C "$DVDNAV_BUILD"

MPV_SOURCE="$WORK_ROOT/mpv-$MPV_VERSION"
MPV_BUILD="$WORK_ROOT/mpv-build"
BREW_FFMPEG="$(brew --prefix ffmpeg)"
BREW_LIBASS="$(brew --prefix libass)"
BREW_LIBPLACEBO="$(brew --prefix libplacebo)"
BREW_LUAJIT="$(brew --prefix luajit)"
export PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:$BREW_FFMPEG/lib/pkgconfig:$BREW_LIBASS/lib/pkgconfig:$BREW_LIBPLACEBO/lib/pkgconfig:$BREW_LUAJIT/lib/pkgconfig:$BREW_PREFIX/lib/pkgconfig:$BREW_PREFIX/share/pkgconfig"

printf '\nBuilding self-contained MPV %s with unencrypted-DVD support...\n' "$MPV_VERSION"
"$MESON" setup "$MPV_BUILD" "$MPV_SOURCE" \
  --prefix="$WORK_ROOT/mpv-install" \
  --buildtype=release \
  --auto-features=disabled \
  -Dbuild-date=false \
  -Dgpl=true \
  -Dcplayer=true \
  -Dlibmpv=false \
  -Dtests=false \
  -Ddvdnav=enabled \
  -Dcocoa=enabled \
  -Dswift-build=enabled \
  -Dgl=enabled \
  -Dgl-cocoa=enabled \
  -Dvulkan=enabled \
  -Dcoreaudio=enabled \
  -Dvideotoolbox-gl=enabled \
  -Dvideotoolbox-pl=enabled \
  -Diconv=enabled \
  -Dzlib=enabled \
  -Dlua=luajit \
  -Dhtml-build=disabled \
  -Dmanpage-build=disabled \
  -Dpdf-build=disabled
"$MESON" compile -C "$MPV_BUILD"
"$MESON" compile -C "$MPV_BUILD" macos-bundle

MPV_BUNDLE="$MPV_BUILD/mpv.app"
[[ -x "$MPV_BUNDLE/Contents/MacOS/mpv" ]] || fail "MPV's macos-bundle target did not create $MPV_BUNDLE"

mkdir -p "$STAGE_PARENT" "$NEW_STAGE/licenses"
install -m 755 "$FFMPEG_PREFIX/bin/ffmpeg" "$NEW_STAGE/ffmpeg"
install -m 755 "$FFMPEG_PREFIX/bin/ffprobe" "$NEW_STAGE/ffprobe"
ditto "$MPV_BUNDLE" "$NEW_STAGE/mpv.app"
install -m 644 "$PROJECT_ROOT/vendor/media-tools/THIRD_PARTY_NOTICES.md" "$NEW_STAGE/THIRD_PARTY_NOTICES.md"
install -m 644 "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$NEW_STAGE/licenses/FFmpeg-COPYING.LGPLv2.1"
install -m 644 "$FFMPEG_SOURCE/LICENSE.md" "$NEW_STAGE/licenses/FFmpeg-LICENSE.md"
install -m 644 "$MPV_SOURCE/LICENSE.GPL" "$NEW_STAGE/licenses/MPV-LICENSE.GPL"
install -m 644 "$MPV_SOURCE/Copyright" "$NEW_STAGE/licenses/MPV-Copyright"
install -m 644 "$DVDREAD_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdread-COPYING"
install -m 644 "$DVDNAV_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdnav-COPYING"
install -m 644 "$DVDREAD_PATCH" "$NEW_STAGE/licenses/libdvdread-no-libdvdcss.patch"

# Preserve the fully assembled candidate before verification. If a verifier
# defect is corrected later, the next media:prepare run can recheck and promote
# these binaries without repeating the lengthy compilation.
mv "$NEW_STAGE" "$CANDIDATE_STAGE"

node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
  --stage "$CANDIDATE_STAGE" \
  --platform darwin \
  --arch arm64 \
  --write-info "$CANDIDATE_STAGE/build-info.json"

promote_candidate

printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
printf 'You can now run: npm run test:media && npm run test:package\n'
