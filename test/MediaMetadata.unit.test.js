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
  'Media metadata selection and normalization',
  'unit',
  'Protects video-stream selection, fallback metadata, legacy rechecks, durations, and writable scratch output.'
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

function videoStream(overrides = {}) {
  return {index:0, codec_type:'video', codec_name:'h264', width:1920, height:800, ...overrides};
}

suite.test('excludes attached pictures and thumbnails regardless of order or default flag', () => {
  const actual = videoStream();
  const cover = videoStream({index:2, codec_name:'mjpeg', width:2000, height:3000,
    disposition:{attached_pic:1, default:1}});
  const thumbnail = videoStream({index:3, disposition:{timed_thumbnails:'1'}});
  const still = videoStream({index:4, disposition:{still_image:true}});
  [ [cover, actual, thumbnail, still], [actual, thumbnail, cover] ].forEach(streams => {
    assert.strictEqual(MediaMetadata.selectVideoStream({streams}), actual);
  });
  assert.strictEqual(MediaMetadata.selectVideoStream({streams:[cover,thumbnail,still]}), null);
});

suite.test('prefers a usable default video and otherwise keeps the first playable video', () => {
  const first = videoStream();
  const preferred = videoStream({index:1, width:1280, height:720, disposition:{default:1}});
  const invalid = videoStream({index:2,width:0,height:0,disposition:{default:1}});
  assert.strictEqual(MediaMetadata.selectVideoStream({streams:[first,preferred]}), preferred);
  assert.strictEqual(MediaMetadata.selectVideoStream({streams:[invalid,first]}), first);
  assert.strictEqual(MediaMetadata.selectVideoStream({streams:[first,videoStream({index:3})]}), first);
});

suite.test('accepts genuine MJPEG video and normalizes optional probe fields safely', () => {
  const result = MediaMetadata.metadataFromProbe({streams:[videoStream({
    codec_name:'mjpeg',width:720,height:432, disposition:{attached_pic:'0'},
    sample_aspect_ratio:'64:45',display_aspect_ratio:'64:27',
    avg_frame_rate:'0/0',r_frame_rate:'25/1'
  })],format:{duration:'123.4'}});
  assert.strictEqual(result.video_stream_selected, true);
  assert.strictEqual(result.sample_aspect_ratio, '64:45');
  assert.strictEqual(result.aspect_ratio, '64:27');
  assert.strictEqual(result.framerate, 25);
  assert.strictEqual(result.duration, 123.4);
  const sparse = MediaMetadata.metadataFromProbe({streams:[null,videoStream()]});
  assert.strictEqual(sparse.width, 1920);
  assert.strictEqual(sparse.framerate, undefined);
  assert.strictEqual(sparse.duration, undefined);
});

suite.test('never uses attached-picture duration in place of the movie or container duration', () => {
  const poster = videoStream({duration:'9999',disposition:{attached_pic:1}});
  assert.strictEqual(MediaMetadata.durationFromProbe({
    streams:[poster,videoStream({duration:'65'})],format:{duration:'80'}
  }), 65);
  assert.strictEqual(MediaMetadata.durationFromProbe({streams:[poster],format:{duration:'80'}}), 80);
  assert.strictEqual(MediaMetadata.durationFromProbe({streams:[poster]}), 0);
});

suite.test('collects FFmpeg input video lines including dimensions and aspect ratios from the same fragment', () => {
  const collector = MediaMetadata.createFfmpegVideoCollector();
  [
    'Input #0, matroska,webm, from movie.mkv:',
    '  Stream #0:0[0x1](eng): Video: h264 (High), yuv420p, 720x432 [SAR 64:45 DAR 64:27], 25 fps (default)',
    '  Stream #0:2: Video: mjpeg (Baseline), yuvj420p, 2000x3000 [SAR 1:1 DAR 2:3] (attached pic)',
    'Output #0, matroska, to output.mkv:',
    '  Stream #0:0: Video: h264, yuv420p, 640x360'
  ].forEach(line => collector.consume(line));
  assert.strictEqual(collector.streams.length, 2);
  const result = MediaMetadata.metadataFromFfmpeg({
    duration:'01:02:03.50',video:'mjpeg',video_details:['2000x3000'],audio:'aac',audio_details:['stereo']
  },collector.streams);
  assert.strictEqual(result.codec, 'h264');
  assert.strictEqual(result.width, 720);
  assert.strictEqual(result.height, 432);
  assert.strictEqual(result.sample_aspect_ratio, '64:45');
  assert.strictEqual(result.aspect_ratio, '64:27');
  assert.strictEqual(result.framerate, 25);
  assert.strictEqual(result.duration, 3723.5);
  assert.strictEqual(result.audio_channels, 2);
});

suite.test('keeps cover-only FFmpeg input from supplying video dimensions', () => {
  const result = MediaMetadata.metadataFromFfmpeg({duration:'30',video:'mjpeg'},[
    videoStream({codec_name:'mjpeg',disposition:{attached_pic:true}})
  ]);
  assert.strictEqual(result.video_stream_selected, false);
  assert.strictEqual(result.width, undefined);
  assert.strictEqual(result.duration, 30);
});

suite.test('uses fallback duration without mixing properties from a different video stream', async () => {
  const result = await MediaMetadata.retrieveMetadata({
    probe: async () => ({streams:[videoStream({avg_frame_rate:'0/0'})]}),
    fallback: async () => ({video_stream_selected:true, codec:'mpeg4',width:640,height:480,
      duration:90,sample_aspect_ratio:'2:1',framerate:30})
  });
  assert.strictEqual(result.duration, 90);
  assert.strictEqual(result.width, 1920);
  assert.strictEqual(result.codec, 'h264');
  assert.strictEqual(result.sample_aspect_ratio, undefined);
  assert.strictEqual(result.framerate, 0);
});

suite.test('avoids fallback for complete probe data and fills missing dimensions when needed', async () => {
  const good = await MediaMetadata.retrieveMetadata({
    probe: async () => ({streams:[videoStream({duration:'65'})]}),
    fallback: async () => {throw new Error('Fallback should not run');},
    log:{debug(){},warn(){assert.fail('Fallback should not run');}}
  });
  assert.strictEqual(good.duration, 65);
  const recovered = await MediaMetadata.retrieveMetadata({
    probe: async () => ({streams:[videoStream({width:0,height:0,duration:'65',sample_aspect_ratio:'2:1'})]}),
    fallback: async () => ({video_stream_selected:true,codec:'mpeg4',width:640,height:480,duration:70})
  });
  assert.strictEqual(recovered.width, 640);
  assert.strictEqual(recovered.codec, 'mpeg4');
  assert.strictEqual(recovered.sample_aspect_ratio, undefined);
  assert.strictEqual(recovered.duration, 65);
});

suite.test('recovers through FFmpeg after a probe error and marks selection as checked', async () => {
  const result = await MediaMetadata.retrieveMetadata({
    probe: async () => {throw new Error('probe failed');},
    fallback: async () => ({video_stream_selected:true,codec:'mjpeg',width:640,height:480,duration:30})
  });
  assert.strictEqual(result.width, 640);
  assert.strictEqual(result.video_stream_selected, true);
  assert.strictEqual(result.video_stream_checked, true);
  assert.strictEqual(MediaMetadata.needsMetadataScan(result), false);
});

suite.test('queues only one legacy MJPEG recheck and retains useful non-video metadata on failure', async () => {
  const legacy = {checked:true,codec:'mjpeg',width:2000,height:3000,duration:60,audio_codec:'aac'};
  assert.strictEqual(MediaMetadata.needsMetadataScan(legacy), true);
  assert.strictEqual(MediaMetadata.needsMetadataScan({checked:true,codec:'h264'}), false);
  assert.strictEqual(MediaMetadata.needsMetadataScan({codec:'h264'}), true);
  const failed = await MediaMetadata.retrieveMetadata({previous:legacy,
    probe: async () => {throw new Error('bad file');},
    fallback: async () => {throw new Error('bad file');}
  });
  assert.strictEqual(failed.video_stream_selected, false);
  assert.strictEqual(failed.width, 0);
  assert.strictEqual(failed.duration, 60);
  assert.strictEqual(failed.audio_codec, 'aac');
  assert.strictEqual(MediaMetadata.needsMetadataScan(failed), false);
  assert.strictEqual(MediaMetadata.hasTechnicalMetadata({checked:true,video_stream_checked:true}), false);
});

runSuite(suite);
