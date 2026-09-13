const {EventEmitter} = require('events');
const path = require('path');
const MpvProcess = require('../src/MpvProcess.js');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'MPV process and IPC startup',
  'unit',
  'Checks platform launch options, IPC paths/readiness, lifecycle events, and captured diagnostics without launching real media.'
);

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalled = false;
  child.kill = () => { child.killCalled = true; };
  return child;
}

function fakePlayer(socketPath = '/tmp/mynda-mpv-test.sock') {
  const controlSocket = new EventEmitter();
  controlSocket.destroyed = false;
  controlSocket.destroy = () => { controlSocket.destroyed = true; };
  controlSocket.on('close', () => {});

  const player = new EventEmitter();
  player.options = {
    binary: '/Applications/Mynda.app/Contents/Resources/media-tools/mpv.app/Contents/MacOS/mpv',
    socket: socketPath
  };
  player.mpv_arguments = ['--idle', '--msg-level=all=no,ipc=v'];
  player.socket = {socket: controlSocket};
  player.running = false;
  player.start = async () => { player.running = true; };
  return player;
}

suite.test('uses a short macOS socket even when the normal temporary directory is long', () => {
  const socket = MpvProcess.uniqueMpvSocketPath({
    platform: 'darwin',
    pid: 12345,
    now: 1700000000000,
    nonce: 'abc123',
    temporaryDirectory: '/private/var/folders/very/long/per-user/temporary/directory/T'
  });
  assert.strictEqual(path.posix.dirname(socket), '/tmp');
  assert(socket.length < 100, `macOS socket path is unexpectedly long: ${socket}`);
});

suite.test('uses named pipes on Windows and Unix sockets on Linux', () => {
  const windows = MpvProcess.uniqueMpvSocketPath({
    platform: 'win32', pid: 7, now: 8, nonce: 'win'
  });
  const linux = MpvProcess.uniqueMpvSocketPath({
    platform: 'linux', pid: 7, now: 8, nonce: 'linux', temporaryDirectory: '/var/tmp'
  });
  assert(windows.startsWith('\\\\.\\pipe\\mynda-mpv-'));
  assert.strictEqual(path.posix.dirname(linux), '/var/tmp');
  assert(linux.endsWith('.sock'));
});

suite.test('selects MPV 0.41\'s Vulkan-backed macOS window explicitly', () => {
  const player = fakePlayer();
  const args = MpvProcess.mpvLaunchArguments(player, {platform: 'darwin'});
  assert(args.includes('--idle'));
  assert(args.includes('--no-config'));
  assert(args.includes('--force-window=yes'));
  assert(args.includes('--vo=gpu-next'));
  assert(args.includes('--gpu-api=vulkan'));
  assert(args.includes('--gpu-context=macvk'));
  assert(args.includes('--msg-level=all=warn,ipc=v'));
  assert(args.includes(`--input-ipc-server=${player.options.socket}`));
  assert(!args.includes('--msg-level=all=no,ipc=v'));
});

suite.test('selects native Direct3D 11 video on Windows', () => {
  const args = MpvProcess.mpvLaunchArguments(fakePlayer('\\\\.\\pipe\\mynda-mpv-test'), {
    platform: 'win32'
  });
  assert(args.includes('--force-window=yes'));
  assert(args.includes('--vo=gpu-next'));
  assert(args.includes('--gpu-api=d3d11'));
  assert(args.includes('--gpu-context=d3d11'));
});

suite.test('lets MPV select Wayland or X11 at Linux runtime', () => {
  const args = MpvProcess.mpvLaunchArguments(fakePlayer('/tmp/mynda-linux.sock'), {
    platform: 'linux'
  });
  assert(args.includes('--force-window=yes'));
  assert(args.includes('--vo=gpu-next'));
  assert.strictEqual(args.some(argument => argument.startsWith('--gpu-api=')), false);
  assert.strictEqual(args.some(argument => argument.startsWith('--gpu-context=')), false);
});

suite.test('launches beside the selected binary without a Windows console window', () => {
  const binary = path.join('/portable', 'media-tools', 'mpv.exe');
  assert.deepStrictEqual(MpvProcess.mpvSpawnOptions(binary), {
    cwd: path.dirname(binary),
    windowsHide: true
  });
});

suite.test('starts from JSON IPC readiness without parsing MPV terminal text', async () => {
  const player = fakePlayer();
  const child = fakeChild();
  let spawnedArguments;
  let spawnedOptions;
  let probeCalled = false;

  await MpvProcess.startMpvPlayer(player, {
    platform: 'darwin',
    timeoutMs: 100,
    spawnProcess(binary, args, options) {
      spawnedArguments = args;
      spawnedOptions = options;
      // Deliberately omit node-mpv's expected "Listening to IPC socket"
      // sentence. Startup must depend only on the injected JSON IPC probe.
      child.stderr.emit('data', Buffer.from('[ipc] ready with different wording\n'));
      return child;
    },
    waitForIpc: async socketPath => {
      probeCalled = true;
      assert.strictEqual(socketPath, player.options.socket);
    }
  });

  assert.strictEqual(probeCalled, true);
  assert(spawnedArguments.includes('--msg-level=all=warn,ipc=v'));
  assert.strictEqual(spawnedOptions.windowsHide, true);
  assert.strictEqual(spawnedOptions.cwd, path.dirname(player.options.binary));
  assert.strictEqual(player.running, true);
  assert.strictEqual(player.mpvPlayer, child);

  let crashed = 0;
  let quit = 0;
  player.on('crashed', () => { crashed += 1; });
  player.on('quit', () => { quit += 1; });
  child.exitCode = 9;
  child.emit('close', 9, null);
  assert.strictEqual(crashed, 1);
  assert.strictEqual(quit, 0);
  assert.strictEqual(player.running, false);
});

suite.test('includes captured MPV output when startup exits early', async () => {
  const player = fakePlayer();
  const child = fakeChild();
  let received;

  try {
    await MpvProcess.startMpvPlayer(player, {
      platform: 'darwin',
      timeoutMs: 100,
      spawnProcess() {
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('[vo/gpu] Cocoa initialization failed\n'));
          child.exitCode = 1;
          child.emit('close', 1, null);
        });
        return child;
      },
      waitForIpc: () => new Promise(() => {})
    });
  } catch(error) {
    received = error;
  }

  assert(received instanceof Error);
  assert(received.message.includes('exit code 1'));
  assert(received.message.includes('Cocoa initialization failed'));
  assert.strictEqual(child.killCalled, false, 'an already-exited process must not be killed again');
});

suite.test('adds retained process output to later load failures', async () => {
  const player = fakePlayer();
  const child = fakeChild();
  await MpvProcess.startMpvPlayer(player, {
    platform: 'darwin',
    timeoutMs: 100,
    spawnProcess() { return child; },
    waitForIpc: async () => {}
  });
  child.stderr.emit('data', Buffer.from('[vo/gpu] failed to create rendering context\n'));

  const error = MpvProcess.withMpvDiagnostics(new Error('Unable to load file'), player);
  assert(error.message.includes('Unable to load file'));
  assert(error.message.includes('failed to create rendering context'));
  MpvProcess.stopMpvPlayer(player, {platform: 'darwin'});
  assert.strictEqual(child.killCalled, true);
});

runSuite(suite);
