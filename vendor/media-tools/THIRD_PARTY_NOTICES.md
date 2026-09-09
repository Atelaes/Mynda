# Mynda bundled media tools

This directory is generated for Mynda's packaged media sidecars. The binaries
are independent executables launched as child processes; they are not imported
into Mynda's JavaScript process.

## Standalone FFmpeg and FFprobe

- Version: 6.1.6
- Source: https://ffmpeg.org/releases/ffmpeg-6.1.6.tar.xz
- SHA-256: `d4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a`
- License policy: LGPL-2.1-or-later build only
- Required configuration: `--disable-gpl --disable-nonfree --disable-version3`

The preparation and verification scripts reject builds that enable GPL or
nonfree FFmpeg components. These standalone tools provide Mynda's metadata,
probing, and runtime-verification operations.

## MPV player

- Version: 0.41.0
- Source: https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz
- SHA-256: `ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209`
- License: GPL-2.0-or-later for this build

MPV is packaged as a separate child-process executable (`mpv.app` on macOS,
`mpv.exe` on Windows, and `mpv` on Linux). These builds enable `dvdnav` so
Mynda can play unencrypted DVD folders. MPV's private FFmpeg libraries and
other runtime dependencies are distinct from the standalone LGPL-only FFmpeg
and FFprobe listed above.

## DVD navigation libraries

- libdvdread 7.1.1
  - Source: https://code.videolan.org/videolan/libdvdread/-/archive/7.1.1/libdvdread-7.1.1.tar.gz
  - SHA-256: `01a690d1b442dfbbf66e5bbe58604ddc42d5aba4334b7c9680d9d4dbd116c74d`
  - License: GPL-2.0-or-later
- libdvdnav 7.0.0
  - Source: https://code.videolan.org/videolan/libdvdnav/-/archive/7.0.0/libdvdnav-7.0.0.tar.gz
  - SHA-256: `15d28086937647a95c3d6b083f0a86678cd4dd428914e319c64adf52cadec786`
  - License: GPL-2.0-or-later

`libdvdread` is built with `-Dlibdvdcss=disabled` and the included
`libdvdread-no-libdvdcss.patch`. The patch removes libdvdread's fallback
dynamic loader, so this build neither links nor attempts to load `libdvdcss`.
Mynda does not promise playback of encrypted discs.

## Release caution

The generated media directory includes the principal license texts and a build
record. Windows and Linux stages also record the native packages that supplied
copied runtime libraries. Before public or commercial distribution, obtain
legal review and make a final corresponding-source and third-party-notice
inventory for every library copied into each platform bundle. This development
build is not a substitute for that release-compliance review.
