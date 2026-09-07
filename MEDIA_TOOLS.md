# Preparing Mynda's bundled media tools

Fix54 makes a packaged Apple Silicon copy of Mynda self-contained. An end user
does not install MPV, FFmpeg, FFprobe, Homebrew, or any other media dependency.
The developer who packages Mynda prepares the binaries once, and Electron
Builder copies them into `Mynda.app/Contents/Resources/media-tools`.

## Current target

This first reproducible build targets Apple Silicon (`mac-arm64`) on macOS 11
or later. It is appropriate for the M1 Mac used for current development.

It does not yet create an Intel/Mojave or Windows media bundle. MPV 0.41 itself
requires macOS 10.15 or later, and Apple Silicon requires macOS 11. A future
legacy build will therefore need separately pinned tools rather than pretending
that this bundle supports Mojave.

## One-time developer setup

Install the build prerequisites with Homebrew:

```bash
brew install meson ninja pkgconf ffmpeg libass libplacebo luajit
```

These packages are needed only on the Mac that builds Mynda. The Homebrew
FFmpeg libraries become private dependencies of the GPL MPV bundle; they are
not the standalone FFmpeg and FFprobe that Mynda uses for probing.

Then, from the Mynda project folder, run:

```bash
cd "/Volumes/2TB-SSD/Coding/Mynda (React)"
npm run media:prepare
```

The preparation command:

1. downloads exact, version-pinned source archives;
2. verifies all four SHA-256 checksums;
3. builds FFmpeg 6.1.6 and FFprobe 6.1.6 with GPL, nonfree, and version-3
   components explicitly disabled;
4. builds libdvdread 7.1.1 with `libdvdcss` explicitly disabled and its
   fallback dynamic loader removed by a pinned source patch;
5. builds libdvdnav 7.0.0;
6. builds MPV 0.41.0 with `dvd://` support and the macOS
   `gpu-next`/Vulkan/`macvk` video-window path;
7. uses MPV's macOS bundle tool to copy and rewrite all non-system dylibs;
8. rejects an incorrect architecture, an external Homebrew dylib path, a
   GPL/nonfree standalone FFmpeg, an audio-only MPV build, missing DVD
   support, or any bundled `libdvdcss` file, link, or libdvdread loader; and
9. stages the verified result under `vendor/media-tools/mac-arm64`.

Downloads are cached under macOS's temporary directory. When an existing stage
still contains the approved FFmpeg and FFprobe builds, `media:prepare` reuses
those two standalone binaries and rebuilds only the DVD libraries and MPV. The
verified staged bundle remains in the project until its replacement passes.

Once compilation has produced a complete candidate, it is preserved until it
passes verification. If a verifier rule—not the binaries—needs correction, the
next `media:prepare` run checks and promotes that candidate without recompiling.

## Verify and package

After preparation succeeds, run:

```bash
npm run test:media
npm run test:package
```

`test:media` runs the staged executables directly. It creates disposable audio
and a 64×64 video frame, has FFmpeg encode audio, has FFprobe read it, confirms
that MPV advertises `dvd://`, and starts MPV through the same JSON-IPC handoff
used by Mynda's Player pane. The strict test briefly opens an MPV window and
requires `current-vo=gpu-next`, `current-gpu-context=macvk`, and nonzero video
dimensions. This catches both an uncontrollable player and an audio-only build.

`test:package` reruns all fast tests, verifies the stage, builds Mynda, and then
launches the packaged application with an empty `PATH`. Emptying `PATH` proves
that a Homebrew installation cannot hide a missing bundled executable. The
packaged check also proves that `node-mpv` can connect to the bundled MPV over
its documented JSON IPC socket and initialize a real Vulkan-backed video
window; merely loading the npm module or decoding audio is not enough.

To launch the unpacked result manually:

```bash
open "dist/mac-arm64/mynda.app"
```

To create normal distributable artifacts later:

```bash
npm run dist
```

Signing and notarization are deliberately not configured yet.

## What is bundled

| Component | Build policy | Purpose |
|---|---|---|
| FFmpeg 6.1.6 | LGPL-2.1-or-later; `--disable-gpl --disable-nonfree --disable-version3` | Metadata fallback and bounded runtime verification |
| FFprobe 6.1.6 | Same LGPL-only FFmpeg source/configuration | Primary media metadata probing |
| MPV 0.41.0 | GPL-2.0-or-later, separate `mpv.app` child process | Video/audio/subtitle playback |
| libdvdread 7.1.1 | GPL-2.0-or-later; `libdvdcss` link and dynamic loader disabled | Read unencrypted DVD structures |
| libdvdnav 7.0.0 | GPL-2.0-or-later | Navigate and play unencrypted DVD folders |

The retired HLS player is no longer loaded or packaged, and its two npm
dependencies have been removed. Mynda neither bundles nor dynamically loads
`libdvdcss`, so encrypted DVD playback is outside this version's promise.

## Release-compliance boundary

The staged directory contains the main license texts, source URLs, checksums,
and a generated `build-info.json`. This gives us a traceable development build,
but it is not the final commercial-release legal review. Before distribution,
have counsel review the sidecar arrangement and complete the corresponding-
source and notice inventory for every dylib copied into `mpv.app`.

## Troubleshooting

- If `media:prepare` lists missing Homebrew formulae, run the exact
  `brew install ...` command it prints and retry.
- If it says the Swift compiler is missing, install/select Xcode and retry.
- If it reports a checksum mismatch, do not bypass the check. Send the complete
  error so the pinned source can be reviewed.
- If it reports an external dylib path, send the path and the MPV build output;
  the app would not yet be self-contained.
- If `test:package` fails, send everything from `npm run media:verify` through
  the packaged media result.
- If ordinary playback fails, the Player pane and Mynda log now include MPV's
  retained warning/error output. Send the complete `Playback failed` record;
  it should name a socket, file, decoder, audio, or video-output failure rather
  than leaving the loading indicator unexplained.
- Hearing audio without seeing a window means the staged MPV predates the
  graphical capability gate. Install the current fix, rerun
  `npm run media:prepare`, and do not reuse the older `mac-arm64` bundle.
