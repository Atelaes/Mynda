const path = require('path');
const os = require('os');
const {EventEmitter} = require('events');
const React = require('react');
const {
  assert,
  createSuite,
  runSuite,
  rejectsWithCode
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');

require('@babel/register')({
  presets: [require.resolve('@babel/preset-react')],
  extensions: ['.js'],
  ignore: [/node_modules/],
  cache: false
});

class TestPane extends React.Component {}
let fakeMpvConstructions = 0;
class FakeMpv {
  constructor() {
    fakeMpvConstructions += 1;
  }
}
const playerWarnings = [];
const Player = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'Player.js'),
  {
    'node-mpv': FakeMpv,
    './RendererRuntime.js': {
      library: {settings: {watchfolders: []}},
      playerLog: {
        debug() {},
        info() {},
        warn(message, detail) { playerWarnings.push({message, detail}); },
        error() {}
      }
    },
    './SharedComponents.js': {MynOpenablePane: TestPane}
  }
);

const suite = createSuite(
  'MPV playback safety helpers',
  'unit',
  'Exercises error handling and player lifecycle logic with controlled event emitters instead of launching MPV.'
);

suite.test('turns every supported MPV error shape into useful text', () => {
  assert.strictEqual(Player.describePlaybackError('  plain failure  '), 'plain failure');
  assert.strictEqual(Player.describePlaybackError(new Error('error message')), 'error message');
  assert.strictEqual(Player.describePlaybackError({error: 'ipc error'}), 'ipc error');
  assert.strictEqual(Player.describePlaybackError({reason: 'file missing'}), 'file missing');
  assert.strictEqual(Player.describePlaybackError({verbose: 'Unable to load file'}), 'Unable to load file');
  assert.strictEqual(Player.describePlaybackError(404), '404');
  assert.strictEqual(Player.describePlaybackError({code: 'bad'}), '{"code":"bad"}');
  const circular = {};
  circular.self = circular;
  assert.strictEqual(Player.describePlaybackError(circular), 'MPV returned an unknown error');
});

function missingError(code = 'ENOENT') {
  const error = new Error(code === 'ENOENT' ? 'No such file or directory' : 'Access denied');
  error.code = code;
  return error;
}

function fakeFilesystem(entries) {
  return {
    statSync(filename) {
      if (!Object.prototype.hasOwnProperty.call(entries, filename)) throw missingError();
      const entry = entries[filename];
      if (entry instanceof Error) throw entry;
      return {
        isFile: () => entry === 'file',
        isDirectory: () => entry === 'directory'
      };
    }
  };
}

suite.test('distinguishes an unmounted macOS drive from missing media on an available drive', () => {
  const filename = '/Volumes/Movie Drive/Movies/example.mp4';
  const watchfolder = '/Volumes/Movie Drive/Movies';
  const unavailableDrive = Player.inspectPlaybackTarget(
    {filename: filename},
    {filesystem: fakeFilesystem({}), platform: 'darwin', watchfolders: [{path: watchfolder}]}
  );
  assert.strictEqual(unavailableDrive.reason, 'storage-unavailable');
  assert(unavailableDrive.message.includes('drive containing this video is not connected or mounted'));
  assert(!unavailableDrive.message.includes(filename));

  const missingFile = Player.inspectPlaybackTarget(
    {filename: filename},
    {
      filesystem: fakeFilesystem({
        '/Volumes/Movie Drive': 'directory',
        [watchfolder]: 'directory'
      }),
      platform: 'darwin',
      watchfolders: [{path: watchfolder}]
    }
  );
  assert.strictEqual(missingFile.reason, 'media-missing');
  assert(missingFile.message.includes('moved, renamed, or deleted'));
  assert(missingFile.message.includes('Scan its watchfolder'));

  assert.strictEqual(
    Player.playbackStorageRoot('E:\\Movies\\example.mkv', 'win32'),
    'E:\\'
  );
  assert.strictEqual(
    Player.playbackStorageRoot('\\\\server\\share\\Movies\\example.mkv', 'win32'),
    '\\\\server\\share\\'
  );
});

suite.test('uses a missing configured watchfolder when a Linux mount cannot be identified', () => {
  const filename = '/media/torgo/Movie Drive/Movies/example.mkv';
  const watchfolder = '/media/torgo/Movie Drive/Movies';
  const status = Player.inspectPlaybackTarget(
    {filename: filename},
    {filesystem: fakeFilesystem({}), platform: 'linux', watchfolders: [{path: watchfolder}]}
  );
  assert.strictEqual(status.reason, 'watchfolder-unavailable');
  assert(status.message.includes('watchfolder is unavailable'));
  assert(status.message.includes('drive or network location'));
});

suite.test('accepts real targets and reports wrong types or permission failures clearly', () => {
  const filesystem = fakeFilesystem({
    '/movies/video.mkv': 'file',
    '/movies/dvd': 'directory',
    '/movies/not-a-video': 'directory',
    '/movies/private.mkv': missingError('EACCES')
  });
  assert.strictEqual(Player.inspectPlaybackTarget(
    {filename: '/movies/video.mkv'}, {filesystem: filesystem, platform: 'linux'}
  ).available, true);
  assert.strictEqual(Player.inspectPlaybackTarget(
    {filename: '/movies/dvd', dvd: true}, {filesystem: filesystem, platform: 'linux'}
  ).available, true);
  assert.strictEqual(Player.inspectPlaybackTarget(
    {filename: '/movies/not-a-video'}, {filesystem: filesystem, platform: 'linux'}
  ).reason, 'wrong-media-type');
  const inaccessible = Player.inspectPlaybackTarget(
    {filename: '/movies/private.mkv'}, {filesystem: filesystem, platform: 'linux'}
  );
  assert.strictEqual(inaccessible.reason, 'media-inaccessible');
  assert(inaccessible.message.includes('Check its permissions'));
});

suite.test('keeps MPV diagnostics in logs while returning concise playback errors', () => {
  const structured = {
    errcode: 0,
    verbose: 'Unable to load file or stream',
    method: 'load()',
    arguments: ['/private/movie.mkv']
  };
  const wrapped = new Error(`${JSON.stringify(structured)}\nMPV output:\ndecoder failed`);
  wrapped.originalError = structured;
  wrapped.mpvOutput = 'decoder failed';
  assert.strictEqual(
    Player.playbackFailureMessage(wrapped, 'video'),
    'Problem playing video: Unable to load file or stream'
  );

  const decoderError = new Error('The video decoder failed');
  decoderError.mpvOutput = "Verbose MPV diagnostics mentioning '/private/movie.mkv'";
  assert.strictEqual(
    Player.playbackFailureMessage(decoderError, 'video'),
    'Problem playing video: The video decoder failed'
  );
});

suite.test('does not construct MPV when the selected media path is unavailable', async () => {
  const before = fakeMpvConstructions;
  const player = new Player.MynPlayer({
    video: {
      id: 'missing-video',
      title: 'Missing Video',
      filename: path.join(os.tmpdir(), 'mynda-file-that-does-not-exist-fix63.mkv')
    },
    show: true,
    hideFunction() {},
    logPlayed() {}
  });
  player.setState = update => { player.state = Object.assign({}, player.state, update); };
  await player.setUpVideo();
  assert.strictEqual(fakeMpvConstructions, before);
  assert(player.state.errorMessage.includes('moved, renamed, or deleted'));
  assert.strictEqual(player.state.showLoadingIndicator, false);
  assert.strictEqual(playerWarnings[playerWarnings.length - 1].detail.reason, 'media-missing');
});

suite.test('passes through prompt resolutions and rejections', async () => {
  assert.strictEqual(await Player.withPlaybackTimeout(Promise.resolve('ready'), 50, 'late'), 'ready');
  const expected = new Error('original rejection');
  let received;
  try {
    await Player.withPlaybackTimeout(Promise.reject(expected), 50, 'late');
  } catch(err) {
    received = err;
  }
  assert.strictEqual(received, expected);
});

suite.test('rejects stalled playback with Mynda\'s stable timeout code', async () => {
  const never = new Promise(() => {});
  const error = await rejectsWithCode(
    Player.withPlaybackTimeout(never, 10, 'MPV stalled'),
    'MYNDA_PLAYBACK_TIMEOUT'
  );
  assert.strictEqual(error.message, 'MPV stalled');
});

suite.test('creates distinct per-attempt IPC socket names', () => {
  const first = Player.uniqueMpvSocketPath();
  const second = Player.uniqueMpvSocketPath();
  assert.notStrictEqual(first, second);
  if (process.platform === 'win32') {
    assert(first.startsWith('\\\\.\\pipe\\mynda-mpv-'));
  } else {
    const expectedDirectory = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    assert.strictEqual(path.dirname(first), expectedDirectory);
    assert(first.endsWith('.sock'));
  }
});

suite.test('tears down sockets, listeners, timers, and the child process safely', () => {
  const player = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killedByTest = false;
  child.kill = () => { child.killedByTest = true; };
  child.on('close', () => {});

  const socket = new EventEmitter();
  socket.destroyedByTest = false;
  socket.destroy = () => { socket.destroyedByTest = true; };
  socket.on('data', () => {});
  socket.on('close', () => {});
  socket.on('error', () => {});

  player.running = true;
  player.timepositionListenerId = setInterval(() => {}, 1000);
  player.mpvPlayer = child;
  player.socket = {socket};
  player.on('test', () => {});

  Player.stopMpvSafely(player);
  assert.strictEqual(player.running, false);
  assert.strictEqual(player.listenerCount('test'), 0);
  assert.strictEqual(child.listenerCount('close'), 0);
  assert.strictEqual(socket.listenerCount('data'), 0);
  assert.strictEqual(socket.listenerCount('close'), 0);
  assert.strictEqual(socket.listenerCount('error'), 1);
  assert.strictEqual(socket.destroyedByTest, true);
  assert.strictEqual(child.killedByTest, true);
});

function dvdPlayer(commandImplementation) {
  const socket = new EventEmitter();
  const child = new EventEmitter();
  const calls = [];
  return {
    player: {
      socket,
      mpvPlayer: child,
      command: (...args) => {
        calls.push(args);
        return commandImplementation ? commandImplementation(...args) : Promise.resolve();
      }
    },
    socket,
    child,
    calls
  };
}

suite.test('loads a DVD only after listening for MPV lifecycle events', async () => {
  const fake = dvdPlayer();
  const loading = Player.loadDvdInMpv(fake.player);
  assert.deepStrictEqual(fake.calls, [['loadfile', ['dvd://', 'replace']]]);
  assert.strictEqual(fake.socket.listenerCount('message'), 1);
  fake.socket.emit('message', {event: 'file-loaded'});
  await loading;
  assert.strictEqual(fake.socket.listenerCount('message'), 0);
  assert.strictEqual(fake.child.listenerCount('close'), 0);
});

suite.test('reports MPV end-file detail and cleans up its listeners', async () => {
  const fake = dvdPlayer();
  const loading = Player.loadDvdInMpv(fake.player);
  fake.socket.emit('message', {event: 'end-file', file_error: 'unsupported format'});
  const error = await rejectsWithCode(loading, 'MYNDA_MPV_LOAD_FAILED');
  assert(error.message.includes('unsupported format'));
  assert.strictEqual(fake.socket.listenerCount('message'), 0);
  assert.strictEqual(fake.child.listenerCount('close'), 0);
});

suite.test('reports an MPV process exit during DVD loading', async () => {
  const fake = dvdPlayer();
  const loading = Player.loadDvdInMpv(fake.player);
  fake.child.emit('close', 7, null);
  const error = await rejectsWithCode(loading, 'MYNDA_MPV_CLOSED');
  assert(error.message.includes('exit code 7'));
});

suite.test('surfaces a rejected load command without waiting for the timeout', async () => {
  const expected = new Error('socket command failed');
  const fake = dvdPlayer(() => Promise.reject(expected));
  let received;
  try {
    await Player.loadDvdInMpv(fake.player);
  } catch(err) {
    received = err;
  }
  assert.strictEqual(received, expected);
  assert.strictEqual(fake.socket.listenerCount('message'), 0);
});

runSuite(suite);
