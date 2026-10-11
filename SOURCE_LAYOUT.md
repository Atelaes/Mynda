# Mynda source layout and process boundaries

Mynda uses an Electron main process, an isolated sandboxed preload, and a browser-only React renderer. Electron is pinned to 44.7.0 (Chromium 152, Node 24) and React remains on its existing version. The runtime upgrade preserves the saved library format and automatic tagging acceptance policy.

## Process ownership

| Area | Owner and entry points | Responsibility |
|---|---|---|
| Application lifecycle | `src/bootstrap.js`, `src/main/index.js` | Single-instance startup, window creation, backend service wiring, scans, Auto-Tag, and orderly shutdown |
| Browser interface | `src/renderer/Renderer.js`, `Mynda.js`, component modules | Render confirmed library state, retain editor drafts, request named operations, and display progress and failures |
| Preload bridge | `src/preload/index.js`, `Bridge.js` | Expose the fixed `window.mynda` API through `contextBridge`; keep Electron channels/events and unrestricted messaging private |
| Caller and payload checks | `src/main/ExternalContent.js`, `RendererBridge.js` | Recognize the registered application main frame, validate bounded plain data, dispatch known operations, and reject navigation/popups/browser permissions |
| Library persistence | `src/library/Library.js`, `LibraryOperations.js`, `LibraryPersistence.js` | Own the committed library, serialize ready transactions, resolve field conflicts, and save atomically |
| Browser library model | `src/library/LibraryClient.js`, `LibraryClientCommands.js`, `LibraryProtocol.js` | Maintain an immutable confirmed snapshot, prepare edits, consume revisioned commits, and flush pending requests on close |
| Renderer edit authorization | `src/library/LibraryRendererPolicy.js` | Reject backend-only commands, scanner-owned fields, unapproved new artwork/subtitle paths, and changes outside editable boundaries |
| Playback | `src/main/PlaybackService.js`, `PlaybackSupport.js`, `src/media/` | Resolve canonical video IDs, inspect storage availability, own MPV lifetime/options/events, and persist playback progress |
| Manual editor operations | `src/main/EditorService.js`, `EditorArtworkDownload.js` | Search and select owner-scoped catalog proposals, reset from filenames, validate/copy/download artwork, and select or validate subtitles |
| Native desktop operations | `src/main/DesktopService.js` | Native dialogs, approved watchfolders/Share directories, owner-bound Share plans, library exports, and controlled file-manager reveals |
| Logging | `src/renderer/RendererLogger.js`, `src/platform/Logger.js` | Browser logger sends named log requests; backend logger owns file output and rotation |

The window has `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Electron no longer contains the old `remote` module, so its obsolete configuration flag is removed. The window also disables webviews, Node in subframes/workers, and insecure mixed content. Components use operations such as `window.mynda.playback.play(videoId)`; they cannot import Node or Electron, invoke arbitrary IPC channels, launch processes, or read/write files directly.

Main validates the sender independently of the preload. Services resolve video IDs against the backend library instead of trusting renderer-supplied filenames or process options. Backend-only operations do not become public merely because a similarly named internal method exists.

## File and directory approvals

Selecting artwork, subtitles, watchfolders, or Share directories in a native chooser already supplies the relevant approval. Previously known library references can be retained. A new path pasted or dropped into the editor, a newly typed artwork URL, or a manually entered directory needs a native confirmation before backend access. Confirmations identify the requested file, URL, or directory; canceling leaves it unauthorized. These grants belong to the current application window, not an unrestricted renderer filesystem API.

Reusing the same approved reference in that window does not ask for the same approval again. A native-picker selection does not need this extra confirmation. A different URL or directory is a separate authorization, and a changed directory identity invalidates its previous grant.

Artwork drops pass the DOM `File` to `editor.inspectDroppedArtwork`. The preload resolves its disk path with Electron's `webUtils.getPathForFile` and invokes the existing `editor.inspectArtwork` operation. Only the path crosses IPC; the main process still owns approval and validation. Generated in-memory files and malformed objects cannot supply disk paths. The renderer never reads the removed `File.path` property.

Artwork URLs obtained through the backend's catalog proposals are recognized separately. A redirect to a different origin requires approval unless its destination URL is already authorized. Downloaded or copied artwork must pass image-content and size checks. Share plan tokens belong to their originating window and reviewed directory; directory identity and import destinations are rechecked when the plan is used. New external resources may need approval again after restarting the application.

## Library saves during background work

The renderer submits field-level edits through its library client. Main checks edit permissions and baselines, merges nonconflicting fields into its current data, saves an atomic candidate, and returns/broadcasts the resulting revision. The renderer incorporates that revision before reporting the save as complete.

Scans, tagging requests, artwork downloads, and playback do not occupy the library commit queue while waiting for external work. They submit ready operations when needed. An interactive edit therefore does not wait behind an entire scan or tagging run. The existing close handshake flushes pending renderer saves and playback state before draining commits; it retains the explicit wait/cancel/quit-without-saving choices when completion cannot be confirmed.

## Folder map

| Path | Contents |
|---|---|
| `src/main/` | Electron lifecycle and privileged backend services |
| `src/preload/` | Fixed renderer API and its isolated Electron adapter |
| `src/renderer/` | Browser React components and runtime; no privileged imports |
| `src/renderer/styles/` | Main stylesheet, themes, and local fonts |
| `src/library/` | Backend persistence/mutations plus explicitly browser-safe protocol, client, display, and filtering modules |
| `src/tagging/` | Catalog discovery, matching, acceptance, evidence, reports, and request management |
| `src/scanning/` | Filesystem scanning, show detection, and technical metadata coordination |
| `src/media/` | Native media tools, metadata probing, playback process helpers, and shared resolution labels |
| `src/sharing/` | Share manifests, planning, fulfillment, and import |
| `src/platform/` | Backend platform utilities and pure shared policies such as external-link validation |
| `src/legacy/` | Retired source excluded from production packaging |
| `images/`, `build/` | Application artwork and platform icon/package assets |
| `scripts/` | Build, native media preparation, verification, and migration commands |
| `test/` | Fast suites, fixture helpers, native Electron journeys, and package smoke checks |

Only browser-safe helpers may cross into the renderer dependency graph. `DuplicateDisplay.js`, `LibraryProtocol.js`, and `LibraryClientCommands.js` keep display/serialization work separate from filesystem normalization and authoritative backend mutations. Do not solve a new privileged import by installing a browser shim: move that operation behind a specific backend capability.

## Compiled artifacts and packaging

Use Node 24 for development (`.nvmrc`), with Node 22.12 as the minimum required by the Electron and ASAR packages. After applying the upgrade, run `npm ci` and `npm run electron:install`. Electron 42+ downloads its executable on first use rather than during npm's postinstall; the explicit install command makes that step visible and repeatable. `scripts/build-renderer.js` uses pinned esbuild to create:

| Generated artifact | Target | Runtime dependencies |
|---|---|---|
| `src/renderer/generated/renderer.js` | Browser IIFE, Chromium 152 | Bundled browser dependencies; no Node or Electron imports |
| `src/preload/generated/preload.js` | CommonJS, Node 24 syntax | Only the Electron import allowed in the sandboxed preload |

Generated output is excluded from Git and included in the application package. `npm start` rebuilds before launch; `npm run build:renderer` builds without launching. The native test runner builds before staging each source/ASAR app. `scripts/before-build.js` compiles production output before the existing media verifier, including direct electron-builder invocation. Development source maps include source contents; production maps omit them.

`src/renderer/index.html` loads the external bundle with a restrictive CSP. Scripts are local-only; inline scripts and dynamic code generation are forbidden. Inline styles remain necessary for React and drag-and-drop. Artwork supports the existing local/data/blob/HTTPS sources. The renderer cannot make network requests or load embedded documents, workers, or plugins.

Packaging pins electron-builder 26.17.0. Archive tests declare `@electron/asar` explicitly rather than relying on the builder's former transitive `asar` package. Babel is used only by development tests; unused `@babel/cli`, `request`, `fs-hard-drive`, and `subtitle` dependencies are removed. Existing media executables remain separate processes; the Electron upgrade does not replace the verified FFmpeg/FFprobe/MPV bundles.

## Platform targets and maintenance

| Mynda target | Runtime baseline | Release validation |
|---|---|---|
| `mac-arm64` | Apple Silicon, macOS 13+ | Run native journeys and packaged media checks on macOS |
| `win-x64` | Windows 10+ x64; Windows 11 recommended for new installations | Run native journeys and NSIS/package checks on Windows |
| `linux-x64` | Ubuntu 24.04 x64 with a graphical desktop | Run native journeys, AppImage, and media checks on Ubuntu |

The macOS minimum is declared in electron-builder configuration. Electron also publishes Intel Mac and ARM Windows/Linux runtimes, but those are not Mynda targets until their native media bundles and tests exist. End users do not install Node; this requirement applies to development and packaging only. See [Electron's platform support](https://github.com/electron/electron/blob/v44.7.0/README.md) and [MEDIA_TOOLS.md](MEDIA_TOOLS.md).

44.7.0 was the latest stable Electron release checked on 2026-10-11, not a beta or nightly. Electron supports only its latest three stable major lines and does not provide a long-term-support branch. Keep current with patches and schedule regular major upgrades; preserve exact pins and update the lockfile and build targets together. See [release history](https://releases.electronjs.org/releases/stable) and [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).

## Verification status

See [TESTING.md](TESTING.md) and `npm run test:list` for the executable suite catalog. Build tests reject privileged imports, exercise source updates with preserved timestamps, initialize the real compiled browser graph without Node or dynamic code generation, and verify exact bundle bytes inside an ASAR archive.

Native journeys use the production preload and actual compiled UI. Dependency fixtures for metadata, catalog responses, and MPV remain in main; UI actions use browser DOM controls. They do not add a test preload or renderer test channel. Torgo confirmed that the isolation migration, editor-list fix, automated tests, and build worked before this upgrade (baseline commit `9071d28`). That is the rollback baseline, not evidence that Electron 44's native tests pass.

For this upgrade, all 79 fast suites (2,929 checks) passed under Electron 44.7.0's embedded Node 24.21.0, including the browser build and real ASAR archive checks. Desktop execution remains unverified: the editing host cannot provide an X display or the required local sockets, and even a minimal window fails. Native source/ASAR journeys and release packaging must pass on the target machines. The startup journey now also covers a disk-backed File crossing the real preload, cancel/approve artwork inspection, an editor drop, and a saved artwork copy. The packaged media smoke test still requires each platform's verified media bundle.

## Historical fix77 cleanup

`scripts/source-reorganization.json` records the old fix76 and relocated fix77 files. `npm run source:cleanup -- --check` performs a dry run; `npm run source:cleanup` verifies replacements, backs up old files beside the project, and removes only the recorded unchanged old copies. A current Git checkout has no superseded files and needs no cleanup. If an old overlay has been modified since fix77, the script refuses removal so those edits can be reconciled first. This historical cleanup is separate from renderer bundling.
