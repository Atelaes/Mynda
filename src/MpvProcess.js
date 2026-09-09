// Reliable process startup and diagnostics for node-mpv.
//
// node-mpv waits for a human-readable "Listening to IPC socket" log line
// before connecting. MPV explicitly does not promise that terminal output is
// stable, and node-mpv also suppresses almost every useful MPV error. Mynda
// instead starts the process itself, waits until MPV answers on its documented
// JSON IPC socket, and then lets node-mpv attach to that running instance.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const DEFAULT_START_TIMEOUT_MS = 10000;
const MAX_OUTPUT_LENGTH = 12000;
const IPC_PROBE_REQUEST_ID = 982451653;

function tail(value, maximum = MAX_OUTPUT_LENGTH) {
  const text = String(value || '');
  return text.length <= maximum ? text : text.slice(text.length - maximum);
}

function uniqueMpvSocketPath(options = {}) {
  const platform = options.platform || process.platform;
  const pid = typeof options.pid === 'number' ? options.pid : process.pid;
  const timestamp = typeof options.now === 'number' ? options.now : Date.now();
  const nonce = options.nonce || crypto.randomBytes(5).toString('hex');
  const suffix = `${pid}-${timestamp.toString(36)}-${nonce}`;

  if (platform === 'win32') return `\\\\.\\pipe\\mynda-mpv-${suffix}`;

  // macOS limits Unix-domain socket paths to roughly one hundred bytes. Its
  // normal TMPDIR (/var/folders/.../T) is long enough that a unique filename
  // can exceed that limit. /tmp is deliberately used as a short spelling;
  // MPV creates the socket with owner-only permissions.
  const directory = platform === 'darwin' ? '/tmp' :
    (options.temporaryDirectory || os.tmpdir());
  return path.join(directory, `mynda-mpv-${suffix}.sock`);
}

function removeSocketFile(socketPath, options = {}) {
  const platform = options.platform || process.platform;
  if (!socketPath || platform === 'win32') return;
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch(error) {
    // A fresh random socket should not normally exist. If cleanup loses a
    // race with an exiting MPV process, its next unique path is unaffected.
  }
}

function optionPresent(args, name) {
  return args.some(argument => argument === name || argument.startsWith(`${name}=`));
}

function mpvLaunchArguments(player, options = {}) {
  const platform = options.platform || process.platform;
  const showWindow = options.showWindow !== false;
  const socketPath = player && player.options && player.options.socket;
  const original = player && Array.isArray(player.mpv_arguments) ?
    player.mpv_arguments.slice() : [];

  // Mynda owns the control socket and logging policy. Remove node-mpv's
  // generated equivalents so the last/duplicate-option rules cannot make the
  // selected behavior ambiguous.
  const args = original.filter(argument =>
    !argument.startsWith('--input-ipc-server=') &&
    !argument.startsWith('--input-unix-socket=') &&
    !argument.startsWith('--msg-level=')
  );

  if (!optionPresent(args, '--idle')) args.push('--idle=yes');
  if (!optionPresent(args, '--no-config')) args.push('--no-config');

  if (platform === 'darwin' && showWindow) {
    if (!optionPresent(args, '--force-window')) args.push('--force-window=yes');
    // MPV 0.41's standalone macOS window is the Vulkan-backed macvk context.
    // Make the release contract explicit instead of allowing a build with no
    // graphical backend to fall through to audio-only playback.
    if (!optionPresent(args, '--vo')) args.push('--vo=gpu-next');
    if (!optionPresent(args, '--gpu-api')) args.push('--gpu-api=vulkan');
    if (!optionPresent(args, '--gpu-context')) args.push('--gpu-context=macvk');
  } else if (platform === 'win32' && showWindow) {
    // Use Windows' native renderer instead of depending on a separately
    // installed Vulkan runtime or OpenGL implementation.
    if (!optionPresent(args, '--force-window')) args.push('--force-window=yes');
    if (!optionPresent(args, '--vo')) args.push('--vo=gpu-next');
    if (!optionPresent(args, '--gpu-api')) args.push('--gpu-api=d3d11');
    if (!optionPresent(args, '--gpu-context')) args.push('--gpu-context=d3d11');
  } else if (platform === 'linux' && showWindow) {
    // Linux desktops may be Wayland or X11. The verified bundle contains both
    // context families, so leave context selection to MPV at runtime.
    if (!optionPresent(args, '--force-window')) args.push('--force-window=yes');
    if (!optionPresent(args, '--vo')) args.push('--vo=gpu-next');
  }

  // Warnings and errors are retained for Mynda's log instead of being hidden
  // by node-mpv's default all=no setting. Readiness is never inferred from
  // this human-readable output.
  args.push('--msg-level=all=warn,ipc=v');
  args.push(`--input-ipc-server=${socketPath}`);
  return args;
}

function mpvSpawnOptions(binary) {
  return {
    cwd: path.dirname(binary),
    windowsHide: true
  };
}

function probeMpvIpc(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs || 200;
  const createConnection = options.createConnection ||
    (() => net.createConnection({path: socketPath}));

  return new Promise(resolve => {
    let socket;
    let settled = false;
    let buffer = '';

    const finish = available => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        try { socket.destroy(); } catch(error) {}
      }
      resolve(available);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      socket = createConnection();
    } catch(error) {
      finish(false);
      return;
    }

    socket.once('connect', () => {
      try {
        socket.write(JSON.stringify({
          command: ['get_property', 'mpv-version'],
          request_id: IPC_PROBE_REQUEST_ID
        }) + '\n');
      } catch(error) {
        finish(false);
      }
    });
    socket.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.request_id === IPC_PROBE_REQUEST_ID) {
            finish(message.error === 'success');
            return;
          }
        } catch(error) {
          // Ignore unrelated or partial diagnostic output. Only a matching
          // successful JSON response proves that this is MPV's control socket.
        }
      }
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processEnding(child) {
  if (!child) return null;
  if (child.signalCode) return `signal ${child.signalCode}`;
  if (child.exitCode !== null && typeof child.exitCode !== 'undefined') {
    return `exit code ${child.exitCode}`;
  }
  return null;
}

function diagnosticsText(state) {
  if (!state) return '';
  const stdout = String(state.stdout || '').trim();
  const stderr = String(state.stderr || '').trim();
  return tail([stdout, stderr].filter(Boolean).join('\n'));
}

function describeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.error === 'string') return error.error;
  if (error && typeof error.errmessage === 'string') return error.errmessage;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch(serializationError) {}
  return 'MPV returned an unknown error';
}

function withMpvDiagnostics(error, player) {
  if (error && error.myndaMpvDiagnosticsAttached) return error;
  const output = diagnosticsText(player && player.myndaMpvProcess);
  const baseMessage = describeError(error);
  const enhanced = new Error(output ?
    `${baseMessage}\nMPV output:\n${output}` : baseMessage);
  if (error && error.code) enhanced.code = error.code;
  enhanced.myndaMpvDiagnosticsAttached = true;
  enhanced.mpvOutput = output;
  enhanced.originalError = error;
  return enhanced;
}

async function waitForMpvIpc(socketPath, child, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_START_TIMEOUT_MS;
  const probe = options.probe || probeMpvIpc;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ending = processEnding(child);
    if (ending) throw new Error(`MPV exited before its control socket was ready (${ending})`);
    if (await probe(socketPath, {timeoutMs: Math.min(200, timeoutMs)})) return;
    await wait(25);
  }

  const error = new Error(`MPV did not open its control socket within ${Math.ceil(timeoutMs / 1000)} seconds`);
  error.code = 'MYNDA_MPV_IPC_TIMEOUT';
  throw error;
}

function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.code = 'MYNDA_MPV_IPC_TIMEOUT';
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function attachOutput(child, state) {
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', data => { state.stdout = tail(state.stdout + data.toString()); });
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', data => { state.stderr = tail(state.stderr + data.toString()); });
  }
}

function attachManagedLifecycle(player, child) {
  let finished = false;
  const socket = player.socket && player.socket.socket;

  if (socket && typeof socket.removeAllListeners === 'function') {
    // node-mpv assumes a process it did not spawn is external, then emits both
    // "crashed" and "quit" whenever that socket closes. Mynda did spawn this
    // process, so its exit code gives us the real single outcome.
    socket.removeAllListeners('close');
    socket.on('close', () => {
      try { clearInterval(player.timepositionListenerId); } catch(error) {}
    });
  }

  const finish = (eventName) => {
    if (finished || !player.running) return;
    finished = true;
    player.running = false;
    try { clearInterval(player.timepositionListenerId); } catch(error) {}
    if (socket && !socket.destroyed) {
      try { socket.destroy(); } catch(error) {}
    }
    player.emit(eventName);
  };

  child.on('error', () => finish('crashed'));
  child.on('close', code => finish(code === 0 ? 'quit' : 'crashed'));
}

function stopMpvPlayer(player, options = {}) {
  if (!player) return;
  player.running = false;
  try { clearInterval(player.timepositionListenerId); } catch(error) {}
  try { player.removeAllListeners(); } catch(error) {}

  const child = player.mpvPlayer;
  if (child) {
    try { child.removeAllListeners('close'); } catch(error) {}
    try { child.removeAllListeners('error'); } catch(error) {}
    try { child.on('error', () => {}); } catch(error) {}
  }

  const socket = player.socket && player.socket.socket;
  if (socket) {
    try {
      socket.removeAllListeners('close');
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.on('error', typeof options.onSocketError === 'function' ?
        options.onSocketError : () => {});
      socket.destroy();
    } catch(error) {}
  }

  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch(error) {}
  }
  removeSocketFile(player.options && player.options.socket, options);
}

async function startMpvPlayer(player, options = {}) {
  if (!player || !player.options || !player.options.binary || !player.options.socket) {
    throw new Error('MPV cannot start without a binary and control-socket path');
  }

  const timeoutMs = options.timeoutMs || DEFAULT_START_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess || spawn;
  const waitForIpc = options.waitForIpc || waitForMpvIpc;
  const args = mpvLaunchArguments(player, options);
  const state = {
    binary: player.options.binary,
    args,
    socket: player.options.socket,
    stdout: '',
    stderr: ''
  };
  player.myndaMpvProcess = state;
  removeSocketFile(player.options.socket, options);

  let child;
  try {
    child = spawnProcess(player.options.binary, args, mpvSpawnOptions(player.options.binary));
  } catch(error) {
    throw withMpvDiagnostics(error, player);
  }
  player.mpvPlayer = child;
  state.pid = child.pid;
  attachOutput(child, state);

  let rejectEarlyExit;
  const earlyExit = new Promise((resolve, reject) => { rejectEarlyExit = reject; });
  const onError = error => rejectEarlyExit(withMpvDiagnostics(error, player));
  const onClose = (code, signal) => {
    const ending = signal ? `signal ${signal}` : `exit code ${code}`;
    rejectEarlyExit(withMpvDiagnostics(
      new Error(`MPV exited before startup completed (${ending})`),
      player
    ));
  };
  child.once('error', onError);
  child.once('close', onClose);

  try {
    await Promise.race([
      waitForIpc(player.options.socket, child, {timeoutMs}),
      earlyExit
    ]);
    await Promise.race([
      promiseWithTimeout(
        player.start(),
        timeoutMs,
        `node-mpv did not attach to MPV's control socket within ${Math.ceil(timeoutMs / 1000)} seconds`
      ),
      earlyExit
    ]);
  } catch(error) {
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
    stopMpvPlayer(player, options);
    throw withMpvDiagnostics(error, player);
  }

  child.removeListener('error', onError);
  child.removeListener('close', onClose);
  attachManagedLifecycle(player, child);
  return player;
}

module.exports = {
  DEFAULT_START_TIMEOUT_MS,
  diagnosticsText,
  mpvLaunchArguments,
  mpvSpawnOptions,
  probeMpvIpc,
  promiseWithTimeout,
  removeSocketFile,
  startMpvPlayer,
  stopMpvPlayer,
  uniqueMpvSocketPath,
  waitForMpvIpc,
  withMpvDiagnostics
};
