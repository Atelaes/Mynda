# Testing Mynda

This test suite is the safety net for modernizing Electron, React, and Mynda's other dependencies. It checks several different boundaries: small calculations, modules working together through real temporary files, React components, and the actual Electron application.

All automated tests use fixtures or disposable directories. They do **not** open, alter, or delete the real library under `~/Library/Application Support/mynda`. The Electron test creates a temporary copy of the application and points both of its processes at a temporary `userData` directory.

## The first commands to learn

Open Terminal, move into the Mynda project, and run:

```bash
cd "/Volumes/2TB-SSD/Coding/Mynda (React)"
npm test
```

`npm test` is the everyday command. It runs every unit, integration, and React component test, but does not launch Electron. It should take only a few seconds.

The complete command set is:

| Command | What it runs | When to use it |
|---|---|---|
| `npm test` | All fast tests | Before and after ordinary code changes |
| `npm run test:list` | Test catalog only | To see what exists without running anything |
| `npm run test:unit` | Unit tests | While changing calculations or one helper module |
| `npm run test:integration` | Integration tests | While changing storage, IPC-facing models, logs, or Share |
| `npm run test:component` | React component tests | While changing renderer state or UI components |
| `npm run test:renderer` | Same as `test:component` | A more memorable alias |
| `npm run test:electron` | Real Electron end-to-end smoke test | After Electron, React, Babel, or startup changes |
| `npm run test:all` | Fast tests plus Electron | Before committing an upgrade or preparing a release |
| `npm run test:package` | Fast tests, then an unpacked production build | Before a release; writes build output under `dist/` |

The Electron test briefly opens Mynda and its DevTools. That is expected. It verifies startup, the first render, creation of an isolated first-launch library, opening Settings, and closing Settings. It exits automatically.

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
| **Packaging smoke check** | The release tool proves it can assemble an unpacked application. This is a build check rather than a separate test file. | `npm run test:package` |

A “test double” is simply a small, predictable substitute for something outside the subject of a test—for example, a pretend FFmpeg process that emits the same events as the real process. A “fixture” is known sample data, such as one complete movie record. An “assertion” is the expected result that makes a test pass or fail.

## Every automated suite and its category

| Suite | Category | What it protects |
|---|---|---|
| `PlaylistFilter.test.js` | Unit | Safe playlist expressions, allowed syntax, runtime errors, caching, and security limits |
| `TableSelection.test.js` | Unit | Single, toggle, range, cross-table, offscreen, and ordered row selection |
| `ReactDevTools.test.js` | Unit | Development extension path/loading, packaged-app skip, and graceful failures |
| `MovieSearch.unit.test.js` | Unit | Filename parsing, title variants, result scoring, ambiguity, and confidence |
| `SubtitleMatcher.unit.test.js` | Unit | Sidecar matching, episode evidence, ambiguity, folder boundaries, and manual provenance |
| `VideoExclusion.unit.test.js` | Unit | Sample/trailer detection, preferences, metadata probing, and conservative retention |
| `VideoRuntimeVerifier.unit.test.js` | Unit | FFmpeg packet thresholds, early EOF, process errors, timeouts, and cleanup |
| `RendererUtils.unit.test.js` | Unit | Batch-edit states, ratings, video validation/repair, paths, DOM ancestry, and object diffs |
| `Player.unit.test.js` | Unit | MPV errors, command timeouts, socket cleanup, DVD load events, and process exits |
| `Stream.unit.test.js` | Unit | FFmpeg HLS options, callbacks, and stopping a stream |
| `LibraryPersistence.integration.test.js` | Integration | Schema validation, atomic saves, backup names/retention, recovery, and preservation of damaged bytes |
| `Library.integration.test.js` | Integration | First launch, migrations, add/replace/remove, synchronization waits, subtitle-safe edits, and recovery decisions |
| `Logger.integration.test.js` | Integration | Log routing, renderer forwarding, secret redaction, rotation, and listener shutdown |
| `ReadWrite.integration.test.js` | Integration | Defaults, main/renderer paths, ordinary persistence, and malformed-file replacement |
| `ShareManifest.integration.test.js` | Integration | Manifest schema, checksums, safe paths, inventory, error codes, and atomic files |
| `ShareService.integration.test.js` | Integration | Complete request → fulfillment → import flow, copies, reuse, conflicts, cancellation, and expiration |
| `RendererComponents.component.test.js` | Component | Status language, notification cleanup, selected navigation, and New-tab visibility |
| `Mynda.component.test.js` | Component | Ratings, playlist filtering, search, recent history, scan IPC, view state, and root pane composition |
| `electron/run-electron-smoke.js` | End-to-end | Real Electron main/renderer boot, first render, isolated library creation, and Settings interaction |

`npm run test:list` prints the same catalog from the file the runner itself uses, so the documentation and the executable selection are easy to compare.

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
3. Run `npm run test:package` to establish that the current release toolchain builds.
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
- decoding an actual movie with MPV/FFmpeg during the fast tests;
- approving native operating-system dialogs;
- judging pixel-perfect layout, animation quality, sound, or playback quality;
- testing every possible media filename or damaged file.

That is why the small manual acceptance pass remains part of the release checklist. The goal is not to eliminate human testing; it is to make regressions early, repeatable, and much easier to locate.

## If a command cannot start

If Node reports a missing package, run `npm install` in the Mynda folder and retry. If only the Electron test reports that Electron's executable is missing, Electron's installation/download did not finish; run `npm install` again before diagnosing Mynda itself.

When reporting a failure, copy from the category header (such as `[INTEGRATION]`) through the final summary. That includes the useful context without requiring the entire Terminal history.
