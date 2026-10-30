# Linux ARM64 / Raspberry Pi builds

Mynda's target is **Linux ARM64**, not a Pi-specific application. The initial
build baseline is **Debian 12 Bookworm ARM64 (glibc 2.36)**, including a
Raspberry Pi 5 running the 64-bit Raspberry Pi OS desktop. Build natively on
that baseline so the package can run there; building on a newer distribution
can introduce newer glibc requirements. The verifier rejects those in the
media executables and libraries. Native Pi acceptance remains pending.

The same ARM64 application is a candidate for other compatible Debian/Ubuntu
ARM64 desktops. The `.deb` installer requires a Debian-family package manager.
Fedora/Arch ARM would need appropriate packaging and validation; Alpine/musl,
Android, headless-only installations, and 32-bit `armhf` are outside this target.
Electron 44 no longer publishes Linux 32-bit ARM binaries. A 64-bit-capable Pi
with a 32-bit OS or Node installation is not sufficient.

## Build on the Pi

Use a checkout containing these changes, based on current `dev`. Do not copy
`node_modules`, `dist`, or `vendor/media-tools` from the Mac or x64 Ubuntu PC.
On an existing checkout, inspect `git status` before `git pull --ff-only`.

The Pi needs a graphical desktop for the playback/installed-app tests. SSH is
fine for compilation; run graphical checks from a terminal in the Pi desktop
session. Use disposable test profiles; do not copy or switch the real library.

Confirm the userland and Node architecture:

```bash
dpkg --print-architecture
node -p 'process.platform + " " + process.arch'
```

Expected: `arm64` and `linux arm64`. If Node is not installed yet, install nvm
as on the Ubuntu development machine, then from the repository:

```bash
nvm install
nvm use
npm ci
npm run test:core
```

The repository `.nvmrc` selects Node; the minimum supported version is 22.12.0.
Use `npm ci` here to install the exact pushed lockfile for this architecture.

Install the build prerequisites (normal Bookworm packages, no distro upgrade):

```bash
sudo apt update
sudo apt install build-essential ca-certificates curl libasound2-dev libass-dev libegl1-mesa-dev libluajit-5.1-dev libpulse-dev libvulkan-dev libwayland-dev libx11-dev libxext-dev libxkbcommon-dev libxpresent-dev libxrandr-dev libxss-dev ninja-build patchelf pkg-config python3 wayland-protocols xz-utils zlib1g-dev glslang-dev liblcms2-dev libdav1d-dev libdrm-dev python3-jinja2
```

`media:prepare` also prints the exact missing subset. Run subsequent commands
as your ordinary user, without `sudo`:

```bash
npm run media:prepare
npm run media:status
npm run media:verify
npm run test:media
npm run test:package
npm run dist:linux:arm64
```

Run each command only after the previous one succeeds. The explicit ARM64
build command refuses an x64 or macOS host. Ordinary `npm run dist` also selects
the native ARM64 architecture when run on the Pi. No publishing is performed.

Preparation compiles FFmpeg/FFprobe 6.1.6, MPV 0.41.0 and patched DVD libraries.
Bookworm's FFmpeg 5.1, libplacebo 4.x and Meson 1.0 are too old for MPV 0.41.
The recipe therefore uses private FFmpeg libraries, libplacebo 6.338.2 and
Meson 1.3.2 under its build directory. It verifies all downloaded archives
against pinned SHA-256 values. It does not install Python packages globally,
replace the system FFmpeg, or change HAL's environment/services.

ARM64 compilation defaults to two jobs. To reduce load further:

```bash
MYNDA_MEDIA_BUILD_JOBS=1 npm run media:prepare
```

The default download cache is `/tmp/mynda-media-tools-cache-linux-arm64`.
To keep downloads across reboots, select a persistent directory with ample
space using `MYNDA_MEDIA_BUILD_CACHE`. Linux retains downloads and a completed
candidate awaiting final verification, but does not yet checkpoint partially
compiled components. An interrupted compile may need recompilation. The
verified stage is `vendor/media-tools/linux-arm64/`; x64 stages are separate.

## Install and validate

At the current version, the output is `dist/mynda_1.0.0_arm64.deb`:

```bash
dpkg-deb --field dist/mynda_1.0.0_arm64.deb Architecture
sudo apt install ./dist/mynda_1.0.0_arm64.deb
npm run test:installed
```

The first command must print `arm64`. Only installation uses `sudo`.
`test:installed` launches `/opt/Mynda/mynda` with a disposable profile and an
empty PATH, verifies the bundled tools, renders generated video, and requires
the existing native Chromium sandbox evidence. Do not add `--no-sandbox` or
change system namespace restrictions to get a passing installed test.

On the Pi that runs HAL, pause HAL temporarily for meaningful performance
measurements using its existing service workflow, then resume it afterward.
No build script manages HAL. Validate:

- installed startup, menus, library import/save/restart using a disposable library;
- generated-video smoke test, actual 1080p H.264/HEVC playback, seeking, audio
  sync, subtitles, fullscreen and an unencrypted DVD folder;
- Wayland and/or X11 session behavior, reporting which session was tested;
- CPU load, dropped frames and thermal throttling with HAL paused, then
  practical coexistence after HAL resumes;
- a second compatible ARM64 desktop before making broader distro claims.

GPU rendering is not the same as hardware video decoding. This first target
keeps the existing MPV GPU policy and includes stock FFmpeg's V4L2 M2M support;
it does **not** add Raspberry Pi-specific FFmpeg patches, force a hardware
decoder, or establish Pi 5 HEVC/4K decoding performance. Verify the actual
decoder in use before claiming acceleration. GPU drivers remain host-provided.

## Checks possible without a Pi

The preparation dispatch and baseline/job policy, ARM64 ELF validation,
glibc ceiling, package scripts, and smoke-test architecture selection have
automated coverage. Run:

```bash
node test/MediaPlatformPreparation.unit.test.js
node test/MediaBundleInspection.unit.test.js
node test/MediaBundleVerifier.unit.test.js
node test/LinuxSandboxCheck.unit.test.js
node test/PackageConfig.unit.test.js
npm run test:packaging
```

Passing these checks is not a native ARM64 compile, installation or playback
result. Do not mark native acceptance complete until those checks run on the Pi.

Upstream references: [MPV 0.41 requirements](https://github.com/mpv-player/mpv/blob/v0.41.0/meson.build),
[libplacebo 6.338.2](https://github.com/haasn/libplacebo/tree/v6.338.2),
[Electron 44 platform changes](https://www.electronjs.org/blog/electron-44-0).
