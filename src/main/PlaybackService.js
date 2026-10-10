'use strict';

const Mpv = require('node-mpv');
const MediaTools = require('../media/MediaTools');
const MpvProcess = require('../media/MpvProcess');
const Support = require('./PlaybackSupport');

// MPV and playback persistence have one main-process owner. The renderer sends
// an existing video ID, never a media path, executable, or command arguments.
function createPlaybackService({library, log, publish = () => {},
  Player = Mpv, tools = MediaTools, processTools = MpvProcess,
  inspectTarget = Support.inspectPlaybackTarget,
  supportsDvd = Support.mpvSupportsDvdPlayback,
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (!library) throw new Error('Playback requires the authoritative library.');
  log = log || {debug() {}, info() {}, warn() {}, error() {}};
  let current = null;
  let sequence = 0;
  let revision = 0;
  let state = {sessionId: 0, revision: 0, videoId: null, status: 'idle', errorMessage: null};
  const positions = new Map();
  const failedPositions = new Map();
  let positionSave = null;
  let recentSave = null;
  const storageErrorCodes = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EPERM',
    'EBUSY', 'EMFILE', 'ENFILE', 'ENOENT']);

  function notify(session, status, details = {}) {
    if (session && current !== session) return;
    state = {sessionId: session ? session.id : state.sessionId, revision: ++revision,
      videoId: session ? session.video.id : state.videoId,
      status, errorMessage: null, ...details};
    publish({...state});
  }

  function saveError(error, operation) {
    log.error(`Could not ${operation}`, {error});
    publish({...state, saveError: `Mynda could not ${operation}: ${Support.describePlaybackError(error)}`});
  }

  function flushPositions() {
    if (positionSave) return positionSave;
    if (!positions.size) return Promise.resolve();
    const [id, position] = positions.entries().next().value;
    positions.delete(id);
    const video = library.media.find(value => value && value.id === id);
    if (!video) return flushPositions();
    const failure = failedPositions.get(id);
    return savePosition({id, position, expected: failure && failure.retryable ?
      failure.expected : {position: video.position}});
  }

  function savePosition(record) {
    const {id, position, expected} = record;
    // Only position is patched; title edits and metadata arriving from scans
    // can never be overwritten by a stale playback snapshot.
    const write = library.patchMedia(id, {position}, expected, undefined, {priority: 'user'});
    positionSave = Promise.resolve(write).then(() => {
      failedPositions.delete(id);
    }, error => {
      // Retain a failed disk write for an explicit later flush/Wait. Its
      // original expectation survives the retry, so a manual reset made while
      // the disk was full cannot be silently overwritten after recovery.
      const failure = {id, expected, position: positions.has(id) ? positions.get(id) : position,
        error, retryable: storageErrorCodes.has(error.code) &&
          !(error.libraryOperation && error.libraryOperation.committed)};
      positions.delete(id);
      const previous = failedPositions.get(id);
      if (!previous || previous.error.message !== error.message || previous.error.code !== error.code) {
        saveError(error, 'save the playback position');
      }
      failedPositions.set(id, failure);
      throw error;
    }).finally(() => {
      positionSave = null;
      if (positions.size) flushPositions().catch(() => {});
    });
    positionSave.catch(() => {});
    return positionSave;
  }

  function updatePosition(session, time) {
    if (current !== session || session.ended || !Number.isFinite(time) || time < 0) return;
    session.position = Math.round(time * 10) / 10;
    // A new playback event is a new position update, not a replay of a failed
    // conflicting write. Queued old ticks and explicit flushes cannot do this.
    const failure = failedPositions.get(session.video.id);
    if (failure && !failure.retryable) failedPositions.delete(session.video.id);
    positions.set(session.video.id, session.position);
    flushPositions().catch(() => {});
  }

  function finishPosition(session) {
    if (session.ended) return;
    clearTimer(session.recentTimer);
    session.ended = true;
    if (!session.started) return;
    let position = session.position;
    const duration = session.video.metadata && session.video.metadata.duration;
    if (Number.isFinite(duration) && duration > 0 &&
      (position < Math.min(duration * .005, 30) || position > Math.max(duration * .97, duration - 300))) {
      position = 0;
    }
    const failure = failedPositions.get(session.video.id);
    if (failure) {
      if (failure.retryable) failure.position = position;
    } else {
      positions.set(session.video.id, position);
      flushPositions().catch(() => {});
    }
    log.info('MPV playback ended', {videoID: session.video.id, title: session.video.title, position});
  }

  function cleanup(session) {
    clearTimer(session.recentTimer);
    for (const [event, handler] of session.listeners) session.player.removeListener(event, handler);
    session.listeners = [];
    if (session.player) processTools.stopMpvPlayer(session.player, {
      onSocketError: error => log.debug('MPV socket closed during cleanup', {error: Support.describePlaybackError(error)})
    });
  }

  function stopCurrent() {
    if (!current) return;
    const previous = current;
    finishPosition(previous);
    current = null;
    cleanup(previous);
    notify(null, 'stopped');
  }

  async function flush() {
    // Capture only failures already known when this explicit request began.
    // A newly failing write must return to its caller; never loop on a full
    // disk or retry a conflict. Concurrent stop calls share the active write.
    const retries = [...failedPositions.values()].filter(failure => failure.retryable);
    while (positionSave || positions.size) await flushPositions();
    for (const failure of retries) {
      if (failedPositions.get(failure.id) !== failure) continue;
      await savePosition(failure);
    }
    if (failedPositions.size) throw failedPositions.values().next().value.error;
    if (recentSave) await recentSave;
  }

  async function stop() {
    stopCurrent();
    await flush();
    return {...state};
  }

  function listen(session, event, handler) {
    session.player.on(event, handler);
    session.listeners.push([event, handler]);
  }

  function ensureCurrent(session) {
    if (current !== session || session.ended) {
      const error = new Error('Playback was canceled');
      error.code = 'MYNDA_PLAYBACK_CANCELED';
      throw error;
    }
  }

  async function start(session) {
    if (current !== session) return;
    const video = session.video;
    const mediaType = Support.playbackMediaType(video);
    const watchfolders = library.settings && library.settings.watchfolders;
    log.info('Playback requested', {videoID: video.id, title: video.title, mediaType,
      filename: video.filename, savedPosition: video.position});
    const target = inspectTarget(video, {watchfolders});
    if (!target.available) {
      log.warn('Playback skipped because its media target is unavailable', {videoID: video.id,
        title: video.title, mediaType, filename: target.filename, storageRoot: target.storageRoot,
        watchfolder: target.watchfolder, reason: target.reason, errorCode: target.error && target.error.code});
      notify(session, 'error', {errorMessage: target.message});
      return;
    }
    if (!tools.mpvPath) {
      notify(session, 'error', {errorMessage: "Problem playing video: Mynda's bundled MPV player is missing or could not be started. Reinstall Mynda, then try again."});
      return;
    }
    try {
      if (video.dvd) {
        const supported = await supportsDvd();
        ensureCurrent(session);
        if (supported === false) {
          notify(session, 'error', {errorMessage: 'Problem playing DVD: this installation of MPV does not include DVD playback support, so Mynda cannot play DVDs with it.'});
          return;
        }
      }
      const player = new Player({time_update: 5, auto_restart: false, binary: tools.mpvPath,
        socket: Support.uniqueMpvSocketPath(), ipc_command: '--input-ipc-server'},
      video.dvd ? [`--dvd-device=${video.filename}`] : []);
      session.player = player;
      await processTools.startMpvPlayer(player, {timeoutMs: Support.MPV_START_TIMEOUT_MS});
      ensureCurrent(session);
      log.debug('MPV process and JSON IPC connection started', {
        videoID: video.id, binary: tools.mpvPath, pid: player.mpvPlayer && player.mpvPlayer.pid});
      if (video.dvd) await Support.loadDvdInMpv(player);
      else await Support.withPlaybackTimeout(player.load(video.filename), Support.MPV_LOAD_TIMEOUT_MS,
        'MPV did not finish loading this video within 30 seconds');
      ensureCurrent(session);
      await Support.withPlaybackTimeout(player.goToPosition(session.position), Support.MPV_COMMAND_TIMEOUT_MS,
        'MPV did not respond while restoring the playback position');
      ensureCurrent(session);
      for (const sub of (Array.isArray(video.subtitles) ? video.subtitles : [])) {
        if (typeof sub !== 'string') continue;
        await Support.withPlaybackTimeout(player.addSubtitles(sub), Support.MPV_COMMAND_TIMEOUT_MS,
          'MPV did not respond while adding subtitles');
        ensureCurrent(session);
      }
      await Support.withPlaybackTimeout(player.play(), Support.MPV_COMMAND_TIMEOUT_MS,
        'MPV did not respond to the play command');
      ensureCurrent(session);
      session.started = true;
      listen(session, 'timeposition', position => updatePosition(session, position));
      listen(session, 'seek', change => updatePosition(session, change && change.end));
      listen(session, 'stopped', () => {
        if (current !== session) return;
        finishPosition(session);
        notify(session, 'ended');
      });
      const exited = crashed => {
        if (current !== session) return;
        if (crashed) log.error('MPV process exited unexpectedly', {videoID: video.id, title: video.title,
          error: processTools.withMpvDiagnostics(new Error('MPV process exited unexpectedly'), player)});
        finishPosition(session);
        cleanup(session);
        notify(session, 'closed');
        current = null;
      };
      listen(session, 'quit', () => exited(false));
      listen(session, 'crashed', () => exited(true));
      session.recentTimer = setTimer(() => {
        if (current !== session || session.ended) return;
        log.info('Video counted as recently played', {videoID: video.id, title: video.title});
        recentSave = Promise.resolve(library.recordPlayed(video.id)).catch(error => {
          saveError(error, 'save recently watched videos');
          throw error;
        });
        recentSave.catch(() => {});
      }, 10000);
      notify(session, 'playing');
    } catch (error) {
      const playbackError = processTools.withMpvDiagnostics(error, session.player);
      cleanup(session);
      if (current !== session || error.code === 'MYNDA_PLAYBACK_CANCELED') {
        log.debug('Playback attempt canceled', {videoID: video.id, error: playbackError});
        return;
      }
      const targetAfterFailure = inspectTarget(video, {watchfolders});
      log.error('Playback failed', {videoID: video.id, title: video.title, mediaType, error: playbackError});
      notify(session, 'error', {errorMessage: targetAfterFailure.available ?
        Support.playbackFailureMessage(playbackError, mediaType) : targetAfterFailure.message});
    }
  }

  function play(videoId) {
    if (typeof videoId !== 'string' || !videoId || videoId.length > 200) throw new Error('A library video ID is required.');
    const video = library.media.find(value => value && value.id === videoId);
    if (!video) throw new Error('That video is no longer in the active library.');
    stopCurrent();
    const session = {id: ++sequence, video, player: null, listeners: [], ended: false,
      started: false, position: Number.isFinite(video.position) ? video.position : 0};
    current = session;
    notify(session, 'loading');
    // An immediate acknowledgement lets the UI cancel while a DVD probe or
    // player startup is pending. Stale attempts can never reclaim ownership.
    Promise.resolve().then(() => start(session)).catch(error => {
      log.error('Could not initialize playback', {error});
      notify(session, 'error', {errorMessage: Support.playbackFailureMessage(error, Support.playbackMediaType(video))});
    });
    return {...state};
  }

  return {play, stop, flush, getState: () => ({...state}), dispose: stop};
}

module.exports = {createPlaybackService};
