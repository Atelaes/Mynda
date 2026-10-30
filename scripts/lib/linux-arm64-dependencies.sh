#!/usr/bin/env bash
# Bookworm's Meson, FFmpeg and libplacebo predate MPV 0.41's requirements.
# Everything here is private to the build; no pip installs or system upgrades.
MESON_VERSION="1.3.2"
MESON_SHA256="683082fb3c5cddf203b21d29bdf4c227e2f7964da5324a15e1a5f7db94322b4b"
PLACEBO_VERSION="6.338.2"
PLACEBO_SHA256="2f1e624e09d72a8c9db70f910f7560e764a1c126dae42acc5b3bcef836a7aec6"
# Exact submodule revisions recorded by libplacebo v6.338.2.
GLAD_REVISION="d08b1aa01f8fe57498f04d47b5fa8c48725be877"
GLAD_SHA256="7a5fb3299a20e8088a504f3bb2b7247d85c4207706754180a1b4a4840a8728e4"
FAST_FLOAT_REVISION="2b2395f9ac836ffca6404424bcc252bff7aa80e4"
FAST_FLOAT_SHA256="230d20e4e4ac1f6a9df92c4d746c6ec536cdb0c085bc8635d4b88cead5dc22cb"
VULKAN_HEADERS_REVISION="d732b2de303ce505169011d438178191136bfb00"
VULKAN_HEADERS_SHA256="570f9ae1e65466dbaf5fcab667abd079dd0a61c4ab86cf535efd492bf70a5b74"

prepare_arm64_build_dependencies() {
  download "https://github.com/mesonbuild/meson/archive/refs/tags/$MESON_VERSION.tar.gz" \
    "$DOWNLOAD_ROOT/meson-$MESON_VERSION.tar.gz" "$MESON_SHA256"
  download "https://github.com/haasn/libplacebo/archive/refs/tags/v$PLACEBO_VERSION.tar.gz" \
    "$DOWNLOAD_ROOT/libplacebo-$PLACEBO_VERSION.tar.gz" "$PLACEBO_SHA256"
  download "https://github.com/Dav1dde/glad/archive/$GLAD_REVISION.tar.gz" \
    "$DOWNLOAD_ROOT/glad-$GLAD_REVISION.tar.gz" "$GLAD_SHA256"
  download "https://github.com/fastfloat/fast_float/archive/$FAST_FLOAT_REVISION.tar.gz" \
    "$DOWNLOAD_ROOT/fast_float-$FAST_FLOAT_REVISION.tar.gz" "$FAST_FLOAT_SHA256"
  download "https://github.com/KhronosGroup/Vulkan-Headers/archive/$VULKAN_HEADERS_REVISION.tar.gz" \
    "$DOWNLOAD_ROOT/Vulkan-Headers-$VULKAN_HEADERS_REVISION.tar.gz" "$VULKAN_HEADERS_SHA256"
  tar -xzf "$DOWNLOAD_ROOT/meson-$MESON_VERSION.tar.gz" -C "$WORK_ROOT"
  tar -xzf "$DOWNLOAD_ROOT/libplacebo-$PLACEBO_VERSION.tar.gz" -C "$WORK_ROOT"
  PLACEBO_SOURCE="$WORK_ROOT/libplacebo-$PLACEBO_VERSION"
  PLACEBO_PREFIX="$WORK_ROOT/libplacebo-install"
  mkdir -p "$PLACEBO_SOURCE/3rdparty/glad" "$PLACEBO_SOURCE/3rdparty/fast_float" "$PLACEBO_SOURCE/3rdparty/Vulkan-Headers"
  tar -xzf "$DOWNLOAD_ROOT/glad-$GLAD_REVISION.tar.gz" \
    -C "$PLACEBO_SOURCE/3rdparty/glad" --strip-components=1
  tar -xzf "$DOWNLOAD_ROOT/fast_float-$FAST_FLOAT_REVISION.tar.gz" \
    -C "$PLACEBO_SOURCE/3rdparty/fast_float" --strip-components=1
  tar -xzf "$DOWNLOAD_ROOT/Vulkan-Headers-$VULKAN_HEADERS_REVISION.tar.gz" \
    -C "$PLACEBO_SOURCE/3rdparty/Vulkan-Headers" --strip-components=1
  MESON=(python3 "$WORK_ROOT/meson-$MESON_VERSION/meson.py")
}

build_arm64_libplacebo() {
  printf '\nBuilding private libplacebo %s for the Bookworm ARM64 baseline...\n' "$PLACEBO_VERSION"
  "${MESON[@]}" setup "$WORK_ROOT/libplacebo-build" "$PLACEBO_SOURCE" \
    --prefix="$PLACEBO_PREFIX" --libdir=lib --buildtype=release \
    --default-library=shared --wrap-mode=nofallback --auto-features=disabled \
    -Ddemos=false -Dtests=false -Dbench=false \
    -Dvulkan=enabled -Dvk-proc-addr=enabled -Dopengl=enabled -Dgl-proc-addr=enabled \
    -Dglslang=enabled -Dshaderc=disabled -Dlcms=enabled
  "${MESON[@]}" compile -C "$WORK_ROOT/libplacebo-build" -j "$JOBS"
  "${MESON[@]}" install -C "$WORK_ROOT/libplacebo-build"
}

install_arm64_dependency_notices() {
  install -m 644 "$PLACEBO_SOURCE/LICENSE" "$NEW_STAGE/licenses/libplacebo-LICENSE"
  install -m 644 "$PLACEBO_SOURCE/3rdparty/glad/LICENSE" "$NEW_STAGE/licenses/glad-LICENSE"
  install -m 644 "$PLACEBO_SOURCE/3rdparty/fast_float/LICENSE-MIT" "$NEW_STAGE/licenses/fast_float-LICENSE-MIT"
  install -m 644 "$PLACEBO_SOURCE/3rdparty/fast_float/LICENSE-APACHE" "$NEW_STAGE/licenses/fast_float-LICENSE-APACHE"
  install -m 644 "$PLACEBO_SOURCE/3rdparty/Vulkan-Headers/LICENSE.txt" "$NEW_STAGE/licenses/Vulkan-Headers-LICENSE"
  # These are linked statically or used by the copied FFmpeg/libplacebo build;
  # ldd cannot discover all of them for the ordinary dependency inventory.
  printf '%s\n' glslang-dev spirv-tools liblcms2-2 libdav1d6 libdrm2 >> "$PACKAGE_INVENTORY"
}
