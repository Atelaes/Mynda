// Top navigation and playlist tabs.
const React = require('react');
const {ipcRenderer} = require('electron');
const {library} = require('./RendererRuntime.js');

// ###### Nav Pane: contains playlist tabs and search field ###### //
class MynNav extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      numVidsAdded:0,
    }

    // sent by index.js when a video is added to the library;
    ipcRenderer.on('videos_added', (event, numVidsAdded) => {
      this.setState({numVidsAdded:numVidsAdded});
    });

    this.render = this.render.bind(this);
  }

  clearSearch(e) {
    const input = document.getElementById("search-input");
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true })); // necessary to trigger the search function
    input.focus();
  }

  // setPlaylist(playlistID,target) {
  //   // reset numVidsAdded to zero when the user clicks on the 'new' playlist
  //   // if (playlistID === 'new') this.state.numVidsAdded = 0;
  //
  //   this.props.setPlaylist(playlistID,target);
  // }

  componentDidUpdate(oldProps) {
    // console.log('MYNNAV PLAYLIST ID::::' + this.props.currentPlaylistID);
    // if (oldProps.videoEditFlag !== this.props.videoEditFlag || oldProps.playlistEditFlag !== this.props.playlistEditFlag) {
    //   // a video was changed, so we want to recalculate the number of videos
    //   // in each playlist to update the displays
    //   // console.log('videoEditFlag was altered, updating MynNav')
    //   this.setState({}); // force component to re-render
    // }
  }


  render() {
    return (
      <div id="nav-pane" className="pane">
        <ul id="nav-playlists">
          {this.props.playlists.map((playlist, index) => {
            if (!playlist) return null;
            let newVidAlert = null;

            // this bit is to NOT display the 'new' playlist
            // unless there is at least one new video
            if (playlist.id === 'new') {
              let anyNew = false;
              for (const v of library.media) {
                if (v && v.new) {
                  anyNew = true;
                  break;
                }
              }
              if (!anyNew) return;

              // if (this.state.numVidsAdded > 0) {
              //   newVidAlert = (
              //     <div id='nav-message'>(+{this.state.numVidsAdded})</div>
              //   );
              // }
            }

            // if playlist is selected to be displayed in as a tab in the navbar
            if (playlist.tab) {
              let numVids = this.props.playlistLength[playlist.id]

              let className = playlist.view;
              if (playlist.id === this.props.currentPlaylistID) className += ' selected';

              return (
                <li
                  key={playlist.id}
                  id={"playlist-" + playlist.id}
                  title={numVids}
                  style={{zIndex: 100 - index}}
                  className={className}
                  onClick={(e) => this.props.setPlaylist(playlist.id,e.target)}
                >
                  {playlist.name}
                  {playlist.id === 'new' && numVids > 0 ? <div className='nav-message loud'>({numVids})</div> : null}
                  {playlist.id !== 'new' && playlist.id === this.props.currentPlaylistID ? <div className='nav-message quiet small'>({numVids})</div> : null} 
                  {/*playlist.id === this.props.currentPlaylistID ? (<MynNavPlaylistMiniEdit playlist={playlist} />) : null*/}
                  {/*newVidAlert*/}
                </li>
              );
            } else {
              // eventually we'll probably add the others to a dropdown/flyout menu
            }
          })}
          <li key="add" id="add-playlist" onClick={(e) => this.props.showSettings('playlists')}>{'\uFF0B'}</li>
        </ul>
        <div id="nav-controls">
          <div id="scan-button" className="controls" onClick={() => this.props.scanWatchfolders()} title="Scan Watchfolders for New Videos"></div>
          <div id="search-field" className="input-container controls"><span id="search-label">Search: </span><input id="search-input" className="empty" type="text" placeholder="Search..." onInput={(e) => this.props.search(e)} /><div id="search-clear-button" className="input-clear-button always" onClick={(e) => this.clearSearch(e)}></div></div>
          <div id="settings-button" className="controls" onClick={() => this.props.showSettings()}></div>
          <div id="show-hide-details-btn" className="controls" onClick={() => this.props.toggleDetailsPane(!this.props.detailsPaneShowing)} title="Hide/Show Details Pane">{this.props.detailsPaneShowing ? "\u21E5" : "\u21E4"}</div>
        </div>
      </div>
    )
  }
}

class MynNavPlaylistMiniEdit extends React.Component {
  constructor(props) {
    super(props)

  }

  render() {
    return null;
  }
}

module.exports = {MynNav, MynNavPlaylistMiniEdit};
