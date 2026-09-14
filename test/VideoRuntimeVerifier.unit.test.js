const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const VideoRuntimeVerifier = require('../src/scanning/VideoRuntimeVerifier.js');

const suite = createSuite(
  'Bounded FFmpeg runtime verification',
  'unit',
  'Simulates FFmpeg streams to test packet counting, failures, and timeouts without starting FFmpeg.'
);

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

suite.test('validates frame rates and calculates a bounded packet target', () => {
  assert.strictEqual(VideoRuntimeVerifier.usableFrameRate(23.976), 23.976);
  assert.strictEqual(VideoRuntimeVerifier.usableFrameRate(0), 0);
  assert.strictEqual(VideoRuntimeVerifier.usableFrameRate(241), 0);
  assert.strictEqual(VideoRuntimeVerifier.targetPacketCount(23.976, 300), 7193);
  assert.strictEqual(VideoRuntimeVerifier.targetPacketCount('bad', 300), 0);
});

suite.test('rejects missing executables, filenames, and usable frame rates', async () => {
  await assert.rejects(
    new VideoRuntimeVerifier().hasMinimumRuntime({filename: 'movie.mkv', framerate: 24, minimumSeconds: 10}),
    /FFmpeg executable is unavailable/
  );
  const verifier = new VideoRuntimeVerifier({ffmpegPath: '/fake/ffmpeg'});
  await assert.rejects(verifier.hasMinimumRuntime({framerate: 24, minimumSeconds: 10}),
    /video filename is unavailable/);
  await assert.rejects(verifier.hasMinimumRuntime({filename: 'movie.mkv', framerate: 0, minimumSeconds: 10}),
    /usable video framerate is unavailable/);
});

suite.test('counts packet records while ignoring framecrc headers', async () => {
  let invocation;
  const child = fakeChild();
  const verifier = new VideoRuntimeVerifier({
    ffmpegPath: '/fake/ffmpeg',
    spawn: (command, args, options) => {
      invocation = {command, args, options};
      setImmediate(() => {
        child.stdout.write('#tb 0: 1/24\n');
        child.stdout.write('0, 0, 0\n1, 1, 1\n2, 2, 2');
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    }
  });

  const result = await verifier.hasMinimumRuntime({
    filename: '/movies/test.mkv',
    framerate: 1,
    minimumSeconds: 3
  });
  assert.deepStrictEqual(result, {hasMinimumRuntime: true, packetsRead: 3, targetPackets: 3});
  assert.strictEqual(invocation.command, '/fake/ffmpeg');
  assert(invocation.args.includes('/movies/test.mkv'));
  assert.deepStrictEqual(invocation.args.slice(-3), ['-f', 'framecrc', 'pipe:1']);
  assert.deepStrictEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

suite.test('reports a short stream when EOF arrives before the target', async () => {
  const child = fakeChild();
  const verifier = new VideoRuntimeVerifier({
    ffmpegPath: '/fake/ffmpeg',
    spawn: () => {
      setImmediate(() => {
        child.stdout.end('0, packet\n1, packet\n');
        child.emit('close', 0);
      });
      return child;
    }
  });
  assert.deepStrictEqual(await verifier.hasMinimumRuntime({
    filename: 'short.mkv', framerate: 1, minimumSeconds: 3
  }), {hasMinimumRuntime: false, packetsRead: 2, targetPackets: 3});
});

suite.test('includes bounded FFmpeg diagnostics when the subprocess fails', async () => {
  const child = fakeChild();
  const verifier = new VideoRuntimeVerifier({
    ffmpegPath: '/fake/ffmpeg',
    spawn: () => {
      setImmediate(() => {
        child.stderr.end('Invalid data found when processing input');
        child.emit('close', 1);
      });
      return child;
    }
  });
  await assert.rejects(
    verifier.hasMinimumRuntime({filename: 'bad.mkv', framerate: 24, minimumSeconds: 300}),
    /exited with code 1: Invalid data/
  );
});

suite.test('kills and rejects a packet scan that exceeds its time limit', async () => {
  const child = fakeChild();
  const verifier = new VideoRuntimeVerifier({
    ffmpegPath: '/fake/ffmpeg',
    timeoutMs: 5,
    spawn: () => child
  });
  await assert.rejects(
    verifier.hasMinimumRuntime({filename: 'stuck.mkv', framerate: 24, minimumSeconds: 300}),
    /timed out after 5ms/
  );
  assert.strictEqual(child.killed, true);
});

runSuite(suite);
