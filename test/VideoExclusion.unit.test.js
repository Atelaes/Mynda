const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const VideoExclusion = require('../src/scanning/VideoExclusion.js');

const suite = createSuite(
  'Sample and trailer exclusion policy',
  'unit',
  'Uses fake metadata probes and packet verification so no media file is opened.'
);

function logger() {
  const entries = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (message, data) => entries.push({level, message, data});
  }
  return {log, entries};
}

suite.test('classifies explicit trailers, samples, and ordinary films', () => {
  assert.strictEqual(VideoExclusion.candidateKind('/Movies/Alien/Trailer.mp4'), 'trailer');
  assert.strictEqual(VideoExclusion.candidateKind('/Movies/Alien/Alien.sample.mkv'), 'sample/garbage');
  assert.strictEqual(VideoExclusion.candidateKind('/Movies/Alien/Samples/clip.mkv'), 'sample/garbage');
  assert.strictEqual(VideoExclusion.candidateKind('/Movies/Alien/Alien.mkv'), '');
  assert.strictEqual(VideoExclusion.runtimeIsBelowLimit(299), true);
  assert.strictEqual(VideoExclusion.runtimeIsBelowLimit(300), false);
});

suite.test('does no expensive work for an ordinary video', async () => {
  let probes = 0;
  const exclusion = new VideoExclusion({
    probeMetadata: async () => { probes++; return {duration: 10}; },
    verifyMinimumRuntime: async () => { throw new Error('should not run'); }
  });
  assert.strictEqual(await exclusion.shouldExclude('/Movies/Alien/Alien.mkv'), false);
  assert.strictEqual(probes, 0);
});

suite.test('honors preferences before reading stored metadata or probing', async () => {
  let probes = 0;
  const exclusion = new VideoExclusion({
    library: {media: [{filename: '/Movies/Alien/Trailer.mp4', metadata: {duration: 30}}]},
    isExclusionEnabled: kind => kind !== 'trailer',
    probeMetadata: async () => { probes++; return {duration: 30}; }
  });
  assert.strictEqual(await exclusion.shouldExclude('/Movies/Alien/Trailer.mp4'), false);
  assert.strictEqual(probes, 0);
});

suite.test('uses stored runtime when available and excludes a short candidate', async () => {
  let probes = 0;
  const output = logger();
  const filename = '/Movies/Alien/Alien.sample.mkv';
  const exclusion = new VideoExclusion({
    library: {media: [{filename, metadata: {duration: 84}}], inactive_media: []},
    probeMetadata: async () => { probes++; return {duration: 9000}; },
    log: output.log
  });
  assert.strictEqual(await exclusion.shouldExclude(filename), true);
  assert.strictEqual(probes, 0);
  assert.strictEqual(output.entries[0].data.durationSource, 'stored metadata');
});

suite.test('probes missing runtime but retains the video when the probe fails', async () => {
  const output = logger();
  const exclusion = new VideoExclusion({
    probeMetadata: async () => { throw new Error('unreadable container'); },
    log: output.log
  });
  assert.strictEqual(await exclusion.shouldExclude('/Movies/Alien/Trailer.mp4'), false);
  assert(output.entries.some(entry => entry.level === 'warn' && /retaining video/.test(entry.message)));
});

suite.test('uses bounded verification when a strong candidate reports a false long runtime', async () => {
  const filename = '/Movies/Alien/Samples/Alien.sample.mkv';
  const exclusion = new VideoExclusion({
    probeMetadata: async () => ({duration: 7000, framerate: 24}),
    verifyMinimumRuntime: async options => {
      assert.strictEqual(options.filename, filename);
      assert.strictEqual(options.minimumSeconds, 300);
      assert.strictEqual(options.framerate, 24);
      return {hasMinimumRuntime: false, packetsRead: 2400, targetPackets: 7200};
    }
  });
  assert.strictEqual(await exclusion.shouldExclude(filename), true);
});

suite.test('retains verified long content and weak mixed-folder candidates', async () => {
  let verifications = 0;
  const exclusion = new VideoExclusion({
    probeMetadata: async () => ({duration: 7000, framerate: 24}),
    verifyMinimumRuntime: async () => {
      verifications++;
      return {hasMinimumRuntime: true, packetsRead: 7200, targetPackets: 7200};
    }
  });

  assert.strictEqual(await exclusion.shouldExclude('/Movies/Alien/Samples/Alien.sample.mkv'), false);
  assert.strictEqual(await exclusion.shouldExclude('/Movies/Movie and Sample/Alien.mkv'), false);
  assert.strictEqual(verifications, 1);
});

suite.test('serializes metadata probes so a scan cannot overload the machine', async () => {
  let active = 0;
  let maximumActive = 0;
  const exclusion = new VideoExclusion({
    probeMetadata: () => new Promise(resolve => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      setTimeout(() => {
        active--;
        resolve({duration: 30});
      }, 5);
    })
  });

  const results = await Promise.all([
    exclusion.shouldExclude('/Movies/A/Trailer.mp4'),
    exclusion.shouldExclude('/Movies/B/Trailer.mp4'),
    exclusion.shouldExclude('/Movies/C/Trailer.mp4')
  ]);
  assert.deepStrictEqual(results, [true, true, true]);
  assert.strictEqual(maximumActive, 1);
});

suite.test('a bad preference reader fails safely by retaining the candidate', async () => {
  const output = logger();
  const exclusion = new VideoExclusion({
    isExclusionEnabled: () => { throw new Error('settings unavailable'); },
    probeMetadata: async () => ({duration: 10}),
    log: output.log
  });
  assert.strictEqual(await exclusion.shouldExclude('/Movies/A/Trailer.mp4'), false);
  assert(output.entries.some(entry => entry.level === 'warn'));
});

runSuite(suite);
