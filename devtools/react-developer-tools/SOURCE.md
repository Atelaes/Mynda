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

## Local compatibility patch

`build/background.js` checks that `chrome.browserAction.setIcon` and `setPopup`
exist before updating the optional Chrome toolbar button. Electron does not
provide that toolbar API; the upstream unconditional call threw when the
content script reported that it had detected React. The guard leaves the
inspection message bridge and DevTools panels intact. It does not suppress
other extension errors or change the app's Dock icon.

`test/ReactDevToolsBackground.unit.test.js` executes this bundled background
script with and without toolbar support, including React detection and
bidirectional inspection messages. Preserve this guard when rebuilding the
extension unless the upstream version already handles the missing API.
