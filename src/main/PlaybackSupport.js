'use strict';
// Main-process playback helpers; no renderer imports or renderer-owned state.
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');
const MediaTools = require('../media/MediaTools.js');
const MpvProcess = require('../media/MpvProcess.js');

// Turn node-mpv's string, Error, and structured IPC rejection shapes into a
// concise user-facing detail without falling back to "[object Object]".
function describePlaybackError(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (error && typeof error.verbose === 'string' && error.verbose.trim()) {
    return error.verbose.trim();
  }
  if (error && typeof error.error === 'string' && error.error.trim()) {
    return error.error.trim();
  }
  if (error && typeof error.reason === 'string' && error.reason.trim()) {
    return error.reason.trim();
  }
  if (error !== null && typeof error !== 'undefined' && typeof error !== 'object') {
    return String(error);
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch(err) {
    // Circular or otherwise non-serializable errors fall through to the stable
    // message below instead of creating another playback error.
  }
  return 'MPV returned an unknown error';
}

function playbackMediaType(video) {
  return video && video.dvd ? 'DVD' : 'video';
}

function playbackMediaDescription(mediaType) {
  return mediaType === 'DVD' ? 'DVD folder' : 'video file';
}

function storageUnavailableMessage(mediaType) {
  return `Problem playing ${mediaType}: the drive containing this ${
    mediaType === 'DVD' ? 'DVD' : 'video'
  } is not connected or mounted. Connect or mount the drive, then try again.`;
}

function watchfolderUnavailableMessage(mediaType) {
  return `Problem playing ${mediaType}: this ${
    mediaType === 'DVD' ? 'DVD\'s' : 'video\'s'
  } watchfolder is unavailable. Make sure its drive or network location is connected; ` +
    'if it is, the watchfolder may have been moved or renamed.';
}

function mediaMissingMessage(mediaType) {
  return `Problem playing ${mediaType}: the ${playbackMediaDescription(mediaType)} was moved, ` +
    'renamed, or deleted. Scan its watchfolder to update Mynda.';
}

function mediaInaccessibleMessage(mediaType) {
  return `Problem playing ${mediaType}: Mynda cannot access the ${
    playbackMediaDescription(mediaType)
  }. Check its permissions, then try again.`;
}

// macOS external volumes and Windows drive/UNC roots let Mynda distinguish an
// unavailable device from an individual file that was moved or deleted. Linux
// mount locations are not standardized, so its configured watchfolder is the
// stronger portable boundary checked below.
function playbackStorageRoot(filename, platform = process.platform) {
  if (typeof filename !== 'string' || !filename) return null;

  if (platform === 'darwin') {
    const resolved = path.posix.resolve(filename);
    const parts = resolved.split('/');
    if (parts[1] === 'Volumes' && parts[2]) {
      return path.posix.join('/Volumes', parts[2]);
    }
    return null;
  }

  if (platform === 'win32') {
    return path.win32.parse(filename).root || null;
  }

  return null;
}

function containingWatchfolderPath(filename, watchfolders, platform = process.platform) {
  if (typeof filename !== 'string' || !Array.isArray(watchfolders)) return null;
  const pathAPI = platform === 'win32' ? path.win32 : path.posix;
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const resolvedFilename = pathAPI.resolve(filename);
  const comparableFilename = caseInsensitive ? resolvedFilename.toLowerCase() : resolvedFilename;

  return watchfolders
    .map(folder => typeof folder === 'string' ? folder : folder && folder.path)
    .filter(folderPath => typeof folderPath === 'string' && folderPath.trim())
    .map(folderPath => {
      const resolved = pathAPI.resolve(folderPath);
      return {
        path: folderPath,
        resolved: resolved,
        comparable: caseInsensitive ? resolved.toLowerCase() : resolved
      };
    })
    .filter(candidate => {
      const relative = pathAPI.relative(candidate.comparable, comparableFilename);
      return relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${pathAPI.sep}`) && !pathAPI.isAbsolute(relative));
    })
    .sort((a, b) => b.resolved.length - a.resolved.length)
    .map(candidate => candidate.path)[0] || null;
}

function statPlaybackPath(filesystem, filename) {
  try {
    return {available: true, stats: filesystem.statSync(filename), error: null};
  } catch(error) {
    return {available: false, stats: null, error: error};
  }
}

function isMissingPathError(error) {
  return Boolean(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

// Inspect the selected target before MPV is constructed. Besides avoiding a
// pointless player window, the staged checks provide a useful distinction:
// missing storage, missing watchfolder, missing media, or a permissions issue.
function inspectPlaybackTarget(video, options = {}) {
  const filesystem = options.filesystem || fs;
  const platform = options.platform || process.platform;
  const watchfolders = Array.isArray(options.watchfolders) ? options.watchfolders : [];
  const mediaType = playbackMediaType(video);
  const filename = video && typeof video.filename === 'string' ? video.filename.trim() : '';

  if (!filename) {
    return {
      available: false,
      mediaType: mediaType,
      filename: filename,
      reason: 'missing-library-path',
      message: `Problem playing ${mediaType}: the library record has no media path`
    };
  }

  const mediaStatus = statPlaybackPath(filesystem, filename);
  if (mediaStatus.available) {
    const correctType = video && video.dvd ?
      mediaStatus.stats.isDirectory() : mediaStatus.stats.isFile();
    if (correctType) {
      return {
        available: true,
        mediaType: mediaType,
        filename: filename,
        reason: null,
        message: null
      };
    }
    return {
      available: false,
      mediaType: mediaType,
      filename: filename,
      reason: 'wrong-media-type',
      message: mediaMissingMessage(mediaType)
    };
  }

  if (!isMissingPathError(mediaStatus.error)) {
    return {
      available: false,
      mediaType: mediaType,
      filename: filename,
      reason: 'media-inaccessible',
      error: mediaStatus.error,
      message: mediaInaccessibleMessage(mediaType)
    };
  }

  const storageRoot = playbackStorageRoot(filename, platform);
  if (storageRoot) {
    const storageStatus = statPlaybackPath(filesystem, storageRoot);
    if (!storageStatus.available && isMissingPathError(storageStatus.error)) {
      return {
        available: false,
        mediaType: mediaType,
        filename: filename,
        storageRoot: storageRoot,
        reason: 'storage-unavailable',
        error: mediaStatus.error,
        message: storageUnavailableMessage(mediaType)
      };
    }
  }

  const watchfolder = containingWatchfolderPath(filename, watchfolders, platform);
  if (watchfolder) {
    const watchfolderStatus = statPlaybackPath(filesystem, watchfolder);
    if (!watchfolderStatus.available) {
      return {
        available: false,
        mediaType: mediaType,
        filename: filename,
        watchfolder: watchfolder,
        reason: 'watchfolder-unavailable',
        error: mediaStatus.error,
        message: watchfolderUnavailableMessage(mediaType)
      };
    }
  }

  return {
    available: false,
    mediaType: mediaType,
    filename: filename,
    watchfolder: watchfolder,
    reason: 'media-missing',
    error: mediaStatus.error,
    message: mediaMissingMessage(mediaType)
  };
}

function playbackFailureMessage(error, mediaType) {
  let displayError = error;
  let depth = 0;
  while (displayError && displayError.originalError && depth < 4) {
    displayError = displayError.originalError;
    depth += 1;
  }
  return `Problem playing ${mediaType}: ${describePlaybackError(displayError)}`;
}

const MPV_START_TIMEOUT_MS = 10000;
const MPV_LOAD_TIMEOUT_MS = 30000;
const MPV_COMMAND_TIMEOUT_MS = 5000;
let mpvDvdSupportPromise = null;

// node-mpv's own load timeout is event-count based rather than time based, so
// a failed load can remain pending forever if MPV stops sending IPC data.
function withPlaybackTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.code = 'MYNDA_PLAYBACK_TIMEOUT';
      reject(error);
    }, timeout);

    Promise.resolve(promise).then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

// MPV's DVD protocol is an optional build feature. In particular, an MPV
// executable can play ordinary files perfectly while dvd:// is unavailable.
// Cache this inexpensive process check for the lifetime of the application.
function mpvSupportsDvdPlayback() {
  if (mpvDvdSupportPromise) return mpvDvdSupportPromise;

  mpvDvdSupportPromise = new Promise((resolve) => {
    let finished = false;
    let output = '';
    let childProcess;
    let timer;

    const finish = (supported) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(supported);
    };

    try {
      if (!MediaTools.mpvPath) {
        resolve(null);
        return;
      }
      childProcess = spawn(
        MediaTools.mpvPath,
        ['--no-config', '--list-protocols'],
        MpvProcess.mpvSpawnOptions(MediaTools.mpvPath)
      );
    } catch(err) {
      resolve(null);
      return;
    }

    timer = setTimeout(() => {
      try { childProcess.kill(); } catch(err) {}
      finish(null);
    }, MPV_START_TIMEOUT_MS);

    childProcess.stdout.on('data', (data) => { output += data.toString(); });
    childProcess.stderr.on('data', (data) => { output += data.toString(); });
    childProcess.once('error', () => finish(null));
    childProcess.once('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(/(?:^|\s)dvd(?:nav)?:\/\/(?:\s|$)/im.test(output));
    });
  });

  return mpvDvdSupportPromise;
}

const uniqueMpvSocketPath = MpvProcess.uniqueMpvSocketPath;

// node-mpv's quit() first writes a command to the IPC socket. When MPV has
// already closed that socket, Node can emit ERR_SOCKET_CLOSED outside the
// returned promise, which an await/catch cannot intercept. Tear down the
// main-owned process and socket directly instead.
function stopMpvSafely(player, playerLog = {debug() {}}) {
  MpvProcess.stopMpvPlayer(player, {
    onSocketError(error) {
      playerLog.debug('MPV socket closed during cleanup', {
        error: describePlaybackError(error)
      });
    }
  });
}

// Watch MPV's actual file lifecycle before sending loadfile. This avoids a
// race in node-mpv's load() implementation and preserves MPV's end-file detail.
function loadDvdInMpv(player) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ipc = player && player.socket;
    const child = player && player.mpvPlayer;

    const cleanup = () => {
      clearTimeout(timer);
      if (ipc && typeof ipc.removeListener === 'function') ipc.removeListener('message', onMessage);
      if (child && typeof child.removeListener === 'function') child.removeListener('close', onProcessClose);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.event === 'file-loaded') {
        succeed();
        return;
      }
      if (message.event === 'end-file') {
        const detail = message.file_error || message.error || message.reason;
        const error = new Error(detail ?
          `MPV could not open this DVD (${detail})` :
          'MPV could not open this DVD');
        error.code = 'MYNDA_MPV_LOAD_FAILED';
        fail(error);
      }
    };
    const onProcessClose = (code, signal) => {
      const ending = signal ? `signal ${signal}` : `exit code ${code}`;
      const error = new Error(`MPV closed while trying to open this DVD (${ending})`);
      error.code = 'MYNDA_MPV_CLOSED';
      fail(error);
    };
    const timer = setTimeout(() => {
      const error = new Error(
        'MPV did not finish loading this DVD within 30 seconds. The DVD folder may be unreadable.'
      );
      error.code = 'MYNDA_PLAYBACK_TIMEOUT';
      fail(error);
    }, MPV_LOAD_TIMEOUT_MS);

    if (!ipc || typeof ipc.on !== 'function') {
      fail(new Error('Mynda could not monitor MPV while loading this DVD'));
      return;
    }

    // The listeners must exist before the command: DVD failures can emit
    // start-file/end-file before node-mpv finishes awaiting its command reply.
    ipc.on('message', onMessage);
    if (child && typeof child.once === 'function') child.once('close', onProcessClose);
    Promise.resolve(player.command('loadfile', ['dvd://', 'replace'])).catch(fail);
  });
}

module.exports = {describePlaybackError, playbackMediaType, playbackStorageRoot, containingWatchfolderPath, inspectPlaybackTarget, playbackFailureMessage, withPlaybackTimeout, mpvSupportsDvdPlayback, uniqueMpvSocketPath, stopMpvSafely, loadDvdInMpv, MPV_START_TIMEOUT_MS, MPV_LOAD_TIMEOUT_MS, MPV_COMMAND_TIMEOUT_MS};
