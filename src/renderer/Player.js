// MPV playback orchestration and the player pane.
const React = require('react');
const {spawn} = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mpvAPI = require('node-mpv');
const {library, playerLog} = require('./RendererRuntime.js');
const {MynOpenablePane} = require('./SharedComponents.js');

// Turn node-mpv's string, Error, and structured IPC rejection shapes into a
// concise user-facing detail without falling back to "[object Object]".
function describePlaybackError(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
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
// Cache this inexpensive process check for the lifetime of the renderer.
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
      childProcess = spawn('mpv', ['--no-config', '--list-protocols']);
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

function uniqueMpvSocketPath() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\mynda-mpv-${suffix}`;
  return path.join(os.tmpdir(), `mynda-mpv-${suffix}.sock`);
}

// node-mpv's quit() first writes a command to the IPC socket. When MPV has
// already closed that socket, Node can emit ERR_SOCKET_CLOSED outside the
// returned promise, which an await/catch cannot intercept. Tear down the
// renderer-owned process and socket directly instead.
function stopMpvSafely(player) {
  if (!player) return;

  // Make any concurrently running node-mpv polling reject as "not running"
  // before its socket is dismantled.
  player.running = false;
  try { clearInterval(player.timepositionListenerId); } catch(err) {}
  try { player.removeAllListeners(); } catch(err) {}

  const child = player.mpvPlayer;
  if (child) {
    // Prevent node-mpv's close handler from attempting an automatic restart.
    try { child.removeAllListeners('close'); } catch(err) {}
  }

  const socket = player.socket && player.socket.socket;
  if (socket) {
    try {
      socket.removeAllListeners('close');
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.on('error', (error) => playerLog.debug('MPV socket closed during cleanup', {
        error: describePlaybackError(error)
      }));
      socket.destroy();
    } catch(err) {}
  }

  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch(err) {}
  }
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

// ###### Player Pane: plays the video ###### //
class MynPlayer extends MynOpenablePane {
  constructor(props) {
    super(props)

    this.state = {
      video: props.video,
      paneID: 'player-pane',
      errorMessage: null,
      showPlayingMessage: false,
      showLoadingIndicator: false,
    }

    this.loadingIndicator = null;
    this.mpv = null;
    this.playbackAttempt = 0;

    this.render = this.render.bind(this);
    this.setUpVideo = this.setUpVideo.bind(this);
  }

  updatePosition(time) {
    this.state.video.position = Math.round(time * 10) / 10;
    playerLog.debug('Updating saved playback position', {
      videoID: this.state.video.id,
      position: this.state.video.position
    });
    library.replace(`media.id=${this.state.video.id}`,this.state.video);
  }

  // called when exiting MynPlayer pane
  onExit() {
    clearTimeout(this.logPlayTimeout);
    this.playbackAttempt += 1;
    const player = this.mpv;
    this.mpv = null;
    stopMpvSafely(player);
  }

  // called when quitting mpv player or video stopping
  onExitVideo() {
    playerLog.info('MPV playback ended', {
      videoID: this.state.video && this.state.video.id,
      title: this.state.video && this.state.video.title
    });
    this.setState({showPlayingMessage: false});

    clearTimeout(this.logPlayTimeout);

    let position = this.state.video.position;
    let duration = this.state.video.metadata.duration;
    playerLog.debug('Evaluating playback position at exit', {
      videoID: this.state.video.id,
      position: position,
      duration: duration
    });

    // if the position is close to the beginning or close enough to the end
    // that we estimate the user is done watching it, we reset to 0
    if (position < Math.min(duration*.005,30)) {
      // if < 30 seconds or 0.5%, whichever is smaller, reset to 0
      // (0.5% of 45 minutes is 13.5 seconds; 0.5% of 2 hours is 36 seconds)
      position = 0;
      playerLog.debug('Resetting playback position near the beginning', {
        videoID: this.state.video.id
      });
    } else if (position > Math.max(duration*.97, duration - 300)) {
      // if 5 minutes or less from the end, or 3% or less from the end, which ever is later, reset to 0 ()
      // (3% of 45 min is 1:21; 3% of 2 hours is 3:36)
      position = 0;
      playerLog.debug('Resetting playback position near the end', {
        videoID: this.state.video.id
      });
    }

    // save the position
    this.updatePosition(position);
  }

  keyCommand(e) {
    // ESC
    if (e.keyCode === 27) {
      // while not in fullscreen, use escape to close the video;
      // don't do anything while in fullscreen, because escape already exits fullscreen natively
      this.props.hideFunction();
    }
  }

  // ========================================== //
  // =========== CREATING THE VIDEO =========== //
  // ========================================== //

  async setUpVideo() {
    // // set up and start mpv player
    // const video = this.state.detailVideo;
    // let mpvArgs = [video.filename];
    // video.subtitles.map((sub) => {
    //   mpvArgs.push(`--sub-file=${sub}`);
    // });
    // mpvArgs.push(`--start=${video.position}`);

    // // Launch MPV with the video file
    // const mpvProcess = spawn('mpv', mpvArgs, {
    //   detached: true, // Optional: allows MPV to run independently of your Electron app
    //   stdio: 'ignore'
    // });

    // // Detach the child process so it can continue running even if the parent exits
    // mpvProcess.unref();

    // // Listen for errors (e.g., if MPV isn't installed or not found in PATH)
    // mpvProcess.on('error', (error) => {
    //   console.error('Error launching MPV:', error);
    // });

    const attempt = ++this.playbackAttempt;
    const video = this.state.video;
    // Mynda represents a copied DVD as the directory containing its VIDEO_TS
    // structure. MPV expects that directory as --dvd-device and the special
    // dvd:// playback URL; passing the directory to load() as a normal file is
    // rejected. With no explicit title, MPV selects the longest DVD title.
    if (!video || typeof video.filename !== 'string' || !video.filename.trim()) {
      this.setState({
        errorMessage: 'Problem playing video: the library record has no media path',
        showLoadingIndicator: false,
        showPlayingMessage: false
      });
      return;
    }
    if (video.dvd && !fs.existsSync(video.filename)) {
      this.setState({
        errorMessage: 'Problem playing DVD: the DVD folder is no longer available',
        showLoadingIndicator: false,
        showPlayingMessage: false
      });
      return;
    }

    if (video.dvd) {
      const dvdSupported = await mpvSupportsDvdPlayback();
      if (attempt !== this.playbackAttempt) return;
      if (dvdSupported === false) {
        this.setState({
          errorMessage: 'Problem playing DVD: this installation of MPV does not include DVD playback support, so Mynda cannot play DVDs with it.',
          showLoadingIndicator: false,
          showPlayingMessage: false
        });
        return;
      }
    }

    const mpvArguments = video && video.dvd ?
      [`--dvd-device=${video.filename}`] : [];
    const playbackTarget = video && video.dvd ? 'dvd://' : video.filename;
    const player = new mpvAPI({
      "time_update": 5,
      "auto_restart": false,
      "socket": uniqueMpvSocketPath()
    }, mpvArguments);
    this.mpv = player;

    const ensureCurrentAttempt = () => {
      if (attempt !== this.playbackAttempt || this.mpv !== player) {
        const error = new Error('Playback was canceled');
        error.code = 'MYNDA_PLAYBACK_CANCELED';
        throw error;
      }
    };

    // console.log(mpv); 

    // starts MPV
    try {
      await withPlaybackTimeout(
        player.start(),
        MPV_START_TIMEOUT_MS,
        'MPV did not start within 10 seconds'
      );
      ensureCurrentAttempt();
      // load the video file
      if (video.dvd) {
        await loadDvdInMpv(player);
      } else {
        await withPlaybackTimeout(
          player.load(playbackTarget),
          MPV_LOAD_TIMEOUT_MS,
          'MPV did not finish loading this video within 30 seconds'
        );
      }
      ensureCurrentAttempt();
      // file is playing, go to saved position
      await withPlaybackTimeout(
        player.goToPosition(Number.isFinite(video.position) ? video.position : 0),
        MPV_COMMAND_TIMEOUT_MS,
        'MPV did not respond while restoring the playback position'
      );
      // add subtitle files
      for (const sub of (Array.isArray(video.subtitles) ? video.subtitles : [])) {
        await withPlaybackTimeout(
          player.addSubtitles(sub),
          MPV_COMMAND_TIMEOUT_MS,
          'MPV did not respond while adding subtitles'
        );
      }
      // manually play in case the video isn't already playing
      await withPlaybackTimeout(
        player.play(),
        MPV_COMMAND_TIMEOUT_MS,
        'MPV did not respond to the play command'
      );
      ensureCurrentAttempt();

      // turn off loading indicator
      this.setState({ showLoadingIndicator: false, showPlayingMessage: true});
      // log that we played the video, but only after 10 seconds
      this.logPlayTimeout = setTimeout(() => {
        playerLog.info('Video counted as recently played', {
          videoID: this.state.video.id,
          title: this.state.video.title
        });
        this.props.logPlayed(this.state.video.id);
      }, 10000);


      player.on('timeposition', (pos) => {
        this.updatePosition(pos);
      });

      player.on('seek', (seeked) => {
        this.updatePosition(seeked.end);
      });

      player.on('stopped', () => {
        this.onExitVideo();
      });

      player.on('quit', () => {
        if (this.mpv === player) this.mpv = null;
        this.onExitVideo();
        this.props.hideFunction();
      });

      player.on('crashed', () => {
        if (this.mpv === player) this.mpv = null;
        this.onExitVideo();
        this.props.hideFunction();
      });
    }
    catch (error) {
      const isCurrentAttempt = attempt === this.playbackAttempt && this.mpv === player;
      stopMpvSafely(player);
      if (this.mpv === player) this.mpv = null;
      if (!isCurrentAttempt || (error && error.code === 'MYNDA_PLAYBACK_CANCELED')) {
        playerLog.debug('Playback attempt canceled', {
          videoID: video && video.id,
          error: error
        });
        return;
      }
      const mediaType = video && video.dvd ? 'DVD' : 'video';
      playerLog.error('Playback failed', {
        videoID: video && video.id,
        title: video && video.title,
        mediaType: mediaType,
        error: error
      });
      this.setState({
        errorMessage: `Problem playing ${mediaType}: ${describePlaybackError(error)}`,
        showLoadingIndicator: false,
        showPlayingMessage: false
      });
    }
  }


  // ============== UPDATE AND RENDER =============== //

  componentDidUpdate(oldProps) {
    // the component should update if props.video changes, BUT
    // ONLY IF the pane was also just opened.
    // (we will be continually updating the position of the video
    // as it's playing, and we don't want the component to re-render
    // every time we do that)
    if (!oldProps.show && this.props.show) {
      playerLog.debug('Opening player pane', {
        videoID: this.props.video && this.props.video.id,
        title: this.props.video && this.props.video.title
      });
      this.state.video = this.props.video;
      this.setState({showLoadingIndicator:true});
      this.setUpVideo();
    }

    if (oldProps.show && !this.props.show && this.mpv) {
      this.onExit();
    }

    if (!this.props.show) {
      this.state.errorMessage = null;
      this.state.showLoadingIndicator = false;
      this.state.showPlayingMessage = false;
    }

  }

  render() {
    let jsx = null;

    if (this.props.show) {

      jsx = (
        <div id="video-container" onKeyUp={(e) => this.keyCommand(e)}>
          {this.state.showPlayingMessage ? (
            <div className='playing-message'>
              <h3>Now Playing</h3>
              <h1 className='video-title'>{this.state.video ? this.state.video.title : ''}</h1>
              <h3>in MPV player</h3>
            </div>
          ) : null}
          {this.state.showLoadingIndicator ? (
            <div className='player-loading'>
              <img className='loading' src='../images/loading-icon.gif' />
            </div>
          ) : null}
          {this.state.errorMessage ? (
            <div className='error-message'>{this.state.errorMessage}</div>
          ) : null}
        </div>
      );
    }

    return super.render({jsx:jsx,exitCB:() => this.onExit()});
  }
}

module.exports = {
  MynPlayer,
  describePlaybackError,
  withPlaybackTimeout,
  mpvSupportsDvdPlayback,
  uniqueMpvSocketPath,
  stopMpvSafely,
  loadDvdInMpv
};
