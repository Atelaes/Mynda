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

# The pacman package is lua51, but it installs lua5.1.pc. MPV's -Dlua option
# selects that pkg-config module name, not the pacman package or DLL name.
# Check now so a metadata problem cannot waste a full FFmpeg/DVD build first.
LUA_PKGCONFIG_NAME="lua5.1"
if ! PKG_CONFIG_PATH="/ucrt64/lib/pkgconfig:/ucrt64/share/pkgconfig" \
    "$PKG_CONFIG" --atleast-version=5.1.0 "$LUA_PKGCONFIG_NAME"; then
  fail "MSYS2 cannot find $LUA_PKGCONFIG_NAME.pc (Lua >= 5.1). In UCRT64, run: pacman -S mingw-w64-ucrt-x86_64-lua51"
fi

# Keep native build outputs outside the project/sync folder. Existing verified
# downloads remain reusable, and incomplete compiler work survives a retry.
CACHE_PARENT="${MYNDA_MEDIA_BUILD_CACHE:-${TMPDIR:-/tmp}/mynda-media-tools-cache-win-x64}"
CACHE_PARENT="$(cygpath -u "$CACHE_PARENT")"
mkdir -p "$CACHE_PARENT/downloads"
CACHE_PARENT="$(cd "$CACHE_PARENT" && pwd -P)"
DOWNLOAD_ROOT="$CACHE_PARENT/downloads"
CACHE_HELPER="$PROJECT_ROOT/scripts/lib/MediaBuildCache.js"
STAGE_PARENT="$PROJECT_ROOT/vendor/media-tools"
FINAL_STAGE="$STAGE_PARENT/win-x64"
JOBS="${NUMBER_OF_PROCESSORS:-4}"
DVDREAD_PATCH="$PROJECT_ROOT/vendor/media-tools/patches/libdvdread-no-libdvdcss.patch"
NOTICES="$PROJECT_ROOT/vendor/media-tools/THIRD_PARTY_NOTICES.md"
[[ -f "$DVDREAD_PATCH" ]] || fail "Required libdvdread patch is missing: $DVDREAD_PATCH"

# Run the lock command directly: its parent is the long-lived build shell,
# rather than a command-substitution subshell that immediately exits.
LOCK_TOKEN=""
LOCK_TOKEN_FILE="$CACHE_PARENT/.lock-token.$$"
finish() {
  local result=$?
  trap - EXIT
  if [[ -n "$LOCK_TOKEN" ]]; then
    node "$CACHE_HELPER" unlock "$CACHE_PARENT" "$LOCK_TOKEN" || true
  fi
  rm -f "$LOCK_TOKEN_FILE"
  if (( result != 0 )); then
    printf '\nBuild progress was preserved at:\n  %s\nRerun npm run media:prepare to resume.\n' "$CACHE_PARENT" >&2
  fi
  exit "$result"
}
trap finish EXIT
node "$CACHE_HELPER" lock "$CACHE_PARENT" > "$LOCK_TOKEN_FILE"
LOCK_TOKEN="$(cat "$LOCK_TOKEN_FILE")"
rm -f "$LOCK_TOKEN_FILE"

hash_inputs() {
  printf '%s\0' "$@" | sha256sum | awk '{print $1}'
}
file_hash() {
  sha256sum "$1" | awk '{print $1}'
}
download() {
  local url="$1" destination="$2" expected="$3" actual=""
  if [[ -f "$destination" ]]; then actual="$(file_hash "$destination")"; fi
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$destination"
    printf 'Downloading %s\n' "$url"
    curl -fL --retry 3 --progress-bar -o "$destination" "$url"
    actual="$(file_hash "$destination")"
  fi
  [[ "$actual" == "$expected" ]] || fail "Checksum mismatch for $destination"
}
prepare_source() {
  local archive="$1" archive_directory="$2" source_patch="${3:-}"
  [[ -f "$COMPONENT_ROOT/source/.mynda-source-ready" ]] && return
  node "$CACHE_HELPER" remove "$COMPONENT_ROOT/source"
  node "$CACHE_HELPER" remove "$COMPONENT_ROOT/extract"
  mkdir -p "$COMPONENT_ROOT/extract"
  tar -xf "$archive" -C "$COMPONENT_ROOT/extract"
  if [[ -n "$source_patch" ]]; then
    (cd "$COMPONENT_ROOT/extract/$archive_directory" && patch -p1 < "$source_patch")
  fi
  touch "$COMPONENT_ROOT/extract/$archive_directory/.mynda-source-ready"
  node "$CACHE_HELPER" move "$COMPONENT_ROOT/extract/$archive_directory" "$COMPONENT_ROOT/source"
  node "$CACHE_HELPER" remove "$COMPONENT_ROOT/extract"
}
build_meson() {
  # A failed setup is safe to restart; a configured Ninja tree resumes objects.
  if [[ ! -f "$COMPONENT_ROOT/build/build.ninja" || ! -f "$COMPONENT_ROOT/build/meson-private/coredata.dat" ]]; then
    node "$CACHE_HELPER" remove "$COMPONENT_ROOT/build"
    meson setup "$COMPONENT_ROOT/build" "$COMPONENT_ROOT/source" --prefix="$COMPONENT_PREFIX" "$@"
  fi
  meson compile -C "$COMPONENT_ROOT/build"
  meson install -C "$COMPONENT_ROOT/build"
}
prepare_component() {
  local name="$1" key="$2" builder="$3"
  shift 3
  local COMPONENT_ROOT="$CACHE_PARENT/components/$name/$key"
  local COMPONENT_PREFIX="$COMPONENT_ROOT/install"
  local status
  status="$(node "$CACHE_HELPER" status "$COMPONENT_ROOT" "$key" component)"
  if [[ "$status" == ready ]]; then
    printf 'Reusing completed %s (checksums verified).\n' "$name"
    return
  fi
  if [[ "$status" == damaged ]]; then
    printf 'The cached %s output changed; rebuilding that component.\n' "$name"
    node "$CACHE_HELPER" remove "$COMPONENT_ROOT"
  fi
  mkdir -p "$COMPONENT_PREFIX/licenses"
  # Do not call this function from a conditional: Bash must stop on build errors.
  "$builder"
  node "$CACHE_HELPER" seal "$COMPONENT_ROOT" "$key" component "$@"
  printf 'Checkpoint saved: %s.\n' "$name"
}
build_ffmpeg() {
  local archive="$DOWNLOAD_ROOT/ffmpeg-$FFMPEG_VERSION.tar.xz"
  download "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$archive" "$FFMPEG_SHA256"
  prepare_source "$archive" "ffmpeg-$FFMPEG_VERSION"
  printf '\nBuilding/resuming LGPL-only Windows FFmpeg and FFprobe %s...\n' "$FFMPEG_VERSION"
  (
    cd "$COMPONENT_ROOT/source"
    if [[ ! -f ffbuild/config.mak ]]; then
      ./configure --prefix="$COMPONENT_PREFIX" --target-os=mingw32 --arch=x86_64 \
        --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-debug \
        --disable-ffplay --disable-autodetect --enable-static --disable-shared --enable-zlib
    fi
    make -j"$JOBS"
    make install
  )
  install -m 644 "$COMPONENT_ROOT/source/COPYING.LGPLv2.1" "$COMPONENT_PREFIX/licenses/FFmpeg-COPYING.LGPLv2.1"
  install -m 644 "$COMPONENT_ROOT/source/LICENSE.md" "$COMPONENT_PREFIX/licenses/FFmpeg-LICENSE.md"
}
build_dvdread() {
  local archive="$DOWNLOAD_ROOT/libdvdread-$DVDREAD_VERSION.tar.gz"
  download "https://code.videolan.org/videolan/libdvdread/-/archive/$DVDREAD_VERSION/libdvdread-$DVDREAD_VERSION.tar.gz" "$archive" "$DVDREAD_SHA256"
  prepare_source "$archive" "libdvdread-$DVDREAD_VERSION" "$DVDREAD_PATCH"
  printf '\nBuilding/resuming Windows libdvdread %s without libdvdcss...\n' "$DVDREAD_VERSION"
  build_meson --libdir=lib --buildtype=release --default-library=shared \
    -Dc_args=-DMYNDA_DISABLE_LIBDVDCSS -Dlibdvdcss=disabled -Denable_docs=false
  install -m 644 "$COMPONENT_ROOT/source/COPYING" "$COMPONENT_PREFIX/licenses/libdvdread-COPYING"
  install -m 644 "$DVDREAD_PATCH" "$COMPONENT_PREFIX/licenses/libdvdread-no-libdvdcss.patch"
}
build_dvdnav() {
  local archive="$DOWNLOAD_ROOT/libdvdnav-$DVDNAV_VERSION.tar.gz"
  download "https://code.videolan.org/videolan/libdvdnav/-/archive/$DVDNAV_VERSION/libdvdnav-$DVDNAV_VERSION.tar.gz" "$archive" "$DVDNAV_SHA256"
  prepare_source "$archive" "libdvdnav-$DVDNAV_VERSION"
  printf '\nBuilding/resuming Windows libdvdnav %s...\n' "$DVDNAV_VERSION"
  PKG_CONFIG_PATH="$DVDREAD_PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig" \
    build_meson --libdir=lib --buildtype=release --default-library=shared \
      -Denable_docs=false -Denable_examples=false
  install -m 644 "$COMPONENT_ROOT/source/COPYING" "$COMPONENT_PREFIX/licenses/libdvdnav-COPYING"
}
build_mpv() {
  local archive="$DOWNLOAD_ROOT/mpv-$MPV_VERSION.tar.gz"
  download "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" "$archive" "$MPV_SHA256"
  prepare_source "$archive" "mpv-$MPV_VERSION"
  printf '\nBuilding/resuming Windows MPV %s with Direct3D 11 and unencrypted-DVD support...\n' "$MPV_VERSION"
  PKG_CONFIG_PATH="$DVDNAV_PREFIX/lib/pkgconfig:$DVDREAD_PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig" \
    build_meson --buildtype=release --auto-features=disabled \
      -Dbuild-date=false -Dgpl=true -Dcplayer=true -Dlibmpv=false -Dtests=false \
      -Ddvdnav=enabled -Dwasapi=enabled -Dwin32-threads=enabled \
      -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
      -Dgl=disabled -Dvulkan=disabled -Diconv=enabled -Dzlib=enabled -Dlua="$LUA_PKGCONFIG_NAME" \
      -Dhtml-build=disabled -Dmanpage-build=disabled -Dpdf-build=disabled
  install -m 644 "$COMPONENT_ROOT/source/LICENSE.GPL" "$COMPONENT_PREFIX/licenses/MPV-LICENSE.GPL"
  install -m 644 "$COMPONENT_ROOT/source/Copyright" "$COMPONENT_PREFIX/licenses/MPV-Copyright"
}
assemble_bundle() {
  local stage="$BUNDLE_ROOT/bundle" inventory="$BUNDLE_ROOT/msys2-packages.txt"
  local binary dependency source_dll package_name short_name license_source prefix changed
  node "$CACHE_HELPER" remove "$stage"
  mkdir -p "$stage/licenses/msys2"
  printf '%s\n' \
    mingw-w64-ucrt-x86_64-zlib mingw-w64-ucrt-x86_64-ffmpeg \
    mingw-w64-ucrt-x86_64-libass mingw-w64-ucrt-x86_64-libiconv \
    mingw-w64-ucrt-x86_64-libplacebo mingw-w64-ucrt-x86_64-lua51 \
    mingw-w64-ucrt-x86_64-shaderc mingw-w64-ucrt-x86_64-spirv-cross > "$inventory"
  install -m 755 "$FFMPEG_PREFIX/bin/ffmpeg.exe" "$stage/ffmpeg.exe"
  install -m 755 "$FFMPEG_PREFIX/bin/ffprobe.exe" "$stage/ffprobe.exe"
  install -m 755 "$MPV_PREFIX/bin/mpv.exe" "$stage/mpv.exe"
  for prefix in "$DVDREAD_PREFIX" "$DVDNAV_PREFIX"; do
    find "$prefix/bin" -maxdepth 1 -type f -iname '*.dll' -exec install -m 755 {} "$stage/" \;
  done
  # Recursively copy private DLLs; the independent verifier checks the resulting
  # dependency closure against its Windows system-library allow-list.
  changed=1
  while (( changed )); do
    changed=0
    while IFS= read -r binary; do
      while IFS= read -r dependency; do
        dependency="${dependency//$'\r'/}"
        [[ -n "$dependency" ]] || continue
        [[ "$dependency" =~ ^(api-ms-win-|ext-ms-win-) ]] && continue
        [[ "${dependency,,}" != *libdvdcss* ]] || fail "MPV unexpectedly imports prohibited $dependency"
        if find "$stage" -maxdepth 1 -type f -iname "$dependency" -print -quit | grep -q .; then continue; fi
        source_dll="$(find /ucrt64/bin -maxdepth 1 -type f -iname "$dependency" -print -quit)"
        if [[ -n "$source_dll" ]]; then
          install -m 755 "$source_dll" "$stage/$(basename "$source_dll")"
          pacman -Qqo "$source_dll" >> "$inventory" 2>/dev/null || true
          changed=1
        fi
      done < <(objdump -p "$binary" | awk 'tolower($0) ~ /dll name:/ {print tolower($3)}')
    done < <(find "$stage" -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.dll' \))
  done
  install -m 644 "$NOTICES" "$stage/THIRD_PARTY_NOTICES.md"
  for prefix in "$FFMPEG_PREFIX" "$DVDREAD_PREFIX" "$DVDNAV_PREFIX" "$MPV_PREFIX"; do
    cp -R "$prefix/licenses/." "$stage/licenses/"
  done
  find "$stage" -maxdepth 1 -type f -iname '*.dll' -printf '%f\n' | sort > "$stage/licenses/msys2/bundled-dlls.txt"
  sort -u "$inventory" -o "$inventory"
  while IFS= read -r package_name; do
    pacman -Q "$package_name" >> "$stage/licenses/msys2/packages.txt"
    short_name="${package_name#mingw-w64-ucrt-x86_64-}"
    license_source="/ucrt64/share/licenses/$short_name"
    if [[ -d "$license_source" ]]; then
      mkdir -p "$stage/licenses/msys2/$short_name"
      cp -R "$license_source/." "$stage/licenses/msys2/$short_name/"
    fi
  done < "$inventory"
}

# Cache keys include actual component recipes, source/patch checksums and the
# installed toolchain. Publication/verifier changes do not invalidate compilers.
TOOLCHAIN_KEY="$(hash_inputs "windows-components-v1" "$(pacman -Q | LC_ALL=C sort)" \
  "$(cygpath -am /ucrt64)" "$CACHE_PARENT" "${CC:-}" "${CXX:-}" "${CFLAGS:-}" \
  "${CXXFLAGS:-}" "${CPPFLAGS:-}" "${LDFLAGS:-}" "${PKG_CONFIG_PATH:-}" "${PKG_CONFIG_LIBDIR:-}")"
SOURCE_KEY="$(hash_inputs "$(declare -f prepare_source)" "$(declare -f download)")"
MESON_KEY="$(hash_inputs "$(declare -f build_meson)")"
FFMPEG_KEY="$(hash_inputs "$TOOLCHAIN_KEY" "$SOURCE_KEY" "$FFMPEG_VERSION" "$FFMPEG_SHA256" "$(declare -f build_ffmpeg)")"
DVDREAD_KEY="$(hash_inputs "$TOOLCHAIN_KEY" "$SOURCE_KEY" "$MESON_KEY" "$DVDREAD_VERSION" "$DVDREAD_SHA256" "$(file_hash "$DVDREAD_PATCH")" "$(declare -f build_dvdread)")"
DVDNAV_KEY="$(hash_inputs "$TOOLCHAIN_KEY" "$SOURCE_KEY" "$MESON_KEY" "$DVDNAV_VERSION" "$DVDNAV_SHA256" "$DVDREAD_KEY" "$(declare -f build_dvdnav)")"
MPV_KEY="$(hash_inputs "$TOOLCHAIN_KEY" "$SOURCE_KEY" "$MESON_KEY" "$MPV_VERSION" "$MPV_SHA256" "$DVDREAD_KEY" "$DVDNAV_KEY" "$LUA_PKGCONFIG_NAME" "$(declare -f build_mpv)")"
FFMPEG_PREFIX="$CACHE_PARENT/components/ffmpeg/$FFMPEG_KEY/install"
DVDREAD_PREFIX="$CACHE_PARENT/components/libdvdread/$DVDREAD_KEY/install"
DVDNAV_PREFIX="$CACHE_PARENT/components/libdvdnav/$DVDNAV_KEY/install"
MPV_PREFIX="$CACHE_PARENT/components/mpv/$MPV_KEY/install"
BUNDLE_KEY="$(hash_inputs "windows-bundle-v1" "$FFMPEG_KEY" "$DVDREAD_KEY" "$DVDNAV_KEY" "$MPV_KEY" "$(file_hash "$NOTICES")" "$(declare -f assemble_bundle)")"
BUNDLE_ROOT="$CACHE_PARENT/bundles/$BUNDLE_KEY"
BUNDLE_STAGE="$BUNDLE_ROOT/bundle"

# A complete old staging directory can sometimes survive the previous recipe's
# cleanup. Recover it only after the full current verifier accepts it.
status="$(node "$CACHE_HELPER" status "$BUNDLE_ROOT" "$BUNDLE_KEY" bundle)"
if [[ "$status" != ready && ! -f "$CACHE_PARENT/legacy-stage-checked" ]]; then
  for legacy in "$STAGE_PARENT/.win-x64.candidate" "$STAGE_PARENT"/.win-x64.new.*; do
    [[ -f "$legacy/ffmpeg.exe" && -f "$legacy/ffprobe.exe" && -f "$legacy/mpv.exe" ]] || continue
    printf 'Checking preserved media bundle: %s\n' "$legacy"
    if node "$PROJECT_ROOT/scripts/verify-media-tools.js" --stage "$legacy" --platform win32 --arch x64; then
      node "$CACHE_HELPER" remove "$BUNDLE_STAGE"
      node "$CACHE_HELPER" copy "$legacy" "$BUNDLE_STAGE"
      node "$CACHE_HELPER" seal "$BUNDLE_ROOT" "$BUNDLE_KEY" bundle ffmpeg.exe ffprobe.exe mpv.exe THIRD_PARTY_NOTICES.md
      status=ready
      break
    fi
    printf 'That old bundle is incomplete or invalid; leaving it untouched.\n' >&2
  done
  # Import old unkeyed stages only once; later recipe/toolchain changes must
  # use their own cache keys instead of re-adopting an obsolete old bundle.
  touch "$CACHE_PARENT/legacy-stage-checked"
fi

if [[ "$status" == ready ]]; then
  printf 'Reusing the completed Windows media bundle (checksums verified).\n'
else
  prepare_component ffmpeg "$FFMPEG_KEY" build_ffmpeg bin/ffmpeg.exe bin/ffprobe.exe licenses/FFmpeg-COPYING.LGPLv2.1
  prepare_component libdvdread "$DVDREAD_KEY" build_dvdread 'bin/*.dll' lib/pkgconfig/dvdread.pc licenses/libdvdread-COPYING
  prepare_component libdvdnav "$DVDNAV_KEY" build_dvdnav 'bin/*.dll' lib/pkgconfig/dvdnav.pc licenses/libdvdnav-COPYING
  prepare_component mpv "$MPV_KEY" build_mpv bin/mpv.exe licenses/MPV-LICENSE.GPL
  printf '\nAssembling the Windows media bundle in the build cache...\n'
  assemble_bundle
  node "$CACHE_HELPER" seal "$BUNDLE_ROOT" "$BUNDLE_KEY" bundle ffmpeg.exe ffprobe.exe mpv.exe THIRD_PARTY_NOTICES.md
fi

# Always run the executable/license/dependency checks, even for a cached bundle.
# A failed check or locked destination leaves all completed checkpoints intact.
node "$PROJECT_ROOT/scripts/verify-media-tools.js" \
  --stage "$BUNDLE_STAGE" --platform win32 --arch x64 --write-info "$BUNDLE_STAGE/build-info.json"
node "$CACHE_HELPER" publish "$BUNDLE_STAGE" "$FINAL_STAGE" "$CACHE_PARENT/publications"

printf '\nPrepared Mynda media tools at:\n  %s\n' "$FINAL_STAGE"
printf 'Run: npm run media:status && npm run test:media && npm run test:package\n'
