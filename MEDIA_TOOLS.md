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
npm run test:core
npm run media:prepare
npm run media:status
npm test
npm run test:electron
npm run test:media
npm run test:package
```

`media:prepare` dispatches to the current platform. Compilation can take a
while, but downloads are cached. Windows also checkpoints each completed
component and keeps incomplete compiler work for retries (see fix75 below).
Generated stages are ignored by Git; do not
commit native binaries or `dist/`.

`test:core` checks the application without requiring media executables. `npm test` includes two suites that really execute FFmpeg/FFprobe against generated fixtures, so those tools must be available first. `test:package` consumes a prepared stage; it does not build the media tools for you.

## macOS preparation

Install the one-time build prerequisites:

```bash
brew install meson ninja pkgconf ffmpeg libass libplacebo luajit
```

Then run the common workflow. The macOS recipe builds `mac-arm64`, uses MPV's
application-bundle target, and rewrites private dylibs to app-relative paths.

## Windows preparation

Install x64 [MSYS2 from its official site](https://www.msys2.org/), then open its **UCRT64** terminal. The current Mynda Windows recipe targets x64. Update MSYS2 and
install the build inputs:

```bash
pacman -Syu
pacman -S --needed base-devel mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-meson mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-zlib mingw-w64-ucrt-x86_64-ffmpeg mingw-w64-ucrt-x86_64-libass mingw-w64-ucrt-x86_64-libiconv mingw-w64-ucrt-x86_64-libplacebo mingw-w64-ucrt-x86_64-lua51 mingw-w64-ucrt-x86_64-shaderc mingw-w64-ucrt-x86_64-spirv-cross
```

If `pacman -Syu` asks to close the terminal after updating core components,
close it, reopen UCRT64, and run the update again before installing packages. See the [MSYS2 update instructions](https://www.msys2.org/docs/updating/).

Return to PowerShell or Windows Terminal in the Mynda directory and run the
common workflow. The PowerShell wrapper locates `C:\msys64` (or the directory
named by `MYNDA_MSYS2_ROOT`) and enters UCRT64 automatically. The inner recipe
builds the pinned standalone FFmpeg/FFprobe, patched DVD libraries, and MPV
source. It recursively copies non-Windows DLLs beside `mpv.exe` and records
which MSYS2 packages supplied them.

For the current Windows checkout, run in PowerShell:

```powershell
Set-Location 'H:\Dropbox\Coding\Mynda'
npm run test:core
npm run media:prepare
npm run media:status
npm test
npm run test:electron
npm run test:media
npm run test:package
```

Run each command after the preceding one succeeds. `test:core` should report 33 suites and 290 cases. After preparation, `media:status` should show all three tools as available with `source: staged`, under `vendor/media-tools/win-x64/`. `npm test` should then report 35 suites and 297 cases. `test:media` and the package smoke check briefly open MPV to verify actual graphical playback. If preparation cannot start, it prints the missing prerequisite packages or commands; install the requested build inputs in UCRT64 and retry from PowerShell.

You do not need to migrate a freshly created library. Applying this overlay requires no new npm packages. The fixes also apply to the macOS/Linux source; the existing media source pins, licensing policy, and Electron version are unchanged.

### Windows launcher fix73

An immediate `-u: -c: line 2: unexpected EOF while looking for matching ')'`
means the PowerShell-to-Bash launcher failed before compilation started.
Windows PowerShell's legacy argument handling can alter embedded quotes in
native command arguments. Fix73 calls MSYS2's `cygpath.exe` separately, then
passes the converted script filename directly to Bash. It also preserves the
invoking Windows `PATH` behind UCRT64's build tools so the recipe can find Node.
See [PowerShell's native argument documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing#passing-arguments-that-contain-quote-characters).

After applying fix73, retry from the Mynda directory in PowerShell:

```powershell
npm run test:core
npm run media:prepare
```

At fix73, the core test count was 32 suites and 278 cases. The preparation unit suite
guards against restoring a Bash command string in the Windows wrapper. Launcher
verification reproduced the original error with real PowerShell in Legacy mode
and passed the corrected wrapper in Legacy and Standard modes, including paths
with spaces, parentheses, brackets, apostrophes, and dollar signs. That check ran
on Linux with real Bash and a substitute path converter; the native Windows
compilation still needs to run on Windows. Failed path conversions and build
processes retain their nonzero exit status.

### Windows Lua lookup fix74

If MPV's Meson configuration stops with `Dependency "lua51" not found`, the
Windows recipe is asking for the wrong pkg-config module name. The installed
MSYS2 package is named `mingw-w64-ucrt-x86_64-lua51`, but its metadata file is
`/ucrt64/lib/pkgconfig/lua5.1.pc`. MPV 0.41.0 accepts `lua5.1` as its Lua option.
See the [MSYS2 package file list](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-lua51)
and [MPV's Lua dependency lookup](https://github.com/mpv-player/mpv/blob/v0.41.0/meson.build).

Fix74 uses `lua5.1` for both the MPV option and an early pkg-config version
check. A missing or unusable Lua package now stops preparation before any
FFmpeg/DVD compilation and prints the package-install command.

After applying the overlay, retry `npm run media:prepare` from PowerShell in
the Mynda directory. There are no new dependencies to install for this fix.
Before fix75, failed attempts removed temporary compilation files, so FFmpeg
and the DVD libraries had to compile again; verified downloads remained cached.
Fix75 supersedes that cleanup behavior. Native Windows compilation and playback
still require a successful run on Windows.

### Windows resumable builds and locked folders: fix75

A `Permission denied` or `Device or resource busy` error while renaming the
completed bundle occurs during installation into the project folder. The log
alone cannot identify which process or permission prevented the operation.
Windows can block deletion/renaming when a file is held open without delete
sharing; see [Microsoft's file-handle documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew).
For a project inside Dropbox, close Mynda and MPV and temporarily pause Dropbox
sync before retrying. Resume sync afterward. No administrator terminal is required.

Fix75 stores compiler work and completed installs in MSYS2's cache, normally
`C:\msys64\tmp\mynda-media-tools-cache-win-x64`, outside the project folder.
It saves separate checkpoints for FFmpeg/FFprobe, libdvdread, libdvdnav, and MPV.
On retry it prints `Reusing completed ...` for unchanged successful stages.
An interrupted component keeps its source and object files so Make/Ninja can
resume. Failed configuration is retried before compilation.

Reuse requires matching source versions, archive and patch checksums, component
build options, toolchain packages, and installed-file checksums. Changed inputs
or damaged output trigger the affected builds again. MPV/DVD dependency changes
propagate to their consumers. A change only to final verification or publication
does not rebuild the compilers. The final executable, license, architecture,
DVD/video and DLL-dependency checks always run, including for reused bundles.

The complete bundle is assembled in the cache before being copied into a new
project staging folder. Brief locks receive bounded retries. Replacement keeps
the previous installed bundle as a backup until the new copy is in place; a
failed rename attempts restoration. A recovery journal outside the project
lets the next run finish an interrupted replacement. If a backup is still locked,
the script reports its retained path. It never deletes the compiled cache on
failure. Run just one preparation at a time; a process lock prevents overlap.

Retry with the same command from PowerShell:

```powershell
npm run media:prepare
```

The first fix75 run checks once for a complete staging folder left by the old
recipe, verifies it, and reuses it if possible. The old cleanup may already have
deleted its executables and compiler work, in which case one new build is
unavoidable. Incomplete remnants are left alone. New failures preserve progress.

The cache consumes disk space and is not a source backup. If it is deleted by
you or temporary-file cleanup, the next run rebuilds it. To use a different
cache, set `MYNDA_MEDIA_BUILD_CACHE` to a local folder outside synced directories
before starting; changing its location causes a fresh build because installed
pkg-config files can contain absolute paths. Native macOS/Linux recipes are
unchanged by fix75. No new npm or MSYS2 dependencies are required.

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

1. `npm run test:core`
2. `npm run media:prepare`
3. `npm test`
4. `npm run test:electron`
5. `npm run test:media`
6. `npm run test:package`
7. Manually scan a fixture watchfolder and play a normal video, subtitles, and
   one representative unencrypted DVD folder.
8. Run `npm run dist` and test the installer or AppImage on a clean machine
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
