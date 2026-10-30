# Desktop packaging and beta readiness

Mynda's release payload is deliberately limited to runtime files. A new file
in the checkout does not automatically become part of the application.

## Package layout

`app.asar` contains:

- `package.json`, the bootstrap and backend JavaScript modules;
- the compiled browser renderer and sandboxed preload;
- the HTML, stylesheets, themes, fonts and images used by the interface;
- production npm dependencies collected by electron-builder.

The authored renderer/preload modules, source maps, tests, scripts, sandbox,
development settings and retired `omdb.js` are excluded. Renderer source maps
are generated locally for debugging, but the production bundle neither includes
them nor requests them through a `sourceMappingURL` comment. Development builds
still use linked maps.

The platform's `Resources` (macOS) or `resources` (Windows/Linux) directory holds
`app.asar`, the staged native media tools, `THIRD_PARTY_NOTICES.md`, and the font
copyright/license texts in `licenses/`. Electron's own runtime notices remain
part of its distribution. Media notices accompany the separate media executables.

The package's name, app ID and version remain unchanged in this pass, so this
change does not deliberately move the user's library or saved activation.
The author metadata is TorVor.

Linux's default installer is a DEB. Native ARM64 packaging is available via
`npm run dist:linux:arm64`, using `vendor/media-tools/linux-arm64/` and producing
`dist/mynda_1.0.0_arm64.deb` at the current package version. The Linux ARM64
baseline is Debian 12 Bookworm; Raspberry Pi 5 installation/playback acceptance
is still pending. See [LINUX_ARM64.md](LINUX_ARM64.md). This target does not
change the x64 Ubuntu DEB or introduce an AppImage/sandbox bypass.

## Checks performed while building

The existing `beforeBuild` hook compiles a fresh production renderer/preload
and verifies the staged native media tools. The `afterPack` hook inspects the
finished archive and external resources before signing. It checks:

- required startup files and all packaged HTML/CSS resource references;
- declared production dependencies, and accidental inclusion of direct
  development-only dependencies;
- unexpected application paths and known private filenames, including local
  server credentials, library snapshots, environment files and Mynda logs;
- platform media executable paths and required font/media notices;
- the compiled Mac icon catalog and flattened ICNS fallback;
- resource symlinks that point outside the application.

Dependency collection fails if production dependencies cannot be resolved.
`npm run dist` explicitly uses `--publish never`; creating a local artifact does
not upload it to GitHub or an update service.

These are structural checks, not a general secret-content scanner, a complete
third-party license audit, or proof of native execution. Keep private data out
of runtime source and do not put unrelated files in staged media directories.

## Commands

Portable checks, without prepared media binaries:

```bash
npm run test:core
npm run test:packaging
```

`test:core` already includes the packaging cases. The second command is useful
when iterating on packaging alone. The resource-layout cases use fixtures for
macOS, Windows and Linux; they do not certify those operating systems.

On each native packaging machine, after the media setup in [MEDIA_TOOLS.md](MEDIA_TOOLS.md):

```bash
npm run test:electron
npm run test:credentials
npm run test:package
npm run dist
```

Run each command only after the preceding one succeeds. `test:package` runs
the fast tests, builds an unpacked application, checks its finished payload,
and exercises its bundled media tools. `dist` creates the distributable artifact.
Both build commands run the new contents check automatically. The native Electron
journeys use disposable libraries; live server tagging tests remain separate.

To inspect a specific existing macOS build without rebuilding:

```bash
npm run package:verify -- "dist/mac-arm64/Mynda.app/Contents/Resources"
```

Use the actual output directory from your builder run. On Windows/Linux pass
the unpacked application's `resources` directory. The command checks the host
platform's layout; it does not locate an arbitrary old build or infer freshness.

## Application icons

The editable Mac icon is `build/Mynda.icon`, copied from the Icon Composer
document originally saved in `sandbox/`. Open this version-controlled copy
in Icon Composer for future edits; its `Assets/` directory belongs with it.

`build.mac.icon` points to that document. electron-builder compiles it with
Xcode's `actool` into `Contents/Resources/Assets.car` and `icon.icns`, and sets
`CFBundleIconName` and `CFBundleIconFile` in the application Info.plist. macOS
26 and later use the layered Liquid Glass icon; older supported macOS versions
use Apple's flattened rendering of the same design. Both ship in the same
Mac application. The minimum macOS version remains 13.0.0. The DMG volume icon
also uses the generated ICNS. See the [electron-builder icon documentation](https://www.electron.build/v26/docs/features/icons-and-images/).

Mac packaging requires full Xcode 26 or newer; standalone Command Line Tools
do not include `actool`. The build respects `DEVELOPER_DIR` or the selected full
Xcode. If only Command Line Tools are selected, it uses `/Applications/Xcode.app`
for that build process. It never changes the system-wide `xcode-select` setting.
For a differently named Xcode installation, set `DEVELOPER_DIR` to that app's
`Contents/Developer` directory when running the build.

Windows retains `build/mynda.ico`; Linux retains `build/icons/`. Those assets
and the original `images/mynda-icon.png` are unchanged. The original
`build/mynda.icns` is retained as artwork and as input to the existing Mac
development-image script; it is no longer the packaged Mac fallback.

Source launches (`npm start`) still set a static development Dock icon because
they run inside Electron's development app bundle. Packaged Mynda leaves the
Dock icon to macOS, preserving its layered rendering and appearance variants.
Inspect the built `.app` to check the Liquid Glass icon. Verify the older-Mac
appearance on an older macOS installation before release; inspecting the
generated fallback here does not replace that native check.

## Remaining beta release checks

1. **Install and upgrade on macOS.** Test the actual distributed app on a
   machine without development dependencies: first launch, fonts/images,
   scanning, playback, subtitles, saving, restart and Share. Test an upgrade
   against a disposable copy of an existing profile. Packaged media smoke tests
   use a special bootstrap, so normal installed startup is a separate check.
2. **Activation in the installed app.** Activate, restart, tag, deactivate,
   and reactivate without restarting. Exercise an unavailable server and a
   locked keychain. Saved activation must survive an application upgrade.
   Source/ASAR journeys cover this logic with synthetic tokens; native keychain
   and signing identity behavior still need checking in the distributed app.
3. **Native signing and distribution.** Finish macOS signing/notarization and
   verify the downloaded artifact on a clean account. Select a beta version
   before distribution (for example `1.0.0-beta.1`); this pass leaves `1.0.0`
   unchanged. Record the source commit, artifact checksum and debug maps for
   each distributed build. An automatic updater is a separate project.
4. **Linux, then any other offered platform.** Run the native media, Electron,
   keyring, package and installer checks on the intended hardware/desktop.
   Linux secure activation requires an available OS keyring; Mynda refuses
   Electron's plaintext credential backend. Keep Linux unvalidated until the
   PC is available. Windows likewise needs its own native validation before
   offering a Windows beta.
5. **Distribution notices and sources.** Finish the media dependency notice
   and corresponding-source inventory described in [MEDIA_TOOLS.md](MEDIA_TOOLS.md).
   Font notices now ship, but they are only one part of that inventory. Confirm
   Mynda's own intended license (package metadata currently says `ISC`) and the
   provider/artwork attribution arrangements before distributing the beta.
6. **Beta service configuration.** The built-in service currently points to
   `https://mynda-server-dev.torvor-dev.workers.dev`. Decide which deployment
   beta clients should use when preparing beta infrastructure. No developer
   token or `metadata-server.local.json` is bundled; users activate through
   Settings. Diagnostic export is available under Settings → Library; see
   [DIAGNOSTICS.md](DIAGNOSTICS.md).

The top-level package `name` stays `mynda`, and top-level `productName` is
`Mynda`. Electron uses the product name for its standard application menu,
profile directory and secure-storage identity; electron-builder also uses it
for the application bundle and helper executables. The app and helper bundle
IDs remain unchanged (`com.torvor.mynda`). There are no separate native-name
or menu-label overrides. The About panel also uses the native defaults. The
window starts with `app.getName()` and then follows the HTML document title;
Electron does not automatically derive page/window titles from `productName`.

Existing development profiles named `mynda` must be migrated before running
this version. Quit Mynda, use the explicit backup/prepare/install procedure in
[PROFILE_MIGRATION.md](PROFILE_MIGRATION.md), then enter the license key again.
The script does not modify system Keychain entries. New installations start
with the `Mynda` profile directly.

Managed artwork references in the library are relative to a single backend
root defined in `src/platform/ArtworkPaths.js`. Downloads, editor saves,
legacy library loading and the renderer all use that root. Moving artwork in
the future requires moving the files and changing this root, not rewriting
relative references in the library.
