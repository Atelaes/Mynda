const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {videoFixture} = require('./helpers/Fixtures.js');
const {
  RESOLUTION_BUCKETS,
  percentage,
  formatPercentage,
  resolutionBucket,
  buildLibraryStats
} = require('../src/LibraryStats.js');

const suite = createSuite(
  'Library statistics',
  'unit',
  'Protects viewing totals, visible-title series grouping, resolution tiers, and global duplicate totals.'
);

suite.test('calculates stable whole-number and one-decimal percentages', () => {
  assert.strictEqual(percentage(2, 3), 66.7);
  assert.strictEqual(formatPercentage(2, 3), '66.7%');
  assert.strictEqual(formatPercentage(3, 4), '75%');
  assert.strictEqual(formatPercentage(0, 0), '0%');
  assert.strictEqual(formatPercentage('bad', 10), '0%');
});

suite.test('classifies cropped, vertical, standard, and missing frame dimensions', () => {
  assert.strictEqual(resolutionBucket({metadata: {width: 3840, height: 1600}}), '4K');
  assert.strictEqual(resolutionBucket({metadata: {width: 1080, height: 1920}}), '1080p');
  assert.strictEqual(resolutionBucket({metadata: {width: 1280, height: 534}}), '720p');
  assert.strictEqual(resolutionBucket({metadata: {width: 720, height: 480}}), '480p');
  assert.strictEqual(resolutionBucket({metadata: {width: 0, height: 0}}), 'Unknown');
  assert.strictEqual(resolutionBucket({metadata: null}), 'Unknown');
});

suite.test('counts seen and unseen videos for the library and within each kind', () => {
  const stats = buildLibraryStats([
    videoFixture({id: 'movie-seen', kind: 'movie', seen: true}),
    videoFixture({id: 'movie-unseen', kind: 'movie', seen: false}),
    videoFixture({id: 'show-seen-a', kind: 'show', seen: true}),
    videoFixture({id: 'show-seen-b', kind: 'show', seen: true}),
    null
  ]);

  assert.deepStrictEqual({
    videos: stats.videoCount,
    seen: stats.seenCount,
    unseen: stats.unseenCount
  }, {videos: 4, seen: 3, unseen: 1});
  assert.deepStrictEqual(stats.kinds.map(kind => ({
    kind: kind.value,
    videos: kind.count,
    seen: kind.seenCount,
    unseen: kind.unseenCount
  })), [
    {kind: 'movie', videos: 2, seen: 1, unseen: 1},
    {kind: 'show', videos: 2, seen: 2, unseen: 0}
  ]);
});

suite.test('groups series by the exact title used by Series view and ignores IMDb IDs', () => {
  const stats = buildLibraryStats([
    videoFixture({id: 'show-a', kind: 'show', series: 'Doctor Who', seriesImdbID: 'tt0056751'}),
    videoFixture({id: 'show-b', kind: 'show', series: 'Doctor Who', seriesImdbID: 'tt0436992'}),
    videoFixture({id: 'show-c', kind: 'show', series: 'Doctor Who (Classic)', seriesImdbID: 'tt0056751'}),
    videoFixture({id: 'show-d', kind: 'show', series: 'doctor who', seriesImdbID: 'tt0056751'}),
    videoFixture({id: 'show-none', kind: 'show', series: '', seriesImdbID: 'tt9999999'}),
    videoFixture({id: 'movie-series', kind: 'movie', series: 'Doctor Who', seriesImdbID: ''})
  ]);

  const show = stats.kinds.find(kind => kind.value === 'show');
  const movie = stats.kinds.find(kind => kind.value === 'movie');
  assert.strictEqual(show.seriesCount, 3);
  assert.strictEqual(movie.seriesCount, 1);
});

suite.test('produces a fixed whole-library resolution breakdown with percentages', () => {
  const stats = buildLibraryStats([
    videoFixture({id: 'uhd', metadata: {width: 3840, height: 1600}}),
    videoFixture({id: 'full-hd', metadata: {width: 1920, height: 800}}),
    videoFixture({id: 'hd', metadata: {width: 1280, height: 720}}),
    videoFixture({id: 'sd', metadata: {width: 720, height: 480}}),
    videoFixture({id: 'unknown', metadata: {width: '', height: ''}})
  ]);

  assert.deepStrictEqual(stats.resolutions.map(row => row.value), RESOLUTION_BUCKETS);
  assert.deepStrictEqual(stats.resolutions.filter(row => row.count).map(row => ({
    label: row.value, count: row.count, percentage: row.percentage
  })), [
    {label:'4K',count:1,percentage:20}, {label:'1080p',count:1,percentage:20},
    {label:'720p',count:1,percentage:20}, {label:'480p',count:1,percentage:20},
    {label:'Unknown',count:1,percentage:20}
  ]);
});

suite.test('collects all duplicate files into one library-wide group', () => {
  const stats = buildLibraryStats([
    videoFixture({
      id: 'movie',
      kind: 'movie',
      filename: '/library/Movie.mkv',
      duplicates: ['/duplicates/Movie A.mkv', '/duplicates/Movie B.mkv']
    }),
    videoFixture({
      id: 'show',
      kind: 'show',
      filename: '/library/Episode.mkv',
      duplicates: ['/duplicates/Episode.mkv', '/library/Episode.mkv']
    })
  ], 'linux');

  assert.strictEqual(stats.duplicateCount, 3);
  assert.strictEqual(stats.duplicateVideos.length, 2);
  assert.deepStrictEqual(stats.duplicateVideos[1].paths, ['/duplicates/Episode.mkv']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stats.kinds[0], 'duplicateCount'), false);
});

runSuite(suite);
