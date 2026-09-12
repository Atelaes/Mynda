const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const MediaTools = require('../src/MediaTools.js');
const MediaMetadata = require('../src/MediaMetadata.js');
const {getResolutionInfo} = require('../src/VideoResolution.js');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');

if (MediaTools.ffmpegPath) ffmpeg.setFfmpegPath(MediaTools.ffmpegPath);
if (MediaTools.ffprobePath) ffmpeg.setFfprobePath(MediaTools.ffprobePath);

const suite = createSuite(
  'Real video metadata and embedded artwork',
  'integration',
  'Generates disposable one-frame videos and checks Mynda\'s actual FFprobe and FFmpeg fallback paths; no user media or windows.'
);

function generate(args) {
  return MediaTools.runExecutable(MediaTools.ffmpegPath, ['-v','error','-y',...args]);
}

function fallback(filename, directory) {
  return MediaMetadata.readFfmpegMetadata(filename, {
    ffmpeg, identifier: 'integration',
    app: {getPath: name => {
      assert.strictEqual(name, 'userData');
      return directory;
    }}
  });
}

suite.test('selects the movie instead of its larger cover image through both real tools', async () => {
  await withTemporaryDirectory('video-with-cover', async directory => {
    const filename = path.join(directory, 'movie with cover.mp4');
    await generate([
      '-f','lavfi','-i','color=c=black:s=320x240:r=1:d=1',
      '-f','lavfi','-i','color=c=blue:s=2048x1536:r=1:d=1',
      '-map','0:v:0','-map','1:v:0',
      '-c:v:0','mpeg4','-c:v:1','mjpeg',
      '-threads:v:0','1','-threads:v:1','1',
      '-frames:v:0','1','-frames:v:1','1',
      '-disposition:v:1','attached_pic',filename
    ]);
    const probe = await MediaTools.probeFile(filename);
    assert(probe.streams.some(stream => stream.width === 2048 && stream.disposition.attached_pic === 1),
      'Fixture must contain a real attached picture');
    const primary = MediaMetadata.metadataFromProbe(probe);
    const backup = await fallback(filename, directory);
    for (const metadata of [primary, backup]) {
      assert.strictEqual(metadata.codec, 'mpeg4');
      assert.strictEqual(metadata.width, 320);
      assert.strictEqual(metadata.height, 240);
      assert.strictEqual(metadata.video_stream_selected, true);
      assert.strictEqual(getResolutionInfo(metadata).label, '240p');
      assert(metadata.duration > 0 && metadata.duration < 2);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(directory, 'temp')), []);
  });
});

suite.test('accepts a genuine MJPEG video through FFprobe and the real FFmpeg fallback', async () => {
  await withTemporaryDirectory('genuine-mjpeg', async directory => {
    const filename = path.join(directory, 'motion jpeg.avi');
    await generate([
      '-f','lavfi','-i','color=c=black:s=640x480:r=1:d=1',
      '-c:v','mjpeg','-threads','1','-frames:v','1',filename
    ]);
    const probe = await MediaTools.probeFile(filename);
    assert.strictEqual(probe.streams[0].disposition.attached_pic, 0);
    for (const metadata of [MediaMetadata.metadataFromProbe(probe), await fallback(filename, directory)]) {
      assert.strictEqual(metadata.codec, 'mjpeg');
      assert.strictEqual(metadata.video_stream_selected, true);
      assert.strictEqual(getResolutionInfo(metadata).label, '480p');
      assert.strictEqual(metadata.width, 640);
      assert.strictEqual(metadata.height, 480);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(directory, 'temp')), []);
  });
});

suite.test('rejects unavailable fallback input and leaves no scratch output', async () => {
  await withTemporaryDirectory('failed-video-metadata', async directory => {
    await assert.rejects(() => fallback(path.join(directory, 'missing.mkv'), directory),
      /No such file|not found|cannot find/i);
    assert.deepStrictEqual(fs.readdirSync(path.join(directory, 'temp')), []);
  });
});

runSuite(suite);
