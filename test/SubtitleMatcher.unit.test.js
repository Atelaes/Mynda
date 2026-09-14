const path = require('path');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const SubtitleMatcher = require('../src/scanning/SubtitleMatcher.js');

const suite = createSuite(
  'Subtitle matching and edit reconciliation',
  'unit',
  'Exercises watchfolder-tree matching and subtitle provenance entirely in memory.'
);

function video(filename, extras = {}) {
  return Object.assign({filename, dvd: false, subtitles: []}, extras);
}

function folder(root, videos = [], subtitles = [], folders = []) {
  return {path: root, videos, subtitles, folders};
}

suite.test('deduplicates subtitle paths without retaining invalid entries', () => {
  const subtitle = path.join('/watch', 'Movie.en.srt');
  assert.deepStrictEqual(
    SubtitleMatcher.uniquePaths([subtitle, subtitle, '', null, subtitle]),
    [subtitle]
  );
  assert.strictEqual(SubtitleMatcher.subtitleExtensions.includes('srt'), true);
  assert.strictEqual(SubtitleMatcher.subtitleExtensions.includes('txt'), false);
});

suite.test('assigns an ordinary sidecar subtitle to the sole movie', () => {
  const root = path.join(path.sep, 'watch', 'Alien');
  const movie = video(path.join(root, 'Alien.1979.mkv'));
  const subtitle = path.join(root, 'Alien.1979.en.srt');
  const result = SubtitleMatcher.matchWatchfolderSubtitles(folder(root, [movie], [subtitle]));

  assert.deepStrictEqual(result.results.get(movie), [subtitle]);
  assert.deepStrictEqual(result.unmatched, []);
  assert.strictEqual(result.numSubtitles, 1);
});

suite.test('uses season and episode numbers when several episodes share a folder', () => {
  const root = path.join(path.sep, 'watch', 'Show');
  const first = video(path.join(root, 'Show.S01E01.mkv'));
  const second = video(path.join(root, 'Show.S01E02.mkv'));
  const subtitle = path.join(root, 'Show.S01E02.English.srt');
  const result = SubtitleMatcher.matchWatchfolderSubtitles(
    folder(root, [first, second], [subtitle])
  );

  assert.deepStrictEqual(result.results.get(first), []);
  assert.deepStrictEqual(result.results.get(second), [subtitle]);
});

suite.test('crosses a conventional Subs folder only when evidence is safe', () => {
  const root = path.join(path.sep, 'watch', 'Movie Folder');
  const movie = video(path.join(root, 'Movie.mkv'));
  const subtitle = path.join(root, 'Subs', 'English.srt');
  const subsFolder = folder(path.join(root, 'Subs'), [], [subtitle]);
  const result = SubtitleMatcher.matchWatchfolderSubtitles(
    folder(root, [movie], [], [subsFolder])
  );
  assert.deepStrictEqual(result.results.get(movie), [subtitle]);
});

suite.test('leaves weak ties ambiguous instead of assigning the subtitle twice', () => {
  const root = path.join(path.sep, 'watch');
  const extended = video(path.join(root, 'Alpha Beta Gamma Epsilon.mkv'));
  const remastered = video(path.join(root, 'Alpha Beta Gamma Zeta.mkv'));
  const subtitle = path.join(root, 'Alpha Beta Gamma Delta.srt');
  const result = SubtitleMatcher.matchWatchfolderSubtitles(
    folder(root, [extended, remastered], [subtitle])
  );

  assert.deepStrictEqual(result.results.get(extended), []);
  assert.deepStrictEqual(result.results.get(remastered), []);
  assert.deepStrictEqual(result.unmatched, [subtitle]);
  assert.strictEqual(result.ambiguous.length, 1);
});

suite.test('skips unavailable watchfolders while collecting scan statistics', () => {
  const onlineRoot = path.join(path.sep, 'online');
  const offlineRoot = path.join(path.sep, 'offline');
  const onlineVideo = video(path.join(onlineRoot, 'Online.mkv'));
  const offlineVideo = video(path.join(offlineRoot, 'Offline.mkv'));
  const onlineSubtitle = path.join(onlineRoot, 'Online.srt');
  const offlineSubtitle = path.join(offlineRoot, 'Offline.srt');
  const tree = {
    folders: [
      folder(onlineRoot, [onlineVideo], [onlineSubtitle]),
      folder(offlineRoot, [offlineVideo], [offlineSubtitle])
    ]
  };

  const prepared = SubtitleMatcher.prepareSubtitleMatches(tree, new Set([offlineRoot]));
  assert.deepStrictEqual(onlineVideo.subtitles, [onlineSubtitle]);
  assert.deepStrictEqual(offlineVideo.subtitles, []);
  assert.strictEqual(prepared.stats.numSubtitles, 1);
});

suite.test('reconciles detected, manual, and deliberately ignored subtitles', () => {
  const autoOld = '/watch/Movie.en.srt';
  const autoIgnored = '/watch/Movie.commentary.srt';
  const autoNew = '/watch/Movie.forced.srt';
  const manual = '/outside/custom.srt';
  const item = video('/watch/Movie.mkv', {
    subtitles: [autoOld, manual],
    detected_subtitles: [autoOld],
    manual_subtitles: [manual],
    ignored_subtitles: [autoIgnored],
    subtitle_tracking_initialized: true
  });

  const changed = SubtitleMatcher.reconcileVideoSubtitles(
    item,
    [autoOld, autoIgnored, autoNew],
    {}
  );
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(item.subtitles, [autoOld, manual, autoNew]);
  assert.deepStrictEqual(item.manual_subtitles, [manual]);
  assert.deepStrictEqual(item.ignored_subtitles, [autoIgnored]);
});

suite.test('records user additions and removals so later scans respect them', () => {
  const detected = '/watch/Movie.en.srt';
  const manual = '/outside/custom.srt';
  const oldVideo = video('/watch/Movie.mkv', {
    subtitles: [detected],
    detected_subtitles: [detected],
    manual_subtitles: [],
    ignored_subtitles: [],
    subtitle_tracking_initialized: true
  });
  const edited = Object.assign({}, oldVideo, {subtitles: [manual]});

  SubtitleMatcher.trackManualSubtitleEdit(oldVideo, edited);
  assert.deepStrictEqual(edited.subtitles, [manual]);
  assert.deepStrictEqual(edited.manual_subtitles, [manual]);
  assert.deepStrictEqual(edited.ignored_subtitles, [detected]);
  assert.deepStrictEqual(edited.detected_subtitles, [detected]);
});

suite.test('carries hidden tracking fields through an unrelated editor save', () => {
  const detected = '/watch/Movie.en.srt';
  const oldVideo = video('/watch/Movie.mkv', {
    title: 'Before',
    subtitles: [detected],
    detected_subtitles: [detected],
    manual_subtitles: [],
    ignored_subtitles: ['/watch/Movie.commentary.srt'],
    subtitle_tracking_initialized: true
  });
  const staleEditorCopy = video('/watch/Movie.mkv', {
    title: 'After',
    subtitles: [detected]
  });

  SubtitleMatcher.trackManualSubtitleEdit(oldVideo, staleEditorCopy);
  assert.deepStrictEqual(staleEditorCopy.detected_subtitles, [detected]);
  assert.deepStrictEqual(staleEditorCopy.ignored_subtitles, ['/watch/Movie.commentary.srt']);
  assert.strictEqual(staleEditorCopy.title, 'After');
});

suite.test('counts each legacy subtitle once per video', () => {
  const shared = '/watch/shared.srt';
  const counts = SubtitleMatcher.buildLegacySubtitleCounts([
    {subtitles: [shared, shared]},
    {subtitles: [shared]},
    null
  ], [{subtitles: ['/watch/other.srt']}]);
  assert.strictEqual(counts.get(SubtitleMatcher.pathKey(shared)), 2);
  assert.strictEqual(counts.get(SubtitleMatcher.pathKey('/watch/other.srt')), 1);
});

runSuite(suite);
