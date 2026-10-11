# Testing Mynda

This test suite is the safety net for modernizing Electron, React, and Mynda's other dependencies. It checks several different boundaries: small calculations, modules working together through real temporary files, React components, and the actual Electron application.

All automated tests use fixtures or disposable directories. They do **not** open, alter, or delete the real library in Electron's platform-specific `userData` directory. The Electron test creates a temporary copy of the application and points both of its processes at a temporary `userData` directory.

Use `npm run test:list` for the current catalog and each test run's final summary for suite and case totals. The catalog includes fast tests and four Electron end-to-end suites: startup/assets and library-save workflows, each in source and ASAR form. Before media-tool setup, `npm run test:core` excludes the two fast suites that require native media tools. Some named cases check entire fixture collections, including 2,657 episode-title pairs from both libraries.

## The first commands to learn

Open Terminal, PowerShell, or your Linux shell, move into the Mynda project, and run:

```bash
npm test
```

`npm test` is the everyday command. It runs every unit, integration, and React component test, but does not launch Electron. It should take only a few seconds.

On a new development machine, start with `npm run test:core`. This runs all fast suites except the two that execute real FFmpeg/FFprobe/MPV binaries. Once `npm run media:prepare` has completed for that machine, use `npm test` for the complete fast suite. `npm test` continues to fail if required media tools are missing; building an Electron package is not a prerequisite for tests.

The complete command set is:

| Command | What it runs | When to use it |
|---|---|---|
| `npm test` | All fast tests | Before and after ordinary code changes |
| `npm run test:core` | Fast suites that do not require media executables | Before native media preparation on a new machine, or while diagnosing its toolchain |
| `npm run test:list` | Test catalog only | To see what exists without running anything |
| `npm run test:unit` | Unit tests | While changing calculations or one helper module |
| `npm run test:integration` | Integration tests | While changing storage, IPC-facing models, logs, or Share |
| `npm run test:component` | React component tests | While changing renderer state or UI components |
| `npm run test:renderer` | Same as `test:component` | A more memorable alias |
| `npm run test:electron` | Real Electron startup/assets and library-save/restart workflows, from source and ASAR | After Electron, React, preload, bundle, or library-save changes |
| `npm run test:all` | Fast tests plus Electron | Before committing an upgrade or preparing a release |
| `npm run build:renderer` | Compiles the browser renderer and sandboxed preload | To check browser-only dependencies without launching Electron |
| `npm run media:prepare` | Builds and stages the current machine's pinned native media sidecars | Once on each packaging platform, or after changing their versions |
| `npm run media:status` | Shows the resolved path and source of FFmpeg, FFprobe, and MPV | To detect a staged, packaged, override, system, or missing tool |
| `npm run media:verify` | Checks license flags, versions, architecture, DVD/video support, and native dependency closure | Before diagnosing a media build or package failure |
| `npm run test:media` | Strict staged FFmpeg/FFprobe checks plus real node-mpv → MPV graphical video over JSON IPC | After preparing or changing media dependencies; briefly opens MPV |
| `npm run test:package` | Fast tests, strict media verification, unpacked production build, then packaged decode/probe/graphical-MPV checks with an empty `PATH` | Before a release; briefly opens MPV and writes under `dist/` |

The Electron test briefly opens Mynda and its DevTools. That is expected. Both source and ASAR runs verify startup, the first render, creation of an isolated first-launch library, opening Settings and its Library statistics, and closing Settings. They then save a preference through the real renderer-to-backend connection and confirm it in the temporary library file. Finally, they request normal window closure and verify that the graceful-close handshake flushes a deferred renderer save before closing. Unexpected dialogs fail the test without opening an interactive modal; failure teardown records the result and exits the isolated process directly. The tests never use your real library.

The startup suites check the actual window preferences, absence of renderer Node/Electron globals and generic bridge messaging, frozen capability groups, and blocking of inline scripts and `eval`. They also activate real IMDb links, verify that the main process approves their browser destinations, and reject unsafe URL requests. They attempt a popup, page navigation and an embedded frame, and make a real geolocation request. That request must return `PERMISSION_DENIED`, and the test must observe Mynda's production handler denying it for the tested renderer. An OS-only denial, unavailable location or timeout fails. A test observer forwards the installed handler's answers unchanged; `shell.openExternal` is replaced with a recorder so the tests do not open your browser or fetch IMDb. Chromium's guards, React events and IPC are real.

The native test makes an actual geolocation request and observes Mynda's permission decision without altering it. Modern Chromium can deny that request in the synchronous check handler before invoking the asynchronous request handler, so both paths are observed. A denial must belong to the tested window and the geolocation permission; an OS-only denial, timeout, or unavailable service cannot pass. This also avoids the historical Electron 12 permission-status issue: `navigator.permissions.query()` alone was not proof of the application policy.

The library workflow suites open a separate app with three synthetic videos and a temporary watchfolder. They perform the following through the real rendered controls and application IPC, then close and start a **new Electron process** against that same temporary library:

| Workflow | Automated assertion |
|---|---|
| Editor rating | A four-star edit is committed and reappears in the editor after restart; catalog ratings remain unchanged. |
| Scan and editing | The real scanner pauses at a fixture metadata probe. An editor save completes before the probe is released, an unsaved draft survives the resulting refresh, and both user edits and new technical metadata persist. |
| Auto-Tag and editing | The real Auto-Tag runner pauses at a fixture catalog response. A manual title correction wins, the late result records a conflict, and the video remains retryable. |
| Batch editing | Two selected videos receive the intended field change; their other fields and an unselected third video remain intact. |
| Settings and closing | Two actual preference checkboxes change in one turn; immediate window closure flushes both before their normal debounce expires. The restarted UI shows both values. |
| Playback history and resume | Controlled MPV events drive the main-process playback service and rendered Player pane; its actual Recently Played timer fires, position and seek events save, and restarted playback receives the saved resume position. |

Metadata probes, catalog responses, and the external MPV process are fixtures, so these save tests require no real media collection, service credentials, quota, or player installation. They do not certify actual decoding, sound, or live catalog availability; `test:media` and `test:package` exercise real native media tools separately. The fixtures are installed only in the main test process. The app uses its production sandboxed preload and compiled renderer; there is no custom test preload, renderer `require()`, test IPC channel, or injected React component. The main-side browser driver operates DOM controls, and authoritative library checks remain in main. Everything else in this journey, including React controls, the scan/tag runners, playback service, library client/backend, file writes, and application close/restart, is real. Unexpected dialogs fail noninteractively. The tests launch several disposable windows, and report the failing workflow stage if one does not complete.

To run just these new journeys:

```bash
node test/electron/run-electron-smoke.js --library
node test/electron/run-electron-smoke.js --library --asar
```

To run one test file while working on a failure:

```bash
node test/MovieSearch.unit.test.js
```

## Renderer and preload builds

Use Node 24 for development (`.nvmrc`); the minimum is Node 22.12. After applying the Electron 44.7.0 upgrade, run `npm ci`, then `npm run electron:install` to download the pinned native runtime. Electron now installs its executable on first use, so `npm ci` alone need not download it. `npm start` compiles the browser renderer and sandbox preload before launching. `npm run build:renderer` rebuilds them without launching the app. The same compiler runs before each native test stages its disposable source/ASAR copy, including when its test file is invoked directly. The electron-builder hook always creates a production bundle before media verification, even if electron-builder is invoked directly.

The generated `src/renderer/generated/renderer.js` targets Chromium 152. The preload's `src/preload/generated/preload.js` targets Node 24 and retains only its permitted Electron import. Both generated files are included in packages and excluded from Git. Source and ASAR native tests exercise development and production renderer bundles respectively. Source maps stay local; production maps omit embedded source contents.

The renderer build fails on any Node builtin or Electron import; no filesystem/process shims are installed. It always compiles current source bytes, so source overlays with unchanged timestamps cannot revive Babel's old persistent cache. Runtime JSX compilation is removed. Browser-build regression tests execute an updated JSX fixture without `require`, `process`, or string code generation, reject privileged imports, retain the previous complete bundle on compilation errors, and verify production build ordering. Source-layout tests also compile the real entry point and verify byte-for-byte renderer/preload inclusion in an actual ASAR archive.

## Library save architecture and checks

The backend owns the committed library and its only ordinary disk writer. The renderer loads a confirmed, immutable snapshot over IPC, submits commands, and applies revisioned commits. A save succeeds only after the candidate was written atomically and the renderer has incorporated its result. Failed writes leave the previous committed state intact. The JSON format, backup retention, recovery, and export behavior remain compatible.

Scans and Auto-Tag do filesystem/network work outside the commit queue. They submit small, ready batches; user edits take priority between commits, with fairness for background progress. Playback updates only position, and editor/settings changes carry field baselines. Disjoint changes merge against current state; conflicting manual changes are preserved. An Auto-Tag conflict records a readable explanation and leaves the video eligible for a retry.

Closing flushes already-requested editor saves, deferred settings changes, and playback positions, then drains ready backend commits. It does not wait for an entire scan or catalog lookup and does not automatically save an unsubmitted editor draft. If completion cannot be confirmed, the user can wait, cancel closing, or explicitly quit without saving. A single-instance lock prevents two normal app launches from writing the same library.

The focused non-GUI suites above run under both `npm run test:core` and `npm test`; persistence/protocol fixtures use disposable files and controlled IPC. Run `npm run test:electron` to automate the normal rating, concurrent-edit, batch, preference, history, and restart checks described above. Before release, run it on each supported native platform. Real drive availability, large-library performance, native dialog behavior, and audiovisual playback remain useful checks with representative user data.

## External-content boundary

The editor's catalog results and autotag report share `ExternalLink.js`. Supported links open in the user's default browser through `window.mynda.external.open()` and the private `external:open` channel; the main process checks the exact registered application window, its main frame and application-file URL before invoking the operating system. `ExternalLinks.js` defines the approved destinations. Currently these are HTTPS IMDb title pages only. New provider links must extend that explicit policy and its tests; arbitrary URLs from catalog data are not passed to the OS. Invalid identifiers remain plain text, and a failed browser launch produces a user-visible message.

`ExternalContent.js` installs the policy before the application page loads. It blocks page-driven navigation, redirects, both Electron 12 and newer popup paths, and webview attachment. Navigation and popups are never automatically forwarded to the browser. Both permission checks and permission requests deny access by default; the web UI does not need hardware, location or browser protocol permissions. MPV remains a separate native process. The page's CSP permits only local external scripts, blocks inline scripts and `eval`, forbids renderer network requests, embedded frames/objects, workers, base-URL changes and form navigation, and retains the styles, fonts and artwork used by the interface.

The application window disables Node integration, enables context isolation and the Chromium sandbox, and loads a bundled preload exposing only `window.mynda` capabilities. Modern Electron no longer contains the retired `remote` module. The main process independently checks the registered main-frame caller and validates operation data. Library mutations have their own renderer-edit policy, and file/process operations belong to backend services. Unit tests exercise hostile URLs, callers, malformed requests, unauthorized file access and permissions; component tests cover the UI; native tests check actual Electron enforcement in source and ASAR launches.

Validation baseline: Torgo confirmed that the isolation migration and editor-list fix passed tests and built successfully at commit `9071d28`. The upgrade preserves that checkpoint and places compatibility preparation in a separate commit before the runtime bump.

Electron 44 verification: all 79 fast suites (2,929 checks) passed using Electron's embedded Node 24.21.0. Compilation and actual ASAR archive checks pass with the updated packaging dependencies. The native startup attempt stopped because the editing host has no usable X display/local socket support; a minimal Electron window also fails. No native GUI or release-package result is claimed from that host. The Linux media bundle is absent there, so a full packaged media test cannot run.

On the Mac, run `npm test`, `npm run test:electron`, and `npm run test:package`. Repeat the native and package checks on Windows; Ubuntu remains a release validation task. The upgraded startup journey exercises a real disk-backed DOM File without `.path`, cancellation and approval through the production artwork bridge, a dropped-image preview, and a saved copy. Component tests cover stale drop replies after Revert, changing videos, unmounting, and a newer drop. Console diagnostics handle modern Electron's event object. Before accepting the upgrade, also try normal development startup, a Finder artwork drop, native Browse dialogs, video playback/seek/subtitles, and a packaged launch. Development should open DevTools; the packaged app should not.

## What the categories mean

The categories describe the size of the boundary under test—not whether a test is important.

| Category | Plain-English meaning | Example |
|---|---|---|
| **Unit** | One function or module is tested in isolation. Expensive or unpredictable neighbors are replaced with controlled test doubles. | Decide which OMDb result best matches a filename without using the network. |
| **Integration** | Several real pieces work together. Mynda's disk tests use real files, but only inside a temporary directory. | Save a library atomically, corrupt it, and restore its newest valid backup. |
| **Component** | A real React component is constructed or rendered, with the browser/Electron boundary controlled. | Render navigation and verify that the New tab appears only when new videos exist. |
| **End-to-end (E2E)** | The actual desktop application starts in Electron and is operated from the outside like a small user journey. | Launch Mynda, verify its panes, open Settings, then close it. |
| **Packaging smoke check** | The release tool assembles an unpacked application, launches it without a system executable search path, and proves its bundled production media dependencies run. | `npm run test:package` |

A “test double” is simply a small, predictable substitute for something outside the subject of a test—for example, a pretend FFmpeg process that emits the same events as the real process. A “fixture” is known sample data, such as one complete movie record. An “assertion” is the expected result that makes a test pass or fail.

## Every automated suite and its category

| Suite | Category | What it protects |
|---|---|---|
| `ArtworkEditor.component.test.js` | Component | modern File drops, native cancellation, inspection errors and stale responses |
| `ElectronConsole.unit.test.js` | Unit | warning/error diagnostics across console event API changes |
| `MainBridge.integration.test.js` | Integration | real main composition, isolated window options, complete handler registration and privileged caller checks |
| `EditorArtworkDownload.unit.test.js` | Unit | HTTP protocols, size/time/redirect bounds, native redirect approval and temporary-file cleanup |
| `DesktopService.unit.test.js` | Unit | native directory grants, owner-bound Share plans, watchfolder saves and exported-file reveal |
| `RendererBridge.unit.test.js` | Unit | fixed capability surface, trusted senders, plain bounded payloads, stripped Electron events and isolated subscriptions |
| `LibraryRendererPolicy.unit.test.js` | Unit | scanner fields, filesystem grants, watchfolder boundaries and malformed library operations |
| `EditorService.unit.test.js` | Unit | canonical video identity, owner-scoped catalog proposals and validated artwork/subtitle operations |
| `PlaybackService.unit.test.js` | Unit | authoritative media selection, process lifetime, position conflicts and confirmed playback saves |
| `Player.component.test.js` | Component | named playback requests, notifications, close flush and out-of-order state |
| `ExternalLink.component.test.js` | Component | shared browser-link component, approved IPC, keyboard/mouse activation and malformed catalog IDs |
| `ExternalContent.unit.test.js` | Unit | approved browser destinations, trusted main-frame IPC, blocked navigation/popups/embeds and denied permissions |
| `ElectronSmokeLifecycle.unit.test.js` | Unit | noninteractive failure teardown, preserved result output, graceful-close ordering and saved-data verification |
| `ElectronPermissions.unit.test.js` | Unit | unchanged forwarding of production permission decisions and rejection of OS-only denials or lookup failures |
| `LibraryTransactions.integration.test.js` | Integration | overlapping process edits, confirmed state, disk failures, stale identity conflicts, atomic moves, user priority and revision recovery |
| `SingleInstance.unit.test.js` | Unit | early process locking, secondary-instance exit, window focus and packaged smoke isolation |
| `LibraryClose.unit.test.js` | Unit | renderer flush, outstanding commits, close cancellation, explicit discard and bounded shutdown waits |
| `LibraryScanOperations.unit.test.js` | Unit | fresh-record merging, active/inactive moves, watchfolder ownership and stale scan results |
| `AutoTagConcurrentEdits.integration.test.js` | Integration | lookup baselines, late manual changes, coherent conflict skips and accurate saved-result accounting |
| `LibraryEditing.component.test.js` | Component | draft retention, delayed and failed saves, batch field diffs, settings transactions and playback-only patches |
| `AutoTagStorage.integration.test.js` | Integration | disk-full and permission errors, atomic-write rollback, retry eligibility, queues and visible failure dialogs |
| `RendererStartup.integration.test.js` | Integration | same-timestamp source updates, browser execution without Node/eval, forbidden imports, CSP and packaging compilation order |
| `SiblingNumbering.integration.test.js` | Integration | independent exact witnesses, release scope, conflicting offsets, saved evidence, shuffled order and shared episode lookup fallback |
| `TaggingReport.unit.test.js` | Unit | historical decisions, provenance, numbering, runtime, bounded candidates and safe error explanations |
| `AutotagReport.component.test.js` | Component | saved-video binding, collapsible selectable reports, keyboard semantics, stale edits and navigation |
| `SeriesEvidence.integration.test.js` | Integration | recorded parent observations, positive season counts, inferred seasons, bounded candidates, release suffixes and numbering origins |
| `EpisodeTitleAnnotations.integration.test.js` | Integration | recorded annotation pairs, original title evidence, exact corrections, duplicate cores, parts and fuzzy sanity |
| `SeriesStructure.integration.test.js` | Integration | two-season lower-bound counts, single-season upper bounds, cross-season contradictions, duplicates, catalog gaps and request budgets |
| `SeriesCollection.integration.test.js` | Integration | cross-season identity, explicit conflicts, independent witnesses, repeated series prefixes, final retry outcomes and shuffled processing |
| `TaggingEditor.component.test.js` | Component | manual identity authorship, retained automatic evidence, one application per confirmed preview and stale selection rejection |
| `TaggingArchitecture.integration.test.js` | Integration | final acceptance ownership, shared budgets, durable identity provenance, run boundaries and exhaustive small-batch permutations |
| `TaggingPrecision.integration.test.js` | Integration | short titles, independent sibling evidence, order conflicts, ambiguity, cancellation and movie title expansion |
| `CatalogClient.unit.test.js` | Unit | concurrent reuse, transient failure eviction, session scope and deduplicated episode probes |
| `SeriesSearch.unit.test.js` | Unit | full-title identity, reviewed aliases, cleanup, query caps and explicit region constraints |
| `OmdbSeries.integration.test.js` | Integration | new discovery queries, preserved episode checks, bounded pagination, batch query sharing and retryable errors |
| `HistoricalTagging.integration.test.js` | Integration | 1921 recorded searches and 63 individual numbering corrections from the project history |
| `HistoricalMovies.integration.test.js` | Integration | 73 individual movie improvements from the saved before/after libraries and corrected catalog IDs |
| `OmdbHistoricalBehaviors.integration.test.js` | Integration | named artwork fallbacks, failed-download caching, series-ID handoff, explicit IDs and batch choices |
| `AutoTagRecovery.integration.test.js` | Integration | directory-scoped sibling evidence, single bounded retry, final save order, cancellation, and per-file statistics |
| `SourceLayout.integration.test.js` | Integration | case-correct module references, renderer resources, relocated themes/fonts, default media roots, and actual ASAR contents |
| `SourceReorganization.integration.test.js` | Integration | verified backups, complete-overlay checks, edited-file preservation, Windows line endings, and repeatable cleanup |
| `EpisodeMatch.unit.test.js` | Unit | 2657 reviewed title pairs, strict correction boundaries, broad runtime checks, and cached optional probes |
| `ShowDetection.unit.test.js` | Unit | shared scan/reset parsing, dedicated extras, mixed folders, season-zero specials, and existing release conventions |
| `OmdbEpisodes.integration.test.js` | Integration | current-tag precedence, optional folder years, recorded corrections, series validation/cache, runtime vetoes, and exact-ID overrides |
| `PlaylistFilter.test.js` | Unit | playlist syntax, operators, security limits, cache, and runtime errors |
| `TableSelection.test.js` | Unit | single, toggle, range, cross-table, and ordered selection behavior |
| `ReactDevTools.test.js` | Unit | development-only extension loading, packaged skip, and failure handling |
| `BoxOffice.unit.test.js` | Unit | fixed-USD input, invalid values, locale presentation, and compact thresholds |
| `LibraryDuplicates.unit.test.js` | Unit | path normalization, scan reconciliation, and offline retention |
| `LibraryStats.unit.test.js` | Unit | viewing totals, visible-title series grouping, resolution tiers, and global duplicates |
| `VideoResolution.unit.test.js` | Unit | all bucket boundaries, crops, anamorphic ratios, portrait video, panoramas, and unknown metadata |
| `PackageConfig.unit.test.js` | Unit | file boundaries, staged sidecars, strict package commands, and retired HLS code |
| `MediaTools.unit.test.js` | Unit | packaged/staged sidecar paths, executable validation, and development fallbacks |
| `MediaToolPolicy.unit.test.js` | Unit | LGPL-only FFmpeg flags, nonfree rejection, and required MPV DVD/native video support |
| `MediaBundleVerifier.unit.test.js` | Unit | source pins, graphical MPV, libdvdcss exclusion, architecture, and native dependencies |
| `MediaBundleInspection.unit.test.js` | Unit | PE/ELF architecture, dependency closure, app-relative loading, and prohibited libraries |
| `MediaPlatformPreparation.unit.test.js` | Unit | native host dispatch, source pins, build baselines, and platform-specific recipes |
| `MediaMetadata.unit.test.js` | Unit | playable video selection, cover-art rejection, aspect ratios, fallback merging, legacy rechecks, and scratch output |
| `MovieSearch.unit.test.js` | Unit | filename parsing, search variants, candidate scoring, and confidence |
| `SubtitleMatcher.unit.test.js` | Unit | sidecar assignment, ambiguity, folder boundaries, and manual provenance |
| `VideoExclusion.unit.test.js` | Unit | candidate classification, preferences, probing, and conservative retention |
| `VideoRuntimeVerifier.unit.test.js` | Unit | FFmpeg packet thresholds, errors, early EOF, and timeout cleanup |
| `RendererUtils.unit.test.js` | Unit | batch edits, ratings, validation/repair, portable URLs/labels, DOM ancestry, and diffs |
| `Player.unit.test.js` | Unit | attempt logging, media availability, concise errors, launch avoidance, timeouts, socket cleanup, DVD load events, and process exits |
| `MpvProcess.unit.test.js` | Unit | native IPC paths, platform video selection, sidecar launch isolation, JSON IPC, and diagnostics |
| `MediaBuildCache.integration.test.js` | Integration | verified checkpoints, locked-file retries, preserved compiler outputs, safe replacement, and interrupted publication recovery |
| `ContentFingerprint.integration.test.js` | Integration | fixed hash vectors, distributed samples, file sizes, DVD normalization, cache validation, and read failures |
| `VideoIdMigration.integration.test.js` | Integration | metadata/history preservation, cross-library IDs, resumable conversion, explicit archiving, collisions, and guarded installation |
| `MediaDependencies.integration.test.js` | Integration | node-mpv JSON IPC startup, real graphical output, decoding/probing, and MPV DVD capability |
| `MediaMetadata.integration.test.js` | Integration | actual FFprobe and FFmpeg fallback selection of videos with cover art, genuine MJPEG, and cleanup on failure |
| `LibraryPersistence.integration.test.js` | Integration | validation, atomic saves, snapshots, retention, recovery, and damaged bytes |
| `Library.integration.test.js` | Integration | first launch, migrations, operations, IPC boundary, idle waits, and recovery |
| `Logger.integration.test.js` | Integration | file routing, visible renderer DEBUG output, forwarding, secret redaction, rotation, and shutdown |
| `ReadWrite.integration.test.js` | Integration | defaults, main/renderer paths, persistence, and malformed-file replacement |
| `ShareManifest.integration.test.js` | Integration | schema, checksums, inventory, hostile paths, error codes, and atomic files |
| `ShareService.integration.test.js` | Integration | request, fulfillment, import, copies, conflicts, cancellation, and expiration |
| `RendererComponents.component.test.js` | Component | progress language, listener cleanup, navigation, Play Next, resolution cells, dimension tooltips, and bucket sorting |
| `SettingsLibrary.component.test.js` | Component | export IPC, aligned statistics, per-video duplicate folders, rescan guidance, and file-manager actions |
| `Mynda.component.test.js` | Component | ratings, filtering, search, recent history, IPC, view state, and pane topology |
| `electron/run-electron-smoke.js` | End-to-end | startup/assets, Settings, renderer saves, disk-backed artwork drops, approved browser links, blocked navigation/popups/frames and denied permissions |
| `electron/run-electron-smoke.js --asar` | End-to-end | the same UI/assets journey from an actual source-and-assets archive; separate from the full bundled-media packaging test |
| `electron/run-electron-smoke.js --library` | End-to-end | rating, scan/edit concurrency, Auto-Tag conflict, batch scope, deferred preferences, playback history and restart durability |
| `electron/run-electron-smoke.js --library --asar` | End-to-end | the complete library save/restart journey from an archived application with controlled external service/player fixtures |

`npm run test:list` prints the same catalog from the file the runner itself uses, so the documentation and the executable selection are easy to compare.

## Unmatched-show recovery integrated with fix78: fix79

See [FIX79.md](FIX79.md) for the integrated change summary. The core run passed
all 44 suites and 2,489 cases, including the complete fix78 historical suite and
fix79's 198 release-label, 30 miniseries, Doctor Who, MST3K and numbering cases.
Release fields cannot swallow edited text such as `1080p fan edit`. Automatic
retries share fix78's discovery session and retain cancellation, save order and
one final disposition per processed file.

`HistoricalTaggingReplay.json` and its expected IDs are unchanged. Two Prisoner
cases use documented supplements in `HistoricalTaggingSupplements.json`: the
1967 row from their recorded yearless query is provided to the new year-filtered
query. These supplemental responses are controlled fixtures, not new live
recordings. Two prior Doctor Who surviving-clips expectations in the separate
title-pair corpus are corrected to reject full-episode matches.

These tests do not measure live catalog availability or the recovered count in
a new autotag run. Electron, real-media and packaged-application validation is
separate from the core run.

## Series discovery and individual historical regressions: fix78

The [complete case inventory](test/TAGGING_REGRESSIONS.md) lists every recovered
historical search, all 73 fix03–fix05 movie improvements, all 63 recorded episode
corrections, and the named workflow checks. These are tests of the actual tagging
code with controlled responses. They do not query OMDb or touch your library.
Each historical search/movie/correction has its own named PASS/FAIL result.

Run everything with `npm test`, or use these files when investigating tagging:

```bash
node test/SeriesSearch.unit.test.js
node test/OmdbSeries.integration.test.js
node test/HistoricalTagging.integration.test.js
node test/HistoricalMovies.integration.test.js
node test/OmdbHistoricalBehaviors.integration.test.js
node test/EpisodeMatch.unit.test.js
node test/ShowDetection.unit.test.js
node test/OmdbEpisodes.integration.test.js
node test/MovieSearch.unit.test.js
```

Fix78 first tries the existing series resolver. If discovery is exhausted, it
tries bounded spelling/spacing queries, recognized series-tag annotations, and
reviewed aliases such as SATC, House MD, MST3K, The Office US, and DanMachi.
A keyword result must still match the complete series identity. The Office US
cannot silently become the UK adaptation. Several same-name candidates still
require an unambiguous episode-title match or a user selection. Title/runtime
checks and exact-title requirements for numbering corrections remain in force.

The historical replay also found that fix76 treated some release-only **title
tags**, such as `WandaVision.S01E01.720p.WEB...`, as meaningful conflicting episode
titles. These can now acquire the actual episode title when the existing tag
contains only the known series, numbering, and recognized release details. A
meaningful edited title remains authoritative; the helper does not re-read the
filename to override it. Seventy replay cases failed against fix77 and pass
with fix78. Old Loglady and other confirmed/unconfirmed bad matches remain
rejections rather than being restored as successes.

Series queries and definitive no-result responses are reused within one Auto-Tag
batch. Network/quota errors remain retryable. INFO logs now contain `Series
discovery diagnostics`, successful fallback recoveries, and `Automatic tagging
series discovery summary`, including request/reuse counts. This makes another
"Series not found" run diagnosable without requiring DEBUG file logging.

To retry previously attempted unmatched videos, select the affected episodes
and use **Auto-Tag Selected**. Ordinary whole-library Auto-Tag continues to skip
videos already marked attempted. Installing this patch does not change stored
tags, retry flags, display series names, or local season/episode numbers.
An existing wrong IMDb ID still needs clearing or Reset from Filename before
retrying, as described below. No `npm install` or `media:prepare` is needed.

The 1,153 historical Atelaes failures are a starting dataset, not a promised
recovery count. An actual retry is needed to measure current OMDb coverage;
these offline tests cannot prove that every catalog record is available now.

## Episode auto-tag safeguards: fix76

Run these checks individually, or use `npm run test:core` / `npm test`:

```bash
node test/EpisodeMatch.unit.test.js
node test/ShowDetection.unit.test.js
node test/OmdbEpisodes.integration.test.js
```

The unit corpus includes all 84 accepted episode-title warnings in Atelaes'
September 13 logs. It marks 53 clear contradictions for rejection, retains 30
reviewed wording/multipart variations, and treats the remaining generic
Ghost in the Shell title as inconclusive. The integration suite additionally
rejects that placeholder under an unconfirmed series, including the case with
no useful local title. It also replays the 16 successful Lost/Dead Like Me
numbering corrections from those logs.

The other 2,573 comparison pairs come from Torgo's uploaded library snapshot:
scan/reset-derived title text versus the stored reference title. This exercises
ER release flags, Heroes chapter prefixes, compact MST3K release names,
Quantum Leap date suffixes, Seinfeld's alternate title, and many ordinary
episodes. Thirteen pairs contain conflicting content/part labels and are
explicitly recorded as contradictions. These are comparison fixtures, not a
claim that every saved reference tag is correct or a live re-tag of the library.
Fixtures contain title/series/numbering only, with no personal media paths,
library identifiers, media bytes, or API credentials.

Auto-Tag's current editable title, series and IDs remain authoritative. A
matching folder can still supply a missing series premiere year; it cannot
replace a tagged series, and an explicit year in the series field wins. Series
display names and local season/episode numbers keep their existing behavior.
Nearby/adjacent-season correction still requires a unique exact normalized
title. The forgiving comparison only judges whether the requested episode is
plausible. Failed matches do not apply catalog metadata or download artwork.
Selected-series batch preflight can try up to three distinct representatives,
so one bonus or conflicting entry cannot needlessly block the whole batch.

Runtime is an optional second check using the specific episode's `Runtime`.
The initial threshold requires both a gap greater than five minutes and a
ratio greater than four. DVDs and tags indicating split/combined episodes are
incomparable for this check. Missing duration does not itself fail a match.
When useful catalog runtime exists but local duration is missing, a seven-second
FFprobe query may supply it; repeated requests share the result. Failed probes
are cached for one minute, then become retryable. No title is extracted by this
technical metadata query. The unit suite controls probes; these three new
suites need no media executables or network service.

Dedicated Extras folders now yield `season: "extras"` during scanning or
Reset from Filename even if the shorts have their own ordinary-looking
numbers. Explicit season-zero specials and episodes in mixed `Season 1 + Extras`
folders remain supported. Extras stay in the library. Existing tags are not
rewritten by installing the patch.

To retry an earlier wrong match, use **Reset from Filename**, or correct the
identifying tags and clear the wrong IMDb ID, save, then Auto-Tag. An existing
exact IMDb ID deliberately keeps its authoritative lookup behavior.

These tests exercise logic and orchestration using recorded pairs and controlled
responses. They do not certify every episode in either library, run live OMDb
requests, or verify native Electron startup. No npm install or media rebuild is
required for fix76.

## Windows first-run failures and fix72

The first Windows run reported 16 failed cases in eight suites. They had three causes:

| Failed cases | Cause | Resolution |
|---|---|---|
| 9 | Cross-platform tests mixed Unix path literals with the host's Windows path operations, or expected unnormalized Unix fixture paths in the UI | Target-specific path helpers and native absolute fixtures; no media build required |
| 4 | No usable FFmpeg/FFprobe executables were found | Complete `media:prepare` on Windows, then rerun `npm test` |
| 3 | Share tried to flush files through read-only handles | Fix72 opens the existing temporary files with `r+`, retaining their bytes and propagating real flush errors |

Windows requires a writable handle for its file-buffer flush operation. See [Microsoft's FlushFileBuffers documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers). Regression tests enforce that constraint while using real temporary files on any host, and verify that a simulated disk failure preserves the previous manifest or removes the incomplete media copy.

`test:core` still covers library persistence, Share, fingerprinting, migration fixtures, settings, player orchestration, and the media path/policy helpers. Its success does not certify executable availability, playback, or packaging. The two real-media suites remain mandatory in `npm test`, `test:all`, and `test:package`. Use `MEDIA_TOOLS.md` for Windows setup and command order. A new library does not need ID migration; the migration tests only operate on disposable fixtures.

The Windows build-cache suite runs in `test:core` on every host. It does not need MSYS2 or launch media tools. It tests real files with controlled failures in filesystem operations; a passing run does not prove native Windows compilation or playback. Fix75's resumable preparation workflow is documented in `MEDIA_TOOLS.md`.

## Content ID and migration checks

The two new suites are **integration tests**: they use actual temporary media files, DVD directory structures, library JSON, and the migration CLI. They verify both intended behavior and refusal to install incomplete or changed results. They run under `npm test`, or individually:

```bash
node test/ContentFingerprint.integration.test.js
node test/VideoIdMigration.integration.test.js
```

`npm run library:migrate` is a separate operational command, **not a test**. It reads the selected real library and media to prepare conversion. Only its explicit `--install` stage replaces that library. Follow `MIGRATING_VIDEO_IDS.md`; keep Mynda closed during conversion and use only the updated app afterward.

After conversion, the manual acceptance pass should include edited metadata, Recently Played, resume positions, scanning a copied file as a duplicate, a representative DVD, and a fresh Share request between two converted libraries. The automated fingerprint fixtures prove byte-level rules, but cannot substitute for reading the actual media on your computers.

## Resolution checks

Playlist cells, resolution sorting, and Library statistics all use `src/media/VideoResolution.js`. Labels are calculated from technical metadata; no derived resolution string is saved in a video. Unknown values sort last in either direction. Hovering over a playlist resolution shows stored pixel dimensions and, for anamorphic video, the adjusted display dimensions.

The buckets are 8K, 4K, 1440p, 1080p, 720p, 576p, 480p, 360p, 240p, Below 240p, and Unknown. The helper corrects for pixel/display aspect ratio and uses the shorter/longer display edges, with a 5% allowance for small crops. Width can preserve the class of an ordinary widescreen crop (1920×800 is 1080p), but cannot promote a panorama wider than 3:1 (3840×1080 is 1080p). These are size categories; the `p` labels do not certify progressive scanning or picture quality.

FFprobe and the FFmpeg fallback exclude attached pictures and thumbnail streams, while accepting genuine MJPEG video. Older checked MJPEG metadata has not established that distinction, so it displays Unknown until one recheck during the next normal library scan. Unavailable watchfolders remain skipped. Other valid existing dimensions use the new buckets immediately; a media-tool rebuild is unnecessary.

To verify this change manually, compare a few playlist labels with their Library statistics, hover over cropped/anamorphic videos, and sort the Resolution column both ways. Automated coverage also creates tiny temporary video files with larger embedded cover images and checks both real metadata paths.

## How to read a test run

A successful section looks like this:

```text
[UNIT] Movie identification and OMDb candidate selection
  PASS  extracts a release title and year from a filename
  PASS  keeps an ambiguous result below the automatic-match threshold
  10/10 tests passed
```

The final summary reports both suites and cases. A suite is one test file; a case is one named behavior inside it. Three older suites contain many grouped assertions and count as one case each in the final total.

On failure, look for the first `FAIL` line. The indented stack trace shows:

1. what value was expected;
2. what value Mynda actually produced; and
3. the test filename and line number.

The runner continues with the other suites so one command can reveal whether a change caused one focused regression or several unrelated ones. It exits with a nonzero status when anything fails, which also makes it suitable for future continuous integration.

## Recommended upgrade workflow

Before changing Electron or React:

1. Run `npm test` on the current versions and fix any failures.
2. Run `npm run test:electron` and confirm the disposable startup journey passes.
3. Run `npm run media:prepare` once on each native packaging platform, then run `npm run test:package` to establish that its release toolchain and self-contained media stack run.
4. Save that passing state in Git or a separate archive.
5. Upgrade one major layer at a time rather than Electron and React simultaneously.
6. Run `npm run test:all` after each dependency step.
7. Run `npm run test:package` again before calling the upgrade complete.
8. Perform a short manual acceptance pass with a copy of a real library: scan, edit one movie, edit one show, play a file, play a DVD if used, and exercise Share.

The automated layers are particularly useful for an Electron upgrade. Unit tests reveal behavior changes in Node or dependencies; integration tests reveal filesystem and serialization regressions; component tests reveal React/rendering regressions; the E2E test reveals failures in Electron startup, main/renderer compatibility, module loading, IPC initialization, or basic interaction.

## Deliberate limits

No practical automated suite proves everything. These tests deliberately avoid:

- calling the live OMDb service or consuming an API quota;
- reading the real Mynda library or watchfolders;
- decoding an actual movie during the fast tests (the strict media check uses generated audio and one disposable 64×64 video frame instead);
- reading a real DVD folder (the strict media suite verifies MPV's DVD protocol, while a manual acceptance pass confirms a representative unencrypted DVD);
- approving native operating-system dialogs;
- judging pixel-perfect layout, animation quality, sound, or playback quality;
- testing every possible media filename or damaged file.

That is why the small manual acceptance pass remains part of the release checklist. The goal is not to eliminate human testing; it is to make regressions early, repeatable, and much easier to locate.

## If a command cannot start

If Node reports a missing package, run `npm install` in the Mynda folder and retry. If only the Electron test reports that Electron's executable is missing, Electron's installation/download did not finish; run `npm install` again before diagnosing Mynda itself. If `test:media` reports that the staged tools are missing, run `npm run media:prepare`; it will list absent Homebrew, MSYS2 UCRT64, or Ubuntu build prerequisites. Use `npm run media:status` when development may be finding a system copy unexpectedly. Packaged tests intentionally ignore media overrides and the system `PATH` so an installed player cannot mask an incomplete application bundle. MPV startup and load failures retain subprocess warning/error output in Mynda's log. See `MEDIA_TOOLS.md` for the complete preparation guide.

When reporting a failure, copy from the category header (such as `[INTEGRATION]`) through the final summary. That includes the useful context without requiring the entire Terminal history.

## Source organization and renderer resources (fix77)

See [SOURCE_LAYOUT.md](SOURCE_LAYOUT.md) for the current process boundaries, folder map, build outputs, and the historical one-time `npm run source:cleanup` procedure. The isolation migration requires `npm install`; it does not require a media-tool rebuild unless those tools changed independently.

`npm run test:paths` runs the focused import/resource/ASAR integration suite. It checks real paths and exact capitalization, including CSS imports, font files, placeholder images, rating logos, themes, and the browser/preload bundles. It also executes the real browser dependency initialization without Node globals or dynamic code generation.

`npm run test:electron` runs source and ASAR startup checks followed by source and ASAR library-save/restart journeys. All launch from outside the application directory. The startup checks cover the interface, Settings, images, fonts, theme stylesheets, and theme icon variables; the save journeys cover the workflows above. `npm run test:electron:asar` runs only the production-bundle ASAR startup check. `test:all` includes all four suites.

The ASAR journey deliberately shares installed npm dependencies from the temporary parent directory. It verifies source/resource paths inside an archive; `npm run test:package` separately assembles the complete native application and checks its bundled media dependencies.
