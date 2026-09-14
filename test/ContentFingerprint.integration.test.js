const fs = require('fs');
const path = require('path');
const Fingerprint = require('../src/library/ContentFingerprint.js');
const Identity = require('../src/library/VideoIdentity.js');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');

const suite = createSuite('Content-based video IDs', 'integration',
  'Checks the fixed cross-platform fingerprint protocol against real disposable files and DVD folders.');
const id = async filename => (await Fingerprint.fingerprintPath(filename)).id;

suite.test('pins sample sizes and exact offsets independently of the implementation', () => {
  assert.deepStrictEqual(Fingerprint.sampleRanges(10 * 1024 * 1024), [
    {offset:0,length:262144}, {offset:2555904,length:262144},
    {offset:5111808,length:262144}, {offset:7667712,length:262144},
    {offset:10223616,length:262144}
  ]);
  assert.deepStrictEqual(Fingerprint.sampleRanges(1310720), [{offset:0,length:1310720}]);
  assert.deepStrictEqual(Fingerprint.sampleRanges(0), [{offset:0,length:0}]);
  assert.throws(() => Fingerprint.sampleRanges(-1));
});

suite.test('matches independently generated SHA-256 protocol vectors', () =>
  withTemporaryDirectory('fingerprint-vectors', async directory => {
    const file = path.join(directory, 'fixture.bin');
    // Golden values are independently calculated from the published framing
    // with Python hashlib/struct, not produced by the code under test.
    const vectors = [
      [Buffer.alloc(0), '2c26a80b6716466ce55bee57b149c3bba7bbf06412c8efe1da6f4f855a8557ed'],
      [Buffer.from('abc'), '14bb0605a19cde2b62e19e29bef9aedf05088250f24052c54872abb1405d707e'],
      [Buffer.alloc(10 * 1024 * 1024), '6a83bc1540849095264e4fa09ea71e73f16c6678632b2c6c2090798ac7d9c55d']
    ];
    for (const [bytes, expected] of vectors) {
      fs.writeFileSync(file, bytes);
      assert.strictEqual(await id(file), expected);
      assert(Identity.isVideoID(expected));
    }
  }));

suite.test('ignores names and timestamps but distinguishes same-prefix files by size and later samples', () =>
  withTemporaryDirectory('fingerprint-copies', async directory => {
    const first = path.join(directory, 'one.mkv');
    const second = path.join(directory, 'renamed.mp4');
    fs.writeFileSync(first, Buffer.alloc(10 * 1024 * 1024));
    fs.copyFileSync(first, second);
    fs.utimesSync(second, 1, 1);
    const original = await id(first);
    assert.strictEqual(await id(second), original);
    const descriptor = fs.openSync(second, 'r+');
    fs.writeSync(descriptor, Buffer.from([1]), 0, 1, 5 * 1024 * 1024);
    fs.closeSync(descriptor);
    assert.notStrictEqual(await id(second), original);
    fs.copyFileSync(first, second);
    fs.appendFileSync(second, Buffer.from([0]));
    assert.notStrictEqual(await id(second), original);
  }));

suite.test('explicitly documents that changes outside the sampled ranges can share an ID', () =>
  withTemporaryDirectory('fingerprint-sampling-limit', async directory => {
    const file = path.join(directory, 'video.mkv');
    fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024));
    const before = await id(file);
    const descriptor = fs.openSync(file, 'r+');
    fs.writeSync(descriptor, Buffer.from([1]), 0, 1, 1024 * 1024);
    fs.closeSync(descriptor);
    assert.strictEqual(await id(file), before);
  }));

function dvd(directory, nested, lowercase = false) {
  const root = nested ? path.join(directory, lowercase ? 'video_ts' : 'VIDEO_TS') : directory;
  fs.mkdirSync(root, {recursive:true});
  for (const [name, contents] of [['VIDEO_TS.IFO','control'], ['VTS_01_0.BUP','backup'], ['VTS_01_1.VOB','video']]) {
    fs.writeFileSync(path.join(root, lowercase ? name.toLowerCase() : name), contents);
  }
  return root;
}

suite.test('gives copied DVDs the same ID across casing, folder names, and VIDEO_TS layouts', () =>
  withTemporaryDirectory('fingerprint-dvd-layout', async directory => {
    const first = path.join(directory, 'First Disc');
    const second = path.join(directory, 'Other Name');
    const playback = dvd(first, true);
    dvd(second, false, true);
    const expected = '2fb19afc73d97d2d68d0ddbfe70e52e66273b937c67be79d1382d197b412109d';
    assert.strictEqual(await id(first), expected);
    assert.strictEqual(await id(playback), expected);
    assert.strictEqual(await id(second), expected);
    fs.writeFileSync(path.join(first, 'poster.jpg'), 'unrelated artwork');
    fs.writeFileSync(path.join(playback, 'subtitle.srt'), 'external subtitle');
    assert.strictEqual(await id(first), expected);
  }));

suite.test('includes every DVD playback file and fully reads IFO/BUP control files', () =>
  withTemporaryDirectory('fingerprint-dvd-content', async directory => {
    const playback = dvd(directory, true);
    const before = await id(directory);
    const secondVob = path.join(playback, 'VTS_02_1.VOB');
    fs.writeFileSync(secondVob, Buffer.alloc(10 * 1024 * 1024));
    const withExtra = await id(directory);
    assert.notStrictEqual(withExtra, before);
    const fd = fs.openSync(secondVob, 'r+');
    fs.writeSync(fd, Buffer.from([1]), 0, 1, 5 * 1024 * 1024);
    fs.closeSync(fd);
    assert.notStrictEqual(await id(directory), withExtra);
    const ifo = path.join(playback, 'VIDEO_TS.IFO');
    fs.writeFileSync(ifo, Buffer.alloc(10 * 1024 * 1024));
    const controlBefore = await id(directory);
    const controlFd = fs.openSync(ifo, 'r+');
    fs.writeSync(controlFd, Buffer.from([1]), 0, 1, 1024 * 1024);
    fs.closeSync(controlFd);
    assert.notStrictEqual(await id(directory), controlBefore);
  }));

suite.test('reuses only unchanged path snapshots and invalidates caches when media changes', () =>
  withTemporaryDirectory('fingerprint-cache', async directory => {
    const file = path.join(directory, 'video.mkv');
    fs.writeFileSync(file, 'bytes');
    const first = await Fingerprint.fingerprintPath(file);
    let read = 0;
    const second = await Fingerprint.fingerprintPath(file, {previous:first,onBytes: n => {read += n;}});
    assert.strictEqual(second.cached, true);
    assert.strictEqual(read, 0);
    fs.appendFileSync(file, 'changed');
    const third = await Fingerprint.fingerprintPath(file, {previous:first});
    assert.strictEqual(third.cached, false);
    assert.notStrictEqual(third.id, first.id);
  }));

suite.test('rejects changing files, cancellation, unreadable paths, and empty DVD folders', () =>
  withTemporaryDirectory('fingerprint-failure', async directory => {
    const file = path.join(directory, 'video.mkv');
    fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
    let changed = false;
    await assert.rejects(() => Fingerprint.fingerprintPath(file, {onBytes() {
      if (!changed) { changed = true; fs.appendFileSync(file, 'changed'); }
    }}), error => error.code === 'FINGERPRINT_CHANGED');
    await assert.rejects(() => Fingerprint.fingerprintPath(file, {shouldCancel: () => true}),
      error => error.code === 'FINGERPRINT_CANCELED');
    await assert.rejects(() => id(path.join(directory, 'missing')), error => error.code === 'ENOENT');
    const empty = path.join(directory, 'empty'); fs.mkdirSync(empty);
    await assert.rejects(() => id(empty), error => error.code === 'FINGERPRINT_DVD_EMPTY');
    await assert.rejects(() => Fingerprint.fingerprintPath(file, {dvd:true}), error => error.code === 'FINGERPRINT_FILE_TYPE');
  }));

suite.test('rejects ambiguous DVD layouts rather than choosing an arbitrary playback set', () =>
  withTemporaryDirectory('fingerprint-dvd-ambiguity', async directory => {
    dvd(directory, true);
    fs.writeFileSync(path.join(directory, 'VTS_01_1.VOB'), 'outside');
    await assert.rejects(() => id(directory), error => error.code === 'FINGERPRINT_DVD_AMBIGUOUS');
  }));

runSuite(suite);
