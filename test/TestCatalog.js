// One catalog drives both npm scripts and the human-readable `test:list`
// command. Keep each file in exactly one primary category even when a test
// touches more than one layer; the category describes its broadest boundary.
module.exports = [
  {category:'integration',file:'test/FeatureAccess.integration.test.js',title:'Restricted features and live activation state',
    protects:'preflight restrictions, immediate activation/removal, cached choices, batch stopping, session verification and explicit failures'},
  {category:'end-to-end',file:'test/electron/run-credentials.js',title:'Credential settings in Electron',
    protects:'real renderer entry, private IPC, persistence across processes, lookup and removal'},
  {category:'end-to-end',file:'test/electron/run-credentials.js',args:['--asar'],title:'Credential settings in packaged layout',
    protects:'ASAR credential exclusion, external settings, restart, live transport and removal'},
  {category:'integration',file:'test/MetadataCredentials.integration.test.js',title:'Encrypted metadata credentials',
    protects:'migration, restart, locked keychains, private files, replacement failures, removal and authenticated validation'},
  {category:'component',file:'test/LicenseActivation.component.test.js',title:'License activation settings UI',
    protects:'masked input, secret clearing, safe errors, status updates and stale responses'},
  {category:'unit',file:'test/MetadataCredentialCli.unit.test.js',title:'Private credential CLI transport',
    protects:'stdin-only token transfer, pinned Electron launch and safe failure output'},
  {category:'component',file:'test/CapacityWait.component.test.js',title:'Metadata capacity waiting UI',
    protects:'batch pause messages, editor cancellation, stale responses, selection changes and preload status subscriptions'},
  {category:'integration',file:'test/CapacityWait.integration.test.js',title:'Metadata capacity waits and cancellation',
    protects:'validated retry timing, fair-queue tickets, unchanged candidate budgets, batch progress, cancellation, storage failures and editor ownership'},
  {category:'integration',file:'test/MetadataServer.integration.test.js',title:'Metadata server integration',
    protects:'authenticated HTTP/HTTPS requests, certificate verification, translation, request reuse, private configuration and error redaction'},
  {category:'integration',file:'test/TaggingJourneys.integration.test.js',title:'Tagging journey catalog and live-test safeguards',
    protects:'raw HTTP fixtures through the real tagging engine, downloaded image bytes, live consent, request limits and secret redaction'},
  {category:'component',file:'test/ArtworkImage.component.test.js',title:'Artwork availability and placeholders',
    protects:'missing images, stable fallback, retry, stale image events and retained artwork references'},
  {category:'component',file:'test/ArtworkEditor.component.test.js',title:'Artwork editor file drops',
    protects:'modern DOM Files, removal, on-demand file paths, native approval/cancellation and stale editor changes'},
  {category:'unit',file:'test/ElectronConsole.unit.test.js',title:'Electron console diagnostics',
    protects:'warning and error capture across legacy and modern console event APIs'},
  {category:'unit',file:'test/ElectronBrowserDriver.unit.test.js',title:'Electron browser-driver diagnostics',
    protects:'renderer result transfer, failed control selectors, original exceptions and execution failures'},
  {category:'integration',file:'test/MainBridge.integration.test.js',title:'Main application isolation wiring',
    protects:'real main composition, isolated window options, complete handler registration and privileged caller checks'},
  {category:'integration',file:'test/FilenameReset.integration.test.js',title:'Filename reset through the main application',
    protects:'production reset wiring, canonical filenames, nested watchfolders, batch resets, cancellation and unsaved user state'},
  {category:'unit',file:'test/EditorArtworkDownload.unit.test.js',title:'Bounded artwork downloads',
    protects:'HTTP protocols, size/time/redirect bounds, native redirect approval and temporary-file cleanup'},
  {category:'unit',file:'test/DesktopService.unit.test.js',title:'Main-process desktop authorization',
    protects:'native directory grants, owner-bound Share plans, watchfolder saves and exported-file reveal'},
  {category:'unit',file:'test/RendererBridge.unit.test.js',title:'Restricted renderer bridge',
    protects:'fixed capability surface, trusted senders, plain bounded payloads, stripped Electron events and isolated subscriptions'},
  {category:'unit',file:'test/LibraryRendererPolicy.unit.test.js',title:'Renderer edit authorization',
    protects:'scanner fields, filesystem grants, watchfolder boundaries and malformed library operations'},
  {category:'unit',file:'test/EditorService.unit.test.js',title:'Main-process editor operations',
    protects:'canonical video identity, owner-scoped catalog proposals and validated artwork/subtitle operations'},
  {category:'unit',file:'test/PlaybackService.unit.test.js',title:'Main-process playback ownership',
    protects:'authoritative media selection, process lifetime, position conflicts and confirmed playback saves'},
  {category:'component',file:'test/Player.component.test.js',title:'Isolated player pane',
    protects:'named playback requests, notifications, close flush and out-of-order state'},
  {
    category: 'component', file: 'test/ExternalLink.component.test.js',
    title: 'External links in catalog results and reports',
    protects: 'shared browser-link component, approved IPC, keyboard/mouse activation and malformed catalog IDs'
  },
  {
    category: 'unit', file: 'test/ExternalContent.unit.test.js',
    title: 'External links and Electron content permissions',
    protects: 'approved browser destinations, trusted main-frame IPC, blocked navigation/popups/embeds and denied permissions'
  },
  {category:'unit',file:'test/ElectronSmokeLifecycle.unit.test.js',title:'Electron smoke-test lifecycle',
    protects:'noninteractive failure teardown, preserved result output, graceful-close ordering and saved-data verification'},
  {category:'unit',file:'test/ElectronPermissions.unit.test.js',title:'Electron permission smoke-test evidence',
    protects:'unchanged forwarding of production permission decisions and rejection of OS-only denials or lookup failures'},
  {category:'integration',file:'test/LibraryTransactions.integration.test.js',title:'Single-writer library transactions',
    protects:'overlapping process edits, confirmed state, disk failures, stale identity conflicts, atomic moves, user priority and revision recovery'},
  {category:'unit',file:'test/SingleInstance.unit.test.js',title:'Library single-instance startup',
    protects:'early process locking, secondary-instance exit, window focus and packaged smoke isolation'},
  {category:'unit',file:'test/LibraryClose.unit.test.js',title:'Library shutdown saves',
    protects:'renderer flush, outstanding commits, close cancellation, explicit discard and bounded shutdown waits'},
  {category:'unit',file:'test/LibraryScanOperations.unit.test.js',title:'Transactional scan operations',
    protects:'fresh-record merging, active/inactive moves, watchfolder ownership and stale scan results'},
  {category:'integration',file:'test/AutoTagConcurrentEdits.integration.test.js',title:'Autotag saves alongside manual editing',
    protects:'lookup baselines, late manual changes, coherent conflict skips and accurate saved-result accounting'},
  {category:'component',file:'test/LibraryEditing.component.test.js',title:'Confirmed library editing',
    protects:'draft retention, delayed and failed saves, batch field diffs, settings transactions and playback-only patches'},
  {category:'integration',file:'test/AutoTagStorage.integration.test.js',title:'Auto-Tag storage failure and notification',
    protects:'disk-full and permission errors, atomic-write rollback, retry eligibility, queues and visible failure dialogs'},
  {category:'integration',file:'test/RendererStartup.integration.test.js',title:'Browser renderer build and update safety',
    protects:'same-timestamp source updates, browser execution without Node/eval, forbidden imports, CSP and packaging compilation order'},
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
    file: 'test/ReactDevToolsBackground.unit.test.js',
    title: 'React DevTools background compatibility',
    protects: 'React detection without browser toolbar APIs and preserved inspection message forwarding'
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
    protects: 'startup/assets, Settings, renderer saves, disk-backed artwork drops, approved browser links, blocked navigation/popups/frames and denied permissions'
  },
  {
    category: 'end-to-end',
    file: 'test/electron/run-electron-smoke.js',
    args: ['--asar'],
    title: 'Real Electron startup from ASAR',
    protects: 'the same UI/assets journey from an actual source-and-assets archive; separate from the full bundled-media packaging test'
  },
  {
    category:'end-to-end',file:'test/electron/run-electron-smoke.js',args:['--library'],
    title:'Library saves through the native UI and restart',
    protects:'rating, scan/edit concurrency, Auto-Tag conflict, batch scope, deferred preferences, playback history and restart durability'
  },
  {
    category:'end-to-end',file:'test/electron/run-electron-smoke.js',args:['--library','--asar'],
    title:'Library save workflows from ASAR',
    protects:'the complete library save/restart journey from an archived application with controlled external service/player fixtures'
  },
  {
    category:'end-to-end',file:'test/electron/run-tagging.js',
    title:'Tagging workflows through the native UI and restart',
    protects:'movie and episode matching, manual choices, batch edits, selected series, concurrent edits, cancellation, service and disk errors, artwork and saved reports'
  },
  {
    category:'end-to-end',file:'test/electron/run-tagging.js',args:['--asar'],
    title:'Tagging workflows from ASAR',
    protects:'the same ten tagging journeys and fresh-process persistence checks from an archived app; external HTTP responses are fixtures'
  }
];
