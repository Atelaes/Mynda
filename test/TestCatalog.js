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
    file: 'test/LibraryDuplicates.unit.test.js',
    title: 'Library duplicate tracking',
    protects: 'path normalization, scan reconciliation, and offline retention'
  },
  {
    category: 'unit',
    file: 'test/LibraryStats.unit.test.js',
    title: 'Library statistics',
    protects: 'viewing totals, visible-title series grouping, resolution tiers, and global duplicates'
  },
  {
    category: 'unit',
    file: 'test/VideoResolution.unit.test.js',
    title: 'Shared resolution buckets',
    protects: 'all bucket boundaries, crops, anamorphic ratios, portrait video, panoramas, and unknown metadata'
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
    title: 'Media metadata selection and normalization',
    protects: 'playable video selection, cover-art rejection, aspect ratios, fallback merging, legacy rechecks, and scratch output'
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
    protects: 'attempt logging, media availability, concise errors, launch avoidance, timeouts, socket cleanup, DVD load events, and process exits'
  },
  {
    category: 'unit',
    file: 'test/MpvProcess.unit.test.js',
    title: 'MPV process and IPC startup',
    protects: 'native IPC paths, platform video selection, sidecar launch isolation, JSON IPC, and diagnostics'
  },
  {
    category: 'integration',
    file: 'test/MediaBuildCache.integration.test.js',
    title: 'Resumable Windows media build storage',
    protects: 'verified checkpoints, locked-file retries, preserved compiler outputs, safe replacement, and interrupted publication recovery'
  },
  {
    category: 'integration',
    file: 'test/ContentFingerprint.integration.test.js',
    title: 'Content-based video IDs',
    protects: 'fixed hash vectors, distributed samples, file sizes, DVD normalization, cache validation, and read failures'
  },
  {
    category: 'integration',
    file: 'test/VideoIdMigration.integration.test.js',
    title: 'One-time video ID migration',
    protects: 'metadata/history preservation, cross-library IDs, resumable conversion, explicit archiving, collisions, and guarded installation'
  },
  {
    category: 'integration',
    file: 'test/MediaDependencies.integration.test.js',
    requiresMediaTools: true,
    title: 'Installed media dependencies',
    protects: 'node-mpv JSON IPC startup, real graphical output, decoding/probing, and MPV DVD capability'
  },
  {
    category: 'integration',
    file: 'test/MediaMetadata.integration.test.js',
    requiresMediaTools: true,
    title: 'Real video metadata and embedded artwork',
    protects: 'actual FFprobe and FFmpeg fallback selection of videos with cover art, genuine MJPEG, and cleanup on failure'
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
    protects: 'file routing, visible renderer DEBUG output, forwarding, secret redaction, rotation, and shutdown'
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
    title: 'Notification, navigation, and playlist UI',
    protects: 'progress language, listener cleanup, navigation, Play Next, resolution cells, dimension tooltips, and bucket sorting'
  },
  {
    category: 'component',
    file: 'test/SettingsLibrary.component.test.js',
    title: 'Settings Library tab',
    protects: 'export IPC, aligned statistics, per-video duplicate folders, rescan guidance, and file-manager actions'
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
    protects: 'main/renderer boot, first-launch storage, root panes, Settings tabs, and Library statistics'
  }
];
