# Mynda source layout and process boundaries

Mynda uses an Electron main process, an isolated sandboxed preload, and a browser-only React renderer. Electron remains pinned to 12.0.5 and React remains on its existing version. The renderer-isolation migration changes ownership and communication, not the saved library format or automatic tagging acceptance policy.

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

The window has `nodeIntegration: false`, `contextIsolation: true`, `enableRemoteModule: false`, and `sandbox: true`. It also disables webviews, Node in subframes/workers, and insecure mixed content. Components use operations such as `window.mynda.playback.play(videoId)`; they cannot import Node or Electron, invoke arbitrary IPC channels, launch processes, or read/write files directly.

Main validates the sender independently of the preload. Services resolve video IDs against the backend library instead of trusting renderer-supplied filenames or process options. Backend-only operations do not become public merely because a similarly named internal method exists.

## File and directory approvals

Selecting artwork, subtitles, watchfolders, or Share directories in a native chooser already supplies the relevant approval. Previously known library references can be retained. A new path pasted or dropped into the editor, a newly typed artwork URL, or a manually entered directory needs a native confirmation before backend access. Confirmations identify the requested file, URL, or directory; canceling leaves it unauthorized. These grants belong to the current application window, not an unrestricted renderer filesystem API.

Reusing the same approved reference in that window does not ask for the same approval again. A native-picker selection does not need this extra confirmation. A different URL or directory is a separate authorization, and a changed directory identity invalidates its previous grant.

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

Run `npm install` after applying this migration. The build host needs Node 18 or later. `scripts/build-renderer.js` uses pinned esbuild to create:

| Generated artifact | Target | Runtime dependencies |
|---|---|---|
| `src/renderer/generated/renderer.js` | Browser IIFE, Chromium 89 | Bundled browser dependencies; no Node or Electron imports |
| `src/preload/generated/preload.js` | CommonJS, Node 14 syntax | Only the Electron import allowed in the sandboxed preload |

Generated output is excluded from Git and included in the application package. `npm start` rebuilds before launch; `npm run build:renderer` builds without launching. The native test runner builds before staging each source/ASAR app. `scripts/before-build.js` compiles production output before the existing media verifier, including direct electron-builder invocation. Development source maps include source contents; production maps omit them.

`src/renderer/index.html` loads the external bundle with a restrictive CSP. Scripts are local-only; inline scripts and dynamic code generation are forbidden. Inline styles remain necessary for React and drag-and-drop. Artwork supports the existing local/data/blob/HTTPS sources. The renderer cannot make network requests or load embedded documents, workers, or plugins.

## Verification status

See [TESTING.md](TESTING.md) and `npm run test:list` for the executable suite catalog. Build tests reject privileged imports, exercise source updates with preserved timestamps, initialize the real compiled browser graph without Node or dynamic code generation, and verify exact bundle bytes inside an ASAR archive.

Native journeys use the production preload and actual compiled UI. Dependency fixtures for metadata, catalog responses, and MPV remain in main; UI actions use browser DOM controls. They do not add a test preload or renderer test channel. These native journeys must still be run on supported machines for the isolation migration: the editing environment cannot start even a minimal Electron UI. Earlier Mac save-test results and a Windows build are pre-isolation baselines, not evidence that this refactor passes on either platform. Ubuntu remains unverified.

## Historical fix77 cleanup

`scripts/source-reorganization.json` records the old fix76 and relocated fix77 files. `npm run source:cleanup -- --check` performs a dry run; `npm run source:cleanup` verifies replacements, backs up old files beside the project, and removes only the recorded unchanged old copies. A current Git checkout has no superseded files and needs no cleanup. If an old overlay has been modified since fix77, the script refuses removal so those edits can be reconciled first. This historical cleanup is separate from renderer bundling.
