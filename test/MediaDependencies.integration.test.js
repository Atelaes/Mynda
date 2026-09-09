const MediaDependencyCheck = require('../src/MediaDependencyCheck.js');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');

const requireBundled = process.argv.includes('--require-bundled');
const requireMpv = requireBundled || process.argv.includes('--require-mpv');
const suite = createSuite(
  'Installed media dependencies',
  'integration',
  requireBundled ?
    'Runs the staged LGPL FFmpeg/FFprobe and DVD-capable graphical MPV bundle without system fallbacks.' :
    'Runs available development media tools against disposable generated media; MPV is optional in the everyday suite.'
);

const reportPromise = MediaDependencyCheck.run({
  requireMpv,
  requireBundled,
  requireLgpl: requireBundled,
  requireDvd: requireBundled
});

function failureFor(report, name) {
  const check = report && report.checks && report.checks[name];
  return check && check.error ? check.error : `${name} did not report a successful result`;
}

suite.test('loads node-mpv and connects it to MPV over JSON IPC when available', async () => {
  const report = await reportPromise;
  assert(report.checks.nodeMpv.ok, failureFor(report, 'nodeMpv'));
  assert.strictEqual(report.checks.nodeMpv.value.loaded, true);
  if (requireMpv) {
    assert.strictEqual(report.checks.nodeMpv.value.ipcChecked, true);
    assert(String(report.checks.nodeMpv.value.version).length > 0);
    if (requireBundled) {
      assert.strictEqual(report.checks.nodeMpv.value.graphicalVideoChecked, true);
      assert.strictEqual(report.checks.nodeMpv.value.videoOutput, 'gpu-next');
      const requirements = require('../src/MediaToolPolicy.js')
        .mpvVideoRequirements(process.platform);
      assert(requirements.runtimeContexts.includes(report.checks.nodeMpv.value.gpuContext));
      assert(report.checks.nodeMpv.value.width > 0);
      assert(report.checks.nodeMpv.value.height > 0);
    }
  }
});

suite.test(requireBundled ?
  'runs Mynda\'s LGPL-only FFmpeg sidecar and decodes disposable audio' :
  'runs FFmpeg and decodes disposable audio', async () => {
  const report = await reportPromise;
  assert(report.checks.ffmpeg.ok, failureFor(report, 'ffmpeg'));
  assert(report.checks.ffmpeg.value.version.toLowerCase().includes('ffmpeg'));
  assert(report.checks.ffmpeg.value.outputBytes > 44);
  if (requireBundled) {
    assert.strictEqual(report.paths.ffmpeg.bundled, true);
    assert.strictEqual(report.checks.ffmpeg.value.license.lgplOnly, true);
  }
});

suite.test(requireBundled ?
  'runs Mynda\'s LGPL-only FFprobe sidecar and reads Matroska metadata' :
  'runs FFprobe and reads Matroska container metadata', async () => {
  const report = await reportPromise;
  assert(report.checks.ffprobe.ok, failureFor(report, 'ffprobe'));
  assert(report.checks.ffprobe.value.version.toLowerCase().includes('ffprobe'));
  assert.strictEqual(report.checks.ffprobe.value.codec, 'pcm_s16le');
  assert(report.checks.ffprobe.value.duration > 0);
  assert(report.checks.ffprobe.value.duration < 300);
  if (requireBundled) {
    assert.strictEqual(report.paths.ffprobe.bundled, true);
    assert.strictEqual(report.checks.ffprobe.value.license.lgplOnly, true);
  }
});

suite.test(requireBundled ?
  'runs the bundled MPV, decodes media, and confirms dvd:// support' :
  (requireMpv ? 'runs the available MPV executable' :
    'validates MPV when available and otherwise records the optional development tool'), async () => {
  const report = await reportPromise;
  assert(report.checks.mpv.ok, failureFor(report, 'mpv'));
  if (requireMpv) {
    assert.strictEqual(report.checks.mpv.value.available, true);
    assert(report.checks.mpv.value.version.toLowerCase().includes('mpv'));
    assert.strictEqual(report.checks.mpv.value.playbackChecked, true);
    if (requireBundled) {
      assert.strictEqual(report.paths.mpv.bundled, true);
      assert.strictEqual(report.checks.mpv.value.dvd, true);
    }
  } else if (report.checks.mpv.value.available) {
    assert(report.checks.mpv.value.version.toLowerCase().includes('mpv'));
  } else {
    assert.strictEqual(report.checks.mpv.value.skipped, true);
  }
});

runSuite(suite);
