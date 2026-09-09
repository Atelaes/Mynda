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

[[ "$PLATFORM" == "Linux" ]] || fail "Linux media preparation must run on Linux."
[[ "$MACHINE_ARCH" == "x86_64" ]] || fail "The Linux media bundle currently targets x64, not $MACHINE_ARCH."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  fail "Cannot identify the Linux distribution because /etc/os-release is missing."
fi
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  if [[ "${MYNDA_ALLOW_UNSUPPORTED_LINUX_BUILD:-0}" != "1" ]]; then
    fail "Build linux-x64 on Ubuntu 24.04 so its glibc baseline is reproducible. Set MYNDA_ALLOW_UNSUPPORTED_LINUX_BUILD=1 only for an experimental local build."
  fi
  printf 'WARNING: building an experimental Linux bundle on %s %s.\n' "${ID:-unknown}" "${VERSION_ID:-unknown}" >&2
fi

required_packages=(
  build-essential ca-certificates curl libasound2-dev libass-dev
  libavcodec-dev libavdevice-dev libavfilter-dev libavformat-dev libavutil-dev
  libegl1-mesa-dev libluajit-5.1-dev libplacebo-dev libpulse-dev
  libswresample-dev libswscale-dev libvulkan-dev libwayland-dev
  libx11-dev libxext-dev libxkbcommon-dev libxpresent-dev libxrandr-dev libxss-dev
  meson nasm ninja-build patchelf pkg-config python3 wayland-protocols xz-utils zlib1g-dev
)
missing_packages=()
for package_name in "${required_packages[@]}"; do
  dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q 'install ok installed' || \
    missing_packages+=("$package_name")
done
if (( ${#missing_packages[@]} > 0 )); then
  printf 'The one-time Ubuntu 24.04 build prerequisites are missing:\n  %s\n' "${missing_packages[*]}" >&2
  printf 'Install them with:\n\n  sudo apt update\n  sudo apt install %s\n\n' "${missing_packages[*]}" >&2
  exit 1
fi

for command_name in curl dpkg-query gcc ldd make meson nasm ninja node patch patchelf pkg-config python3 readelf sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is missing: $command_name"
done

CACHE_PARENT="${MYNDA_MEDIA_BUILD_CACHE:-${TMPDIR:-/tmp}/mynda-media-tools-cache-linux-x64}"
mkdir -p "$CACHE_PARENT/downloads"
WORK_ROOT="$(mktemp -d "$CACHE_PARENT/work.XXXXXX")"
DOWNLOAD_ROOT="$CACHE_PARENT/downloads"
STAGE_PARENT="$PROJECT_ROOT/vendor/media-tools"
FINAL_STAGE="$STAGE_PARENT/linux-x64"
CANDIDATE_STAGE="$STAGE_PARENT/.linux-x64.candidate"
NEW_STAGE="$STAGE_PARENT/.linux-x64.new.$$"
PACKAGE_INVENTORY="$WORK_ROOT/linux-packages.txt"
printf '%s\n' zlib1g > "$PACKAGE_INVENTORY"

cleanup() {
  rm -rf "$WORK_ROOT" "$NEW_STAGE"
}
trap cleanup EXIT

promote_candidate() {
  local old_stage="$STAGE_PARENT/.linux-x64.old.$$"
  if [[ -d "$FINAL_STAGE" ]]; then mv "$FINAL_STAGE" "$old_stage"; fi
  mv "$CANDIDATE_STAGE" "$FINAL_STAGE"
  rm -rf "$old_stage"
}

mkdir -p "$STAGE_PARENT"
if [[ -d "$CANDIDATE_STAGE" ]]; then
  printf 'Checking the completed Linux media build preserved from the previous attempt...\n'
  if node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
    --stage "$CANDIDATE_STAGE" --platform linux --arch x64 \
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

JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')"
FFMPEG_SOURCE="$WORK_ROOT/ffmpeg-$FFMPEG_VERSION"
FFMPEG_PREFIX="$WORK_ROOT/ffmpeg-install"
printf '\nBuilding LGPL-only Linux FFmpeg and FFprobe %s...\n' "$FFMPEG_VERSION"
(
  cd "$FFMPEG_SOURCE"
  ./configure \
    --prefix="$FFMPEG_PREFIX" \
    --disable-gpl --disable-nonfree --disable-version3 \
    --disable-doc --disable-debug --disable-ffplay --disable-autodetect \
    --enable-static --disable-shared --enable-zlib
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

printf '\nBuilding Linux libdvdread %s without libdvdcss...\n' "$DVDREAD_VERSION"
(
  cd "$DVDREAD_SOURCE"
  patch -p1 < "$DVDREAD_PATCH"
)
meson setup "$DVDREAD_BUILD" "$DVDREAD_SOURCE" \
  --prefix="$DVD_PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Dc_args=-DMYNDA_DISABLE_LIBDVDCSS -Dlibdvdcss=disabled -Denable_docs=false
meson compile -C "$DVDREAD_BUILD"
meson install -C "$DVDREAD_BUILD"

printf '\nBuilding Linux libdvdnav %s...\n' "$DVDNAV_VERSION"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson setup "$DVDNAV_BUILD" "$DVDNAV_SOURCE" \
  --prefix="$DVD_PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Denable_docs=false -Denable_examples=false
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson compile -C "$DVDNAV_BUILD"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig" meson install -C "$DVDNAV_BUILD"

MPV_SOURCE="$WORK_ROOT/mpv-$MPV_VERSION"
MPV_BUILD="$WORK_ROOT/mpv-build"
MPV_PREFIX="$WORK_ROOT/mpv-install"
printf '\nBuilding Linux MPV %s with X11, Wayland, and unencrypted-DVD support...\n' "$MPV_VERSION"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}" meson setup "$MPV_BUILD" "$MPV_SOURCE" \
  --prefix="$MPV_PREFIX" --buildtype=release --auto-features=disabled \
  -Dbuild-date=false -Dgpl=true -Dcplayer=true -Dlibmpv=false -Dtests=false \
  -Ddvdnav=enabled -Dalsa=enabled -Dpulse=enabled \
  -Dwayland=enabled -Dx11=enabled -Degl=enabled \
  -Degl-wayland=enabled -Degl-x11=enabled -Dgl=enabled -Dvulkan=enabled \
  -Diconv=enabled -Dzlib=enabled -Dlua=luajit \
  -Dhtml-build=disabled -Dmanpage-build=disabled -Dpdf-build=disabled
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}" meson compile -C "$MPV_BUILD"
PKG_CONFIG_PATH="$DVD_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}" meson install -C "$MPV_BUILD"

mkdir -p "$NEW_STAGE/lib" "$NEW_STAGE/licenses/linux-packages"
install -m 755 "$FFMPEG_PREFIX/bin/ffmpeg" "$NEW_STAGE/ffmpeg"
install -m 755 "$FFMPEG_PREFIX/bin/ffprobe" "$NEW_STAGE/ffprobe"
install -m 755 "$MPV_PREFIX/bin/mpv" "$NEW_STAGE/mpv"
while IFS= read -r library; do
  cp -L "$library" "$NEW_STAGE/lib/$(basename "$library")"
  chmod 755 "$NEW_STAGE/lib/$(basename "$library")"
done < <(find "$DVD_PREFIX/lib" -maxdepth 1 \( -type f -o -type l \) -name '*.so*')

is_core_linux_library() {
  case "$1" in
    ld-linux-x86-64.so.2|libc.so.6|libdl.so.2|libm.so.6|libpthread.so.0|librt.so.1|linux-vdso.so.1) return 0 ;;
    *) return 1 ;;
  esac
}

record_package_for_path() {
  local source_path="$1"
  local canonical_path=""
  local owner=""
  canonical_path="$(readlink -f "$source_path" 2>/dev/null || printf '%s' "$source_path")"
  owner="$(dpkg-query -S "$canonical_path" 2>/dev/null | head -n 1 | sed 's/: .*//' || true)"
  if [[ -z "$owner" ]]; then
    owner="$(dpkg-query -S "$source_path" 2>/dev/null | head -n 1 | sed 's/: .*//' || true)"
  fi
  [[ -n "$owner" ]] && printf '%s\n' "$owner" >> "$PACKAGE_INVENTORY"
}

# Copy the complete non-glibc shared-library closure. Host GPU drivers remain
# host-provided, as they must, while all ordinary desktop and codec libraries
# are private to Mynda's media sidecars.
changed=1
while (( changed )); do
  changed=0
  while IFS= read -r binary; do
    while IFS='|' read -r dependency source_path; do
      [[ -n "$dependency" ]] || continue
      [[ "$source_path" == "not found" ]] && fail "$binary cannot resolve $dependency"
      is_core_linux_library "$dependency" && continue
      [[ -f "$NEW_STAGE/lib/$dependency" ]] && continue
      [[ -f "$source_path" ]] || fail "$binary reported an invalid dependency path for $dependency: $source_path"
      cp -L "$source_path" "$NEW_STAGE/lib/$dependency"
      chmod 755 "$NEW_STAGE/lib/$dependency"
      record_package_for_path "$source_path"
      changed=1
    done < <(LD_LIBRARY_PATH="$NEW_STAGE/lib" ldd "$binary" | awk '
      /=>/ {print $1 "|" $3; next}
      $1 ~ /^\// {name=$1; sub(/^.*\//, "", name); print name "|" $1}
    ')
  done < <(find "$NEW_STAGE" -maxdepth 1 -type f -perm /111; find "$NEW_STAGE/lib" -maxdepth 1 -type f)
done

for binary in "$NEW_STAGE/ffmpeg" "$NEW_STAGE/ffprobe" "$NEW_STAGE/mpv"; do
  patchelf --set-rpath '$ORIGIN/lib:$ORIGIN' "$binary"
done
while IFS= read -r library; do
  patchelf --set-rpath '$ORIGIN' "$library"
done < <(find "$NEW_STAGE/lib" -maxdepth 1 -type f -name '*.so*')

install -m 644 "$PROJECT_ROOT/vendor/media-tools/THIRD_PARTY_NOTICES.md" "$NEW_STAGE/THIRD_PARTY_NOTICES.md"
install -m 644 "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$NEW_STAGE/licenses/FFmpeg-COPYING.LGPLv2.1"
install -m 644 "$FFMPEG_SOURCE/LICENSE.md" "$NEW_STAGE/licenses/FFmpeg-LICENSE.md"
install -m 644 "$MPV_SOURCE/LICENSE.GPL" "$NEW_STAGE/licenses/MPV-LICENSE.GPL"
install -m 644 "$MPV_SOURCE/Copyright" "$NEW_STAGE/licenses/MPV-Copyright"
install -m 644 "$DVDREAD_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdread-COPYING"
install -m 644 "$DVDNAV_SOURCE/COPYING" "$NEW_STAGE/licenses/libdvdnav-COPYING"
install -m 644 "$DVDREAD_PATCH" "$NEW_STAGE/licenses/libdvdread-no-libdvdcss.patch"

if [[ -s "$PACKAGE_INVENTORY" ]]; then
  sort -u "$PACKAGE_INVENTORY" -o "$PACKAGE_INVENTORY"
  while IFS= read -r package_name; do
    dpkg-query -W -f='${Package}\t${Version}\n' "$package_name" >> "$NEW_STAGE/licenses/linux-packages/packages.txt"
    copyright_file="$(dpkg-query -L "$package_name" | awk '/\/copyright$/ {print; exit}')"
    if [[ -f "$copyright_file" ]]; then
      safe_name="${package_name//:/-}"
      install -m 644 "$copyright_file" "$NEW_STAGE/licenses/linux-packages/$safe_name-copyright"
    fi
  done < "$PACKAGE_INVENTORY"
fi

mv "$NEW_STAGE" "$CANDIDATE_STAGE"
node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
  --stage "$CANDIDATE_STAGE" --platform linux --arch x64 \
  --write-info "$CANDIDATE_STAGE/build-info.json"
promote_candidate

printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
printf 'Run: npm run media:status && npm run test:media && npm run test:package\n'
