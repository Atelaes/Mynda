const fs = require('fs');
const path = require('path');
const MediaMetadata = require('../src/MediaMetadata.js');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Media metadata normalization and scratch paths',
  'unit',
  'Protects container-level FFprobe durations and writable packaged-app fallback output.'
);

suite.test('uses a Matroska container duration when streams omit it', () => {
  assert.strictEqual(MediaMetadata.durationFromProbe({
    streams: [{codec_type: 'video'}, {codec_type: 'audio', duration: 'N/A'}],
    format: {duration: '64.68'}
  }), 64.68);
});

suite.test('prefers a video-stream duration and rejects unusable values', () => {
  assert.strictEqual(MediaMetadata.durationFromProbe({
    streams: [
      {codec_type: 'audio', duration: '70'},
      {codec_type: 'video', duration: '65'}
    ],
    format: {duration: '80'}
  }), 65);
  assert.strictEqual(MediaMetadata.durationFromProbe({
    streams: [{codec_type: 'video', duration: 'N/A'}],
    format: {duration: '-1'}
  }), 0);
});

suite.test('creates FFmpeg fallback output under writable userData', async () => {
  await withTemporaryDirectory('metadata-user-data', directory => {
    const output = MediaMetadata.createFallbackOutputPath({
      getPath(name) {
        assert.strictEqual(name, 'userData');
        return directory;
      }
    }, {identifier: 'known-id'});

    assert.strictEqual(output, path.join(directory, 'temp', 'metadata-known-id.mkv'));
    assert.strictEqual(fs.statSync(path.dirname(output)).isDirectory(), true);
    assert.strictEqual(fs.existsSync(output), false);
  });
});

runSuite(suite);
