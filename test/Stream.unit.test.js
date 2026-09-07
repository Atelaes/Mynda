const path = require('path');
const {EventEmitter} = require('events');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');

class FakeFfmpegCommand extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.ran = false;
    this.killed = false;
  }
  input(value) { this.calls.push(['input', value]); return this; }
  output(value) { this.calls.push(['output', value]); return this; }
  setDuration(value) { this.calls.push(['setDuration', value]); return this; }
  addOptions(value) { this.calls.push(['addOptions', value]); return this; }
  run() { this.ran = true; }
  kill() { this.killed = true; }
}

let lastCommand;
const fakeFfmpeg = () => {
  lastCommand = new FakeFfmpegCommand();
  return lastCommand;
};
fakeFfmpeg.setFfmpegPath = () => {};
fakeFfmpeg.setFfprobePath = () => {};

const Stream = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'Stream.js'),
  {
    'electron': {},
    'fluent-ffmpeg': fakeFfmpeg,
    './MediaTools.js': {ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'},
    'hls-server': class FakeHlsServer {},
    './Logger.js': {child: () => ({debug() {}, info() {}, warn() {}, error() {}})}
  }
);

const suite = createSuite(
  'HLS stream command orchestration',
  'unit',
  'Verifies Mynda\'s FFmpeg command and callbacks without reading media or starting FFmpeg.'
);

suite.test('configures and starts the expected 60-second HLS stream', () => {
  const stream = new Stream();
  stream.createStream('/movies/Alien.mkv', 'alien', {});
  assert.deepStrictEqual(lastCommand.calls.slice(0, 3), [
    ['input', '/movies/Alien.mkv'],
    ['output', 'video_stream/alien.m3u8'],
    ['setDuration', 60]
  ]);
  const options = lastCommand.calls.find(call => call[0] === 'addOptions')[1];
  assert(options.includes('-start_number 0'));
  assert(options.includes('-hls_time 4'));
  assert(options.includes('-hls_list_size 0'));
  assert(options.includes('-f hls'));
  assert.strictEqual(lastCommand.ran, true);
});

suite.test('forwards codec, progress, and error callbacks with stable arguments', () => {
  const stream = new Stream();
  const calls = [];
  stream.createStream('/movies/Arrival.mkv', 'arrival', {
    codecData: (output, data) => calls.push(['codec', output, data]),
    progress: output => calls.push(['progress', output]),
    error: error => calls.push(['error', error])
  });
  const codec = {video: 'h264'};
  const expectedError = new Error('conversion failed');
  lastCommand.emit('codecData', codec);
  lastCommand.emit('progress', {percent: 50});
  lastCommand.emit('error', expectedError);
  lastCommand.emit('end');
  assert.deepStrictEqual(calls, [
    ['codec', 'video_stream/arrival.m3u8', codec],
    ['progress', 'video_stream/arrival.m3u8'],
    ['error', expectedError]
  ]);
});

suite.test('kills the owned FFmpeg command', () => {
  const stream = new Stream();
  stream.kill();
  assert.strictEqual(lastCommand.killed, true);
});

runSuite(suite);
