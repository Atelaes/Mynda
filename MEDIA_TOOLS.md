# Preparing Mynda's bundled media tools

Mynda has native media-bundle contracts for Apple Silicon macOS, x64 Windows,
and x64 Linux. End users do not install MPV, FFmpeg, FFprobe, Homebrew, MSYS2,
or Ubuntu build packages. A developer prepares the matching bundle on each
native build machine, and Electron Builder copies only that target's files into
the packaged application.

## Supported targets

| Target | Build host | MPV window path | Package target |
|---|---|---|---|
| `mac-arm64` | Apple Silicon macOS | `gpu-next` + Vulkan/`macvk` | macOS application |
| `win-x64` | 64-bit Windows with MSYS2 UCRT64 | `gpu-next` + Direct3D 11 | NSIS installer |
| `linux-x64` | Ubuntu 24.04 x64 | `gpu-next` + Wayland and X11 | AppImage |

These are native builds, not cross-compiles. Windows ARM, Linux ARM, Intel
macOS, and Mojave are not claimed yet. Ubuntu 24.04 is the first explicit
Linux/glibc baseline, not a promise that every distribution has been tested.

## Which executables development uses

Run this at any time:

```bash
npm run media:status
```

For each tool it prints `packaged`, `staged`, `override`, `system`, or
`missing`. Resolution order is:

1. an explicit `MYNDA_FFMPEG_PATH`, `MYNDA_FFPROBE_PATH`, or
   `MYNDA_MPV_PATH` override;
2. the packaged application's `Resources/media-tools` directory;
3. `vendor/media-tools/<target>` in the development project;
4. `PATH` and a few conventional system locations.

After `media:prepare`, ordinary development uses the same staged executables
that will be packaged. A system fallback remains useful before a developer has
built a stage, but `media:verify`, `test:media`, `test:package`, and `dist`
require the verified target bundle and will not accept that fallback.

## Common workflow

From the Mynda project directory on each target machine:

```bash
npm install
npm run media:prepare
npm run media:status
npm run test:media
npm run test:package
```

`media:prepare` dispatches to the current platform. Compilation can take a
while, but downloads are cached and a completed candidate is preserved if only
a verifier rule needs correction. Generated stages are ignored by Git; do not
commit native binaries or `dist/`.

## macOS preparation

Install the one-time build prerequisites:

```bash
brew install meson ninja pkgconf ffmpeg libass libplacebo luajit
```

Then run the common workflow. The macOS recipe builds `mac-arm64`, uses MPV's
application-bundle target, and rewrites private dylibs to app-relative paths.

## Windows preparation

Install 64-bit MSYS2, then open its **UCRT64** terminal. Update MSYS2 and
install the build inputs:

```bash
pacman -Syu
pacman -S --needed base-devel mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-meson mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-zlib mingw-w64-ucrt-x86_64-ffmpeg mingw-w64-ucrt-x86_64-libass mingw-w64-ucrt-x86_64-libiconv mingw-w64-ucrt-x86_64-libplacebo mingw-w64-ucrt-x86_64-lua51 mingw-w64-ucrt-x86_64-shaderc mingw-w64-ucrt-x86_64-spirv-cross
```

If `pacman -Syu` asks to close the terminal after updating core components,
close it, reopen UCRT64, and run the update again before installing packages.

Return to PowerShell or Windows Terminal in the Mynda directory and run the
common workflow. The PowerShell wrapper locates `C:\msys64` (or the directory
named by `MYNDA_MSYS2_ROOT`) and enters UCRT64 automatically. The inner recipe
builds the pinned standalone FFmpeg/FFprobe, patched DVD libraries, and MPV
source. It recursively copies non-Windows DLLs beside `mpv.exe` and records
which MSYS2 packages supplied them.

## Linux preparation

Build the distributable bundle on x64 Ubuntu 24.04. The preparation command
checks prerequisites and prints the exact missing subset. A fresh machine can
install the complete set with:

```bash
sudo apt update
sudo apt install build-essential ca-certificates curl libasound2-dev libass-dev libavcodec-dev libavdevice-dev libavfilter-dev libavformat-dev libavutil-dev libegl1-mesa-dev libluajit-5.1-dev libplacebo-dev libpulse-dev libswresample-dev libswscale-dev libvulkan-dev libwayland-dev libx11-dev libxext-dev libxkbcommon-dev libxpresent-dev libxrandr-dev libxss-dev meson nasm ninja-build patchelf pkg-config python3 wayland-protocols xz-utils zlib1g-dev
```

Then run the common workflow. The recipe builds MPV with PulseAudio and ALSA,
Vulkan/EGL, and both Wayland and X11 window contexts. It copies the recursive
non-glibc shared-library closure under `media-tools/lib`, applies `$ORIGIN`
RUNPATHs, and records the Ubuntu package/version and copyright file for each
copied library. GPU drivers remain supplied by the user's system.

## What preparation and verification enforce

All targets use these pinned top-level sources:

| Component | Version | Policy |
|---|---:|---|
| FFmpeg and FFprobe | 6.1.6 | Standalone LGPL-only build; `--disable-gpl --disable-nonfree --disable-version3` |
| MPV | 0.41.0 | Separate GPL child-process executable |
| libdvdread | 7.1.1 | GPL; patched to remove the `libdvdcss` fallback loader |
| libdvdnav | 7.0.0 | GPL; unencrypted-DVD navigation |

The verifier rejects wrong versions or CPU architecture, GPL/nonfree flags in
the standalone FFmpeg pair, missing `dvd://`, a missing graphical backend,
`libdvdcss` by file/import/content, and dependencies that escape the bundle.
Platform-specific checks use Mach-O dependencies on macOS, PE imports on
Windows, and ELF `NEEDED` plus app-relative RUNPATH entries on Linux.

`test:media` creates disposable audio and a 64×64 video frame, then exercises
real FFmpeg encoding, FFprobe metadata, MPV JSON IPC, DVD capability, and a
real graphical MPV window. `test:package` builds the unpacked Electron app and
launches it with an empty `PATH`, proving that installed system tools cannot
mask a missing packaged dependency.

## First native validation pass

The scripts and platform-independent inspectors can be tested anywhere, but a
target is not release-validated until these steps pass on that target:

1. `npm test`
2. `npm run test:electron`
3. `npm run media:prepare`
4. `npm run test:media`
5. `npm run test:package`
6. Manually scan a fixture watchfolder and play a normal video, subtitles, and
   one representative unencrypted DVD folder.
7. Run `npm run dist` and test the installer or AppImage on a clean machine
   without development tools.

The Windows and Linux recipes in this change are ready for those native passes;
they are not represented as already executed merely because their portable
JavaScript inspectors pass on another host.

## Release-compliance boundary

Each stage contains principal license texts, source URLs/checksums, a generated
`build-info.json`, and a native dependency inventory. Before public or
commercial distribution, have counsel review the sidecar arrangement and
complete the corresponding-source and notice inventory for every copied DLL,
dylib, or shared library. Signing and notarization remain separate release
tasks.

## Troubleshooting

- Start with `npm run media:status`; it makes accidental system fallbacks
  visible.
- If preparation lists missing Homebrew, MSYS2, or Ubuntu packages, install the
  exact set it prints and rerun the same command.
- If verification reports an unresolved DLL or `.so`, send the complete error;
  do not copy random files into the stage, because the dependency inventory and
  licenses must stay aligned.
- MPV startup and load failures retain subprocess warning/error output in
  Mynda's log.
