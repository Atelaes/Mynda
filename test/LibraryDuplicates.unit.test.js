const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {
  duplicatePathKey,
  normalizeDuplicatePaths,
  ScanDuplicateTracker
} = require('../src/LibraryDuplicates.js');

const suite = createSuite(
  'Library duplicate-path tracking',
  'unit',
  'Protects duplicate-path normalization, scan reconciliation, and offline retention.'
);

suite.test('normalizes absolute paths and removes invalid, repeated, and primary entries', () => {
  assert.deepStrictEqual(normalizeDuplicatePaths([
    '/watch/duplicates/../Movie Copy.mkv',
    '/watch/Movie Copy.mkv',
    '/watch/Movie.mkv',
    'relative/Movie.mkv',
    '',
    null
  ], '/watch/Movie.mkv', 'linux'), ['/watch/Movie Copy.mkv']);
});

suite.test('compares Windows paths case-insensitively', () => {
  assert.strictEqual(
    duplicatePathKey('C:\\Movies\\ALIEN.MKV', 'win32'),
    duplicatePathKey('c:\\movies\\alien.mkv', 'win32')
  );
  assert.deepStrictEqual(normalizeDuplicatePaths([
    'C:\\Movies\\Alien Copy.mkv',
    'c:\\movies\\ALIEN COPY.MKV',
    'C:\\Movies\\Alien.mkv'
  ], 'c:\\movies\\ALIEN.MKV', 'win32'), ['C:\\Movies\\Alien Copy.mkv']);
});

suite.test('rebuilds available paths while retaining evidence beneath offline watchfolders', () => {
  const tracker = new ScanDuplicateTracker([{
    id: 'alien',
    filename: '/online/Alien.mkv',
    duplicates: ['/online/Removed Copy.mkv', '/offline/Alien Copy.mkv']
  }], filepath => filepath.startsWith('/offline/'), 'linux');

  tracker.record('alien', '/online/New Copy.mkv');
  const videos = tracker.apply([{
    id: 'alien',
    filename: '/online/Alien.mkv',
    duplicates: ['/stale/value.mkv']
  }]);
  assert.deepStrictEqual(videos[0].duplicates, [
    '/offline/Alien Copy.mkv',
    '/online/New Copy.mkv'
  ]);
});

suite.test('tracks duplicates for a primary video first discovered in the same scan', () => {
  const tracker = new ScanDuplicateTracker([], () => false, 'linux');
  assert.strictEqual(tracker.record('new-video', '/watch/Second Copy.mkv'), true);
  assert.strictEqual(tracker.record('new-video', '/watch/Second Copy.mkv'), false);
  assert.strictEqual(tracker.record('', '/watch/Invalid.mkv'), false);
  const videos = tracker.apply([{
    id: 'new-video',
    filename: '/watch/First Copy.mkv'
  }]);
  assert.deepStrictEqual(videos[0].duplicates, ['/watch/Second Copy.mkv']);
});

runSuite(suite);
