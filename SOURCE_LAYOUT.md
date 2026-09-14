# Mynda source layout — fix77

This update reorganizes the fix76 source and bundled themes. Application behavior, video IDs, saved media metadata, and media-tool build recipes are preserved. No npm dependencies were added or upgraded.

## Install over fix76

Quit Mynda. Extract `mynda-fix77-source-organization.zip` over your project, then run these commands from the project folder:

```bash
npm run source:cleanup
npm test
npm run test:electron
```

On your Mac, the complete extraction command is:

```bash
ditto -x -k "$HOME/Downloads/mynda-fix77-source-organization.zip" "/Volumes/2TB-SSD/Coding/Mynda (React)"
cd "/Volumes/2TB-SSD/Coding/Mynda (React)"
npm run source:cleanup
```

In Windows PowerShell:

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\mynda-fix77-source-organization.zip" -DestinationPath 'H:\Dropbox\Coding\Mynda' -Force
Set-Location 'H:\Dropbox\Coding\Mynda'
npm run source:cleanup
```

For Linux, extract the zip over the project with your archive manager or `unzip -o`, then run the same npm commands from that project directory.

An overlay zip adds the new locations but cannot delete the old ones. `source:cleanup` handles that one-time step. It checks each old file against fix76 and each replacement against fix77 before removing anything. Text comparisons accept either LF or CRLF line endings. It copies the old files into a new sibling directory named `Mynda-before-fix77-...` (using your project's actual folder name) and verifies the backup bytes first. Keep that backup until you have tested and committed the update.

If it finds unexpected edits or an incomplete extraction, it stops without removing any old files and names the affected paths. Preserve/reconcile those edits before trying again. Unlisted files are left alone, including any additional files you put in the old themes directory. Empty old directories are removed; directories containing additional files remain. If Windows file locking interrupts deletion, close Mynda, pause file synchronization, and rerun the command. It safely skips old files already removed.

To inspect cleanup without writing anything:

```bash
npm run source:cleanup -- --check
```

Neither `npm install` nor rebuilding the media tools is needed. Rebuild the application when you want the reorganized source in your packaged copy:

```bash
npm run test:package
```

Use `git add -A` when committing this update so Git records the old-file removals as well as the new locations. Fix76 can be committed first as its own checkpoint, or included in the same commit. The zip is based on the delivered fix76 working copy, including the unpushed auto-tagging safeguards.

## Where things live

| Location | Responsibility |
|---|---|
| `src/bootstrap.js` | Stable Electron entry point; chooses normal startup or the packaged media diagnostic |
| `src/main/` | Electron startup, windows, backend coordination, developer-extension loading, packaged media diagnostic |
| `src/renderer/` | React interface, renderer bootstrap, HTML, and renderer state helpers |
| `src/renderer/styles/main.css` | Main interface rules and imports for bundled themes |
| `src/renderer/styles/themes/` | Appearance/layout stylesheets and their `_fonts` directory |
| `src/library/` | Library records, persistence, export, statistics, duplicates, filtering, content fingerprints, IDs, and box-office values |
| `src/scanning/` | Filename/folder detection, subtitle matching, exclusions, and runtime verification |
| `src/tagging/` | OMDb search, episode matching, and optional runtime evidence |
| `src/media/` | Technical metadata, resolution classification, executable discovery, MPV process control, and bundle checks |
| `src/sharing/` | Share manifests and file transfer orchestration |
| `src/platform/` | Logging, generic application-data storage, and downloads |
| `src/legacy/` | Retained older playback code; excluded from production builds |
| `images/` | Shared application image assets |
| `scripts/` | Developer preparation, verification, and migration commands |
| `test/` | Automated tests and fixtures |
| `vendor/media-tools/` | Prepared platform media binaries; copied into application Resources during packaging |

The source move preserves the existing module filenames. The large backend and OMDb files can be split into smaller modules in a separate change.

## Bundled themes and future user themes

The main stylesheet imports the bundled appearance and layout themes directly. The old `settings.themes` fields are not currently used to select stylesheets. New-library defaults point to the new locations; existing libraries do not need a data migration.

These bundled themes are application resources. Future editable user themes should be stored in a writable user-data directory and loaded explicitly. They should not require editing the installed application's archive.

Fonts use paths relative to their theme stylesheet. Image URLs inside CSS custom properties resolve relative to the stylesheet that consumes those properties—currently `main.css`. For that reason the icon variables use `../../../images/...`, while font-face declarations retain `../_fonts/...`. See the [CSS custom properties specification](https://www.w3.org/TR/css-variables-1/#syntax).

## What checks this reorganization

- `npm run test:paths` is an integration suite. It resolves relative imports in source, scripts, and tests; checks exact capitalization even on case-insensitive systems; follows renderer images, CSS imports, themes, and fonts; and verifies source/asset contents in an actual ASAR archive using electron-builder's file matcher.
- `SourceReorganization.integration.test.js` uses disposable projects to check backups, incomplete overlays, unexpected edits, CRLF handling, safe repeat runs, and path boundaries.
- `npm run test:electron` runs the same real application journey from a disposable source directory and then from a source/assets ASAR archive. Both runs launch from a different working directory and load all bundled images, the five font families, both themes, and the theme icon variables. Both use an isolated library and a fake OMDb key.
- `npm run test:electron:asar` runs only that second journey. Its archive shares installed npm dependencies from the temporary parent folder; it is a source/resource path check. The full production dependency and media-bundle check remains `npm run test:package`.

The core/fast suites and `test:all` include the new checks in their appropriate categories. The source audit recognizes the deliberately untracked root `omdb.js` configuration; archive and Electron fixtures supply their own fake key without reading or copying yours.

## Delivery validation

The fast suite passed all 40 suites and 356 named cases. The path audit checked 227 relative module references and 51 resource references. The archive check verified 107 source/asset files, including unchanged image/font bytes.

Real Electron 12 GUI checks were attempted in the coding environment, but the runtime crashed with SIGABRT/SIGSEGV before reporting a result. The unchanged fix76 baseline also aborted with the same native futex error. These GUI checks therefore remain unverified here and should be run on your Mac with `npm run test:electron`. Full native packaging also requires the prepared media-tool stage on your own build machine; `npm run test:package` performs that check.
