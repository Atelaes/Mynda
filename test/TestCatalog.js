// One catalog drives both npm scripts and the human-readable `test:list`
// command. Keep each file in exactly one primary category even when a test
// touches more than one layer; the category describes its broadest boundary.
module.exports = [
  {
    category: 'unit',
    file: 'test/PlaylistFilter.test.js',
    title: 'Safe playlist expressions',
    protects: 'playlist syntax, operators, security limits, cache, and runtime errors'
  },
  {
    category: 'unit',
    file: 'test/TableSelection.test.js',
    title: 'Virtual-table selection',
    protects: 'single, toggle, range, cross-table, and ordered selection behavior'
  },
  {
    category: 'unit',
    file: 'test/ReactDevTools.test.js',
    title: 'React DevTools loader',
    protects: 'development-only extension loading, packaged skip, and failure handling'
  },
  {
    category: 'unit',
    file: 'test/BoxOffice.unit.test.js',
    title: 'Box-office parsing and formatting',
    protects: 'fixed-USD input, invalid values, locale presentation, and compact thresholds'
  },
  {
    category: 'unit',
    file: 'test/PackageConfig.unit.test.js',
    title: 'Production package boundaries',
    protects: 'file boundaries, staged sidecars, strict package commands, and retired HLS code'
  },
  {
    category: 'unit',
    file: 'test/MediaTools.unit.test.js',
    title: 'Media executable resolution',
    protects: 'packaged/staged sidecar paths, executable validation, and development fallbacks'
  },
  {
    category: 'unit',
    file: 'test/MediaToolPolicy.unit.test.js',
    title: 'Bundled media policy',
    protects: 'LGPL-only FFmpeg flags, nonfree rejection, and required MPV DVD/native video support'
  },
  {
    category: 'unit',
    file: 'test/MediaBundleVerifier.unit.test.js',
    title: 'Media bundle staging verifier',
    protects: 'source pins, graphical MPV, libdvdcss exclusion, architecture, and native dependencies'
  },
  {
    category: 'unit',
    file: 'test/MediaBundleInspection.unit.test.js',
    title: 'Windows/Linux media-bundle inspection',
    protects: 'PE/ELF architecture, dependency closure, app-relative loading, and prohibited libraries'
  },
  {
    category: 'unit',
    file: 'test/MediaPlatformPreparation.unit.test.js',
    title: 'Cross-platform media preparation',
    protects: 'native host dispatch, source pins, build baselines, and platform-specific recipes'
  },
  {
    category: 'unit',
    file: 'test/MediaMetadata.unit.test.js',
    title: 'Media metadata paths',
    protects: 'container durations and writable packaged-app FFmpeg scratch output'
  },
  {
    category: 'unit',
    file: 'test/MovieSearch.unit.test.js',
    title: 'Movie identification',
    protects: 'filename parsing, search variants, candidate scoring, and confidence'
  },
  {
    category: 'unit',
    file: 'test/SubtitleMatcher.unit.test.js',
    title: 'Subtitle matching',
    protects: 'sidecar assignment, ambiguity, folder boundaries, and manual provenance'
  },
  {
    category: 'unit',
    file: 'test/VideoExclusion.unit.test.js',
    title: 'Sample/trailer exclusion',
    protects: 'candidate classification, preferences, probing, and conservative retention'
  },
  {
    category: 'unit',
    file: 'test/VideoRuntimeVerifier.unit.test.js',
    title: 'Runtime verification',
    protects: 'FFmpeg packet thresholds, errors, early EOF, and timeout cleanup'
  },
  {
    category: 'unit',
    file: 'test/RendererUtils.unit.test.js',
    title: 'Renderer editing helpers',
    protects: 'batch edits, ratings, validation/repair, portable URLs/labels, DOM ancestry, and diffs'
  },
  {
    category: 'unit',
    file: 'test/Player.unit.test.js',
    title: 'MPV playback safety',
    protects: 'media availability, concise errors, launch avoidance, timeouts, socket cleanup, DVD load events, and process exits'
  },
  {
    category: 'unit',
    file: 'test/MpvProcess.unit.test.js',
    title: 'MPV process and IPC startup',
    protects: 'native IPC paths, platform video selection, sidecar launch isolation, JSON IPC, and diagnostics'
  },
  {
    category: 'integration',
    file: 'test/MediaDependencies.integration.test.js',
    title: 'Installed media dependencies',
    protects: 'node-mpv JSON IPC startup, real graphical output, decoding/probing, and MPV DVD capability'
  },
  {
    category: 'integration',
    file: 'test/LibraryPersistence.integration.test.js',
    title: 'Library persistence',
    protects: 'validation, atomic saves, snapshots, retention, recovery, and damaged bytes'
  },
  {
    category: 'integration',
    file: 'test/Library.integration.test.js',
    title: 'Library model and synchronization',
    protects: 'first launch, migrations, operations, IPC boundary, idle waits, and recovery'
  },
  {
    category: 'integration',
    file: 'test/Logger.integration.test.js',
    title: 'Backend logging',
    protects: 'file routing, renderer forwarding, secret redaction, rotation, and shutdown'
  },
  {
    category: 'integration',
    file: 'test/ReadWrite.integration.test.js',
    title: 'Small settings-file storage',
    protects: 'defaults, main/renderer paths, persistence, and malformed-file replacement'
  },
  {
    category: 'integration',
    file: 'test/ShareManifest.integration.test.js',
    title: 'Share manifests',
    protects: 'schema, checksums, inventory, hostile paths, error codes, and atomic files'
  },
  {
    category: 'integration',
    file: 'test/ShareService.integration.test.js',
    title: 'Complete Share workflow',
    protects: 'request, fulfillment, import, copies, conflicts, cancellation, and expiration'
  },
  {
    category: 'component',
    file: 'test/RendererComponents.component.test.js',
    title: 'Notification and navigation UI',
    protects: 'progress language, listener cleanup, active navigation, and the New tab'
  },
  {
    category: 'component',
    file: 'test/Mynda.component.test.js',
    title: 'Top-level React coordinator',
    protects: 'ratings, filtering, search, recent history, IPC, view state, and pane topology'
  },
  {
    category: 'end-to-end',
    file: 'test/electron/run-electron-smoke.js',
    title: 'Real Electron startup',
    protects: 'main/renderer boot, first-launch storage, root panes, and Settings interaction'
  }
];
