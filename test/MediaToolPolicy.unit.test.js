const MediaToolPolicy = require('../src/MediaToolPolicy.js');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Bundled media license and feature policy',
  'unit',
  'Rejects GPL/nonfree standalone FFmpeg builds and MPV builds without DVD navigation or macOS video output.'
);

function versionOutput(flags) {
  return [
    'ffmpeg version 6.1.6 Copyright (c) the FFmpeg developers',
    `configuration: ${flags.join(' ')}`,
    'libavutil 58.29.100'
  ].join('\n');
}

suite.test('accepts the explicitly LGPL-only FFmpeg configuration', () => {
  const inspection = MediaToolPolicy.assertLgplOnlyFfmpeg(versionOutput([
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--enable-videotoolbox'
  ]));
  assert.strictEqual(inspection.lgplOnly, true);
  assert(inspection.flags.includes('--disable-gpl'));
});

suite.test('rejects a GPL-enabled FFmpeg build even if disable flags also appear', () => {
  assert.throws(
    () => MediaToolPolicy.assertLgplOnlyFfmpeg(versionOutput([
      '--disable-gpl',
      '--disable-nonfree',
      '--enable-gpl'
    ])),
    error => error && error.code === 'MYNDA_MEDIA_LICENSE_POLICY' && /enable-gpl/.test(error.message)
  );
});

suite.test('rejects a nonfree FFmpeg build', () => {
  assert.throws(
    () => MediaToolPolicy.assertLgplOnlyFfmpeg(versionOutput([
      '--disable-gpl',
      '--disable-nonfree',
      '--enable-nonfree'
    ])),
    error => error && error.code === 'MYNDA_MEDIA_LICENSE_POLICY' && /enable-nonfree/.test(error.message)
  );
});

suite.test('rejects unproven FFmpeg output rather than guessing its license', () => {
  const inspection = MediaToolPolicy.inspectFfmpegLicense('ffmpeg version 6.1.6');
  assert.strictEqual(inspection.lgplOnly, false);
  assert(inspection.problems.includes('missing --disable-gpl'));
  assert(inspection.problems.includes('missing --disable-nonfree'));
});

suite.test('recognizes current and legacy MPV DVD protocol names', () => {
  assert.strictEqual(MediaToolPolicy.mpvSupportsDvd('file://\ndvd://\nhttp://'), true);
  assert.strictEqual(MediaToolPolicy.mpvSupportsDvd('file://\ndvdnav://\nhttp://'), true);
});

suite.test('does not confuse ordinary file protocols with DVD support', () => {
  assert.strictEqual(MediaToolPolicy.mpvSupportsDvd('file://\nbluray://\nhttp://'), false);
});

suite.test('raises a named error when MPV lacks DVD navigation', () => {
  assert.throws(
    () => MediaToolPolicy.assertMpvDvdSupport('file://\nhttp://'),
    error => error && error.code === 'MYNDA_MPV_DVD_UNAVAILABLE'
  );
});

suite.test('accepts MPV with gpu-next and the macvk window context', () => {
  const inspection = MediaToolPolicy.assertMpvMacVideoSupport(
    'Available video outputs:\n  gpu-next\n  gpu\n  null\n',
    'Available GPU contexts:\n  auto\n  macvk\n'
  );
  assert.strictEqual(inspection.graphical, true);
  assert(inspection.videoOutputs.includes('gpu-next'));
  assert(inspection.gpuContexts.includes('macvk'));
});

suite.test('rejects an audio-only MPV build without macvk', () => {
  assert.throws(
    () => MediaToolPolicy.assertMpvMacVideoSupport(
      'Available video outputs:\n  gpu-next\n  null\n',
      'Available GPU contexts:\n  auto\n'
    ),
    error => error &&
      error.code === 'MYNDA_MPV_VIDEO_OUTPUT_UNAVAILABLE' &&
      /macvk/.test(error.message)
  );
});

suite.test('rejects a macOS context when gpu-next itself is absent', () => {
  assert.throws(
    () => MediaToolPolicy.assertMpvMacVideoSupport(
      'Available video outputs:\n  null\n  image\n',
      'Available GPU contexts:\n  auto\n  macvk\n'
    ),
    error => error &&
      error.code === 'MYNDA_MPV_VIDEO_OUTPUT_UNAVAILABLE' &&
      /gpu-next/.test(error.message)
  );
});

runSuite(suite);
