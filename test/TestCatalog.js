// One catalog drives both npm scripts and the human-readable `test:list`
// command. Keep each file in exactly one primary category even when a test
// touches more than one layer; the category describes its broadest boundary.
module.exports = [
  {category:'integration',file:'test/AutoTagStorage.integration.test.js',title:'Auto-Tag storage failure and notification',
    protects:'disk-full and permission errors, atomic-write rollback, retry eligibility, queues and visible failure dialogs'},
  {category:'integration',file:'test/RendererStartup.integration.test.js',title:'Renderer startup after an update',
    protects:'persistent Babel cache, source overlays with identical timestamps, and actual rendered IMDb links'},
  {category:'integration',file:'test/SiblingNumbering.integration.test.js',title:'Sibling-supported numbering and correction lookups',
    protects:'independent exact witnesses, release scope, conflicting offsets, saved evidence, shuffled order and shared episode lookup fallback'},
  {category:'unit',file:'test/TaggingReport.unit.test.js',title:'Saved autotag explanations',
    protects:'historical decisions, provenance, numbering, runtime, bounded candidates and safe error explanations'},
  {category:'component',file:'test/AutotagReport.component.test.js',title:'Editor autotag report',
    protects:'saved-video binding, collapsible selectable reports, keyboard semantics, stale edits and navigation'},
  {category:'integration',file:'test/SeriesEvidence.integration.test.js',title:'Incomplete catalog evidence and release collections',
    protects:'recorded parent observations, positive season counts, inferred seasons, bounded candidates, release suffixes and numbering origins'},
  {category:'integration',file:'test/EpisodeTitleAnnotations.integration.test.js',title:'Episode title annotations and correction boundaries',
    protects:'recorded annotation pairs, original title evidence, exact corrections, duplicate cores, parts and fuzzy sanity'},
  {category:'integration',file:'test/SeriesStructure.integration.test.js',title:'Series structure and numbered episode acceptance',
    protects:'two-season lower-bound counts, single-season upper bounds, cross-season contradictions, duplicates, catalog gaps and request budgets'},
  {category:'integration',file:'test/SeriesCollection.integration.test.js',title:'Series collection identity and local episode order',
    protects:'cross-season identity, explicit conflicts, independent witnesses, repeated series prefixes, final retry outcomes and shuffled processing'},
  {category:'component',file:'test/TaggingEditor.component.test.js',title:'Tagging editor provenance',
    protects:'manual identity authorship, retained automatic evidence, one application per confirmed preview and stale selection rejection'},
  {category:'integration',file:'test/TaggingArchitecture.integration.test.js',title:'Tagging architectural contracts',
    protects:'final acceptance ownership, shared budgets, durable identity provenance, run boundaries and exhaustive small-batch permutations'},
  {category:'integration',file:'test/TaggingPrecision.integration.test.js',title:'Tagging precision and evidence provenance',
    protects:'short titles, independent sibling evidence, order conflicts, ambiguity, cancellation and movie title expansion'},
  {category:'unit',file:'test/CatalogClient.unit.test.js',title:'Catalog request reuse',
    protects:'concurrent reuse, transient failure eviction, session scope and deduplicated episode probes'},
  {
      "category": "unit",
      "file": "test/SeriesSearch.unit.test.js",
      "title": "Conservative series discovery queries",
      "protects": "full-title identity, reviewed aliases, cleanup, query caps and explicit region constraints"
  },
  {
      "category": "integration",
      "file": "test/OmdbSeries.integration.test.js",
      "title": "OMDb series discovery and batch reuse",
      "protects": "new discovery queries, preserved episode checks, bounded pagination, batch query sharing and retryable errors"
  },
  {
      "category": "integration",
      "file": "test/HistoricalTagging.integration.test.js",
      "title": "Individual historical tagging regressions",
      "protects": "1921 recorded searches and 63 individual numbering corrections from the project history"
  },
  {
      "category": "integration",
      "file": "test/HistoricalMovies.integration.test.js",
      "title": "Individual fix03\u2013fix05 movie discoveries",
      "protects": "73 individual movie improvements from the saved before/after libraries and corrected catalog IDs"
  },
  {
      "category": "integration",
      "file": "test/OmdbHistoricalBehaviors.integration.test.js",
      "title": "Historical tagging workflows",
      "protects": "named artwork fallbacks, failed-download caching, series-ID handoff, explicit IDs and batch choices"
  },
  {
    category: 'integration',
    file: 'test/AutoTagRecovery.integration.test.js',
    title: 'Automatic series recovery and save accounting',
    protects: 'directory-scoped sibling evidence, single bounded retry, final save order, cancellation, and per-file statistics'
  },
  {
    category: 'integration',
    file: 'test/SourceLayout.integration.test.js',
    title: 'Source imports, assets, and packaged layout',
    protects: 'case-correct module references, renderer resources, relocated themes/fonts, default media roots, and actual ASAR contents'
  },
  {
    category: 'integration',
    file: 'test/SourceReorganization.integration.test.js',
    title: 'Source reorganization cleanup safety',
    protects: 'verified backups, complete-overlay checks, edited-file preservation, Windows line endings, and repeatable cleanup'
  },
  {
    category: 'unit',
    file: 'test/EpisodeMatch.unit.test.js',
    title: 'Episode title and runtime sanity checks',
    protects: '2657 reviewed title pairs, strict correction boundaries, broad runtime checks, and cached optional probes'
  },
  {
    category: 'unit',
    file: 'test/ShowDetection.unit.test.js',
    title: 'Show detection for scans and filename resets',
    protects: 'shared scan/reset parsing, dedicated extras, mixed folders, season-zero specials, and existing release conventions'
  },
  {
    category: 'integration',
    file: 'test/OmdbEpisodes.integration.test.js',
    title: 'OMDb episode selection and tagging safeguards',
    protects: 'current-tag precedence, optional folder years, recorded corrections, series validation/cache, runtime vetoes, and exact-ID overrides'
  },
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
    protects: 'main/renderer boot from another working directory, first-launch storage, panes, Settings, styles, themes, fonts, and icons'
  },
  {
    category: 'end-to-end',
    file: 'test/electron/run-electron-smoke.js',
    args: ['--asar'],
    title: 'Real Electron startup from ASAR',
    protects: 'the same UI/assets journey from an actual source-and-assets archive; separate from the full bundled-media packaging test'
  }
];
