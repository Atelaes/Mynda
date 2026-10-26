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

The visible window/title and macOS menu labels say **Mynda**. The macOS bundle
uses `build.productName: "Mynda"` so electron-builder consistently names the
application bundle, native menu and helper executables. Overriding only
`CFBundleName` leaves helper names inconsistent and can prevent startup.

The top-level package name and runtime `app.getName()` stay `mynda`; there is
no top-level `productName`. The builder removes its `build` configuration from
the packaged metadata, so the display name does not change Electron's existing
profile directory or secure-storage identity. The app and helper bundle IDs
remain unchanged. Do not add a top-level `productName` or call
`app.setName('Mynda')` without a separate storage/credential migration plan.
