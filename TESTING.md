# Testing Mynda

This test suite is the safety net for modernizing Electron, React, and Mynda's other dependencies. It checks several different boundaries: small calculations, modules working together through real temporary files, React components, and the actual Electron application.

All automated tests use fixtures or disposable directories. They do **not** open, alter, or delete the real library in Electron's platform-specific `userData` directory. The Electron test creates a temporary copy of the application and points both of its processes at a temporary `userData` directory.

The current catalog contains 42 suites: 40 fast suites with 356 named cases, plus two Electron end-to-end suites (source and ASAR). Before media-tool setup, `npm run test:core` selects 38 suites with 349 cases. Some named cases check entire fixture collections, including 2,657 episode-title pairs from both libraries.

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
| `npm run test:electron` | Real Electron end-to-end smoke test | After Electron, React, Babel, or startup changes |
| `npm run test:all` | Fast tests plus Electron | Before committing an upgrade or preparing a release |
| `npm run media:prepare` | Builds and stages the current machine's pinned native media sidecars | Once on each packaging platform, or after changing their versions |
| `npm run media:status` | Shows the resolved path and source of FFmpeg, FFprobe, and MPV | To detect a staged, packaged, override, system, or missing tool |
| `npm run media:verify` | Checks license flags, versions, architecture, DVD/video support, and native dependency closure | Before diagnosing a media build or package failure |
| `npm run test:media` | Strict staged FFmpeg/FFprobe checks plus real node-mpv → MPV graphical video over JSON IPC | After preparing or changing media dependencies; briefly opens MPV |
| `npm run test:package` | Fast tests, strict media verification, unpacked production build, then packaged decode/probe/graphical-MPV checks with an empty `PATH` | Before a release; briefly opens MPV and writes under `dist/` |

The Electron test briefly opens Mynda and its DevTools. That is expected. It verifies startup, the first render, creation of an isolated first-launch library, opening Settings and its Library statistics, and closing Settings. It exits automatically.

To run one test file while working on a failure:

```bash
node test/MovieSearch.unit.test.js
```

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
| `SourceLayout.integration.test.js` | Integration | Exact import capitalization, renderer resources, relocated themes/fonts, default executable roots, and actual ASAR source/asset contents |
| `SourceReorganization.integration.test.js` | Integration | Verified old-file backups, incomplete overlays, unexpected edits, Windows line endings, and safe cleanup reruns |
| `PlaylistFilter.test.js` | Unit | Safe playlist expressions, allowed syntax, runtime errors, caching, and security limits |
| `TableSelection.test.js` | Unit | Single, toggle, range, cross-table, offscreen, and ordered row selection |
| `ReactDevTools.test.js` | Unit | Development extension path/loading, packaged-app skip, and graceful failures |
| `BoxOffice.unit.test.js` | Unit | Fixed-USD parsing, bad input, full and compact formatting, locale conventions, and no currency conversion |
| `LibraryDuplicates.unit.test.js` | Unit | Duplicate-path normalization, complete-scan reconciliation, and unavailable-watchfolder retention |
| `LibraryStats.unit.test.js` | Unit | Seen/unseen totals, exact visible-title series grouping, resolution tiers, percentages, and global duplicate totals |
| `VideoResolution.unit.test.js` | Unit | Shared labels/ranks, exact bucket cutoffs, crops, anamorphic ratios, portrait video, extreme panoramas, and unknown metadata |
| `PackageConfig.unit.test.js` | Unit | Production file boundaries, media staging, strict package commands, and retirement of the HLS player |
| `MediaTools.unit.test.js` | Unit | Target-platform paths on either host, Windows environment-key casing, overrides, bundled-path classification, and development fallbacks |
| `MediaToolPolicy.unit.test.js` | Unit | LGPL-only standalone FFmpeg flags, nonfree rejection, and required MPV DVD/video capabilities on macOS, Windows, and Linux |
| `MediaBundleVerifier.unit.test.js` | Unit | Pinned source policy, graphical MPV, architecture, exclusion of `libdvdcss`, and platform verification dispatch |
| `MediaBundleInspection.unit.test.js` | Unit | Windows PE imports, Linux ELF dependencies/RUNPATHs, architecture, closure, and prohibited libraries |
| `MediaPlatformPreparation.unit.test.js` | Unit | Native preparation dispatch, source pins, Windows UCRT64 policy, and the Ubuntu Linux baseline |
| `MediaMetadata.unit.test.js` | Unit | Video-stream selection, cover-art rejection, aspect ratios, safe fallback merging, one-time legacy rechecks, durations, and writable scratch output |
| `MovieSearch.unit.test.js` | Unit | Filename parsing, title variants, result scoring, ambiguity, and confidence |
| `EpisodeMatch.unit.test.js` | Unit | Both libraries' title corpus, forgiving acceptance versus strict corrections, runtime thresholds, optional probe caching and failures |
| `ShowDetection.unit.test.js` | Unit | The actual shared scan/reset parser, dedicated extras, mixed folders, season-zero specials, and release-title conventions |
| `OmdbEpisodes.integration.test.js` | Integration | Actual OMDb orchestration with controlled responses: current tags, folder-year hints, series validation, title/runtime vetoes, corrections, cache safety and exact-ID behavior |
| `SubtitleMatcher.unit.test.js` | Unit | Sidecar matching, episode evidence, ambiguity, folder boundaries, and manual provenance |
| `VideoExclusion.unit.test.js` | Unit | Sample/trailer detection, preferences, metadata probing, and conservative retention |
| `VideoRuntimeVerifier.unit.test.js` | Unit | FFmpeg packet thresholds, early EOF, process errors, timeouts, and cleanup |
| `RendererUtils.unit.test.js` | Unit | Batch-edit states, metadata repair without inventing IDs, portable artwork URLs, desktop labels, DOM ancestry, and object diffs |
| `Player.unit.test.js` | Unit | Playback-attempt logs, missing drives/files/watchfolders, launch avoidance, concise MPV errors, command timeouts, socket cleanup, DVD load events, and process exits |
| `MpvProcess.unit.test.js` | Unit | Native IPC paths, macOS Vulkan, Windows Direct3D 11, Linux context selection, sidecar launch isolation, JSON IPC, lifecycle, and diagnostics |
| `MediaBuildCache.integration.test.js` | Integration | Actual temporary files with simulated Windows locks: checkpoint integrity, copy/rename retries, old-bundle preservation, interrupted replacement recovery, and build ownership |
| `ContentFingerprint.integration.test.js` | Integration | Fixed SHA-256 protocol vectors, sample boundaries, copied files/DVDs, complete control files, cache checks, cancellation, and sampled-hash limitations |
| `VideoIdMigration.integration.test.js` | Integration | Separate conversion, exact original preservation, metadata/history and filter remapping, unavailable media, conflicts, resume, and real CLI installation safeguards |
| `MediaDependencies.integration.test.js` | Integration | Production node-mpv JSON-IPC startup, real graphical output, encode/probe/decode operations, strict LGPL bundles, and MPV DVD capability |
| `MediaMetadata.integration.test.js` | Integration | Real FFprobe and FFmpeg fallback on generated videos with embedded covers, genuine MJPEG video, unavailable files, and scratch cleanup |
| `LibraryPersistence.integration.test.js` | Integration | Schema validation, atomic saves, backup names/retention, recovery, and preservation of damaged bytes |
| `Library.integration.test.js` | Integration | First launch, schema/version guards, add/replace/remove, synchronization waits, scanner-owned fields, exports, and recovery decisions |
| `Logger.integration.test.js` | Integration | File routing, visible renderer DEBUG output, forwarding, secret redaction, rotation, and listener shutdown |
| `ReadWrite.integration.test.js` | Integration | Defaults, main/renderer paths, ordinary persistence, and malformed-file replacement |
| `ShareManifest.integration.test.js` | Integration | Manifest/ID compatibility, safe paths, atomic files, Windows flush permissions, and preservation after a failed flush |
| `ShareService.integration.test.js` | Integration | Request → fulfillment → import, content identity, conflicts, Windows flush permissions, cleanup after disk failure, cancellation, and expiration |
| `RendererComponents.component.test.js` | Component | Status language, notification cleanup, navigation, recently-played controls, resolution cells/tooltips, shared statistics, and bucket sorting |
| `SettingsLibrary.component.test.js` | Component | Library export requests, aligned viewing/kind/series/resolution totals, independent per-video duplicate folders, rescan guidance, and file-manager actions |
| `Mynda.component.test.js` | Component | Ratings, playlist filtering, search, recent history, scan IPC, view state, and root pane composition |
| `electron/run-electron-smoke.js` | End-to-end | Real Electron main/renderer boot, first render, scheme-2 library creation, and Library-statistics interaction |

`npm run test:list` prints the same catalog from the file the runner itself uses, so the documentation and the executable selection are easy to compare.

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

See [SOURCE_LAYOUT.md](SOURCE_LAYOUT.md) for the folder map and one-time `npm run source:cleanup` step after extracting fix77 over fix76. The fast suite now includes a source/resource path audit and cleanup safety checks. No media-tool rebuild or npm installation is needed for the reorganization.

`npm run test:paths` runs the focused import/resource/ASAR integration suite. It checks real paths and exact capitalization, including CSS imports, font files, placeholder images, rating logos, themes, and both JavaScript entry points.

`npm run test:electron` now opens two disposable applications in sequence: first the source copy, then a copy in an ASAR archive. Both launch from outside the application directory and check the interface, Settings, images, fonts, theme stylesheets, and theme icon variables. `npm run test:electron:asar` runs only the archived-source check. `test:all` includes both.

The ASAR journey deliberately shares installed npm dependencies from the temporary parent directory. It verifies source/resource paths inside an archive; `npm run test:package` separately assembles the complete native application and checks its bundled media dependencies.
