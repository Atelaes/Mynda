# React Developer Tools 4.12.3

This unpacked development extension was built from Meta's React repository at
revision `8f202a7c8dc9b1a644f830bf3066b3bb7dfd915d`, the React Developer Tools
4.12.3 release revision.

It was originally bundled for Mynda's Electron 12 source-development environment,
which could not use the current Manifest V3 Chrome Web Store build. The Electron
44 upgrade retains this optional extension and loads it through
`session.defaultSession.extensions.loadExtension`. It is excluded from packaged
apps. Confirm its Components/Profiler tabs during native development testing;
the normal Chromium DevTools window opens independently of extension loading.
The extension remains licensed under the included MIT license.
