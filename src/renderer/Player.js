// Browser-only player pane. Playback and persistence belong to main.
const {library, playerLog} = require('./RendererRuntime.js');
const {MynOpenablePane} = require('./SharedComponents.js');
const React = require('react');

class MynPlayer extends MynOpenablePane {
  constructor(props) {
    super(props);
    this.state = {video: props.video, paneID: 'player-pane', errorMessage: null,
      showPlayingMessage: false, showLoadingIndicator: false};
    this.playbackAttempt = 0;
    this.sessionId = 0;
    this.stateRevision = 0;
    this.playback = window.mynda.playback;
    this._removePlaybackListener = this.playback.onState(state => this.receiveState(state));
    this._removeCloseHook = library.onBeforeClose(() => this.playback.stop());
    this.setUpVideo = this.setUpVideo.bind(this);
  }

  receiveState(state) {
    if (!state || !this.props.show || !this.state.video || state.videoId !== this.state.video.id ||
      state.sessionId < this.sessionId || state.revision < this.stateRevision) return;
    this.sessionId = state.sessionId;
    this.stateRevision = state.revision;
    if (state.saveError) {
      playerLog.error('Playback state could not be saved', {error: state.saveError});
      alert(state.saveError);
    }
    this.setState({errorMessage: state.errorMessage || null,
      showLoadingIndicator: state.status === 'loading', showPlayingMessage: state.status === 'playing'});
    if (state.status === 'closed') this.props.hideFunction();
  }

  async setUpVideo() {
    const attempt = ++this.playbackAttempt;
    this.setState({errorMessage: null, showLoadingIndicator: true, showPlayingMessage: false});
    try {
      const state = await this.playback.play(this.state.video.id);
      if (attempt === this.playbackAttempt) this.receiveState(state);
    } catch (error) {
      if (attempt !== this.playbackAttempt) return;
      this.setState({errorMessage: 'Problem playing video: ' + (error && error.message || String(error)),
        showLoadingIndicator: false, showPlayingMessage: false});
    }
  }

  onExit() {
    this.playbackAttempt += 1;
    this.playback.stop().catch(error => {
      playerLog.error('Could not finish playback', {error: error && error.message || String(error)});
      alert('Mynda could not save the playback position: ' + (error && error.message || String(error)));
    });
  }

  componentWillUnmount() {
    if (this._removePlaybackListener) this._removePlaybackListener();
    if (this._removeCloseHook) this._removeCloseHook();
    this.onExit();
  }

  keyCommand(event) {
    if (event.keyCode === 27) this.props.hideFunction();
  }

  componentDidUpdate(oldProps) {
    if (!oldProps.show && this.props.show) {
      this.state.video = this.props.video;
      this.setUpVideo();
    }
    if (oldProps.show && !this.props.show) {
      this.onExit();
      this.setState({errorMessage: null, showLoadingIndicator: false, showPlayingMessage: false});
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
              <img className='loading' src='../../images/loading-icon.gif' />
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

module.exports = {MynPlayer};
