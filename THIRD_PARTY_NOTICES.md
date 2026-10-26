# Mynda third-party components

Mynda is developed by TorVor. The following components and services retain
their own licenses and attribution requirements.

## Fonts

Baloo Tamma 2, Dorsa, HK Grotesk, Source Code Pro and Wire One are included
under the SIL Open Font License 1.1. Their copyright and reserved-name notices
are in `licenses/fonts.txt`; the full license is in `licenses/OFL-1.1.txt`.
The font files have not been modified.

## Application runtime and JavaScript dependencies

Mynda uses Electron, Chromium, Node.js, React and other JavaScript libraries.
Electron's distribution includes its runtime license and Chromium notices.
Production JavaScript packages retain their license files under `node_modules`
in `app.asar`; generated renderer code also retains upstream legal comments.
Mynda's package metadata does not replace these component licenses.

## Media executables

FFmpeg, FFprobe and MPV run as separate programs. Platform-specific notices,
principal license texts and the libdvdread source patch are included in
`media-tools/THIRD_PARTY_NOTICES.md` and `media-tools/licenses/` beside `app.asar`.
The media build records identify the staged versions and build settings.

## Metadata and ratings

TheTVDB provides catalogue metadata and artwork: https://thetvdb.com/

Wikidata provides the imported ratings data: https://www.wikidata.org/
Those records identify ratings from IMDb, Rotten Tomatoes and Metacritic.
These services and their marks belong to their respective owners; Mynda is
not endorsed by them. These credits do not grant rights to artwork or logos.

This file and the font licenses are copied outside `app.asar`, into the
application's Resources/resources directory, for inspection without extracting
the application archive.
