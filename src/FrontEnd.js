const React = require('react');
const ReactDOM = require('react-dom');
const electron = require('electron');
const { ipcRenderer } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const _ = require('lodash');
const DateJS = require('datejs');
const URL = require("url");
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const Logger = require('./Logger.js');
const OmdbHelper = require('./OmdbHelper.js');
const omdb = require('../omdb');
const axios = require('axios');
const accounting = require('accounting');
const { DragDropContext, Droppable, Draggable } = require('react-beautiful-dnd');
const hashObject = require('object-hash');
const Hls = require('hls.js');
const Stream = require('./Stream.js');
const subtitle = require('subtitle');
const crypto = require('crypto');
const mpvAPI = require('node-mpv');
const pathToFFmpeg = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(pathToFFmpeg);
const ffprobe = require('ffprobe');
let ffprobeStatic = {};
try {
  ffprobeStatic = require('ffprobe-static');
} catch(err) {console.warn('Warning: ffprobe-static not installed')}
const placeholderImage = "../images/qmark.png";
const editorLog = Logger.child('Editor');
let nextEditorArtworkDownloadNumber = 0;
let nextFilenameResetNumber = 0;

// Most long-running status messages originate in index.js and arrive through
// Electron IPC. Batch editing is different: the renderer prepares the edited
// videos and submits one Library.replaceMediaBatch() operation, so there is no
// backend loop that can report its progress. A local DOM event lets that
// renderer-side workflow reuse MynNotify instead of creating a second progress
// UI or bouncing a message through the main process.
const LOCAL_STATUS_UPDATE_EVENT = 'mynda-local-status-update';

function sendLocalStatusUpdate(status) {
  window.dispatchEvent(new CustomEvent(LOCAL_STATUS_UPDATE_EVENT, {detail: status}));
}

// React may give the editor freshly cloned props even though the user is
// still editing the exact same video selection. Compare stable video IDs
// rather than object identity so those harmless refreshes cannot discard
// filename-reset patches or other editor state that has not been saved yet.
function editorSelectionKey(video, batch) {
  if (!video) return '';
  if (video.id !== 'batch') return `single:${video.id || ''}`;

  const ids = (Array.isArray(batch) ? batch : [])
    .map(item => item && item.id)
    .filter(Boolean)
    .sort();
  return `batch:${JSON.stringify(ids)}`;
}

// A batch checkbox needs three display states: checked when every selected
// video is New, unchecked when none are New, and indeterminate when the
// selection is mixed. Null is used only by the editable batch summary; the
// individual videos retain ordinary boolean values.
function batchNewState(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return false;

  const numberNew = videos.filter(video => video && video.new === true).length;
  if (numberNew === videos.length) return true;
  if (numberNew === 0) return false;
  return null;
}


// let savedPing = {};

class Mynda extends React.Component {
  constructor(props) {
    super(props)

    let library = this.props.library;

    this.state = {
      videos : library.media,
      playlists : library.playlists,
      settings: library.settings,
      recentlyWatched: library.recently_watched, // a list of the id's of the x most-recently-watched videos
      // recentlyWatched : ["a14fdec2-97db-5d2f-b537-f001493f0c48","f7fb6360-d4d9-582e-b162-f35c5fe1d406","72b9f3a0-aafe-50c6-8411-c0598b7cded8","d487a789-1799-5ed4-b2a9-786ddc474cf5","dd6d32e1-4427-5c9a-8a62-be284ea7ae00"],

      filteredVideos : [], // list of videos to display: can be filtered by a playlist or a search query or whatever; this is what is displayed
      playlistVideos : [], // list of videos filtered by the playlist only; this is used to execute a search query on
      playlistLength : {}, // will contain the number of videos in each playlist (playlist id as key)
      view : "flat", // whether to display a flat table or a series view
      columns : [], // the list of columns to display for the current playlist
      detailVideo : null,
      detailVideoRowIndex: null, // keep the row index of the detail video in state so we can go to prev/next video even if the video leaves the table after being edited
      currentPlaylistID : null,
      prevQuery : '',
      selectedRows : {},
      playlistRowManifest : [],

      detailsPaneShowing : true,

      // openablePane: null
      show : {
        settingsPane : false,
        editorPane : false,
        playerPane : false
      },
      defaultSettingsView : 'folders',
    }
    this.state.settingsView = this.state.defaultSettingsView;

    this.render = this.render.bind(this);
    this.playlistFilter = this.playlistFilter.bind(this);
    this.setPlaylist = this.setPlaylist.bind(this);
    this.search = this.search.bind(this);
    this.calcAvgRatings = this.calcAvgRatings.bind(this);
    this.toggleDetailsPane = this.toggleDetailsPane.bind(this);
    this.showDetails = this.showDetails.bind(this);
    this.editSeries = this.editSeries.bind(this);
    this.playVideo = this.playVideo.bind(this);
    this.handleHoveredRow = this.handleHoveredRow.bind(this);
    this.handleSelectedRows = this.handleSelectedRows.bind(this);
    this.reportSortedManifest = this.reportSortedManifest.bind(this);
    this.logPlayed = this.logPlayed.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    // this.showSettings = this.showSettings.bind(this);
    // this.hideSettings = this.hideSettings.bind(this);
  }

  displayColumnName(name, reverse) {
    const substitutions = {
      "ratings_user" : "rating",
      "dateadded" : "added",
      "lastseen" : "last seen",
      "ratings_rt" : (<img src="../images/logos/rt-logo.png" className='ratings-icon' />),
      "ratings_imdb" : (<img src="../images/logos/imdb-logo.png" className='ratings-icon' />),
      "ratings_mc" : (<img src="../images/logos/mc-logo.png" className='ratings-icon' />),
      "ratings_avg" : "avg",
      "boxoffice" : "BoxOffice",
      "languages" : "language",
      "duration" : "runtime",
      "episode" : "#",
      "resolution" : "res",
      "watchlater" : "\u2665"
    }

    let result = name;

    if (!reverse) {
      if (Object.keys(substitutions).includes(name)) {
        result = substitutions[name];
      }
    } else {
      Object.keys(substitutions).forEach(key => {
        if (_.isEqual(substitutions[key],name)) {
          result = key;
        }
      });
    }

    if (typeof result === 'string') {
      result = result.replace(/\b\w/g,(letter) => letter.toUpperCase());
    }

    return result;
  }

  calcAvgRatings(ratings, purpose) {
    // get list of sources, but
    // ignore sources with a value of empty string
    let keys = Object.keys(ratings).filter(key => ratings[key] !== '');

    // if the preferences option to include the user rating in the average is NOT checked,
    // delete the user rating key from the array
    if (!this.state.settings.preferences.include_user_rating_in_avg) {
      keys = keys.filter(key => key !== 'user');
    }

    if (keys.length === 0) return purpose === 'sort' ? -1 : '';

    let avg = 0;
    keys.map(r => {
      let value = Number(ratings[r]);
      let normalized = 0;
      if (r === 'user') normalized = value * 20;
      else if (r === 'imdb') normalized = value * 10;
      else normalized = value;
      avg += normalized;
    });
    avg /= keys.length;
    return purpose === 'sort' ? Number(avg) : Math.round(avg) + '%';
  }

  loadLibrary() {
    const library = this.props.library;
    this.setState({
      videos : library.media,
      playlists : library.playlists,
      settings: library.settings
    });
  }

  handleHoveredRow(video, rowID, index) {
    // if nothing is selected, populate the details pane with the video of the row being hovered
    // but don't re-render the details pane when the pointer moves between cells in the same row
    if (_.isEmpty(this.state.selectedRows) && this.state.detailsPaneShowing && rowID !== this.state.detailRowID) {
      this.showDetails(video.id, rowID, video, index);
    }
  }

  // forceRowHover(vidID, rowID) {
  //   this.state.selectedRows = {};
  //   this.handleHoveredRow(vidID,rowID);
  // }

  // selectedVids should be an array of video ids
  // or a single video id
  handleSelectedRows(selectedVids, highestRow, tableID, overwrite) {
    // console.log("Overwrite ? " + overwrite);
    // overwrite is a boolean telling us whether to deselect all previously
    // selected rows in all tables before adding the new selections
    if (overwrite) this.state.selectedRows = {};

    if (typeof selectedVids === 'string') {
      selectedVids = [selectedVids];
    }

    // if any videos were selected in this table, add them to the object;
    // we don't want to add an empty list of rows to the object, because that may
    // cause an infinite loop when the table updates its own state variable
    // based on this object
    if (selectedVids && selectedVids.length > 0) {
      this.state.selectedRows[tableID] = {
        rows: selectedVids,
        highestRow: highestRow
      };
    } else {
      // if no videos in this table were selected, delete this table from the object
      delete this.state.selectedRows[tableID]
    }

    // get object containing all selected videos
    let allSelected = this.getAllSelected();
    console.log(`ALL SELECTED: ${JSON.stringify(allSelected)}`);

    if (allSelected.rows.length === 0) {
      // if no rows are selected, empty the state object so that
      // this.handleHoveredRow can take over and display whatever row the
      // user is hovering on
      this.setState({selectedRows:{}} /*, ()=>console.log('SELECTED ROWS OBJECT: ' + JSON.stringify(this.state.selectedRows))*/);
    } else if (allSelected.rows.length === 1) {
      // if only one row is selected, show that video in the details pane
      this.showDetails(allSelected.rows[0],allSelected.highestRow);
    } else {
      // if multiple rows are selected, pass the whole array into showDetails
      this.showDetails(allSelected.rows,allSelected.highestRow);
    }
    // console.log('SELECTED ROWS OBJECT: ' + JSON.stringify(this.state.selectedRows));
  }

  getAllSelected() {
    let selected = [];
    Object.keys(this.state.selectedRows).map(tableID => {
      selected = [...selected, ...this.state.selectedRows[tableID].rows];
    });

    selected = [...new Set(selected)];
    const selectedSet = new Set(selected);
    const firstSelectedManifestRow = (this.state.playlistRowManifest || [])
      .find(row => selectedSet.has(row.vidID));
    const highestRow = firstSelectedManifestRow ? firstSelectedManifestRow.rowID : null;

    let results = {
      rows: selected,
      highestRow: highestRow
    }

    return results;
  }

  // given video id, return a list of its rows in the current playlist, if any
  findVideoRows(id) {
    return this.state.playlistRowManifest.filter(row => row.vidID === id);
  }

  reportSortedManifest(manifest) {
    this.state.playlistRowManifest = manifest;
  }

  toggleDetailsPane(show) {
    // when hiding details pane, add the class "whole" to the library pane,
    // to allow it to take up the remaining space
    let libPane = document.getElementById("library-pane");
    if (show) {
      libPane.classList.remove("whole");
    } else {
      libPane.classList.add("whole");
    }

    this.setState({detailsPaneShowing : show});
  }

  // Open the existing batch editor for every video in one series. Series
  // headers are not ordinary table rows, so they cannot use rowSelect(). Build
  // the same selectedRows structure that a Cmd/Ctrl/Shift selection would
  // have produced; this keeps the batch alive when saves refresh the playlist.
  editSeries(videos) {
    const videoIDs = (videos || []).map(video => video && video.id).filter(Boolean);
    if (videoIDs.length === 0) return;

    const selectedIDSet = new Set(videoIDs);
    const selectedRows = {};
    let firstRowID = null;

    (this.state.playlistRowManifest || []).forEach(row => {
      if (!row || !selectedIDSet.has(row.vidID)) return;

      if (!firstRowID) firstRowID = row.rowID;
      if (!selectedRows[row.tableID]) {
        selectedRows[row.tableID] = {rows: [], highestRow: row.rowID};
      }
      if (!selectedRows[row.tableID].rows.includes(row.vidID)) {
        selectedRows[row.tableID].rows.push(row.vidID);
      }
    });

    // A just-rendered or otherwise incomplete manifest should not prevent the
    // explicit series action. This synthetic entry is enough for refreshDetails
    // to reconstruct the same batch after the first save completes.
    if (Object.keys(selectedRows).length === 0) {
      selectedRows['series-edit'] = {rows: videoIDs, highestRow: null};
    }

    this.setState({selectedRows: selectedRows}, () => {
      this.showDetails(videoIDs, firstRowID, undefined, undefined, () => {
        this.showOpenablePane('editorPane');
      });
    });
  }

  showDetails(id, rowID, video, index, callback) { // video, index, and callback are optional
    // if (!this.state.detailsPaneShowing) {
    //   return;
    // }

    this.state.batchVids = null;
    // if the first parameter is an array of ids, we want to display
    // a special screen indicating that multiple videos are selected,
    // and also create a batchObject, which is basically a video object
    // which contains only the attributes every selected video has in common;
    // this object will be used to perform the batch edit
    if (Array.isArray(id)) {
      const vidIDs = id;
      console.log('SHOWING BATCH DETAILS PANE')
      // console.log(vidIDs);

      // store a list of videos to display to the user
      // in the details pane and the editor
      let batchVids = [];
      this.state.videos.map(v => {
        if (id.includes(v.id)) {
          batchVids.push(_.cloneDeep(v));
        }
      });

      // console.log(batchVids);

      // get an array of the videos themselves
      let videos = this.state.videos.filter(v => vidIDs.includes(v.id));
      // console.log(videos);

      // create the batch object
      let batchObject = {}
      validateVideo(batchObject); // this populates the object with all the right keys
      batchObject.id = 'batch'; // but set the id to 'batch' so that the editor knows what we're doing
      delete batchObject.metadata; // and delete metadata, since that is derived from the files themselves and is uneditable
      Object.keys(batchObject).map(key => {
        if (key === 'id' || key === 'metadata') return;
        // test each video's value for this key against that of the first video
        let testValue = videos[0][key];
        // loop through and test all the videos against that value
        // console.log('Testing ' + key);
        for (let i=1; i<videos.length; i++) {
          const value = videos[i][key];
          // if any one of them is different, return;
          // different keys require different equality tests;
          // if 'value' is an array, for instance,
          // we want to compare individual elements of the array
          // and keep only the ones that are in common,
          // even if the whole array isn't identical
          if (Array.isArray(testValue) && Array.isArray(value)) {
            testValue = testValue.filter(el => value.includes(el));
          } else if (typeof testValue === 'object' && testValue !== null && typeof value === 'object' && value !== null) {
            // if (!_.isEqual(value,testValue)) return;
            Object.keys(testValue).map(subProp => {
              if (value[subProp] !== testValue[subProp]) {
                testValue[subProp] = ''; // set to empty string instead of deleting, because the editor uses an empty string for an empty value
              }
            });
          } else {
            if (value !== testValue) return;
          }
        }
        // if we're here, the values for this key were the same in every video,
        // (or in the case of an array/object, testValue only contains elements all videos had in common)
        // so assign this value to the batch object
        batchObject[key] = testValue;
      });
      // `new` is not part of validateVideo's ordinary editable template. Add
      // its three-state batch summary explicitly so the checkbox reflects what
      // an untouched batch save will actually preserve.
      batchObject.new = batchNewState(videos);
      console.log(JSON.stringify(batchObject));

      this.setState({detailRowID: rowID, detailVideo: batchObject, batchVids: batchVids}, callback);
      return;
    } // end if (we have multiple videos)

    let detailVideo = null;
    if (video) {
      detailVideo = video;
    } else {
      try {
        detailVideo = this.state.filteredVideos.filter(v => v.id === id)[0]
      } catch (error) {
        console.log("Error: could not find video " + id)
      }
    }


    // save the row index of this video (for the incr/decr buttons to use)
    let rowIndex;
    if (typeof index !== "undefined") {
      rowIndex = index;
    } else {
      this.state.playlistRowManifest.map((row, i) => {
        if (row.rowID === rowID) rowIndex = i;
      });
    }
    // console.log("Video row index is " + rowIndex);


    // note if the video is the first or last video in the playlist (as currently sorted)
    // so that in the video editor, we can gray out the 'next' or 'previous' button
    let boundaryFlag = '';
    if (/*this.state.playlistRowManifest.length > 0 && */this.state.playlistRowManifest[0].rowID === rowID) boundaryFlag = 'first';
    if (/*this.state.playlistRowManifest.length > 0 && */this.state.playlistRowManifest[this.state.playlistRowManifest.length-1].rowID === rowID) boundaryFlag = 'last';

    this.setState({detailRowID: rowID, detailVideo: detailVideo, detailVideoRowIndex: rowIndex, detailRowBoundaryFlag: boundaryFlag}, callback);
  }

  // activated from a button in the editor pane,
  // moves to earlier/later video in playlist (depending on the amount param),
  // highlighting that row and showing it in the details pane,
  // and if the video editor is open, changing the video there too
  incrementDetailVid(amount) {
    console.log(`Going to ${amount == 1 ? 'NEXT' :( amount == -1 ? 'PREVIOUS' : 'SOME OTHER')} video`);

    console.log('******** playlistRowManifest: ');
    console.log(this.state.playlistRowManifest);
    console.log(`Current detail vid rowID: ${this.state.detailRowID}`);

    // first find index of the current detail vid in the playlistRowManifest;
    // even though we've already saved this in this.state.detailVideoRowIndex,
    // we want to check again in case the video moved (in case of a saved edit);
    // the only reason for saving it in state is in case it was edited out of 
    // the playlist entirely, in which case we still want to be able to
    // go to the next or prev video from where it used to be
    let index;
    this.state.playlistRowManifest.map((row,i) => {
      if (row.rowID === this.state.detailRowID) index = i;
    });
    if (typeof index === "undefined") {
      if (this.state.detailVideoRowIndex !== null && typeof this.state.detailVideoRowIndex !== "undefined") {
        index = this.state.detailVideoRowIndex;

        // so this little hack assumes that the video has disappeared from the playlist,
        // which is why we ended up in this 'if' block, in which case if we're incrementing,
        // we need to subtract from where we were in order to get to the next video;
        // we subtract <<amount>> instead of 1 because of batch editing, which is probably
        // the only scenario in which we would ever want to increment by more than 1
        if (amount > 0) {
          index -= amount;
        }
      } else {
        return console.error('Could not find current detail vid in manifest');
      }
    }

    this.goToRow(this.state.playlistRowManifest[index + amount]);

    // we could use the following lines instead of the above if we just wanted to hover it:
    // let row = this.state.playlistRowManifest[index + amount];
    // this.forceRowHover(row.vidID, row.rowID);
  }

  goToRow(row) {
    if (!row) return console.error('Could not find row to move to');

    // select the row that we are going to (instead of just hovering it)
    this.handleSelectedRows(row.vidID, row.rowID, row.tableID, true);

    // we could use the following line instead if we just wanted to hover it:
    // this.forceRowHover(row.vidID, row.rowID);
  }

  scrollToVideo(rowID) {
    let els = document.getElementsByClassName('movie-row ' + rowID);
    if (els && els.length > 0) {
      els[0].scrollIntoView();
    } else {
      console.log('Could not find table row to scroll to for ' + rowID);
    }
  }

  isElementOffScreen(el) {
    try {
      let rect = el.getBoundingClientRect();
      return (
           (rect.x + rect.width) < 0
        || (rect.y + rect.height) < 0
        || (rect.x > window.innerWidth || rect.y > window.innerHeight)
      );
    } catch(err) {
      console.error(err);
      return true;
    }
  }

  // tells if the table row for a given video id
  // is visible: i.e. it is within the viewport (not scrolled offscreen)
  // within the viewport (not scrolled offscreen)
  isRowVisible(rowID) {
    return false; // just until we get the rest of the infrastructure written

    // first find the row
    let row = null;
    try {
      row = document.getElementsByClassName('movie-row ' + rowID)[0];
    } catch(err) {
      console.log('Cannot tell if row is visible. Unable to find row for movie ' + rowID);
      return false;
    }

    // then test if it is scrolled out of view
    let inViewport = false;
    try {
      let boundary = document.getElementById('library-pane').getBoundingClientRect();
      let rect = row.getBoundingClientRect();
      if (rect.top < window.innerHeight || rect.bottom > boundary.top) {
        inViewport = true;
      }
    } catch(err) {
      console.error(err);
      inViewport = true; // if there was an error, set this to true, so the link doesn't appear
    }

    // then test if it or any of its parents is set to display:none
    let isNotHidden = row.offsetParent !== null;

    // return whether its scroll position is onscreen and it is not hidden
    return inViewport && isNotHidden;
  }

  // filter the movies we'll hand off to the table component
  // based on the given playlist
  playlistFilter(id) {
    let playlist;
    try {
      playlist = this.state.playlists.filter(playlist => playlist.id == id)[0]
    } catch(error) {
      console.error("Error: could not find playlist " + id + ", displaying first playlist")
      try {
        playlist = this.state.playlists[0] // display the first one
        id = playlist.id
      } catch(error) {
        console.error("Error: no playlists found, displaying nothing")
        playlist = { "filter_function" : "false", "id":-1 } // just display nothing
        id = playlist.id
      }
    }

    // I don't know how we ever get here after the above try blocks, but it happens when deleting an open playlist
    // so this is necessary to keep Mynda from crashing
    if (typeof playlist === "undefined") {
      playlist = this.state.playlists[0] // display the first one
      id = playlist.id
    }
    // console.log('playlistFilter() ' + playlist.name)

    let filteredVids = [];
    let showNew = playlist.id === 'new' || this.state.settings.preferences.include_new_vids_in_playlists;
    try {
      filteredVids = this.state.videos.filter(video => video && eval(playlist.filter_function) && (video.new ? showNew : true));
    } catch(err) {
      let name = playlist ? playlist.name : 'nonexistent';
      console.error(`Unable to execute filter for ${name} playlist: ${err}`);
    }

    if (playlist.id) {
      // update playlist length to trigger any components using this.state.playlistLength
      // (e.g. MynNav uses it to display the lengths of the playlists on the tabs)
      this.state.playlistLength[playlist.id] = filteredVids.length;
      this.setState({playlistLength:this.state.playlistLength});
    }

    return filteredVids;
  }

  // called from the nav component to change the current playlist
  setPlaylist(id,element) {
    // console.log('===== set playlist =====')
    // if (!element) {
    //   element = document.getElementById("playlist-" + id);
    // }

    // // if this playlist is one of the tabs, visually bring that tab to the front
    // if (element) {
    //   console.log('setting selected class................')
    //   Array.from(element.parentNode.children).map((child) => { child.classList.remove('selected') });
    //   element.classList.add('selected');
    // }

    // set the playlist, and erase any row selection from the previous playlist (only if we actually switched playlists)
    let videos = this.playlistFilter(id);
    let playlist
    try {
      playlist = this.state.playlists.filter(playlist => playlist && playlist.id == id)[0];
    } catch(e) {
      console.error("Error: could not find playlist " + id + ", setting to first playlist")
      try {
        playlist = this.state.playlists[0] // display the first one
        id = playlist.id
      } catch(e) {
        console.error("Error: no playlists found, displaying nothing")
        playlist = { "filter_function": "false", "id":-1 } // just display nothing
        id = playlist.id
      }
    }

    // I don't know how we ever get here after the above try blocks, but it happens when deleting an open playlist
    // so this is necessary to display a playlist afterwards instead of nothing
    if (typeof playlist === "undefined") {
      playlist = this.state.playlists[0] // display the first one
      id = playlist.id
    }

    let view = playlist && playlist.view === 'series' ? 'series' : 'flat';
    let columns = playlist ? playlist.columns : []; // set the columns state variable to this playlist's columns
    let flatDefaultSort = playlist ? playlist.flatDefaultSort : null; // default sort column for this playlist, but only applies when viewed in flat view
    if (id !== this.state.currentPlaylistID) {
      // only erase the selection if we've switched playlists;
      // if we haven't, we're just trying to refresh this playlist,
      // probably because some changes occurred in some of its videos,
      // e.g. the user edited a video/videos; if the user edited more than
      // one at a time, we want to preserve the selection so that we can
      // continue to display the batch editor for those selected videos
      this.setState({selectedRows : {}, detailVideo: null});
    }

    //
    let searchField = document.getElementById("search-input");
    if (searchField.value !== "") {
      this.state.playlistVideos = videos; // must set this prior to calling this.searchFilter so it only searches videos in this playlist
      this.setState({ playlistVideos: videos, filteredVideos: this.searchFilter(searchField.value), view: view, currentPlaylistID: id, flatDefaultSort: flatDefaultSort, columns: columns });
    } else {
      this.setState({ playlistVideos: videos, filteredVideos: videos, view: view, currentPlaylistID: id, flatDefaultSort: flatDefaultSort, columns: columns });
    }



    // reset the details pane
    // this line causes an error I don't understand yet
    // this.showDetails('hi','hihi');
  }

  // called when the search input is changed
  // change the filteredVideos state variable to those videos that match query
  search(e) {
    let query = "";
    if (e.target) {
      query = e.target.value;
    } else { // could be passed as an element instead of event
      query = e.value;
    }

    if (query != "") {
      // change the classes of the element to help with styling
      e.target.classList.add('filled');
      e.target.classList.remove('empty');

      // if the query is not empty, filter the videos
      this.setState({ filteredVideos : this.searchFilter(query) });
    } else {
      // change the classes of the element to help with styling
      e.target.classList.remove('filled');
      e.target.classList.add('empty');

      // if the field is empty, reset to the full playlist
      this.setPlaylist(this.state.currentPlaylistID);
    }
  }

  // set the lengths of all the playlists
  setPlaylistLengths(shy) {
    // if shy == true, then we only save the playlist lengths for ones we haven't saved already;
    // if it's falsy, then we overwrite all of them;
    this.state.playlists.map(pl => {
      if (pl.id && (!shy || typeof this.state.playlistLength[pl.id] === "undefined")) {
        // running the playlistFilter function will set the
        // value in this.state.playlistLength for that playlist
        this.playlistFilter(pl.id);
      }
    });
  }

  // filter videos in current playlist to match search query
  searchFilter(query) {
    // the below optimization might fail in the case of a copy-paste situation, so we need a more robust solution
    // // if a character is deleted, we need to search all the movies in the playlist again,
    // // but if a character is added, we only need to search the movies we've already filtered
    // const videos = query.length < this.state.prevQuery.length ? this.state.playlistVideos : this.state.filteredVideos;
    const videos = this.state.playlistVideos;
    return videos.filter((video) => {
      query = query.replace(/\s+/,' ').replace(/^\s|\s$/,''); // eliminate multiple white-space characters and leading/trailing whitespace
      const subQueries = query.split(' ');
      // console.log('search terms: ' + subQueries);

      queryLoop: for (let i=0; i<subQueries.length; i++) {
        let regex = new RegExp(subQueries[i],'i');
        let flag = false;

        // Object.keys(video).forEach((key) => {
        fieldLoop: for (const field in video) {
          switch(field) {
            // the first group of fields are just a simple string search
            case "title":
            case "year":
            case "director":
            case "description":
            case "genre":
              if (regex.test(video[field])) {
                flag = true;
                break fieldLoop;
              }
              break;
            // cast and tags are an array
            case "cast":
            case "tags":
              for(let i=0; i<video[field].length; i++) {
                if (regex.test(video[field])) {
                  flag = true;
                  break fieldLoop;
                }
              }
              break;
            // the remaining fields are ones we do not want to search
            default:
              break;
          } // end switch
        } // end fieldLoop

        // if the results are false on any of the query terms (sub-queries),
        // we want to return false
        if (flag == false) {
          return false;
        }
      } // end queryLoop

      // if we're here, all the search terms were found somewhere in this video
      // so return true
      return true;
    });
  }

  // id is optional; if not provided, will play the detailVideo
  // (this is normally what happens, when the user plays a video from a row)
  // if it is provided, find its row, select it, then play the video;
  async playVideo(id) {
    if (id) {
      let row = this.findVideoRows(id)[0];
      let vidID = id;
      if (row) {
        // we found a row of this video in the current playlist, so select that,
        // which will make it the detail vid, which will be played
        this.goToRow(row);
      } else {
        // we didn't find a row of this video in the current playlist,
        // so unselect all the rows in this playlist, and just
        // force the detail vid to be this video
        console.log(`Playing video from '${id}', but could not find row in current playlist, so just forcing the detail vid`);

        let video = this.state.videos.filter(v => v.id === vidID)[0];
        if (video) {
          await this.setState({detailVideo: video});
        } else {
          return console.error(`Could not play video; could not find video from '${id}' in library`);
        }
      }
    }

    this.showOpenablePane('playerPane');
  }

  // store the 5 most recently played videos
  logPlayed(id) {
    let recent = this.state.recentlyWatched;
    recent = recent.filter(v_id => v_id !== id); // delete this id if it's already in the array
    recent.unshift(id); // then add this id to the top of the list
    recent = recent.slice(0,10); // if the list is longer than 10 elements, clip it at 10
    this.setState({recentlyWatched:recent},() => {
      // then save to the library
      library.replace('recently_watched',recent);
    });
  }

  showOpenablePane(name,view) {
    // the view parameter may be passed to us to tell us which tab to display in panes with tabs (only 'settings' for now)
    if (view && name === 'settingsPane') {
      this.setState({settingsView:view});
    }

    // apply 'blurred' class to all other panes
    Array.from(document.getElementsByClassName('pane')).map((pane) => {
      pane.classList.add('blurred');
    });

    let show = _.cloneDeep(this.state.show);
    Object.keys(show).map(key => {show[key] = false});
    show[name] = true;
    this.setState({show:show});

  }

  hideOpenablePane(name) {
    // this.setState({openablePane:null});
    let show = _.cloneDeep(this.state.show);
    show[name] = false;
    this.setState({show:show});

    // remove 'blurred' class from all panes
    Array.from(document.getElementsByClassName('pane')).map((pane) => {
      pane.classList.remove('blurred');
    });

    if (name === 'settingsPane') {
      // reset the view of the settings tab so that next time it will open to the default tab
      this.setState({settingsView:this.state.defaultSettingsView});
    }
  }

  // set the initial playlist
  componentDidMount(props) {
    // this.loadLibrary();
    // let playlist = library.playlists[0];
    // this.setState({filteredVideos : this.playlistFilter(playlist.id), view : playlist.view})
    // this.setPlaylist(playlist.id, document.getElementById('nav-playlists').getElementsByTagName('li')[0]);

    // programmatically click on the first playlist
    try {
      document.getElementById('nav-playlists').getElementsByTagName('li')[0].click();
    } catch(e) {
      console.log("Error displaying first playlist: no playlists found? " + e.toString());
    }

    // set the lengths of all the playlists
    // (pass true to only set the ones that don't have values already)
    this.setPlaylistLengths(true);

    // used as a delay timer in savedPing the case of multiple saves,
    // where we want to wait until they're all done before doing something
    let timeout;

    // this callback function will be executed by Library.js every time
    // something is saved. So here we must take any actions necessary to update
    // the view in real time whenever that happens
    savedPing.saved = (address) => {
      console.log('MYNDA KNOWS WE SAVED!!!, address is ' + address);

      // if the whole media array was replaced at one time
      // (this happens when a watchfolder is removed or a batch is saved),
      // first put that replacement array into React state. setState() is
      // asynchronous, so rebuilding the playlist outside its callback would
      // make playlistFilter() read the old this.state.videos array and leave
      // the table showing stale data even though library.json was saved.
      if (address === 'media') {
        console.log('library.media was replaced. Refreshing videos');

        this.setState({videos:library.media}, () => {
          // Now playlistFilter(), the table, and the details/editor refresh all
          // read the newly saved videos rather than the pre-save references.
          this.setPlaylist(this.state.currentPlaylistID);
          this.setPlaylistLengths(true);
          this.refreshDetails(timeout);
        });
      } else if (address.includes('media')) {
        // A one-video save replaces an entry inside the existing media array,
        // so no parent-state handoff is needed before refreshing its consumers.
        console.log('a video was edited');
        this.setPlaylist(this.state.currentPlaylistID);
        this.setPlaylistLengths(true);
        this.refreshDetails(timeout);
      }

      // if a playlist was changed
      if (address.includes('playlists')) {
        // // change the playlistEditFlag, which components can listen for to find out if a video was edited
        // // (if they don't care which one or what the change was)
        // this.setState({playlistEditFlag:uuidv4()});

        console.log('a playlist was edited');
        // reload the playlists, and then re-render the current playlist
        this.setState({playlists:this.props.library.playlists}, () => {

          this.setPlaylist(this.state.currentPlaylistID);

          // check all the playlist lengths (pass true to skip the one we just set above)
          this.setPlaylistLengths(true);
        });
      }

      // if the settings were changed
      if (address.includes('settings')) {
        console.log('settings was edited');
        this.setState({settings : this.props.library.settings}, () => {
          // if (address === 'settings.preferences.defaultcolumns') {
          //
          // }

          // if the user changed the pref for including the user rating in the average rating calculation
          // if (address === 'settings.preferences.include_user_rating_in_avg') {
          //   console.log('HEEYYYYYY, USER RATING IN AVG SETTING CHANGED')
          //   // first test if the current playlist displays the average;
          //   // if it doesn't, we don't need to do anything
          //   let currentPlaylist = this.state.playlists.filter(p => p.id === this.state.currentPlaylistID)[0];
          //   console.log('current playlist: ' + JSON.stringify(currentPlaylist));
          //   if (currentPlaylist && currentPlaylist.columns.includes('ratings_avg')) {
          //     console.log('resetting playlist!')
          //     // if it does, reload the playlist
          //     this.setPlaylist(this.state.currentPlaylistID);
          //   }
          // }

          if (address === 'settings.preferences.include_new_vids_in_playlists'){
            this.setPlaylistLengths();
          }
        });
      }
    };
  }

  // REFRESH DETAILS PANE
  refreshDetails(timeout) {
    console.log('Refreshing Details');
    if (this.state.detailVideo) {
      if (this.state.detailVideo.id !== 'batch') {
        this.setState({detailVideo : this.state.videos.filter(video => video && video.id === this.state.detailVideo.id)[0]});
      } else {
        // if the detailVideo id is 'batch', that means multiple rows are selected;
        // calling handleSelectedRows with no parameters will reset the details pane and the editor
        // to correspond appropriately to the selected rows (without adding any new rows)
        clearTimeout(timeout);
        timeout = setTimeout(() => {console.log('TIMEOUT FIRED, UPDATING BATCH VID');this.handleSelectedRows()},500);
      }
    }
  }

  componentDidUpdate(oldProps) {
    // console.log('UPDATING MYNDA');
    // console.log('lastUpdate: ' + this.props.lastUpdate);
    // // console.log('results: ' + this.state.filteredVideos.map((video) => video.title));
    // if (oldProps.lastUpdate !== this.props.lastUpdate) {
    //   console.log('Mynda props.library.media changed!!!');
    //   this.setPlaylist(this.state.currentPlaylistID);
    // }
  }

  render () {
    return (
      <div id='grid-container'>
        <ErrorBoundary>
          <MynNav
            playlists={this.state.playlists}
            currentPlaylistID={this.state.currentPlaylistID}
            setPlaylist={this.setPlaylist}
            search={this.search}
            showSettings={(view) => {this.showOpenablePane("settingsPane",view)}}
            playlistLength={this.state.playlistLength}
            toggleDetailsPane={this.toggleDetailsPane}
            detailsPaneShowing={this.state.detailsPaneShowing}
          />
        </ErrorBoundary>
        <ErrorBoundary>
          <MynLibrary
            videos={this.state.filteredVideos}
            settings={this.state.settings}
            playlistID={this.state.currentPlaylistID}
            view={this.state.view}
            flatDefaultSort={this.state.flatDefaultSort}
            columns={this.state.columns}
            displayColumnName={this.displayColumnName}
            calcAvgRatings={this.calcAvgRatings}
            playVideo={this.playVideo}
            handleSelectedRows={this.handleSelectedRows}
            handleHoveredRow={this.handleHoveredRow}
            editSeries={this.editSeries}
            selectedRows={this.state.selectedRows}
            reportSortedManifest={this.reportSortedManifest}
            recentlyWatched={this.state.recentlyWatched}
          />
        </ErrorBoundary>
        <ErrorBoundary>
          { this.state.detailsPaneShowing ? 
            (<MynDetails
              video={this.state.detailVideo}
              rowID={this.state.detailRowID}
              settings={this.state.settings}
              showEditor={() => {this.showOpenablePane("editorPane")}}
              scrollToVideo={this.scrollToVideo}
              isRowVisible={this.isRowVisible}
            />)
          : null
          }
        </ErrorBoundary>
        <ErrorBoundary>
          <MynNotify
            settings={this.state.settings}
          />
        </ErrorBoundary>
        <MynSettings
          show={this.state.show.settingsPane}
          view={this.state.settingsView}
          settings={this.state.settings}
          videos={this.state.videos}
          playlists={this.state.playlists}
          displayColumnName={this.displayColumnName}
          hideFunction={() => {this.hideOpenablePane('settingsPane')}}
        />
        <MynEditor
          show={this.state.show.editorPane}
          video={this.state.detailVideo}
          batch={this.state.batchVids}
          settings={this.state.settings}
          hideFunction={() => {this.hideOpenablePane('editorPane')}}
          goToPrevious={() => this.incrementDetailVid(-1)}
          goToNext={() => this.incrementDetailVid(1)}
          detailRowBoundaryFlag={this.state.detailRowBoundaryFlag}
        />
        <MynPlayer
          show={this.state.show.playerPane}
          video={this.state.detailVideo}
          logPlayed={this.logPlayed}
          hideFunction={() => {this.hideOpenablePane('playerPane')}}
        />
      </div>
    );
  }
}

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

// ###### Library Pane: displays either a flat table or tables grouped by series ###### //
class MynLibrary extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      compact: false
    }
    this.manifest = {};
    this.manifestPlaylistID = props.playlistID;
    this.manifestVideos = props.videos;

    this.reportSortedManifest = this.reportSortedManifest.bind(this);
    this.toggleCompact = this.toggleCompact.bind(this);
  }

  shouldComponentUpdate(nextProps, nextState) {
    const oldPropKeys = Object.keys(this.props);
    const nextPropKeys = Object.keys(nextProps);
    const propsChanged = oldPropKeys.length !== nextPropKeys.length ||
      nextPropKeys.some(key => nextProps[key] !== this.props[key]);
    const stateChanged = nextState !== this.state;

    return propsChanged || stateChanged;
  }

  reportSortedManifest(tableID, rows, tableOrder = 0) {
    if (rows.length === 0) {
      delete this.manifest[tableID];
    } else {
      this.manifest[tableID] = {rows: rows, order: tableOrder};
    }

    const sortedManifest = Object.values(this.manifest)
      .sort((a,b) => a.order - b.order)
      .reduce((allRows, table) => [...allRows, ...table.rows], []);

    this.props.reportSortedManifest(sortedManifest);
  }

  toggleCompact() {
    this.setState({compact: !this.state.compact});
  }

  render() {
    let tables = null;

    if (this.manifestPlaylistID !== this.props.playlistID || this.manifestVideos !== this.props.videos) {
      this.manifest = {};
      this.manifestPlaylistID = this.props.playlistID;
      this.manifestVideos = this.props.videos;
    }

    if (this.props.view === "series") {
      tables = (
        <div id="series-container">
          <MynLibSeries
            key={this.props.playlistID}
            videos={this.props.videos}
            settings={this.props.settings}
            playlistID={this.props.playlistID}
            view={this.props.view}
            flatDefaultSort={this.props.flatDefaultSort}
            columns={this.props.columns}
            displayColumnName={this.props.displayColumnName}
            calcAvgRatings={this.props.calcAvgRatings}
            showDetails={this.props.showDetails}
            playVideo={this.props.playVideo}
            handleSelectedRows={this.props.handleSelectedRows}
            handleHoveredRow={this.props.handleHoveredRow}
            editSeries={this.props.editSeries}
            selectedRows={this.props.selectedRows}
            reportSortedManifest={this.reportSortedManifest}
            compact={this.state.compact}
          />
        </div>
      );
    } else if (this.props.view === "flat") {
      tables = (
        <MynLibTable
          tableID="table"
          tableOrder={0}
          movies={this.props.videos}
          settings={this.props.settings}
          playlistID={this.props.playlistID}
          view={this.props.view}
          flatDefaultSort={this.props.flatDefaultSort}
          columns={this.props.columns}
          displayColumnName={this.props.displayColumnName}
          calcAvgRatings={this.props.calcAvgRatings}
          showDetails={this.props.showDetails}
          playVideo={this.props.playVideo}
          handleSelectedRows={this.props.handleSelectedRows}
          handleHoveredRow={this.props.handleHoveredRow}
          selectedRows={this.props.selectedRows}
          reportSortedManifest={this.reportSortedManifest}
          compact={this.state.compact}
        />
      );
    } else {
      console.log('Playlist has bad "view" parameter ("' + this.props.view + '"). Should be "flat" or "series"');
      return null;
    }

    let playlist;
    try {
      playlist = library.playlists.filter(p => p.id === this.props.playlistID)[0];
    } catch(err) {}

    return (
      <div id="library-pane" className="pane">
        <MynPlaylistBar
          playlist={playlist}
          view={this.props.view}
          recentlyWatched={this.props.recentlyWatched}
          playVideo={this.props.playVideo}
          toggleCompact={this.toggleCompact}
          compact={this.state.compact}
        />
        {tables}
      </div>
    );
  }
}

class MynLibSeries extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      manifest: {},
      columns: _.cloneDeep(props.columns),
      collapsed: {}
    }
  }

  createManifest() {
    this.state.manifest = {};

    // loop through all the videos in this playlist and add them to the manifest
    this.props.videos.map((video) => {
      if (video.series) {
        let series = video.series;
        let season = "none";
        if (video.season) {
          season = '' + video.season;
        }

        // create series object
        if (!this.state.manifest.hasOwnProperty(series)) {
          this.state.manifest[series] = {};

          // A changed video object causes this manifest to be rebuilt even
          // though the user is still viewing the same playlist—for example,
          // immediately after saving an edit. Initialize only genuinely new
          // series as collapsed so existing series retain the expansion state
          // the user chose before that re-render. MynLibrary keys this entire
          // component by playlist ID, so leaving the playlist still discards
          // this state and returning starts with every series collapsed.
          if (!Object.prototype.hasOwnProperty.call(this.state.collapsed, series)) {
            this.state.collapsed[series] = true;
          }
        }

        // create season array
        if (!this.state.manifest[series].hasOwnProperty(season)) {
          this.state.manifest[series][season] = [];
        }

        // add video to series and season (we don't need to worry about episode, since we'll simply have the table sort each season by episode number)
        this.state.manifest[series][season].push(video);
      }
    });

    // this.setState({manifest: this.state.manifest});
  }

  // expand or collapse a series
  toggleExpansion(series) {
    // Keep expansion in React state instead of changing the rendered DOM by
    // hand. That makes this state the authoritative value used both for the
    // immediate click and for any later re-render caused by edited video data.
    this.setState(previousState => ({
      collapsed: {
        ...previousState.collapsed,
        [series]: !previousState.collapsed[series]
      }
    }));
  }

  addEpisodeToColumns() {
    if (!this.state.columns.includes('episode')) {
      this.state.columns.unshift('episode');
    }
    return this.state.columns;
  }

  componentDidMount() {
    this.createManifest();
    this.setState({columns: this.addEpisodeToColumns()});
  }

  componentDidUpdate(oldProps) {
    let needsRender = false;

    if (!_.isEqual(this.props.columns,oldProps.columns)) {
      this.state.columns = _.cloneDeep(this.props.columns);
      this.addEpisodeToColumns();
      needsRender = true;
    }

    if (!_.isEqual(this.props.videos, oldProps.videos)) {
      this.createManifest();
      needsRender = true;
    }

    if (needsRender) {
      this.setState({columns:this.state.columns, manifest:this.state.manifest});
    }
  }

  render() {
    // sort the series alphabetically
    let seriesKeys = Object.keys(this.state.manifest);
    seriesKeys.sort();
    // (a,b) => { // (not working for some reason)
    //   a = a.replace(/^(?:a\s|an\s|the\s)/i, "");
    //   b = b.replace(/^(?:a\s|an\s|the\s)/i, "");
    //   return a > b ? 1 : (a < b ? -1 : 0);
    // });

    // go through the manifest and create a table for each season
    let tableOrder = 0;
    let JSX = seriesKeys.map(series => {

      // sort the seasons by season number in ascending order
      let seasons = Object.keys(this.state.manifest[series]);
      seasons.sort((a,b) => {
        const seasonSortValue = season => {
          const number = parseFloat(season);
          if (!Number.isNaN(number)) return number;
          if (season === 'extras') return Number.MAX_SAFE_INTEGER-1;
          return Number.MAX_SAFE_INTEGER;
        };
        return seasonSortValue(a) - seasonSortValue(b);
      });

      let seriesJSX = seasons.map(season => {
        let seasonVideos = this.state.manifest[series][season];
        let tableID = `${series}.${season}`;
        let thisTableOrder = tableOrder++;

        return (
          <div className="season" key={tableID}>
            <h2 className="season-header">{season === 'none' ? '[No Season]' : (season === 'extras' ? 'Extras' : `Season ${season}`)}</h2>
            <MynLibTable
              tableID={tableID}
              tableOrder={thisTableOrder}
              movies={seasonVideos}
              settings={this.props.settings}
              playlistID={this.props.playlistID}
              view={this.props.view}
              flatDefaultSort={season === 'extras' ? 'title' : 'episode'}
              columns={this.state.columns}
              displayColumnName={this.props.displayColumnName}
              calcAvgRatings={this.props.calcAvgRatings}
              showDetails={this.props.showDetails}
              playVideo={this.props.playVideo}
              handleSelectedRows={this.props.handleSelectedRows}
              handleHoveredRow={this.props.handleHoveredRow}
              selectedRows={this.props.selectedRows}
              reportSortedManifest={this.props.reportSortedManifest}
              compact={this.props.compact}
            />
          </div>
        );
      });

      // Flatten the season buckets only for this header action. The same
      // video objects are handed to Mynda, which converts them into the batch
      // editor's normal ID-based selection without changing their sort order.
      const seriesVideos = seasons.reduce(
        (allVideos, season) => allVideos.concat(this.state.manifest[series][season]),
        []
      );

      return (
        <div className={"series " + (this.state.collapsed[series] ? "collapsed" : "expanded")} key={series}>
          <h1 className={"series-header " + (this.props.compact ? 'compact' : '')} onClick={() => this.toggleExpansion(series)}>
            <span className="series-header-title">{series}</span>
            <button
              type="button"
              className="series-edit-button"
              title={`Edit all ${seriesVideos.length} video${seriesVideos.length === 1 ? '' : 's'} in ${series}`}
              onClick={(event) => {
                // The header itself expands/collapses the series. Do not let
                // an Edit click also toggle that unrelated state.
                event.stopPropagation();
                this.props.editSeries(seriesVideos);
              }}
            >
              Edit
            </button>
          </h1>
          <div className={"seasons-container " + (this.state.collapsed[series] ? "hidden" : "")}>
            {seriesJSX}
          </div>
        </div>
      );

    });

    return JSX;
  }
}

class MynPlaylistBar extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      autotagRunning: false,
      autotagCancelRequested: false
    }

    this.handleAutoTagStatus = (event, status) => {
      if (status.action === 'autotag') {
        this.setState({
          autotagRunning: true,
          autotagCancelRequested: Boolean(status.cancelRequested)
        });
      } else if (status.action === '') {
        this.setState({
          autotagRunning: false,
          autotagCancelRequested: false
        });
      }
    };
  }

  autotag(e) {
    ipcRenderer.send('autotag');
  }

  cancelAutotag(e) {
    ipcRenderer.send('autotag-cancel');
  }

  componentDidMount() {
    ipcRenderer.on('status-update', this.handleAutoTagStatus);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('status-update', this.handleAutoTagStatus);
  }

  changeView(view) {
    library.replace(`playlists.id=${this.props.playlist.id}`,{...this.props.playlist,view:view});
  }

  render() {
    if (typeof this.props.playlist === "undefined") return null;

    let autotagButton = null;
    if (this.state.autotagRunning) {
      autotagButton = (
        <button
          className="pb-element autotag cancel"
          onClick={this.cancelAutotag.bind(this)}
          disabled={this.state.autotagCancelRequested}
          title="Stop Auto-Tag after the current video finishes"
        >
          {this.state.autotagCancelRequested ? 'Canceling...' : 'Cancel Auto-Tag'}
        </button>
      );
    } else if (this.props.playlist.id === 'new') {
      autotagButton = <button className="pb-element autotag" onClick={this.autotag.bind(this)} title="Run auto-tagging on all new videos; has no effect on videos not in the 'New' playlist">Auto-tag</button>;
    }

    return (
      <div className="playlist-bar">

        <div className="pb-element recent">
          <div className="pb-text">Recently Viewed:</div>
          <MynRecentlyWatched list={this.props.recentlyWatched} selected={0} playVideo={this.props.playVideo} />
        </div>

        <button className="pb-element compact" onClick={(e) => this.props.toggleCompact()}>{this.props.compact ? 'Large' : 'Compact'}</button>

        <div className="pb-element view">
          <div className="pb-text">View:</div>
          <div className="select-container select-alwaysicon">
            <select value={this.props.view} onChange={(e) => this.changeView(e.target.value)}>
              <option value='flat'>Flat</option>
              <option value='series'>Series</option>
            </select>
          </div>
        </div>

        {autotagButton}
      </div>
    );
  }
}

// ###### Table: contains list of movies in the selected playlist ###### //
class MynLibTable extends React.Component {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.tableID = this.props.tableID || 'table';

    this.clickTimer = null;

    this.state = {
      tHeadContent: null,
      tBodyContent: null,
      sortKey: null,
      sortAscending: true,
      sortedRows: [],
      batchSelected: [],
      rowID: (vidID) => vidID,
      shiftDown: false,
      ctrlDown: false,
      include_user_rating_in_avg: props.settings.preferences.include_user_rating_in_avg
    }

    // this.keyDown = this.keyDown.bind(this);
    // this.keyUp = this.keyUp.bind(this);
    this.requestSort = this.requestSort.bind(this);
    this.render = this.render.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.componentDidUpdate = this.componentDidUpdate.bind(this);
  }

  keyDown(e) {
    if (!this._isMounted) return;

    // SHIFT
    if (e.keyCode === 16) {
      this.setState({shiftDown : true});
    }
    // CTRL if not MacOS, CMD if MacOS
    if ((os.platform() !== 'darwin' && e.keyCode === 17) || (os.platform() === 'darwin' && e.metaKey)) {
      this.setState({ctrlDown : true});
    }
  }

  keyUp(e) {
    if (!this._isMounted) return;

    // SHIFT
    if (e.keyCode === 16) {
      this.setState({shiftDown : false});
    }
    // CTRL if not MacOS, CMD if MacOS
    if ((os.platform() !== 'darwin' && e.keyCode === 17) || (os.platform() === 'darwin' && !e.metaKey)) {
      this.setState({ctrlDown : false});
    }
  }

  rowHovered(video, rowID, index, e) {
    // show details in details pane on hovering a row
    // except if a row has been locked (because then we want that video's details
    // to persist in the details pane until it's unlocked), or if multiple
    // videos have been selected (in which case we will show a special batch-edit
    // screen in the details pane)
    // if (!this.state.batchSelected || this.state.batchSelected.length === 0) {
      this.props.handleHoveredRow(video, rowID, index);
    // }
  }

  rowOut(id, rowID, e) {
    // hide details in details pane
    // this.props.showDetails(null, e);
  }

  // if there was a single click on the row, select the row;
  // if there was a double click, play the video
  rowClick(id, rowID, index, e) {
    let target = e.target;
    // clear the click timer; we're no longer setting a timer in this function,
    // but rowSelect() is using it when unselecting the clicked row
    // (when it's the only one already selected); because in that case
    // a double click should not unselect the row;
    clearTimeout(this.clickTimer);

    // single click, or click with mod keys: normal row selection
    if (e.detail === 1 || this.state.shiftDown || this.state.ctrlDown) {
      // this.clickTimer = setTimeout(() => this.rowSelect(id, rowID, index, target), 0);
      this.rowSelect(id, rowID, index, target)

    // double click with no mod keys: play video and select row
    } else if (e.detail === 2 && !this.state.shiftDown && !this.state.ctrlDown) {
      this.rowSelect(id, rowID, index, target, true); // 'true' forces the row to be selected; otherwise, if it was already (the only row) selected, clicking on it would unselect it

      console.log('PLAYING VIDEO!');
      this.props.playVideo();
    }
  }

  // select one or multiple rows (through the use of modifier keys)
  // when selected, the user can batch edit videos;
  // eventually, we'd like to enable batch drag n' drop as well
  rowSelect(id, rowID, index, target, forceSelect) {
    // console.log(`TABLE ${this.tableID} REGISTERED A CLICK`);
    const row = findNearestOfClass(target,'movie-row');

    // if the user clicks on a row with a modifier key pressed
    // (either shift or ctrl/cmd), we create/modify the selection of multiple videos
    if (this.state.shiftDown || this.state.ctrlDown) {

      // if shift is pressed, then we want to select all the videos between
      // two rows that were clicked (including the clicked ones);
      // we do this by using the nearest selected row as an anchor
      // and the new click as the second click, highlighting all the videos in between;
      // and if there is no other selected row, we just select the row
      // that was clicked on by itself
      if (this.state.shiftDown) {
        // find the index of the clicked row (end) and the nearest already-selected row (start)
        let end = index;
        let start;
        let selectedIndices = [];
        // get the indices of every selected row
        for (let i=0; i<this.state.sortedRows.length; i++) {
          if (this.state.batchSelected.includes(this.state.sortedRows[i].vidID)) {
            selectedIndices.push(i);
          }
        }

        // use the selectedIndices array to pick the closest video
        // that's already selected and use that as the start point
        let minDiff = this.state.sortedRows.length;
        let minDiffIndex;
        for (let i of selectedIndices) {
          let diff = Math.abs(end - i);
          if (diff < minDiff) {
            minDiff = diff;
            minDiffIndex = i;
          }
        }
        if (typeof minDiffIndex != "undefined") {
          start = minDiffIndex;
        } else {
          // if we're here, there were no previously selected videos,
          // so we set 'start' to the same as 'end', which will just
          // select only the video that was clicked on
          start = end;
        }

        // if (this.state.shiftDown) console.log(`SHIFT CLICKED FROM (INDEX) ${start} TO ${end}`);
        // if (this.state.ctrlDown) console.log(`CTRL CLICKED FROM (INDEX) ${start} TO ${end}`);

        // get a list of the actual videos being selected
        // and select them
        let selectedVids = []
        let low = start < end ? start : end;
        let high = start < end ? end : start;
        for (let i = low; i <= high; i++) {
          selectedVids.push(this.state.sortedRows[i].vidID);
        }
        this.setState({batchSelected:selectedVids},this.handleBatch);
        // console.log(`SELECTED VIDEOS: ${selectedVids}`);
      }

      // if ctrl/cmd was pressed, but NOT shift,
      // then we add or subtract the individual row clicked on
      // from any previously selected videos
      else if (this.state.ctrlDown) {
        let selectedVids = _.cloneDeep(this.state.batchSelected);
        if (this.state.batchSelected.includes(id)) {
          selectedVids = selectedVids.filter(vID => vID !== id);
        } else {
          // console.log("ADDING " + id)
          selectedVids.push(id);
        }
        this.setState({batchSelected:selectedVids},this.handleBatch);
      }


      // no modifier keys were pressed
    } else {
      // if there is only one video selected and this is the one we've clicked on,
      // we actually want to unselect it, UNLESS forceSelect is true
      if (!forceSelect && this.state.batchSelected.length === 1 && this.state.batchSelected[0] === id) {
        // erase any previous batch selection
        // but put it on a timeout, because if the user double clicked,
        // the row will be reselected (with forceSelect == true);
        // so that would work just fine without the timeout,
        // but it's ugly (and maybe confusing) for the row to get unselected and
        // then reselected on the second click. This way, it just stays selected
        // if there's a double click
        this.clickTimer = setTimeout(() => {
          this.setState({batchSelected:[]},() => this.handleBatch(true));
        },150);

      } else {
        // if we're here, either multiple rows, a different row, or no row was already selected,
        // (or this row was selected but forceSelect was true)
        // and neither 'shift' nor 'cmd/ctrl' was being pressed,
        // so we want to erase any previous batch selection,
        // selecting only the row that was clicked on
        let selectedVids = [];
        selectedVids.push(id)
        this.setState({batchSelected:selectedVids},() => this.handleBatch(true));
      }
    }

  }

  // called when the selection is changed;
  // if 'overwrite' is true, then we tell the Mynda component
  // to overwrite any rows previously selected by other tables;
  // otherwise, we simply want to add this batch to any existing batches
  // (for example, from other season tables in the series view)
  handleBatch(overwrite) {
    // first, add the 'selected' class to all the selected rows
    Array.from(document.getElementById(this.tableID).getElementsByClassName('movie-row')).map(row => {
      // console.log(row.getAttribute('vid_id'));
      if (this.state.batchSelected.includes(row.getAttribute('vid_id'))) {
        row.classList.add('selected');
      } else {
        // console.log(`REMOVING SELECTED CLASS FROM ${row.id}`)
        row.classList.remove('selected');
      }
    });

    // find a rowID to pass to the details pane, so that it can
    // populate its "jump to row" link. When multiple rows are selected,
    // we simply find the highest selected row in the table
    // (i.e. the row with the lowest index)
    let firstVid;
    let lowestIndex = this.state.sortedRows.length;
    for (let id of this.state.batchSelected) {
      for (let i=0; i<lowestIndex; i++) {
        if (this.state.sortedRows[i].vidID === id) {
          lowestIndex = i;
          firstVid = id;
          break;
        }
      }
    }
    let firstRow = firstVid ? this.state.rowID(firstVid) : null;

    // then we pass upwards the list of selected videos
    this.props.handleSelectedRows(_.cloneDeep(this.state.batchSelected),firstRow,this.tableID,overwrite);
  }

  requestSort(key, ascending) {
    console.log(`SORTING TABLE ${this.tableID} by ${key}`);

    if (key === undefined) {
      throw "Error: key was undefined; must supply a key to sort by";
    }

    // if the user clicked on the same column that was previously sorted by,
    // then we override the defaults and just reverse the sort direction of the previous sort
    // (unless we're explicitly told which direction to sort by)
    if (this.state.sortKey === key && ascending === undefined) {
      ascending = !this.state.sortAscending;
    }

    if (ascending === undefined) {
      // the default direction of a sort is ascending
      ascending = true;

      // except for the following fields, which should have a default sort direction of descending
      let descendingFields = ['ratings_user','ratings_imdb','ratings_rt','ratings_mc','ratings_avg','dateadded','lastseen'];
      if (descendingFields.includes(key)) {
        ascending = false;
      }
    }

    let ratedOrder = {
        'G':        0,
        'TV-G':     1,
        'TV-Y':     2,
        'TV-Y7':    3,
        'PG':       4,
        'TV-PG':    5,
        'PG-13':    6,
        'TV-14':    7,
        'R':        8,
        'TV-MA':    9,
        'NC-17':    10,
        'X':        11,
        'Not Rated':12,
        'N/A':      13
      };

    let sortItems = {
     title: (a, b) => [this.removeArticle(a.title).toLowerCase(),this.removeArticle(b.title).toLowerCase()],
     year: (a, b) => [a.year,b.year],
     director: (a, b) => {let a_ds = a.directorsort === '' ? a.director : a.directorsort; let b_ds = b.directorsort === '' ? b.director : b.directorsort; return [a_ds.toLowerCase(), b_ds.toLowerCase()]},
     genre: (a, b) => [a.genre.toLowerCase(), b.genre.toLowerCase()],
     seen: (a, b) => [a.seen, b.seen],
     ratings_user: (a, b) => {let a_r = a.ratings.user || -1; let b_r = b.ratings.user || -1; return [a_r, b_r];},
     dateadded: (a, b) => {let a_added = isNaN(parseInt(a.dateadded)) ? -1 : parseInt(a.dateadded); let b_added = isNaN(parseInt(b.dateadded)) ? -1 : parseInt(b.dateadded); return [a_added, b_added];},
     kind: (a, b) => [a.kind.toLowerCase(), b.kind.toLowerCase()],
     lastseen: (a, b) => {let a_ls = isNaN(parseInt(a.lastseen)) ? -1 : parseInt(a.lastseen); let b_ls = isNaN(parseInt(b.lastseen)) ? -1 : parseInt(b.lastseen); return [a_ls, b_ls];},
     ratings_rt: (a, b) => {let a_r = a.ratings.rt ? a.ratings.rt : -1; let b_r = b.ratings.rt ? b.ratings.rt : -1; return [a_r, b_r]},
     ratings_imdb: (a, b) => {let a_r = a.ratings.imdb ? a.ratings.imdb : -1; let b_r = b.ratings.imdb ? b.ratings.imdb : -1; return [a_r, b_r]},
     ratings_mc: (a, b) => {let a_r = a.ratings.mc ? a.ratings.mc : -1; let b_r = b.ratings.mc ? b.ratings.mc : -1; return [a_r, b_r]},
     ratings_avg: (a, b) => [this.props.calcAvgRatings(a.ratings,'sort'), this.props.calcAvgRatings(b.ratings,'sort')],
     boxoffice: (a, b) => [a.boxoffice === 0 ? -1 : a.boxoffice, b.boxoffice === 0 ? -1 : b.boxoffice],
     rated: (a, b) => [ratedOrder[a.rated.toUpperCase()], ratedOrder[b.rated.toUpperCase()]],
     country: (a, b) => [a.country.toLowerCase(), b.country.toLowerCase()],
     languages: (a, b) => [(a.languages[0] || '').toLowerCase(), (b.languages[0] || '').toLowerCase()],
     duration: (a, b) => [a.metadata ? parseInt(a.metadata.duration)-1 : null, b.metadata ? parseInt(b.metadata.duration)-1 : null], // - 1 because we use 0 when we don't have a duration, but the sort function doesn't treat 0 as empty (it does treat -1 as empty);
     resolution: (a, b) => [parseInt(a.metadata.width),parseInt(b.metadata.width)],
     episode: (a,b) => [parseFloat(a.episode),parseFloat(b.episode)],
    }

    console.log('this.props.movies.length === ' + this.props.movies.length);

    let rows = this.props.movies.sort((vid_a, vid_b) => {

      // get the video attributes to sort by
      let a,b;
      try {
        [a,b] = sortItems[key](vid_a, vid_b);
      } catch(err) {
        a = vid_a[key];
        b = vid_b[key];
      }

      // we want empty values to always appear at the bottom,
      // whether we're sorting by ascending or descending
      // so if a or b is empty, send it to the bottom, ignoring sort direction
      let isEmpty = n => n === -1 || n === '' || n === null || (typeof n === 'number' && isNaN(n)) || typeof n === 'undefined';
      if (isEmpty(a) && !isEmpty(b)) {
        return 1;
      } else if (!isEmpty(a) && isEmpty(b)) {
        return -1;
      } else if (isEmpty(a) && isEmpty(b)) {
        return 0;
      }

      // otherwise, do a normal comparison, and respect sort direction
      let result = a > b ? 1 : (a < b ? -1 : 0);
      result *= ascending ? 1 : -1;


      return result;
    }).map((movie, index) => {

      let row = {
        index:index,
        rowID:this.state.rowID(movie.id),
        vidID:movie.id,
        vidTitle:movie.title,
        tableID:this.tableID
      };

      // THE BELOW MAY NOT BE NECESSARY
      // include the 'selected' class if this row is selected
      // let selected = ''//(this.props.selectedRows[this.tableID] && this.props.selectedRows[this.tableID].rows && this.props.selectedRows[this.tableID].rows.includes(video.id.toString())) ? ' selected' : '';
      // console.log(`Row for video ${video.id} in table ${this.tableID} class: ${selected}`);
      let rowID = this.state.rowID(movie.id);

      let rowJSX = (
        <MynLibTableRow
          key={movie.id}
          video={movie}
          index={index}
          rowID={rowID}
          settings={this.props.settings}
          calcAvgRatings={this.props.calcAvgRatings}
          columns={this.props.columns}
          rowHovered={(...args) => this.rowHovered(...args)}
          rowOut={(...args) => this.rowOut(...args)}
          rowClick={(...args) => this.rowClick(...args)}
        />
      );
      row.jsx = rowJSX;

      return row;
    });

    // set the sort state in state
    // this.setState({ sortKey: key, sortAscending: ascending , sortedRows: rows});
    // since we don't need to trigger a re-render here,
    // and we need these changes to happen synchronously,
    // we don't use setState
    // this.state = {...this.state, sortKey: key, sortAscending: ascending , sortedRows: rows};
    this.state.sortKey = key;
    this.state.sortAscending = ascending;
    this.state.sortedRows = rows;

    console.log("...finished sorting");
  }

  // Sort the rows and rebuild the table content.
  reset(sortValue) {
    console.log("======== MynLibTable RESET WAS CALLED ========");

    if (sortValue === "initial-sort" || this.state.sortKey === null) {
      this.state.sortKey = null;
      if (this.props.flatDefaultSort && this.props.columns.includes(this.props.flatDefaultSort)) {
        this.requestSort(this.props.flatDefaultSort);
      } else {
        this.requestSort('title');
      }
    } else if (this.props.columns.includes(sortValue)) {
      this.requestSort(sortValue);
    } else {
      this.requestSort(this.state.sortKey, this.state.sortAscending);
    }

    this.props.reportSortedManifest(
      this.tableID,
      this.state.sortedRows,
      this.props.tableOrder || 0
    );

    let tBodyContent = this.state.sortedRows.map(row => row.jsx);
    let tHeadContent = (
      <tr id="main-table-header-row">
        {this.props.columns.map(col => (
          <th key={col} className={col} onClick={() => this.reset(col)}>{this.props.displayColumnName(col)}</th>
        ))}
      </tr>
    );

    this.setState({tBodyContent:tBodyContent, tHeadContent:tHeadContent});
  }

  removeArticle(string) {
    if (typeof string !== 'string') return string;
    return string.replace(/^(?:a\s|an\s|the\s)/i,"")
  }


  componentDidUpdate(oldProps) {
    // let propsDiff = getObjectDiff(oldProps,this.props);
    // if (propsDiff.length === 0) return;
    // console.log(Date.now());

    // if (_.isEqual(oldProps,this.props)) {
    //   // console.log(Date.now());
    //   // console.log('MynLibTable props are the same')
    //   // console.log('----------------')
    //   return;
    // }

    // console.log('UPDATING MynTable at ' + Date.now());
    // console.log(getObjectDiff(oldProps,this.props));

    // if another table unselected this table's rows, update the state variable
    if (!this.props.selectedRows[this.tableID] && oldProps.selectedRows[this.tableID]) {
      console.log('Rows unselected from outside')
      this.setState({batchSelected:[]},this.handleBatch);
    }
    // if the selection of rows in this table was otherwise changed from the outside
    // (though I don't know when that would happen besides a simple unselection)
    // update the state variable
    if (this.props.selectedRows[this.tableID] && oldProps.selectedRows[this.tableID] && !_.isEqual(this.props.selectedRows[this.tableID],oldProps.selectedRows[this.tableID]) && this.props.selectedRows[this.tableID].rows) {
      console.log('Selected rows otherwise changed from outside');
      this.setState({batchSelected:this.props.selectedRows[this.tableID].rows},this.handleBatch);
    }

    // // in the special case that we now have some videos when before there were none at all
    // // (this will happen when the first playlist is displayed on load)
    // // sort the table by initial values
    // if (this.props.movies && this.props.movies.length > 0 && (!oldProps.movies || oldProps.movies.length === 0)) {
    //   this.reset(true,true);
    // }

    // If the playlist changed, reset it using the playlist's default sort.
    if (oldProps.playlistID !== this.props.playlistID) {
      console.log("MynLibTable ============= PLAYLIST WAS CHANGED to " + this.props.playlistID);
      // setTimeout(() => this.reset(true,true), 1000);
      this.reset('initial-sort');
    } else { //if (this.props.view === 'flat' || this.props.isExpanded) {
      // console.log('playlist is the same, checking if any videos changed...');
      // if the playlist was NOT changed, but
      // if any videos in the playlist were changed...
      // (or if the setting to include user ratings in avg was changed)

      // console.log("USER_RATING_IN_AVG STATE == " + this.state.include_user_rating_in_avg);
      // console.log("USER_RATING_IN_AVG PROPS == " + this.props.settings.preferences.include_user_rating_in_avg);

      // Comparing the movies is expensive, so only do it when the parent supplied
      // a different array. Detail-pane updates reuse the same array and can skip it.
      let moviesChanged = false;
      if (oldProps.movies !== this.props.movies) {
        // We have to sort the movies arrays before comparing them; otherwise a
        // change in element order alone would look like a video update.
        let tempOld = _.cloneDeep(oldProps.movies).sort((a,b) => a.id > b.id ? 1 : (a.id < b.id ? -1 : 0));
        let tempNew = _.cloneDeep(this.props.movies).sort((a,b) => a.id > b.id ? 1 : (a.id < b.id ? -1 : 0));
        moviesChanged = !_.isEqual(tempOld,tempNew);
      }

      let includeUserRatingChanged = this.state.include_user_rating_in_avg !== this.props.settings.preferences.include_user_rating_in_avg;
      if (moviesChanged || includeUserRatingChanged) {
        console.log("MynLibTable ============= a video updated (or user avg rating setting changed)");
        // let diff = getArrayDiff(tempOld,tempNew);
        // console.log(diff);
        // diff.map(key => {
        //   console.log(`Old[${key}]: ${tempOld[key].title}\nNew[${key}]: ${tempNew[key].title}`);
        // });
        // console.log(`old rating_in_avg: ${this.state.include_user_rating_in_avg}, new rating_in_avg: ${this.props.settings.preferences.include_user_rating_in_avg}`);
        // for some reason, comparing oldProps did not work for this, because oldProps and this.props were always the same; I have no idea why; so we just use a state variable to compare
        this.state.include_user_rating_in_avg = this.props.settings.preferences.include_user_rating_in_avg;

        // re-render the table (sorting by the current values)
        this.reset();
      }
    }

  }

  componentDidMount(props) {
    this._isMounted = true;
    // console.log("--MOUNTED--");
    // this.props.movies.map(movie => console.log(JSON.stringify(movie)));
    // render the table
    this.reset('initial-sort');

  }

  componentWillMount() {
    // set key listeners to be used for batch highlighting of videos
    document.addEventListener("keydown", this.keyDown.bind(this));
    document.addEventListener("keyup", this.keyUp.bind(this));
  }

  componentWillUnmount() {
    this._isMounted = false;
    document.removeEventListener("keydown", this.keyDown.bind(this));
    document.removeEventListener("keyup", this.keyUp.bind(this));
  }

  render() {
    // console.log('----MynLibTable RENDER----');
    // TEMPORARY HOVER-LAG DIAGNOSTIC
    // console.count('[hover diagnostic] MynLibTable render');

    // return this.state.content;

    return (
      <div className="movie-table-container">
        <table className={"movie-table " + (this.props.compact ? 'compact' : '')} id={this.tableID}>
          <thead>
            {this.state.tHeadContent}
          </thead>
          <tbody>
            {this.state.tBodyContent}
          </tbody>
        </table>
      </div>
    );
  }
}

class MynLibTableRow extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
    }

    this.render = this.render.bind(this);
  }

  displaydate(date) {
    let result;
    if (date === null || date === "") {
      result = "";
    } else {
      try {
        result = new Date(date * 1000);
        result = result.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
      } catch(err) {
        result = "";
      }
    }
    return result;
  }

  displayResolution(metadata) {
    let width = metadata.width;
    if (!width) {
      return '';
    }

    // this correlates with erroneous width and height metadata, causing the wrong resolution to be displayed,
    // so we'd rather leave it blank
    if (metadata.codec.includes("mjpeg")) {
      return '';
    }

    let resolution = '';
    width = parseInt(width);

    if (width > 6000) { // 8K, nominal 7680
      resolution = '4320p';
    } else if (width > 3000) { // 4K, nominal 4096
      resolution = '2160p';
    } else if (width > 2240) { // 1440p, nominal 2560
      resolution = '1440p';
    } else if (width > 1600) { // 1080p, nominal 1920
      resolution = '1080p';
    } else if (width > 900) { // 720p, nominal 1280
      resolution = '720p';
    } else if (width > 670) { // 480p, nominal 720 (NTSC DVD resolution), or 854 (16:9 ratio)
      resolution = '480p';
    } else if (width > 400) { // 360p, nominal 640
      resolution = '360p';
    } else if (width > 340) { // 240p, nominal 427
      resolution = '240p';
    } else { // 144p, nominal 256
      resolution = '144p';
    }

    return resolution
  }

  saveEdited(originalVid, ...args) {
    // console.log('save-edited!!!');
    let changes = {};
    if (args.length == 2 && typeof args[0] === "string") {
      changes[args[0]] = args[1];
    } else if (args.length == 1 && typeof args[0] === "object") {
      changes = args[0];
    } else {
      throw 'Incorrect parameters passed to saveEdited in MynLibTableRow';
    }
    // console.log('changes == ' + JSON.stringify(changes));


    ipcRenderer.once('save-video-confirm', (event, response, changes, originalVid, skipDialog) => {
      if (response === 0) { // yes
        // save video to library
        let updated = { ...originalVid, ...changes };
        let index = library.media.findIndex((video) => video.id === updated.id);
        library.replace("media." + index, updated);
      } else {
        console.log('Edit canceled by user')
      }

      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (skipDialog) {
        // console.log('option to override dialog was checked!');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs[`MynLibTable-confirm-inlineEdit`] = true;
        library.replace("settings.preferences",prefs);
      }
    });

    // user confirmation dialog
    if (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynLibTable-confirm-inlineEdit']) {
      ipcRenderer.send('save-video-confirm', changes, originalVid, true); // pass 'true' to show the skip dialog checkbox
    } else {
      // save changes without the confirmation dialog
      let updated = { ...originalVid, ...changes };
      let index = library.media.findIndex((video) => video.id === updated.id);
      library.replace("media." + index, updated);
    }
  }


  render() {

    let rowID = this.props.rowID;
    let video = this.props.video;
    let index = this.props.index;

    let cellJSX = {
      title: (<td key="title" className="title">{video.title}</td>),
      // title: (<td key="title" className="title"><MynOverflowTextMarquee class="table-title-text" text={video.title} ellipsis='fade' /></td>),
      year: (<td key="year" className="year centered mono">{video.year}</td>),
      director: (<td key="director" className="director">{video.director}</td>),
      genre: (<td key="genre" className="genre">{video.genre}</td>),
      seen: (<td key="seen" className="seen centered"><MynEditSeenWidget movie={video} update={(...args) => this.saveEdited(video, ...args)} /></td>),
      watchlater: (<td key="watchlater" className="watchlater centered"><MynEditWatchlaterWidget movie={video} update={(...args) => this.saveEdited(video, ...args)} /></td>),
      ratings_user: (<td key="ratings_user" className="ratings_user centered"><MynEditRatingWidget movie={video} update={(...args) => this.saveEdited(video, ...args)} /></td>),
      dateadded: (<td key="dateadded" className="dateadded centered mono">{this.displaydate(video.dateadded)}</td>),
      kind: (<td key="kind" className="kind">{video.kind ? video.kind.replace(/\b\w/g,ltr=>ltr.toUpperCase()) : null}</td>),
      lastseen: (<td key="lastseen" className="lastseen centered mono">{this.displaydate(video.lastseen)}</td>),
      ratings_rt: (<td key="ratings_rt" className="ratings_rt ratings centered">{video.ratings.rt ? video.ratings.rt + '%' : ''}</td>),
      ratings_imdb: (<td key="ratings_imdb" className="ratings_imdb ratings centered">{video.ratings.imdb ? Number(video.ratings.imdb).toFixed(1) : ''}</td>),
      ratings_mc: (<td key="ratings_mc" className="ratings_mc ratings centered">{video.ratings.mc ? video.ratings.mc : ''}</td>),
      ratings_avg: (<td key="ratings_avg" className="ratings_avg ratings centered">{this.props.calcAvgRatings(video.ratings)}</td>),
      boxoffice: (<td key="boxoffice" className="boxoffice">{video.boxoffice === 0 ? '' : accounting.formatMoney(Number(video.boxoffice),'$',0).replace(/,(\d{3})$/,(...grps) => Math.round(grps[1]/100)>0 ? `.${Math.round(grps[1]/100).toString().replace(/0$/,'')}k` : 'k').replace(/,(\d{3})(\.\d{1,2})?k$/,(...grps) => Math.round(grps[1]/100)>0 ? `.${Math.round(grps[1]/100).toString().replace(/0$/,'')}M` : 'M').replace(/,(\d{3})(\.\d{1,2})?M$/,(...grps) => Math.round(grps[1]/100)>0 ? `.${Math.round(grps[1]/100).toString().replace(/0$/,'')}B` : 'B')}</td>),
      rated: (<td key="rated" className="rated centered">{video.rated}</td>),
      country: (<td key="country" className="country">{video.country}</td>),
      languages: (<td key="languages" className="languages">{video.languages[0]}</td>),
      duration: (<td key="duration" className="duration">{video.metadata.duration !== 0 && video.metadata.duration !== null ? `${Math.round(Number(video.metadata.duration)/60)} min` : ''}</td>),
      resolution: (<td key="resolution" className="resolution">{this.displayResolution(video.metadata)}</td>)
    };

    let cells = this.props.columns.map(column => {
      // bespoke row JSX
      if (cellJSX.hasOwnProperty(column)) {
        return cellJSX[column];
      }

      // generic row
      return (<td key={column} className={column}>{String(video[column])}</td>)
    });

    return (
      <tr
        className={"movie-row " + rowID}
        id={rowID}
        vid_id={video.id}
        onMouseEnter={(e) => this.props.rowHovered(video, rowID, index, e)}
        onClick={(e) => this.props.rowClick(video.id, rowID, index, e)}
      >
        {cells}
      </tr>
    );
    // onMouseOut = {(e) => this.props.rowOut(video.id, rowID, e)}
  }
}

// ###### Details Pane: contains details of the hovered/clicked video ###### //
class MynDetails extends React.Component {
  constructor(props) {
    super(props)

    this.render = this.render.bind(this);
    this.saveVideo = this.saveVideo.bind(this);
    this.scrollBtn = React.createRef();
  }

  displayDate(value) {
    let date;
    let displaydate = "";
    if (value === null || value === "") {
      return "(never)";
    }
    try {
      date = new Date(parseInt(value) * 1000);
      displaydate = date.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
    } catch(e) {
      console.log("MynDetails: could not resolve date: " + e.toString());
      displaydate = "";
    }
    return displaydate;
  }

  clickDescrip(e) {
    // if (this.props.settings.preferences.hide_description === "hide") {
      try {
        document.getElementById('detail-description').classList.toggle('hide');
      } catch(err) {
        console.log(err);
      }
    // }
  }

  displayRatings() {
    let ratings = this.props.video.ratings;
    // console.log(JSON.stringify(ratings));
    return Object.keys(ratings).map(source => {
      // console.log(source);
      if (source === 'user') return null;
      if (ratings[source] === '') return null;

      let rating = Number(ratings[source]);

      // image path
      let path = '../images/logos/' + source + '-logo';
      if (source === 'rt' && rating < 60) {
        path += '-splat';
      }
      path += '.png';
      // console.log(path);

      // units/display
      let units = '';
      if (source === 'imdb') rating = rating.toFixed(1); // no units, just display 1 decimal place
      if (source === 'rt') units = '%';
      if (source === 'mc') units = '/100';

      return (
      <div key={source}><img src={path} className='ratings-icon' /> {rating + units}</div>
    )});
  }

  // called just by any edit widgets in the details pane
  // not used by the video editor or anywhere else
  saveVideo(...args) {
    let changes = {};
    if (args.length === 2) {
      changes[args[0]] = args[1];
    } else if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      changes = {...args[0]};
    } else {
      console.error('Bad arguments supplied to saveVideo in MynDetails: ' + JSON.stringify(args));
      return;
    }

    let updated = {...this.props.video, ...changes};
    library.replace(`media.id=${this.props.video.id}`,updated);
  }

  openInFinder() {
    shell.showItemInFolder(this.props.video.filename);
  }

  componentDidUpdate(oldProps) {
    // this.setTitleMarquee();
    if (!_.isEqual(oldProps.video, this.props.video)) {
      // this.setTitleMarquee();
      if (this.props.settings.preferences.hide_description === "hide") {
        try {
          document.getElementById('detail-description').classList.add('hide');
        } catch(err) {
          console.log('Error: could not find detail description: ' + err);
        }
      }
    }

    // if the user has scrolled, we want to show or not show the scroll button
    // depending on whether the row of the details video is still in view
    if (oldProps.libraryScroll !== this.props.libraryScroll) {
      if (this.scrollBtn.current && !this.props.isRowVisible(rowID)) {
        console.log(video.title + ' is NOT visible!');
        this.scrollBtn.current.style.display = 'block';
      } else {
        this.scrollBtn.current.style.display = 'none';
      }
    }
  }

  componentDidMount() {
  }

  render() {
    // TEMPORARY HOVER-LAG DIAGNOSTIC
    // console.count('[hover diagnostic] MynDetails render');

    let details;
    let editBtn = (<div id="edit-button" onClick={() => this.props.showEditor()}>Edit</div>);
    let scrollBtn = null;

    try {
      const video = this.props.video;
      let imageURL = video.artwork ? URL.pathToFileURL(video.artwork).pathname : '';
      details = (
        <ul>
          <li className="detail" id="detail-artwork"><div className="optional-artwork-duplicate" style={{backgroundImage:`url('${imageURL}')`}}></div><img id="detail-artwork-img" src={video.artwork || '../images/qmark-details.png'} /></li>
          {/* <li className="detail" id="detail-title"><MynOverflowTextMarquee class="detail-title-text" text={video.title} /></li> */}
          <li className="detail" id="detail-title">{video.title}</li>
          <li className="detail" id="detail-year">{video.year}</li>
          <li className="detail" id="detail-position"><MynEditPositionWidget movie={video} update={this.saveVideo} /></li>
          <li className={"detail " + this.props.settings.preferences.hide_description} id="detail-description" onClick={(e) => this.clickDescrip(e)}><div>{video.description}</div></li>
          <li className="detail" id="detail-ratings">{this.displayRatings()}</li>
          <li className="detail" id="detail-director"><span className="label">Director:</span> {video.director}</li>
          <li className="detail" id="detail-cast"><span className="label">Cast:</span> {video.cast.join(", ")}</li>
          <li className="detail" id="detail-tags"><span className="label">Tags:</span> {video.tags.map((tag) => <span key={tag}>{tag} </span>)}</li>
          <li className="detail" id="detail-rated"><span className="label">Rated:</span> {video.rated}</li>
          <li className="detail" id="detail-country"><span className="label">Country:</span> {video.country}</li>
          <li className="detail" id="detail-languages"><span className="label">Languages:</span> {video.languages.join(", ")}</li>
          {video.boxoffice > 0 ? (<li className="detail" id="detail-boxoffice"><span className="label">Box Office:</span> {accounting.formatMoney(video.boxoffice,'$',0) || ''}</li>) : null}
          <li className="detail" id="detail-dateadded"><span className="label">Date Added:</span> {this.displayDate(video.dateadded)}</li>
          <li className="detail" id="detail-lastseen"><span className="label">Last Seen:</span> {this.displayDate(video.lastseen)}</li>
          <li className="detail" id="detail-showFileBtn"><button onClick={() => this.openInFinder()}>Open in {os.platform() === 'darwin' ? "Finder" : "Explorer"}</button></li>
        </ul>
      );

      scrollBtn = (
        <div id='details-scroll-btn' ref={this.scrollBtn} className='clickable' style={{display: this.props.isRowVisible(this.props.rowID) ? 'none' : 'block'}} onClick={() => this.props.scrollToVideo(this.props.rowID)}>
          Scroll to Row
        </div>
      );

    } catch (error) {
      // dummy details as a visual placeholder when no video is hovered/selected
      details = (
        <ul>
          <li className="detail" id="detail-artwork"><img id="detail-artwork-img" src={'../images/qmark-details.png'} /></li>
          <li className="detail dummy" id="detail-title"><div className="detail-title-text">A Movie Title</div></li>
          <li className="detail dummy first"><div className="dummy-field"></div></li>
          <li className="detail dummy second"><div className="dummy-field"></div></li>
          <li className="detail dummy third"><div className="dummy-field"></div></li>
          <li className="detail dummy fourth"><div className="dummy-field"></div></li>
        </ul>
      );
      editBtn = null; // in the case of no video, we don't want an edit button
      scrollBtn = null; // same with this

      // console.error(error.toString());
      // console.trace();
      // validateVideo(this.props.video);
    }

    return  (
      <aside id="details-pane" className="pane">
        {scrollBtn}
        {editBtn}
        {details}
      </aside>
    )
  }
}

class MynNotify extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      on: false
    }

    ipcRenderer.on('status-update', (event, status) => this.statusUpdate(status));

    // Renderer-owned jobs, currently batch video saves, arrive here. The
    // listener exists for the lifetime of this notification component and is
    // removed if React ever unmounts it.
    this.handleLocalStatusUpdate = (event) => this.statusUpdate(event.detail);
    window.addEventListener(LOCAL_STATUS_UPDATE_EVENT, this.handleLocalStatusUpdate);

    this.render = this.render.bind(this);
    this.statusUpdate = this.statusUpdate.bind(this);
    this.animateEllipsis = this.animateEllipsis.bind(this);
  }

  on(status) {
    if (!status.action) {
      this.off();
      return console.error('Error: invalid status');
    }

    // if it's not already on, turn on ellipsis animation and set the state to on
    if (!this.state.on) {
      // this.setState({on:true});
      this.state.on = true;
      this.startEllipsis();

      // give the 'notify-on' class to all the panes
      // to allow for any css manipulation
      Array.from(document.getElementsByClassName('pane')).map(el => {
        el.classList.add('notify-on');
      });
    }

    // if the status has changed, update the status in state
    // if (!_.isEqual(status,this.state.status)) {
    //   this.setState({status:status});
    // }
    this.setState({statusMessage:this.messageFor(status)})
  }

  off() {
    this.setState({on:false, status: {}});
    this.stopEllipsis();

    // remove the 'notify-on' class from all the panes
    Array.from(document.getElementsByClassName('pane')).map(el => {
      el.classList.remove('notify-on');
    })
  }

  statusUpdate(status) {
    // console.log(`Running statusUpdate with status: ${JSON.stringify(status)}`);
    // console.log('this.state.on: ' + this.state.on)
    if (status.action === '') {
      // console.log('STATUS.ACTION empty, turning off')
      // console.log(status)
      this.off();
    } else {
      this.on(status);
    }
  }

  messageFor(status) {
    if (status.action === 'autotag' && status.cancelRequested) {
      return 'Finishing the current video before canceling auto-tagging';
    }

    let _c = '';
    let _t = '';
    let _of = '';
    if (status.numCurrent) _c = ` ${status.numCurrent}`;
    if (status.numCurrent && status.numTotal) _of = ' of';
    if (status.numTotal) _t = ` ${status.numTotal}`;

    let textFor = {
      'export'        : `Exporting${_c}${_of}${_t} videos`,
      'add'           : `Adding${_c}${_of}${_t} videos`,
      'metadata'      : `Checking metadata${status.numCurrent || status.numTotal ? ' for ' + _c + _of + _t + ' videos' : ''}`,
      'metadata_save' : `Saving metadata${status.numCurrent || status.numTotal ? ' for ' + _c + _of + _t + ' videos' : ''}`,
      'batch_save'    : `Saving${_c}${_of}${_t} ${status.numTotal === 1 ? 'video' : 'videos'}`,
      'autotag'       : `Auto-tagging${_c}${_of}${_t} videos`,
      'check'         : 'Checking for new videos'
    }

    return textFor[status.action];
  }

  startEllipsis() {
    if (this.ellipsisAnimation) {
      // console.log("trying to start ellipsis, but thinks it's already started: ");
      // console.log(this.ellipsisAnimation);
      return;
    }

    // console.log('starting ellipsis........................')

    this.setState({ellipsis:""}, () => {
      this.animateEllipsis();
    });

    // this.ellipsisAnimation = setInterval(() => {
    //   this.state.ellipsis = ".".repeat((this.state.ellipsis.length+1)%4)
    //   this.setState({ellipsis:this.state.ellipsis});
    // },400);

  }

  stopEllipsis() {
    // console.log('stopping ellipsis........................')

    clearTimeout(this.ellipsisAnimation);
    this.ellipsisAnimation = null; // we have to do this to make sure the check in this.startEllipsis works
    this.state.ellipsis = "";
    this.setState({ellipsis:this.state.ellipsis});
  }

  animateEllipsis() {
    this.setState({ellipsis:".".repeat((this.state.ellipsis.length+1)%4)}, () => {
      // console.log('setting timeout for ellipsisAnimation')
      this.ellipsisAnimation = setTimeout(this.animateEllipsis,400);
    });
  }

  componentDidMount() {
    // this.statusUpdate({action:['export','add','metadata','autotag','check'][Math.round(Math.random()*4)], numCurrent:1, numTotal:85});
  }

  componentWillUnmount() {
    window.removeEventListener(LOCAL_STATUS_UPDATE_EVENT, this.handleLocalStatusUpdate);
  }

  render() {
    if (this.state.on) {
      // <div className="ellipsis animation" style={{display:'inline-block', width:'1em'}}>
      // </div>

      return (
        <div id="notify-banner">
          {this.state.statusMessage}
          <div className="ellipsis animation" style={{display:'inline-block', width:'1em', textAlign:'left'}}>{this.state.ellipsis}</div>
        </div>
      );
    } else {
      return null;
    }
  }
}

// <MynOverflowTextMarquee class="detail-title-text" text={video.title} endPadding='.2em' time={6} timeR={3} delay={.5} delayR={0} timingFuncR='ease-in-out' />
class MynOverflowTextMarquee extends React.Component {
  constructor(props) {
    super(props)

    this.ellipsisBaseStyle = {
      // position: 'absolute',
      // right: '0',
      // top: '0',
      // height: '100%',
      // width: '1em'
    }

    this.state = {
      ellipsisStyle: {...this.ellipsisBaseStyle},
      direction: props.direction ? props.direction : 'right',
      oppositeDir: props.direction === 'left' ? 'right' : 'left',
      fadeSize: props.fadeSize ? props.fadeSize : '1em'
    }

    // this.state = {
    //   reverse: false,
    //   style : {
    //
    //   },
    //   time: `${!isNaN(this.props.time) ? this.props.time : '5'}s`,
    //   timingFunc: this.props.timingFunc ? this.props.timingFunc : 'cubic-bezier(.5, 0, .8, 1)',
    //   timingFuncR: this.props.timingFuncR ? this.props.timingFuncR : 'cubic-bezier(.2, 0, .5, 1)',
    //   delay: `${!isNaN(this.props.delay) ? this.props.delay : '0'}s`
    // }
    //
    // this.baseStyle = {
    //   whiteSpace:'no-wrap',
    //   overflow:'visible'
    // };
    // this.overflowHoverStyle = {
    //   // animation: `details-scroll-left ${this.props.time ? this.props.time : '5'}s cubic-bezier(.5, 0, .8, 1) infinite`,
    //   // animationDelay: this.props.delay ? `${this.props.delay}s` : '0s',
    //   // animationDirection: 'alternate',
    //   // animationFillMode: 'both',
    //
    //
    //   transform: `translateX(calc(-100%${this.props.endPadding ? (' - ' + this.props.endPadding) : ''}))`,
    //   transitionProperty: 'transform',
    //   transitionDuration: this.state.time,
    //   transitionTimingFunction: this.state.timingFunc,
    //   transitionDelay: this.state.delay
    //
    // };
    //
    // this.overflowHoverStyleReverse = {
    //   transform: 'translateX(0%)',
    //   transitionProperty: 'transform',
    //   transitionDuration: !isNaN(this.props.timeR) ? `${this.props.timeR}s` : this.state.time,
    //   transitionTimingFunction: this.state.timingFuncR,
    //   transitionDelay: !isNaN(this.props.delayR) ? `${this.props.delayR}s` : this.state.delay
    //
    // };
    //
    //
    // this.switchDir = this.switchDir.bind(this);
    this.theDiv = React.createRef();
    this.render = this.render.bind(this);
    this.timeDelayInit = this.timeDelayInit.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.componentWillUnmount = this.componentWillUnmount.bind(this);
  }

  // initialize() {
  //   this.setState({style:{...this.baseStyle}});
  //
  //   // check for overflow
  //   try {
  //     this.overflowHoverStyle.border = '1px solid red';
  //     this.overflowHoverStyle.width = window.getComputedStyle(this.theDiv.current.parentNode, null).getPropertyValue('width');
  //
  //     // let computed = window.getComputedStyle(this.theDiv.current, null);
  //     // console.log(this.theDiv.current.innerHTML);
  //     // console.log('width: ' + this.theDiv.current.style.width);
  //     // console.log('actual width: ' + computed.getPropertyValue('width'));
  //     // console.log('offsetWidth: ' + this.theDiv.current.offsetWidth);
  //     // console.log('scrollWidth: ' + this.theDiv.current.scrollWidth);
  //     // console.log('getBoundingClientRect().width: ' + this.theDiv.current.getBoundingClientRect().width);
  //     // console.log('padding: ' + computed.getPropertyValue('padding-left') + computed.getPropertyValue('padding-left'));
  //     // console.log('font-size: ' + computed.getPropertyValue('font-size'));
  //     // console.log('margin-right: ' + computed.getPropertyValue('margin-right'));
  //
  //     // if the text is overflowing the container
  //     if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) { // text is overflowing
  //       this.overflowHoverStyle.width = this.theDiv.current.scrollWidth - this.theDiv.current.offsetWidth + 'px';
  //       this.overflowHoverStyle.marginRight = titleDiv.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
  //       this.theDiv.current.classList.add('overflow');
  //     } else {
  //       // the text is not overflowing, so we don't need to do anything special
  //       this.theDiv.current.classList.remove('overflow');
  //     }
  //
  //     // console.log('new width: ' + this.theDiv.style.width);
  //   } catch(err) {
  //     console.error(`Could not apply overflow styles: ${err}`);
  //   }
  // }

  initialize() {
    let ellipsisStyle = {};
    // console.log('INITIALIZE');
    // check for overflow
    try {
      // I'm not sure why, but the following line seems to fix an issue where the
      // scrollWidth (I think) gives inconsistent numbers, resulting in a mess
      this.theDiv.current.style.width = window.getComputedStyle(this.theDiv.current.parentNode.parentNode, null).getPropertyValue('width');

      // let computed = window.getComputedStyle(this.theDiv.current, null);
      // console.log(this.theDiv.current.innerHTML);
      // console.log('width: ' + this.theDiv.current.style.width);
      // console.log('actual width: ' + computed.getPropertyValue('width'));
      // console.log('offsetWidth: ' + this.theDiv.current.offsetWidth);
      // console.log('scrollWidth: ' + this.theDiv.current.scrollWidth);
      // console.log('getBoundingClientRect().width: ' + this.theDiv.current.getBoundingClientRect().width);
      // console.log('padding: ' + computed.getPropertyValue('padding-left') + computed.getPropertyValue('padding-left'));
      // console.log('font-size: ' + computed.getPropertyValue('font-size'));
      // console.log('margin-right: ' + computed.getPropertyValue('margin-right'));

      // if the text is overflowing the container
      // set the width and stuff so that the CSS animation scrolls the appropriate amount;
      // then we just add the 'overflow' class and let the CSS do the actual animation
      if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) { // text is overflowing
        // console.log('OVERFLOWING')

        this.theDiv.current.style.position = 'absolute';
        this.theDiv.current.style.width = this.theDiv.current.scrollWidth - this.theDiv.current.offsetWidth + 'px';
        if (this.state.direction === 'right') this.theDiv.current.style.marginRight = this.theDiv.current.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
        if (this.state.direction === 'left') this.theDiv.current.style.marginLeft = this.theDiv.current.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
        this.theDiv.current.classList.add('overflow');
        this.theDiv.current.classList.add(this.state.direction);

        this.setEllipsis();

      } else {
        // console.log('NOT OVERFLOWING');
        this.theDiv.current.style.position = 'relative';
        this.theDiv.current.style.width = null;
        this.theDiv.current.style.marginRight = null;
        this.theDiv.current.style.marginLeft = null;

        // the text is not overflowing, so we don't need to do anything special
        this.theDiv.current.classList.remove('overflow');
        this.theDiv.current.classList.remove(this.state.direction);

        this.unsetEllipsis();
      }



      // console.log('new width: ' + this.theDiv.current.style.width);
    } catch(err) {
      console.error(`Could not apply overflow styles: ${err}`);
    }
  }

  setEllipsis() {
    let ellipsis = {};
    if (this.props.ellipsis === 'fade' || !this.props.ellipsis) {
      // console.log('fade');
      ellipsis = {
        WebkitMaskImage: `linear-gradient(to ${this.state.oppositeDir}, transparent 0, rgba(0, 0, 0, 1.0) ${this.state.fadeSize})`,
        WebkitMaskPosition: '0 0',
        WebkitMaskRepeat: 'repeat-y'
      }
    }

    let ellipsisStyle = {...this.ellipsisBaseStyle,...ellipsis};

    // when we're overflowing left, this.theDiv is set to absolute,
    // which means the container will have a height of 0, so we have to compensate for that
    // if (this.state.direction === 'left') {
      ellipsisStyle.height = this.theDiv.current.offsetHeight + 'px';
    // }

    this.setState({ellipsisStyle:ellipsisStyle});
  }

  unsetEllipsis() {
    this.setState({ellipsisStyle: {...this.ellipsisBaseStyle}});
  }


  // switchDir() {
  //   // if this.state.reverse === true NOW, then we're currently reversing, so we want to switch to forward
  //   let hoverStyle = this.state.reverse ? this.overflowHoverStyle : this.overflowHoverStyleReverse
  //
  //   this.setState({
  //     reverse: !this.state.reverse,
  //     style: {...this.baseStyle,...hoverStyle}
  //   });
  // }
  //
  // hover(e) {
  //   // if the text is overflowing, set the overflow CSS animation
  //   if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) {
  //     this.theDiv.current.addEventListener('transitionend', this.switchDir);
  //
  //     // start the animation (always start forward)
  //     this.setState({
  //       reverse: false,
  //       style: {...this.baseStyle,...this.overflowHoverStyle}
  //     });
  //   }
  // }
  //
  // unhover(e) {
  //   this.setState({style:{...this.baseStyle}});
  //   this.theDiv.current.removeEventListener('transitionend', this.switchDir);
  // }

  timeDelayInit() {
    clearTimeout(this.initTimer);
    this.initTimer = setTimeout(() => {
      this.initialize();
    },500);
  }

  componentDidMount() {
    this.initialize();

    // this.timeDelayInit();

    // this.theDiv.current.addEventListener('resize', this.timeDelayInit);
  }

  componentWillUnmount() {
    // this.theDiv.current.removeEventListener('resize', this.timeDelayInit);
  }


  componentDidUpdate(oldProps) {
    if (oldProps.text !== this.props.text) {
      this.initialize();
    }
  }

  render() {
    // return (
    //   <div ref={this.theDiv} className={this.props.class} style={this.state.style} onMouseEnter={(e) => this.hover(e)} onMouseLeave={(e) => this.unhover(e)}>
    //     {this.props.text}
    //   </div>
    // );

    let style = {
      whiteSpace: 'nowrap',
      // overflow: 'hidden'
    };
    if (this.state.direction === 'left') {
      style.textAlign = 'right';
      style.direction = 'rtl';
      style.position = 'absolute';
      style.right = '0';
      // style.float = 'right'
    }

    return (
      <div className='marquee-container' style={this.state.ellipsisStyle} onMouseEnter={this.timeDelayInit}>
        <div ref={this.theDiv} className={this.props.class} style={style}>
          {this.props.text}
        </div>
      </div>
    );

  }

}

class MynOpenablePane extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      paneID: ''
    }

    this.render = this.render.bind(this);
  }

  closePane(id,confirm,msg,cb) {
    try {
      // in case confirm is a function instead of just a boolean
      confirm = confirm();
    } catch(err) {}

    // if we're supposed to confirm before exiting:
    // i.e. the confirm boolean variable tells us whether the pane wants us to confirm exit,
    // but that can be overridden by the user preference to override the confirmation dialog,
    // hence the rest of the conditional here
    if (confirm && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`])) {
      ipcRenderer.once('MynOpenablePane-confirm-exit', (event, response, data, checked) => {
        let id = data.id;
        let cb = data.cb;
        // if the user checked the checkbox to override the confirmation dialog,
        // set that preference in the settings
        if (checked) {
          console.log('option to override dialog was checked!');
          let prefs = _.cloneDeep(this.props.settings.preferences);
          if (!prefs.override_dialogs) {
            prefs.override_dialogs = {};
          }
          prefs.override_dialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`] = true;
          library.replace("settings.preferences",prefs);
        }

        if (response === 0) { // yes
          // close pane
          try {
            cb();
          } catch(err) {}
          this.props.hideFunction(id);
        } else {
          console.log('Exit pane canceled by user')
        }
      });

      ipcRenderer.send(
        'generic-confirm',
        'MynOpenablePane-confirm-exit',
        {
          message: msg || 'Are you sure you want to exit?',
          checkboxLabel: `Don't show this dialog again`
        },
        {id:id,cb:cb}
      );
    } else {
      try {
        cb();
      } catch(err) {
        // console.error(err);
      }
      this.props.hideFunction(id);
    }
  }

  // child class must supply 'content' variable when calling super.render()
  render(content) {
    if (this.props.show === false) {
      return null;
    }

    return (
      <div id={this.state.paneID} className="pane openable-pane">
        <div className="openable-close-btn" onClick={() => this.closePane(this.state.paneID,content.confirmExit,content.confirmMsg,content.exitCB)}>{"\u2715"}</div>
        {content.jsx}
      </div>
    );
  }
}

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
      socket.on('error', (error) => console.warn('MPV socket closed during cleanup:', describePlaybackError(error)));
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
    console.log('UPDATING POSITION TO ' + this.state.video.position);
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
    console.log('MPV PLAYER CLOSED');
    this.setState({showPlayingMessage: false});

    clearTimeout(this.logPlayTimeout);

    let position = this.state.video.position;
    let duration = this.state.video.metadata.duration;
    console.log(`position: ${position}, duration: ${duration}`);

    // if the position is close to the beginning or close enough to the end
    // that we estimate the user is done watching it, we reset to 0
    if (position < Math.min(duration*.005,30)) {
      // if < 30 seconds or 0.5%, whichever is smaller, reset to 0
      // (0.5% of 45 minutes is 13.5 seconds; 0.5% of 2 hours is 36 seconds)
      position = 0;
      console.log('POSITION close to beginning, resetting to 0');
    } else if (position > Math.max(duration*.97, duration - 300)) {
      // if 5 minutes or less from the end, or 3% or less from the end, which ever is later, reset to 0 ()
      // (3% of 45 min is 1:21; 3% of 2 hours is 3:36)
      position = 0;
      console.log('POSITION close to END, resetting to 0');
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
      this.logPlayTimeout = setTimeout(() => { console.log('Logging that we played ' + this.state.video.title); this.props.logPlayed(this.state.video.id) }, 10000);


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
      console.error(error);
      const isCurrentAttempt = attempt === this.playbackAttempt && this.mpv === player;
      stopMpvSafely(player);
      if (this.mpv === player) this.mpv = null;
      if (!isCurrentAttempt || (error && error.code === 'MYNDA_PLAYBACK_CANCELED')) return;
      const mediaType = video && video.dvd ? 'DVD' : 'video';
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
      console.log('NOW SHOWING');
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

// ###### Settings Pane: allows user to edit settings. Only appears when user clicks to open it ###### //
class MynSettings extends MynOpenablePane {
  constructor(props) {
    super(props)

    this.save = this.save.bind(this);

    this.state = {
      paneID: 'settings-pane',
      settingView: null,
      settingViewName: props.view,
      delaySave: false,
      timer: null
    }

    ipcRenderer.on('settings-watchfolder-added', (event, folderObj) => {
      console.log('server told us it has added ' + folderObj.path)
      // update everything
      this.setStateViewsFromProps(() => this.setView(this.state.settingViewName));
    });

    ipcRenderer.on('settings-watchfolder-remove', (event, path, removed) => {
      if (removed) {
        console.log('REMOVED FOLDER: ' + path);
        // update everything
        this.setStateViewsFromProps(() => this.setView(this.state.settingViewName));
      } else {
        console.log('DID NOT REMOVE FOLDER: ' + path);
      }
    });
  }

  setStateViewsFromProps(callback) {
    let views = {
      folders :     (<MynSettingsFolders      save={this.save} folders={this.props.settings.watchfolders} kinds={this.props.settings.used.kinds} />),
      playlists :   (<MynSettingsPlaylists    save={this.save} playlists={this.props.playlists} defaultcolumns={this.props.settings.preferences.defaultcolumns} displayColumnName={this.props.displayColumnName} />),
      // themes :      (<MynSettingsThemes       save={this.save} themes={this.props.settings.themes} />),
      preferences : (<MynSettingsPrefs        save={this.save} settings={this.props.settings} displayColumnName={this.props.displayColumnName} />),
      sync : (<MynSettingsSync                save={this.save} settings={this.props.settings} />)

    }
    this.setState({views:views},callback);
  }

  save(saveObj) {
    // if the timer is already running
    if (this.state.timer !== null) {
      // cancel the old timer before we set a new one
      clearTimeout(this.state.timer);
    }

    // set new delay timer
    // console.log('Setting new timer...');
    this.state.timer = setTimeout(() => {
      // console.log('Timer ended; saving');

      // SAVE
      // saveObj should be an object with the keys being the 'replace' parameter in the library.replace function
      // (i.e. a string address in dot notation pointing to the object being updated in the library)
      // and the values should be the object being updated;
      // then we just loop over all the keys, and save everything to the library
      Object.keys(saveObj).forEach((address) => {
        library.replace(address, saveObj[address]);
      });

      this.setState({timer:null});
    },500);
  }

  setView(view,event,index) {
    // if the index isn't passed to us, find it from the view name;
    // even though object keys aren't in a reliable order, these should be
    // in the same order as they were when we generated the tabs
    if (index === undefined) {
      Object.keys(this.state.views).forEach((v,i) => {
        if (v == view) {
          index = i;
        }
      });
    }

    // console.log('index: ' + index);
    // update all views first, and then switch to the selected view
    this.setStateViewsFromProps(() => this.setState({settingView : this.state.views[view], settingViewName : view}));

    // remove "selected" class from all the tabs
    try {
      Array.from(document.getElementById("settings-tabs").getElementsByClassName("tab")).map((tab,i) => {
        // console.log('i: ' + i);
        tab.classList.remove("selected");

        // make classes for the selected-adjacent tabs
        if (i == index-1) { tab.classList.add("before-selected"); } else { tab.classList.remove("before-selected"); }
        if (i == index+1) { tab.classList.add("after-selected"); } else { tab.classList.remove("after-selected"); }
      });
    } catch(e) {
      // this will happen when the settings pane is not visible
      // console.log('There was an error updating classes for the settings tabs: ' + e.toString());
    }

    // add "selected" class to the clicked tab
    let element;
    try {
      element = event.target;
    } catch(e) {
      // if no event was passed, try to get the element from the view name
      try {
        element = document.getElementById('settings-tab-' + view);
      } catch(e) {
        //console.log('Unable to add "selected" class to tab in settings component: ' + e.toString());
      }
    }
    try {
      element.classList.add("selected");
    } catch(e) {
    }
  }

  createContentJSX() {
    const tabs = [];
    try {
      Object.keys(this.state.views).forEach((tab,i) => {
        tabs.push(<li key={tab} id={"settings-tab-" + tab} className="tab" onClick={(e) => this.setView(tab,e,i)}>{tab.replace(/\b\w/g,(letter) => letter.toUpperCase())}</li>)
      });
    } catch(err) {
      // this.state.views has not been created yet
    }

    return (
        <div>
          <ul id="settings-tabs">
            {tabs}
          </ul>
          <div id="settings-content">{this.state.settingView}</div>
        </div>
    );
  }

  componentDidMount(props) {
    // create the views
    // and set the initial view to the 'folders' tab
    // --------
    // NOTE: this no longer works, because the rendering process relies on
    // finding existing DOM nodes (e.g. document.getElementById("settings-tabs") for styling),
    // and when props.show is false, those don't exist;
    // this is always the case when the component mounts, because props.show isn't
    // set to true until the user clicks to open the pane;
    // it doesn't matter though, because we're calling the same function
    // in componentDidUpdate anyway
    // --------
    // this.setStateViewsFromProps(() => this.setView('folders'));
  }

  componentDidUpdate(oldProps) {
    // console.log('MynSettings: component has updated');
    // console.log(this.props.settings.watchfolders)

    // Mynda creates new callback functions whenever it renders. Ignore those
    // function-only changes before doing the expensive deep prop comparison.
    const nonFunctionPropsChanged = Object.keys(this.props).some(key => {
      return !_.isFunction(this.props[key]) && oldProps[key] !== this.props[key];
    });
    if (!nonFunctionPropsChanged) return;

    if (!isEqualIgnoreFuncs(oldProps,this.props)) {
      console.log('MynSettings: PROPS HAVE CHANGED:\n' + getObjectDiff(oldProps,this.props));

      // if the view was changed from outside, call up that view;
      // OR, whenever the pane is closed, also set to props.view
      // so that it will open to that view the next time the user opens the pane;
      // (if we want the open tab to be persistent through close, just get rid of the 'or' statement)
      // otherwise stay with the view we're on, so that if an update happens
      // while the pane is open, it doesn't throw the user to a different tab
      let viewName = this.state.settingViewName;
      if (this.props.view !== oldProps.view || this.props.show === false) {
        viewName = this.props.view;
      }

      // update everything
      this.setStateViewsFromProps(() => this.setView(viewName));
    }
  }

  render() {
    return super.render({jsx:this.createContentJSX()});
  }
}

class MynSettingsFolders extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      existingFolders : [],
      folderToAdd: null

    }
    this.folderSelect = this.folderSelect.bind(this);

  }

  // create JSX for an options dropdown of the possible media kinds
  formFieldKindOptions() {
    let options;
    try {
      options = this.props.kinds.map((kind) => {
        if (!kind) return null;
        return (<option key={kind} value={kind}>{kind.replace(/\b\w/g,(letter) => letter.toUpperCase())}</option>)
      });
      options.unshift(<option key="none" value="none">(none)</option>);
    } catch(e) {
      console.error("Unable to find list of media kinds in library: " + e.toString());
      // should display error message to user
    }
    return options;
  }

  editRemove(path, index) {
    console.log("user wants to remove " + path + " which is at index " + index);

    ipcRenderer.send('settings-watchfolder-remove', path);
  }

  // edit the default kind of an existing watchfolder
  editKind(event, index) {
    console.log("user wants to change 'kind' to " + event.target.value + " for folder at index " + index);

    try {
      let temp = _.cloneDeep(this.state.existingFolders[index]);
      temp.kind = event.target.value;

      library.replace(`settings.watchfolders.${index}`,temp);

    } catch(err) {
      console.error(`Could not edit the kind for folder at index ${index}: ${err}`);
    }
  }

  changeTargetFolder(folder) {
    this.setState({folderToAdd: folder});
    console.log('Changed target folder to ' + folder);

    const inputField = document.getElementById('settings-folders-choose-path');
    if (folder == "") {
      inputField.classList.remove('filled');
      inputField.classList.add('empty');
    } else {
      inputField.classList.remove('empty');
      inputField.classList.add('filled');
    }
  }

  submitFolderToServer() {
    let folderAddress = document.getElementById("settings-folders-choose-path").value;
    let defaultKind = document.getElementById("settings-folders-choose-kind").value;
    let submitObject = {address: folderAddress, kind: defaultKind};
    // console.log(submitObject);
    ipcRenderer.send('settings-watchfolder-add', submitObject);
  }

  displayFolders() {
    let folders;
    try {
      folders = this.state.existingFolders.map((folder, index) => {
        if (!folder) return null;
        return (
          <tr key={index}>
            <td className='path' title={folder.path}><MynOverflowTextMarquee text={folder.path} ellipsis='fade' fadeSize='3em' direction='left' /></td>
            <td className='default-kind'>
              <span className='select-container select-alwaysicon'>
                <select value={folder.kind} onChange={(e) => this.editKind(e,index)}>{this.formFieldKindOptions()}</select>
              </span>
            </td>
            <td className='remove'><button onClick={() => this.editRemove(folder.path, index)}>Remove</button></td>
          </tr>
        )
      });
    } catch(e) {
      console.error("Error finding watchfolders from library: " + e.toString());
    }
    return folders;
  }

  folderSelect() {
    ipcRenderer.once('settings-folder-selected', (event, args) => {
      this.changeTargetFolder(args);
    });
    ipcRenderer.send('settings-folder-select');
  }

  componentDidMount() {
    this.setState({existingFolders: this.props.folders})
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(this.props.kinds,oldProps.kinds)) {
      console.log('MynSettingsFolders : kinds has changed!!!!!!');
    }
    if (!_.isEqual(this.props.folders,oldProps.folders)) {
      console.log('MynSettingsFolders : folders has changed!!!!!!');
      this.setState({existingFolders: this.props.folders})
    }
  }

  render() {
    // console.log(JSON.stringify(this.props.folders));
    return (
      <div id="settings-folders">

        <div id="settings-folders-choose" className='subsection'>
          <h2>Add new watchfolder</h2>
          <div className="choose-section kind">
            <label htmlFor="settings-folders-choose-kind">Default kind: </label>
            <span className='select-container select-alwaysicon'>
              <select id="settings-folders-choose-kind">
                {this.formFieldKindOptions()}
              </select>
            </span>
          </div>
          <div className="choose-section path">
            <label htmlFor="settings-folders-choose-path">Path: </label>
            <div className="input-container">
              <input type="text" id="settings-folders-choose-path" className="empty" value={this.state.folderToAdd || ''} placeholder="Select a directory..." onChange={(e) => this.changeTargetFolder(e.target.value)} />
              <div className="input-clear-button hover" onClick={() => this.changeTargetFolder('')}></div>
            </div>
          </div>
          <div className="choose-section buttons">
            <button onClick={() => this.folderSelect()}>Browse</button>
            <button onClick={this.submitFolderToServer}>Add</button>
          </div>
        </div>

        <div id="settings-folders-folders" className='subsection'>
          <h2>Watchfolders</h2>
          <table className='watchfolders-table' style={{visibility: this.state.existingFolders.length > 0 ? "visible" : "hidden"}}>
            <thead>
              <tr>
                <th className='path'>Path</th>
                <th className='default-kind'>Default Kind</th>
                <th className='remove'>Remove</th>
              </tr>
            </thead>
            <tbody>
              {this.displayFolders()}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

}

class MynSettingsPlaylists extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      playlists : _.cloneDeep(props.playlists),
      valid : {}
    }

    ipcRenderer.on('MynSettingsPlaylists-confirm-delete-playlist', (event, response, id) => {
      if (response === 0) { // yes
        // delete playlist
        let playlists = _.cloneDeep(this.state.playlists).filter(playlist => playlist.id !== id);
        this.setState({playlists:playlists}, () => {
          this.updateValue(); // force a save to the library
        });
      } else {
        console.log('Deletion canceled by user')
      }
    });

    this.updateValue = this.updateValue.bind(this);
    this.reportValid = this.reportValid.bind(this);
    this.showEditPlaylist = this.showEditPlaylist.bind(this);
    this.deletePlaylist = this.deletePlaylist.bind(this);
    this.addPlaylist = this.addPlaylist.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
  }

  updateValue(index,prop,value) {
    // console.log(`Updating ${index}: ${prop} = ${value}`);
    let playlists = _.cloneDeep(this.state.playlists);

    // if an index is given, update that playlist
    if (!isNaN(index) && index >= 0) {
      playlists[index][prop] = value;

      if (prop === 'tab') {
        playlists = this.sortByTab(playlists);
      }

      // update the playlists object in state (this is what is displayed in the editor)
      this.setState({playlists: playlists});
    }

    // if there are no invalid fields, save the updated playlists to the library
    let invalidFields = Object.keys(this.state.valid).filter(key => this.state.valid[key] === false);
    if (invalidFields.length == 0) {
      this.props.save({'playlists':playlists});
    } else {
      console.log('Not saving, the following fields are invalid: ' + invalidFields);
    }
  }

  reportValid(property,valid) {
    console.log(property + ' is ' + (!valid ? 'not ':'') + 'valid');
    if (typeof valid === 'boolean') {
      this.state.valid[property] = valid;
    }
  }

  showEditPlaylist(playlist) {
    let hiddenEls = [];
    hiddenEls.push(document.getElementById('edit-filter-header-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-filter-field-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-columns-header-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-columns-field-' + playlist.id));

    hiddenEls.map(el => {
      if (!el || !el.style) return;
      if (el.style.display === 'none') {
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    });
  }

  deletePlaylist(playlist) {
    let playlistName = playlist.name != '' ? `the '${playlist.name}' playlist` : 'this playlist'
    ipcRenderer.send('generic-confirm', 'MynSettingsPlaylists-confirm-delete-playlist', `Are you sure you want to delete ${playlistName}?`, playlist.id);
  }

  addPlaylist() {
    let newPlaylist = {
      id : uuidv4(),
      name : "",
      filter_function : "false",
      view : "flat",
      tab : true,
      columns : _.cloneDeep(this.props.defaultcolumns.used)
    }
    let playlists = _.cloneDeep(this.state.playlists);
    playlists.unshift(newPlaylist);
    this.setState({playlists : playlists});
    // we do NOT want to call this.updateValue here to force a save,
    // because we don't want the new playlists to start being saved until a name
    // is entered by the user. The playlist will be saved automatically when that
    // or any other change is made to the playlist by the user
  }

  // order playlist array according to the user's drag and drop action
  onDragEnd(result) {
    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      // re-order the array
      const playlists = _.cloneDeep(this.state.playlists);
      const movedItems = playlists.splice(source.index, 1);
      playlists.splice(destination.index, 0, movedItems[0]);

      // now change the 'tab' value of the playlist if it was moved amongst or away from the 'tab'-ed playlists
      if (playlists[destination.index + 1] && playlists[destination.index + 1].tab) {
        playlists[destination.index].tab = true;
      }
      if (playlists[destination.index - 1] && !playlists[destination.index - 1].tab) {
        playlists[destination.index].tab = false;
      }

      this.setState({playlists:playlists}, () => {
        this.updateValue(); // passing no parameters means nothing will be updated, but the whole (newly ordered) array will still be saved
      });
    }
  }

  sortByTab(playlists) {
    playlists.sort((a,b) => {
      return a.tab > b.tab ? -1 : 1;
    });
    return playlists;
  }

  render() {
    // console.log(JSON.stringify(this.state.playlists));

    let playlists = this.state.playlists.map((playlist,i) => {
      if (!playlist) return null;
      return (
        <Draggable key={playlist.id} draggableId={'' + playlist.id} index={i}>
          {(provided) => (
            <MynSettingsPlaylistsTableRow
              playlist={playlist}
              index={i}
              allColumns={this.props.defaultcolumns.used.concat(this.props.defaultcolumns.unused)}
              defaultcolumns={this.props.defaultcolumns}
              updateValue={this.updateValue}
              showEditPlaylist={this.showEditPlaylist}
              deletePlaylist={this.deletePlaylist}
              reportValid={this.reportValid}
              displayColumnName={this.props.displayColumnName}
              innerRef={provided.innerRef}
              provided={provided}
            />
          )}
        </Draggable>
      )
    });

    // add a divider at the end of the tab==true playlists
    // for (let i=0; i<this.state.playlists.length; i++) {
    //   if (this.state.playlists[i-1] && !this.state.playlists[i].tab && this.state.playlists[i-1].tab) {
    //     playlists.splice(i,0,(<tr id='settings-playlists-rowdivider' key='-1'><td/><td/><td/><td/><td/><td/></tr>));
    //   }
    // }

    return (
      <div id='settings-playlists'>
        <DragDropContext onDragEnd={this.onDragEnd}>
          <div className="table" id='settings-playlists-table'>
            <div className="header row">
              <div className="header cell tab" title="Checked playlists will display as tabs. Unchecked playlists will only appear in the dropdown">Tab</div>
              <div className="header cell name">Name</div>
              <div className="header cell view" title="Flat view displays items as a simple list. Series view displays only items that are part of a series.">View</div>
              <div className="header cell add-btn"><button onClick={() => this.addPlaylist()}>Add...</button></div>
            </div>
            <Droppable droppableId='settings-playlist-table'>
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps}>
                  {playlists}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>
        </DragDropContext>
      </div>
    );
  }
}

class MynSettingsPrefs extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      defaultcolumns : {
        used : _.cloneDeep(props.settings.preferences.defaultcolumns.used),
        unused : _.cloneDeep(props.settings.preferences.defaultcolumns.unused)
      },
      hide_description : props.settings.preferences.hide_description,
      include_new_vids_in_playlists : props.settings.preferences.include_new_vids_in_playlists,
      remove_autotagged_from_new: props.settings.preferences.remove_autotagged_from_new,
      exclude_samples_from_library :
        props.settings.preferences.exclude_samples_from_library !== false,
      exclude_trailers_from_library :
        props.settings.preferences.exclude_trailers_from_library !== false,
      include_user_rating_in_avg : props.settings.preferences.include_user_rating_in_avg,
      kinds : props.settings.used.kinds.filter(kind => !!kind),
      override_dialogs : props.settings.preferences.override_dialogs
    }

    this.update = this.update.bind(this);
  }

  update(property, value, subProp) {
    let address = '';
    switch(property) {
      case "columns" :
        address = "settings.preferences.defaultcolumns";
        this.setState({defaultcolumns:value});
        break;
      case "hide-description" :
        address = "settings.preferences.hide_description";
        this.setState({hide_description:value});
        break;
      case "user-rating-avg" :
        address = "settings.preferences.include_user_rating_in_avg";
        this.setState({include_user_rating_in_avg:value});
        break;
      case "include-new" :
        address = "settings.preferences.include_new_vids_in_playlists";
        this.setState({include_new_vids_in_playlists:value});
        break;
      case "remove-autotagged-new":
        address = "settings.preferences.remove_autotagged_from_new";
        this.setState({ remove_autotagged_from_new: value });
        break;
      case "exclude-samples":
        address = "settings.preferences.exclude_samples_from_library";
        this.setState({exclude_samples_from_library:value});
        break;
      case "exclude-trailers":
        address = "settings.preferences.exclude_trailers_from_library";
        this.setState({exclude_trailers_from_library:value});
        break;
      case "kinds" :
        address = "settings.used.kinds";
        this.setState({kinds:value});
        break;
      case "override-dialogs" :
        address = "settings.preferences.override_dialogs";
        let new_od = _.cloneDeep(this.state.override_dialogs);
        new_od[subProp] = value;
        value = new_od;
        this.setState({override_dialogs:value});
        break;
    }

    if (address !== '') {
      let saveObj = {};
      saveObj[address] = value;
      this.props.save(saveObj);
    } else {
      console.error('No address was provided to save.');
    }
  }

  render() {
    const dialogDescriptions = {
      'MynEditorSearch-confirm-select' : 'Confirm selection of search result in video editor',
      'MynEditor-confirm-exit' : 'Confirm on exiting video editor without saving',
      'MynEditorEdit-confirm-revert' : 'Confirm on reverting to saved values in video editor',
      'MynLibTable-confirm-inlineEdit' : (
        <span>
          {'Confirm when editing a video directly from a widget'}
          <br/>
          {'in a table row (e.g. the rating stars)'}
        </span>
      )
    }

    return (
      <div id='settings-preferences'>
        <ul className='sections-container'>
          <li id='settings-prefs-cols' className='subsection'>
            <h2>Default Columns for new playlists:</h2>
            <MynSettingsColumns
              used={this.state.defaultcolumns.used}
              unused={this.state.defaultcolumns.unused}
              defaultcolumns={this.props.settings.preferences.defaultdefaultcolumns}
              update={this.update}
              displayTransform={this.props.displayColumnName}
              storeTransform={(val) => this.props.displayColumnName(val,true)}
            />
          </li>
          <li id='settings-prefs-kinds' className='subsection'>
            <h2>Media Kinds:</h2>
            <MynEditInlineAddListWidget
              object={this.state}
              property="kinds"
              update={this.update}
              options={null}
              deleteDialog={'Videos of this kind will not be affected until edited.'}
              storeTransform={value => value.toLowerCase()}
              displayTransform={value => value.replace(/\b\w/g,(letter) => letter.toUpperCase())}
              validator={/^[^=;{}]+$/}
              validatorTip={"Not allowed: = ; { }"}
              reportValid={() => {}}
            />
          </li>
          <li id='settings-prefs-libraryexclusions' className='subsection'>
            <h2>Library Exclusions:</h2>
            <div>
              <input
                type='checkbox'
                checked={this.state.exclude_samples_from_library}
                onChange={(e) => this.update('exclude-samples',e.target.checked)}
              />
              Exclude sample videos from library
              <MynTooltip tip="If checked, short release samples and known release-group garbage clips will be excluded on the next watchfolder scan" />
            </div>
            <div>
              <input
                type='checkbox'
                checked={this.state.exclude_trailers_from_library}
                onChange={(e) => this.update('exclude-trailers',e.target.checked)}
              />
              Exclude trailers from library
              <MynTooltip tip="If checked, short videos whose filenames identify them as trailers will be excluded on the next watchfolder scan" />
            </div>
          </li>
          <li id='settings-prefs-includenew' className='subsection'>
            <h2>Include New:</h2>
            <input
              type='checkbox'
              checked={this.state.include_new_vids_in_playlists ? true : false}
              onChange={(e) => this.update('include-new',e.target.checked)}
            />
            Include new videos in playlists
            <MynTooltip tip="If unchecked, newly added videos will appear only in the 'New' playlist until edited (or auto-tagged)" />
          </li>
          <li id='settings-prefs-removeautotaggednew' className='subsection'>
            <h2>Removed Autotagged from New:</h2>
            <input
              type='checkbox'
              checked={this.state.remove_autotagged_from_new}
              onChange={(e) => this.update('remove-autotagged-new', e.target.checked)}
            />
            Remove all videos from 'New' playlist after auto-tagging 
            <MynTooltip tip="If unchecked, videos will only be removed from the 'New' playlist when manually edited/tagged" />
          </li>
          <li id='settings-prefs-hidedescrip' className='subsection'>
            <h2>Hide Descriptions:</h2>
            <input
              type='checkbox'
              checked={this.state.hide_description === "hide" ? true : false}
              onChange={(e) => this.update('hide-description',e.target.checked ? "hide" : "show")}
            />
            Hide plot summaries
            <MynTooltip tip="Hide plot summaries in the Details pane until clicked on" />
          </li>
          <li id='settings-prefs-userratingavg' className='subsection'>
            <h2>Average Rating:</h2>
            <input
              type='checkbox'
              checked={this.state.include_user_rating_in_avg ? true : false}
              onChange={(e) => this.update('user-rating-avg',e.target.checked)}
            />
            Include user rating in avg rating
            <MynTooltip tip="If checked, the user rating (i.e. the rating stars) will be included along with the external ratings (Rotten Tomatoes, Metacritic, and IMDb) when calculating the average (though only if you've actually rated it). If unchecked, the average will only be calculated from the external ratings." />
          </li>
          <li id='settings-prefs-showdialogs' className='subsection' style={{display: this.props.settings.preferences.override_dialogs && Object.keys(this.props.settings.preferences.override_dialogs).length > 0 ? 'block' : 'none'}}>
            <h2>Show Confirmation Dialogs:</h2>
            {this.state.override_dialogs ? Object.keys(this.state.override_dialogs).map(dialogName => (
              <div className='dialog' key={dialogName} style={{display:'flex'}}>
                <input
                  type='checkbox'
                  checked={!this.state.override_dialogs[dialogName]}
                  onChange={(e) => this.update('override-dialogs',!e.target.checked,dialogName)}
                />
                <div className='showdialog-descrip'>{dialogDescriptions[dialogName] || dialogName}</div>
              </div>
            )) : null}
          </li>
        </ul>
      </div>
    );
  }
}

class MynSettingsColumns extends React.Component {
  constructor(props) {
    super(props);

    // this.state = {
    //   used : _.cloneDeep(props.used),
    //   unused : _.cloneDeep(props.unused)
    // }

    this.onDragEnd = this.onDragEnd.bind(this);
  }

  onDragEnd(result) {
    let temp = {};
    temp.used = _.cloneDeep(this.props.used);
    temp.unused = _.cloneDeep(this.props.unused);

    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      // move the item
      const movedItems = temp[source.droppableId].splice(source.index,1);

      // transform the item if given a transform function
      let movedItem;
      try {
        movedItem = this.props.storeTransform(movedItems[0]);
      } catch(err) {
        movedItem = movedItems[0];
      }

      // store the item in the new location
      temp[destination.droppableId].splice(destination.index, 0, movedItems[0]);
    }

    this.props.update('columns',temp);//{ used : this.props.used, unused : this.props.unused });
  }

  render() {
    return (
      <DragDropContext onDragEnd={this.onDragEnd}>
        <div className='settings-columns'>
          <Droppable droppableId='used' direction='horizontal'>
            {(provided) => (
              <div>
                <label>Used:</label>
                <ul className="columns-list used" ref={provided.innerRef} {...provided.droppableProps}>
                  {this.props.used.map((col,i) => (
                    <Draggable key={col} draggableId={col} index={i}>
                      {(provided) => (
                        <li className='col' ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{this.props.displayTransform ? this.props.displayTransform(col) : col}</li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              </div>
            )}
          </Droppable>
          <Droppable droppableId='unused' direction='horizontal'>
          {(provided) => (
            <div>
              <label>Available:</label>
              <ul className="columns-list unused" ref={provided.innerRef} {...provided.droppableProps}>
                {this.props.unused.map((col,i) => (
                  <Draggable key={col} draggableId={col} index={i}>
                    {(provided) => (
                      <li className='col' ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{this.props.displayTransform ? this.props.displayTransform(col) : col}</li>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </ul>
            </div>
          )}
          </Droppable>
          <button className='settings-prefs-restore-btn' onClick={() => this.props.update('columns',this.props.defaultcolumns)}>Restore Default Columns</button>
        </div>
      </DragDropContext>
    );
  }
}

class MynSettingsPlaylistsTableRow extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    let playlist = this.props.playlist;

    let dragButton = (
      <div className='cell drag-button' {...this.props.provided.dragHandleProps}>
        {'\u2630'}
      </div>
    );

    let tabCheckbox = (
      <div className='cell tab'>
        <input
          type='checkbox'
          checked={playlist.tab}
          onChange={(e) => this.props.updateValue(this.props.index,'tab',e.target.checked)}
        />
      </div>
    );

    let uneditable = playlist.id === 'new';
    let newToolTip = "The 'New' playlist is a special built-in playlist that only appears when there are 'new' videos. A video is new when it is first added to the library. This gives you a convenient place to edit/tag new videos. Once edited, a video is no longer new, and disappears from the New playlist (but this can be edited in the video editor). The 'New' playlist cannot be deleted, but you can hide it by unchecking the 'tab' property."
    let name = (
      <div className='cell name name-and-edit'>
        <MynEditText
          object={playlist}
          property='name'
          update={(...args) => this.props.updateValue(this.props.index,...args)}
          options={null}
          validator={/[^\s]/}
          validatorTip={'At least 1 non-whitespace character'}
          allowedEmpty={false}
          reportValid={this.props.reportValid}
          uneditable={uneditable}
          tooltip={playlist.id === 'new' ? newToolTip : null}
        />
      </div>
    );

    let filterHeader = (
      <div className='header filter' id={'edit-filter-header-' + playlist.id} style={{display: 'none'}}>
        Filter
      </div>
    );

    let filterEditor = (
      <div className="cell filter" id={'edit-filter-field-' + playlist.id} style={{display: 'none'}}>
        <textarea
          className='edit-filter-field'
          name="playlist filter"
          value={playlist.filter_function}
          placeholder={'Enter a boolean expression to be executed on each video object: e.g. video.genre === \'Action\''}
          onChange={(e) => this.props.updateValue(this.props.index,'filter_function',e.target.value)}
        />
      </div>
    );

    let columnsHeader = (
      <div className='header columns' id={'edit-columns-header-' + playlist.id} style={{display: 'none'}}>
        Columns
      </div>
    );

    let columnsEditor = (
      <div className="cell columns" id={'edit-columns-field-' + playlist.id} style={{display: 'none'}}>
        <MynSettingsColumns
          used={playlist.columns}
          defaultcolumns={this.props.defaultcolumns}
          unused={this.props.allColumns.filter(col => !playlist.columns.includes(col))}
          update={(prop, columns) => this.props.updateValue(this.props.index,prop,columns.used)}
          displayTransform={this.props.displayColumnName}
          storeTransform={(val) => this.props.displayColumnName(val,true)}
        />
      </div>
    );

    let view = (
      <div className='cell view'>
        <div className='select-container select-alwaysicon'>
          <select value={playlist.view} onChange={(e) => this.props.updateValue(this.props.index,'view',e.target.value)}>
            <option value='flat'>Flat</option>
            <option value='series'>Series</option>
          </select>
        </div>
      </div>
    );

    let editButton = (
      <div className='cell edit-btn'>
        <button onClick={() => this.props.showEditPlaylist(playlist)}>Edit</button>
      </div>
    );

    let deleteButton = (
      <div className='cell delete-btn'>
        <button onClick={() => this.props.deletePlaylist(playlist)}>Delete</button>
      </div>
    );

    // several things are not to be displayed for the 'new' playlist, because it's a special playlist
    return (
      <div className="row" id={'settings-playlists-row-' + playlist.id} ref={this.props.innerRef} {...this.props.provided.draggableProps}>
        {dragButton}
        {tabCheckbox}
        {name}
        {playlist.id === 'new' ? null : filterHeader}
        {playlist.id === 'new' ? null : filterEditor}
        {columnsHeader}
        {columnsEditor}
        {view}
        {editButton}
        {playlist.id === 'new' ? null : deleteButton}
      </div>
    );

  }
}

class MynSettingsSync extends React.Component {
  constructor(props) {
    super(props);
    this.state = {driveList : [],
      driveInfo : [],
      selectedDrive : ''}

    this.render = this.render.bind(this);
    //this.findDrives = this.findDrives.bind(this);
    this.selectDrive = this.selectDrive.bind(this);
    this.plantManifest = this.plantManifest.bind(this);
    this.exportFiles = this.exportFiles.bind(this);
  }

  /*findDrives() {
    lsDevices()
    .then((drives) => {
      let currentDriveList = [<option key={-1} disabled selected value> -- select an option -- </option>];
      for (let i=0; i<drives.length; i++) {
        let drive = drives[i];
        currentDriveList.push( <option key={i} value={drive.caption}>{drive.caption} {drive.so.VolumeName}</option>);
      }
      this.setState({driveList : currentDriveList, driveInfo : drives});
      console.log(currentDriveList);
    })
    .catch((err) => {
        console.log(err);
    });
  }*/

  folderSelect() {
    ipcRenderer.once('settings-folder-selected', (event, args) => {
      this.changeTargetFolder(args);
    });
    ipcRenderer.send('settings-folder-select');
  }

  changeTargetFolder(folder) {
    this.setState({selectedDrive: folder});
  }


  exportFiles(e) {
    if (!this.state.selectedDrive) {
      alert('You have to select a drive, you silly goose!');
      return;
    }
    ipcRenderer.send('exportFiles', this.state.selectedDrive);
  }

  plantManifest(e) {
    if (!this.state.selectedDrive) {
      alert('You have to select a drive, you silly goose!');
      return;
    }
    let location = path.join(this.state.selectedDrive, "Mynda Manifest.json");
    library.save(location);
  }

  importFiles(e) {
  }

  selectDrive(e) {
    this.setState({selectedDrive : e.target.value});
  }

  render() {
    return (<div>
      <div className="input-container">
        <input type="text" id="settings-sync-choose-path" className="empty" value={this.state.selectedDrive || ''} placeholder="Select a directory..." onChange={(e) => this.changeTargetFolder(e.target.value)} />
        <div className="input-clear-button hover" onClick={() => this.changeTargetFolder('')}></div>
      </div>
      <div><button onClick={() => this.folderSelect()}>Browse</button></div>
      <div>
        <span style={{width: '33%'}}><button onClick={this.plantManifest}>Request</button></span>
        <span style={{width: '33%'}}><button onClick={this.exportFiles}>Export</button></span>
        <span style={{width: '33%'}}><button onClick={this.importFiles}>Import</button></span>
      </div>
    </div>)
  }

}


class MynSettingsThemes extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    return (<h1>I'm a Themee!!!</h1>)
  }
}

// ###### Editor: overlayed pane for editing video information (tagging) ###### //
class MynEditor extends MynOpenablePane {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      paneID: 'editor-pane',
      placeholderImage: placeholderImage,
      valid: {},
      changed: new Set(),

      // Batch fields normally hold one value that is applied to every video.
      // A filename reset is different: each episode gets its own detected
      // title/season/episode. Keep those individual patches here until Save.
      pendingFilenameResetPatches: {},

      // The main process derives the patches and owns the native confirmation
      // dialog. While that round trip is pending, prevent a form submission
      // from racing ahead and saving before the patches reach the renderer.
      resetFromFilenamePending: false,

      // This remains true after confirmation until Save or Revert. It also
      // covers single-video resets, which apply their patch directly to the
      // editable video rather than storing a per-video batch patch.
      filenameResetStaged: false
    }

    this.render = this.render.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.revertChanges = this.revertChanges.bind(this);
    this.requestResetFromFilename = this.requestResetFromFilename.bind(this);
    this.saveChanges = this.saveChanges.bind(this);
    this.reportValid = this.reportValid.bind(this);
  }

  reportValid(property,valid) {
    if (typeof valid === 'boolean' && property !== undefined) {
      this.state.valid[property] = valid;
    }
  }

  // handleChange(value,prop) {
  //   // console.log('Editing ' + prop);
  //   let update = this.state.video;
  //   update[prop] = value;
  //   this._isMounted && this.setState({data : update});
  // }

  handleChange(...args) {
    // console.log("UPDATING");

    let update;
    let suppliedChanges;
    const previousSeries = this.state.video && this.state.video.series;
    const previousKind = this.state.video && this.state.video.kind;
    // if we were passed two arguments, treat them as prop,value
    if (args.length == 2 && typeof args[0] === "string") {
      suppliedChanges = {[args[0]]: args[1]};
      update = this.state.video;
      update[args[0]] = args[1];

      // keep track of which fields have been changed
      if (args[1] === '')/* || (Array.isArray(args[1]) && args[1].length === 0))*/ {
        // if the updated value is empty, do NOT save this property
        this.state.changed.delete(args[0]);
      } else {
        // otherwise, mark it as changed
        this.state.changed.add(args[0]);
      }
    }
    // if we were passed one argument, it should be an object, where
    // the keys are video props, and the values are those props' values
    else if (args.length == 1 && typeof args[0] === "object") {
      //console.log(JSON.stringify(args[0]));
      suppliedChanges = args[0];
      update = { ...this.state.video, ...args[0] };
      //console.log(JSON.stringify(update));

      // keep track of which fields have been changed
      Object.keys(args[0]).map(field => {
        if (args[0][field] === '')/* || (Array.isArray(args[0][field]) && args[0][field].length === 0))*/ {
          // if the updated value is empty, do NOT save this property
          this.state.changed.delete(field);
        } else {
          // otherwise, mark it as changed
          this.state.changed.add(field);
        }
      });
    } else {
      throw 'Incorrect parameters passed to handleChange in MynEditor';
    }

    // seriesImdbID identifies the parent show represented by `series`. A
    // manual series rename makes the old ID unsafe, and changing a video's
    // kind away from show makes it meaningless. Explicit OMDb results include
    // their own seriesImdbID and therefore are not cleared here.
    const suppliedSeries = Object.prototype.hasOwnProperty.call(suppliedChanges, 'series');
    const suppliedSeriesID = Object.prototype.hasOwnProperty.call(suppliedChanges, 'seriesImdbID');
    const seriesChanged = suppliedSeries && suppliedChanges.series !== previousSeries;
    const kindChangedAwayFromShow =
      Object.prototype.hasOwnProperty.call(suppliedChanges, 'kind') &&
      suppliedChanges.kind !== previousKind && suppliedChanges.kind !== 'show';
    const batchWillSaveSeries = this.state.video && this.state.video.id === 'batch' ?
      this.state.changed.has('series') : true;

    if ((seriesChanged && !suppliedSeriesID && batchWillSaveSeries) || kindChangedAwayFromShow) {
      update.seriesImdbID = '';
      // Empty values are normally removed from the batch changed set. This
      // empty value is an intentional clear and must be applied to every video
      // whose series/kind edit invalidated the old parent ID.
      this.state.changed.add('seriesImdbID');
    }

    this._isMounted && this.setState({video : update});

    // just for debugging:
    let changedFields = []
    this.state.changed.forEach(field => {changedFields.push(field)});
    console.log('Changed Fields: ' + changedFields.join(', '));
  }

  revertChanges() {
    this.componentDidUpdate({video:null});

  }

  // Ask the main process to rerun the same conservative filename/folder
  // detector used for brand-new videos. The native confirmation explains the
  // wider reset (IMDb/catalog fields are cleared), and a private response
  // channel prevents simultaneous editor actions from hearing one another.
  requestResetFromFilename(event) {
    if (event) event.preventDefault();
    if (!this.state.video) return;
    if (this.state.resetFromFilenamePending) {
      editorLog.warn('Ignored duplicate filename-reset request while the first request was pending');
      return;
    }

    let sourceVideos;
    if (this.state.video.id === 'batch') {
      sourceVideos = (this.props.batch || []).map(video => {
        const source = _.cloneDeep(video);

        // Ratings are one object in the editor, but only the external catalog
        // ratings are reset. Carry a pending batch user-rating edit into every
        // source object so the backend can preserve that unsaved value too.
        if (this.state.changed.has('ratings') && this.state.video.ratings) {
          source.ratings = source.ratings || {};
          source.ratings.user = this.state.video.ratings.user;
        }
        return source;
      });
    } else {
      sourceVideos = [this.state.video];
    }
    if (!sourceVideos || sourceVideos.length === 0) return;

    const requestedSelectionKey = editorSelectionKey(this.state.video, this.props.batch);
    const responseChannel = `reset-from-filename-${process.pid}-${++nextFilenameResetNumber}`;
    this.setState({resetFromFilenamePending: true});
    editorLog.info('Requesting filename-derived editor reset', {
      videoCount: sourceVideos.length,
      selectionType: this.state.video.id === 'batch' ? 'batch' : 'single',
      changedFieldsBeforeReset: Array.from(this.state.changed).sort()
    });

    const handleResetResponse = (ipcEvent, response) => {
      // The native dialog can remain open while the renderer changes for other
      // reasons. Never apply its eventual response to a different selection.
      const currentSelectionKey = editorSelectionKey(this.state.video, this.props.batch);
      if (currentSelectionKey !== requestedSelectionKey) {
        editorLog.warn('Ignored filename-reset response because the editor selection changed', {
          requestedSelectionKey: requestedSelectionKey,
          currentSelectionKey: currentSelectionKey
        });
        this._isMounted && this.setState({resetFromFilenamePending: false});
        return;
      }

      if (response && response.error) {
        editorLog.error('Filename-derived editor reset failed', {
          error: response.error
        });
        this.setState({resetFromFilenamePending: false});
        alert(`Mynda could not reset the video information: ${response.error}`);
        return;
      }
      if (!response || !response.confirmed || !Array.isArray(response.patches)) {
        editorLog.info('Filename-derived editor reset canceled', {
          videoCount: sourceVideos.length
        });
        this.setState({resetFromFilenamePending: false});
        return;
      }

      const patchesByID = {};
      response.patches.forEach(item => {
        if (item && item.id && item.changes) {
          patchesByID[item.id] = item.changes;
        }
      });
      const patches = Object.values(patchesByID);
      if (patches.length === 0) {
        editorLog.warn('Filename-reset response contained no usable patches', {
          requestedVideoCount: sourceVideos.length
        });
        this.setState({resetFromFilenamePending: false});
        return;
      }

      const resetFields = new Set();
      patches.forEach(patch => Object.keys(patch).forEach(field => resetFields.add(field)));

      // A reset deliberately replaces any unsaved edits to fields that it
      // controls. Changes to unrelated user fields, notably tags, remain in
      // the ordinary changed set and will still be applied at Save time.
      const changed = new Set(
        Array.from(this.state.changed).filter(field => !resetFields.has(field))
      );

      if (this.state.video.id !== 'batch') {
        const patch = patchesByID[this.state.video.id];
        if (!patch) {
          editorLog.warn('Filename-reset response did not contain the open video', {
            requestedVideoCount: sourceVideos.length,
            receivedPatchCount: patches.length
          });
          this.setState({resetFromFilenamePending: false});
          return;
        }

        Object.keys(patch).forEach(field => changed.add(field));
        this.setState({
          video: {...this.state.video, ..._.cloneDeep(patch)},
          changed: changed,
          pendingFilenameResetPatches: {},
          resetFromFilenamePending: false,
          filenameResetStaged: true
        });
        editorLog.info('Staged filename-derived reset in the editor', {
          videoCount: 1,
          patchCount: 1,
          resetFields: Array.from(resetFields).sort(),
          changedFieldsAfterReset: Array.from(changed).sort()
        });
        return;
      }

      // The batch form can display only values shared by every video. Build a
      // preview of the reset fields using the same intersection rules as the
      // original batch object, while retaining every per-video patch for Save.
      const commonPatch = {};
      resetFields.forEach(field => {
        let commonValue = _.cloneDeep(patches[0][field]);
        for (let i=1; i<patches.length; i++) {
          const value = patches[i][field];
          if (Array.isArray(commonValue) && Array.isArray(value)) {
            commonValue = commonValue.filter(item => value.includes(item));
          } else if (commonValue && typeof commonValue === 'object' && value && typeof value === 'object') {
            Object.keys(commonValue).forEach(key => {
              if (!_.isEqual(commonValue[key], value[key])) commonValue[key] = '';
            });
          } else if (!_.isEqual(commonValue, value)) {
            commonValue = '';
          }
        }
        commonPatch[field] = commonValue;
      });

      this.setState({
        video: {...this.state.video, ...commonPatch},
        changed: changed,
        pendingFilenameResetPatches: patchesByID,
        resetFromFilenamePending: false,
        filenameResetStaged: true
      });
      editorLog.info('Staged filename-derived batch reset in the editor', {
        requestedVideoCount: sourceVideos.length,
        receivedPatchCount: patches.length,
        resetFields: Array.from(resetFields).sort(),
        changedFieldsAfterReset: Array.from(changed).sort()
      });
    };

    ipcRenderer.once(responseChannel, handleResetResponse);
    try {
      ipcRenderer.send('reset-from-filename', responseChannel, sourceVideos);
    } catch(err) {
      ipcRenderer.removeListener(responseChannel, handleResetResponse);
      this.setState({resetFromFilenamePending: false});
      editorLog.error('Could not request filename-derived editor reset', {
        error: err && err.stack ? err.stack : String(err)
      });
    }
  }

  saveChanges(event) {
    if (event) {
      event.preventDefault();
    }

    // A form can still submit via Enter even when its visible submit button is
    // disabled. Refuse that race explicitly so Save cannot run between the
    // reset request and the arrival of its per-video patches.
    if (this.state.resetFromFilenamePending) {
      editorLog.warn('Blocked editor save while filename reset was pending');
      alert('Please wait for the filename reset to finish before saving.');
      return;
    }

    /* make sure all the fields are valid before submitting */
    // console.log("VALID: " + JSON.stringify(this.state.valid));
    let valid = true;
    let invalidFields = [];
    for (var i=0, keys=Object.keys(this.state.valid); i<keys.length; i++) {
      if (this.state.valid[keys[i]] == false) {
        valid = false;
        invalidFields.push(keys[i]);
      }
    }
    if (!valid) {
      alert("Invalid Input in " + invalidFields);
      return;
    }

    // Before saving, we need to move the artwork image to the appropriate
    // folder in the user data. In the case of a new image, it may either be
    // in its original location on the user's local drive (in the case that
    // the user browsed to it or entered its path manually), or it may be
    // saved in a temp folder (in the case that it was downloaded from a URL)
    if (this._isMounted && typeof this.state.video.artwork === 'string' && this.state.video.artwork !== '') {
      let fileExt;
      try {
        fileExt = this.state.video.artwork.match(/.\w{3,4}$/)[0];
      } catch(err) {
        fileExt = '.jpg'; // just use .jpg as the extension if we can't find one, i guess?
      }

      const artworkFolder = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork');
      const oldArtworkPath = path.resolve(__dirname, this.state.video.artwork); // create the correct absolute path, in case it was a relative one
      // if the file is not already in the Artwork folder,
      // copy it there and update the reference to it in the video object
      if (path.resolve(path.dirname(oldArtworkPath)) !== path.resolve(artworkFolder)) {
        const newArtworkPath = path.join(artworkFolder, uuidv4() + fileExt);
        fs.copyFile(oldArtworkPath, newArtworkPath, (err) => {
          if (err) {
            console.error(err);
          } else {
            console.log('artwork was copied successfully: ' + newArtworkPath);
          }
        });
        // this.handleChange({'artwork':newArtworkPath}); // <-- I think this was happening too slowly (part of the function is async), so the new path was not being saved
        this.state.video.artwork = newArtworkPath;
        console.log("updated state var: " + this.state.video.artwork);
      } else {
        console.log('Not copying image, as it is already in the artwork folder');
      }
    }

    /* Submit */
    // console.log('saving...');

    // When a batch is saved, this object remains non-null until the final
    // queued library operation reports completion. The edited videos are
    // prepared individually below, but Library commits the resulting media
    // array with one atomic write instead of rewriting library.json per video.
    let batchSaveProgress = null;
    let batchVideosToSave = [];

    // if we're editing multiple videos
    // find the edited fields, and apply only those changes to
    // the videos in the batch
    if (this.state.video.id === 'batch') {
      // Reminder: this.state.video is the edited 'batch object',
      // initially containing the values of the elements all the videos have in common,
      // and now also containing any changes the user made in the editor,
      // which we will now apply to the videos and then save them

      console.log('SAVING BATCH')
      console.log('Changed Fields: ' + JSON.stringify(this.state.changed))
      if (this.props.batch) { // <-- this should always be true if this.state.video.id === 'batch', this is just for safety
        const changedFields = Array.from(this.state.changed).sort();
        const filenameResetPatches = this.state.pendingFilenameResetPatches || {};
        const filenameResetPatchCount = Object.keys(filenameResetPatches).length;

        // A confirmed batch reset must have one private patch per selected
        // video. If that invariant is ever broken, stop instead of silently
        // saving only the user's ordinary overrides (the original symptom).
        if (this.state.filenameResetStaged && filenameResetPatchCount !== this.props.batch.length) {
          editorLog.error('Blocked batch save because staged filename-reset patches were incomplete', {
            videoCount: this.props.batch.length,
            filenameResetPatchCount: filenameResetPatchCount,
            changedFields: changedFields
          });
          alert('The filename reset data is incomplete, so Mynda has not saved this batch. Please use Reset from Filename again.');
          return;
        }

        editorLog.info('Preparing editor batch save', {
          videoCount: this.props.batch.length,
          filenameResetStaged: Boolean(this.state.filenameResetStaged),
          filenameResetPatchCount: filenameResetPatchCount,
          changedFields: changedFields
        });

        batchSaveProgress = {
          numCurrent: 0,
          numTotal: this.props.batch.length
        };

        // Show the banner before the first synchronous file write begins. With
        // only numTotal supplied, MynNotify initially says "Saving N videos";
        // subsequent callbacks add the familiar "X of N" counter.
        if (batchSaveProgress.numTotal > 0) {
          sendLocalStatusUpdate({
            action: 'batch_save',
            numTotal: batchSaveProgress.numTotal
          });
        }

        // loop through the videos we're editing
        this.props.batch.map(video => {
          // Unlike ordinary batch edits, this reset contains a different
          // derived title/season/episode for each file. Apply that video's
          // private patch first; any fields the user edited afterwards are
          // applied by the normal changed-fields loop below and therefore win.
          const filenameResetPatch = filenameResetPatches[video.id];
          if (filenameResetPatch) {
            Object.assign(video, _.cloneDeep(filenameResetPatch));
          }

          // loop through each property of this video
          Object.keys(video).map(prop => {
            if (prop === 'id' || prop === 'metadata') return;

            // if this property was changed
            if (this.state.changed.has(prop)) {
              if (Array.isArray(this.state.video[prop])) {
                // if this property is an array, we need to compare individual array elements

                // deleted any of the common elements that the user deleted
                let deleted = this.state.batchObjectUnedited[prop].filter(el => !this.state.video[prop].includes(el));
                video[prop] = video[prop].filter(el => !deleted.includes(el));

                // add any new elements the user added
                let added = this.state.video[prop].filter(el => !this.state.batchObjectUnedited[prop].includes(el)).filter(el => !video[prop].includes(el));
                video[prop] = [...video[prop], ...added];

              } else if (typeof this.state.video[prop] === 'object' && this.state.video[prop] !== null) {
                // if this property is an object, we need to compare individual object properties

                let original = this.state.batchObjectUnedited[prop];
                let altered = this.state.video[prop];

                // any props that were in the original batch object (common to all videos)
                // and were changed, add the change to this video
                Object.keys(original).map(subProp => {
                  if (altered[subProp] !== original[subProp]) {
                    video[prop][subProp] = altered[subProp];
                  }
                });
                // any props that were not in the original batch object but were added,
                // add the change to this video
                Object.keys(altered).map(subProp => {
                  if (typeof original[subProp] === "undefined") {
                    video[prop][subProp] = altered[subProp];
                  }
                });

              } else {
                // this property is not an array or an object,
                // so we simply replace the old value with the edited value
                video[prop] = this.state.video[prop];
              }
            }
          });
          console.log('EDITED: ' + JSON.stringify(video));

          // Prepare this video's final replacement. Do not submit it yet:
          // replaceMediaBatch() will merge every prepared video into the
          // freshest media array and commit that array with one library write.
          let temp = _.cloneDeep(video);
          temp.seriesImdbID = temp.kind === 'show' &&
            typeof temp.seriesImdbID === 'string' ? temp.seriesImdbID : '';
          temp.autotag_tried = false; // reset this flag whenever a video is saved
          // Transient signal for Library.js; it is removed before saving.
          temp.__mynda_subtitles_edited = this.state.changed.has('subtitles');
          batchVideosToSave.push(temp);
        });

        if (batchVideosToSave.length > 0) {
          library.replaceMediaBatch(batchVideosToSave, (err) => {
            if (err) {
              console.error(`Could not save video batch: ${err}`);
              editorLog.error('Editor video batch save failed', {
                videoCount: batchVideosToSave.length,
                filenameResetPatchCount: filenameResetPatchCount,
                error: err && err.stack ? err.stack : String(err)
              });
            } else {
              // The complete media-array write has finished. Jump the counter
              // to N of N and leave it visible until the queued settings save
              // below also completes.
              batchSaveProgress.numCurrent = batchSaveProgress.numTotal;
              editorLog.info('Editor video batch saved', {
                videoCount: batchVideosToSave.length,
                filenameResetPatchCount: filenameResetPatchCount,
                changedFields: changedFields
              });
            }
            sendLocalStatusUpdate({
              action: 'batch_save',
              numCurrent: batchSaveProgress.numCurrent,
              numTotal: batchSaveProgress.numTotal
            });
          });
        }

      } else {
        console.error('The video objects were not supplied to MynEditor when editing multiple videos');
      }
    } else {
      // SINGLE VIDEO
      // save the video data in library.media
      let temp = _.cloneDeep(this.state.video);
      temp.seriesImdbID = temp.kind === 'show' &&
        typeof temp.seriesImdbID === 'string' ? temp.seriesImdbID : '';
      temp.autotag_tried = false; // reset this flag whenever a video is saved
      // Transient signal for Library.js; it is removed before saving.
      temp.__mynda_subtitles_edited = this.state.changed.has('subtitles');
      let index = library.media.findIndex((video) => video && video.id === this.props.video.id);
      library.replace("media." + index, temp);
    }

    // then, add any new tags to the library.settings.used.tags list so they'll be available
    // as options for the next video the user edits
    let tags = [...this.props.settings.used.tags];
    tags = tags.concat(this.state.video.tags.filter(tag => tags.indexOf(tag) < 0)).sort();

    // and then do the same for genres
    let genres = [...this.props.settings.used.genres];
    const saveNewGenre = this.state.video.genre !== '' && genres.indexOf(this.state.video.genre) < 0;

    // Whichever settings operation is last owns the completion callback. The
    // callback is omitted for ordinary single-video saves, whose behavior and
    // lack of a progress banner remain unchanged.
    const finishBatchSave = batchSaveProgress && batchSaveProgress.numTotal > 0 ? (err) => {
      // Tags and genres are queued after the one media-array replacement. Keep
      // the completed "N of N" message visible until the final settings
      // operation finishes, then release the banner for the next task.
      if (err) {
        console.error(`Could not finish batch save: ${err}`);
        editorLog.error('Could not finish editor batch settings save', {
          videoCount: batchSaveProgress.numTotal,
          error: err && err.stack ? err.stack : String(err)
        });
      } else {
        editorLog.info('Editor batch save finished', {
          videoCount: batchSaveProgress.numTotal
        });
      }
      sendLocalStatusUpdate({action: ''});
    } : undefined;

    library.replace("settings.used.tags", tags, saveNewGenre ? undefined : finishBatchSave);

    if (saveNewGenre) {
      // library.add("settings.used.genres.0",this.state.video.genre);
      genres.push(this.state.video.genre);
      genres.sort();
      library.replace("settings.used.genres", genres, finishBatchSave);
    }

    // console.log('object when saving:');
    // console.log(this.state.video);

    // save hash so that later we can check if the video has changed
    // (in order to ask the user if they want to save before exiting)
    // and reset the 'changed' set (which keeps track of which fields
    // are changed before saving)
    this.setState({
      saveHash: hashObject(this.state.video),
      changed: new Set(),
      pendingFilenameResetPatches: {},
      resetFromFilenamePending: false,
      filenameResetStaged: false
    });
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.video, this.props.video)) {
      const oldSelectionKey = editorSelectionKey(oldProps.video, oldProps.batch);
      const currentSelectionKey = editorSelectionKey(this.props.video, this.props.batch);

      // Parent-level library updates recreate the batch summary object. Before
      // this guard, such a same-selection refresh unconditionally replaced the
      // editor state and erased the confirmed per-video reset patches. Preserve
      // the local reset transaction until the user explicitly Saves, Reverts,
      // or moves to a genuinely different video selection.
      if (oldSelectionKey === currentSelectionKey &&
          (this.state.resetFromFilenamePending || this.state.filenameResetStaged)) {
        editorLog.info('Preserved staged filename reset during same-selection refresh', {
          selectionType: this.props.video && this.props.video.id === 'batch' ? 'batch' : 'single',
          videoCount: this.props.video && this.props.video.id === 'batch' ?
            (this.props.batch || []).length : 1,
          resetRequestPending: Boolean(this.state.resetFromFilenamePending),
          filenameResetPatchCount: Object.keys(this.state.pendingFilenameResetPatches || {}).length,
          changedFields: Array.from(this.state.changed || []).sort()
        });
        return;
      }

      let videoEditPrepped = _.cloneDeep(this.props.video);

      if (videoEditPrepped) {
        if (videoEditPrepped.id === 'batch') {
          this.state.batchObjectUnedited = _.cloneDeep(videoEditPrepped);
        } else {
          // A single-video save replaces the complete editable object, so its
          // established behavior remains: saving removes it from New unless
          // the user explicitly checks the box to keep/re-add it.
          videoEditPrepped.new = false;
        }

        validateVideo(videoEditPrepped);

        this.setState({
          video: videoEditPrepped,
          changed: new Set(),
          pendingFilenameResetPatches: {},
          resetFromFilenamePending: false,
          filenameResetStaged: false,
          saveHash: hashObject(videoEditPrepped)
        });
      }
    }
  }

  isBatchEdit() {
    // Check both sources so a control from the preceding render cannot navigate
    // during the brief props/state handoff into or out of a batch selection.
    return Boolean(
      (this.props.video && this.props.video.id === 'batch') ||
      (this.state.video && this.state.video.id === 'batch')
    );
  }

  goToPrevious() {
    if (this.isBatchEdit()) return;
    if (this.props.detailRowBoundaryFlag !== 'first') {
      if (this.state.changed.size > 0)
        this.saveChanges();
      this.props.goToPrevious();
    }
  }

  goToNext() {
    if (this.isBatchEdit()) return;
    if (this.props.detailRowBoundaryFlag !== 'last') {
      if (this.state.changed.size > 0)
        this.saveChanges();
      this.props.goToNext();
    }
  }


  componentDidMount() {
    this._isMounted = true;
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  createContentJSX() {
    // <MynEditorLookup
    //   video={this.state.video}
    // />

    const hasUnsavedChanges = Boolean(this.state.video) && (
      this.state.saveHash !== hashObject(this.state.video) ||
      this.state.resetFromFilenamePending ||
      Object.keys(this.state.pendingFilenameResetPatches || {}).length > 0
    );
    const navigationControls = this.isBatchEdit() ? null : (
      <div className={'editor-next-prev-btns ' + this.props.detailRowBoundaryFlag}>
        <div className='btn editor-prev-btn' onClick={()=>this.goToPrevious()}>
          <div style={{display:"inline-block",transform:"scaleX(-1)"}}>{'\u25B8'}</div> Previous
        </div>
        <div className='separator'>|</div>
        <div className='btn editor-next-btn' onClick={()=>this.goToNext()}>
          Next <div style={{display:"inline-block"}}>{'\u25B8'}</div>
        </div>
      </div>
    );

    return (
      <div>
        <MynEditorSearch
          video={this.state.video}
          batch={this.props.batch}
          settings={this.props.settings}
          placeholderImage={this.state.placeholderImage}
          handleChange={this.handleChange}
          hasUnsavedChanges={hasUnsavedChanges}
        />

        {navigationControls}

        <MynEditorEdit
          show={this.props.show}
          video={this.state.video}
          batch={this.props.batch}
          settings={this.props.settings}
          handleChange={this.handleChange}
          revertChanges={this.revertChanges}
          resetFromFilename={this.requestResetFromFilename}
          resetPatches={this.state.pendingFilenameResetPatches}
          resetPending={this.state.resetFromFilenamePending}
          changedFields={this.state.changed}
          saveChanges={this.saveChanges}
          placeholderImage={this.state.placeholderImage}
          reportValid={this.reportValid}
          saveHash={this.state.saveHash}
        />
      </div>
    );
  }

  render() {

    return super.render({
      jsx: this.createContentJSX(),
      confirmExit: () => {
        // console.log('EXITING EDITOR PANE!!! isEqual: ' + _.isEqual(this.props.video,this.state.video));
        // console.log('props: ' + JSON.stringify(this.props.video));
        // console.log('state: ' + JSON.stringify(this.state.video));
        // return !_.isEqual(this.props.video,this.state.video);
        // console.log('object when exiting:');
        // console.log(this.state.video);

        let newHash = this.state.video ? hashObject(this.state.video) : null;
        return this.state.saveHash !== newHash ||
          Object.keys(this.state.pendingFilenameResetPatches || {}).length > 0;
      }, // boolean for whether or not to show confirmation dialog upon exiting the pane
      confirmMsg: 'Are you sure you want to exit without saving? Your changes will be lost'
    });
  }

}

class MynEditorSearch extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      results: null,
      searching: false
    }

    this.handleSearch = this.handleSearch.bind(this);
    this.clearSearch = this.clearSearch.bind(this);
    this.render = this.render.bind(this);

    this.handleConfirmSelect = (event, response, video, checked) => {
      console.log('CONFIRMATION OF SEARCH RESULTS HAS FIRED')
      console.log(event);
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        console.log('option to override dialog was checked!');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs['MynEditorSearch-confirm-select'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.retrieveResult(video);
      } else {
        console.log('Selection canceled by user')
      }
    };
  }

  // search online movie database to auto-fill fields
  async handleSearch(event) {
    event.preventDefault();

    // The editor's synthetic batch summary is not a searchable video. Send
    // only the real selected IDs to the main process, which resolves fresh
    // library records, confirms the scope, and runs the normal Auto-Tag path.
    if (this.props.video && this.props.video.id === 'batch') {
      if (this.props.hasUnsavedChanges) {
        alert('Save or Revert the current batch edits before auto-tagging the selected videos.');
        return;
      }
      const selectedIDs = (this.props.batch || [])
        .map(video => video && video.id)
        .filter(Boolean);
      if (selectedIDs.length === 0) {
        alert('No videos are selected for Auto-Tag.');
        return;
      }
      ipcRenderer.send('autotag-selected', selectedIDs);
      return;
    }

    this.setState({searching:true});
    let resultsObject = await OmdbHelper.search(this.props.video);
    this.setState({searching:false});
    //console.log(results);
    let results;
    if (resultsObject.success) {
      results = resultsObject.data;
      if (!Array.isArray(results)) {
        results = [
          {
            Poster: results.artwork,
            Title: results.title,
            Type: results.kind === 'show' ? 'episode' : (results.type || results.kind),
            Year: results.year,
            imdbID: results.imdbID
          }
        ];
      }
    } else if (resultsObject.choiceType === 'series' && Array.isArray(resultsObject.choices) && resultsObject.choices.length > 0) {
      // OmdbHelper does not decide whether ambiguity is fatal. Automatic
      // tagging leaves these choices unresolved, while the editor lets the
      // user select the intended series and then retrieves that exact episode.
      results = resultsObject.choices;
    } else {
      alert('No results found! For shows, check the series, season, and episode. For other videos, try editing the title and year, or enter the IMDb ID for an exact match.');
      return;
    }

    // Ordinary title searches can contain series records that are not valid
    // choices for a movie or episode. Filter those records before rendering,
    // rather than returning undefined JSX entries: an array of undefined
    // entries is truthy and used to produce an empty results area with only
    // its X button visible.
    let displayableResults = results.filter(movie => {
      if (!movie) return false;
      let isSeriesChoice = movie.myndaChoiceType === 'series';
      return movie.Type !== 'series' || isSeriesChoice;
    });

    if (displayableResults.length === 0) {
      this.setState({results:null});
      alert('No compatible results found! For shows, check the series, season, and episode. For other videos, try editing the title and year, or enter the IMDb ID for an exact match.');
      return;
    }

    let movies = displayableResults.map((movie) => {

      if (!isValidURL(movie.Poster)) {
        movie.Poster = this.props.placeholderImage;
      }

      return (
        <tr key={movie.imdbID} onClick={() => (this.chooseResult(movie))}>
          <td className='artwork'><img src={movie.Poster} /></td>
          <td className='title'>{movie.Title}</td>
          <td className='year'>{movie.Year}</td>
          <td><a href={`https://www.imdb.com/title/${movie.imdbID}`} target='_blank' onClick={(e) => {e.stopPropagation()}}>IMDb</a></td>
        </tr>
      );
    });
    this.setState({results:movies});
  }

  clearSearch() {
    this.setState({results:null});
  }

  chooseResult(movie) {
    // if the user hasn't previously selected the preference to override this confirmation dialog
    if (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynEditorSearch-confirm-select']) {
      // we ask the user to confirm, because this will overwrite any metadata
      // the movie currently has (although the revert button will still work until
      // the user saves the changes)
      ipcRenderer.send(
        'generic-confirm',
        'MynEditorSearch-confirm-select',
        {
          message: `Are you sure you want to choose ${movie.Title} (${movie.Year})? This will overwrite most of the existing information for this video.`,
          checkboxLabel: `Don't show this dialog again`
        },
        movie
      );
    } else {
      // skip the dialog
      this.retrieveResult(movie);
    }
  }

  retrieveResult(movie) {
    // clear the search results
    this.clearSearch();

    // A series choice identifies which show owns the already-known season and
    // episode. Ordinary movie/episode result rows continue to be retrieved by
    // their own IMDb ID as before.
    let searchTarget = movie.myndaChoiceType === 'series' ? this.props.video : movie;
    let searchOptions = movie.myndaChoiceType === 'series' ? {seriesImdbID: movie.imdbID} : {};
    OmdbHelper.search(searchTarget, searchOptions).then(responseObject => {
      if (!responseObject.success) {
        alert(movie.myndaChoiceType === 'series' ?
          'OMDb could not find this episode in the selected series.' :
          'OMDb could not retrieve the selected result.');
        return console.log('Error: no result found: ' + responseObject.data);
      } else {
        this.props.handleChange(responseObject.data);
      }
    })
  }

  componentDidUpdate(previousProps) {
    const previousSelection = editorSelectionKey(previousProps.video, previousProps.batch);
    const currentSelection = editorSelectionKey(this.props.video, this.props.batch);
    if (previousSelection !== currentSelection && (this.state.results || this.state.searching)) {
      // Search rows belong to one concrete video. Never carry them into a
      // different video—or into a batch where selecting one row would apply a
      // single title's metadata to every selected item.
      this.setState({results: null, searching: false});
    }
  }

  componentDidMount() {
    ipcRenderer.on('MynEditorSearch-confirm-select', this.handleConfirmSelect);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('MynEditorSearch-confirm-select', this.handleConfirmSelect);
  }

  render() {
    const isBatch = this.props.video && this.props.video.id === 'batch';
    let clearBtn = !isBatch && this.state.results ? (<div id='edit-search-clear-button' className='clickable' onClick={this.clearSearch} title='Clear search results'>{"\u2715"}</div>) : null;
    let searchBtn;
    let batchMessage = null;
    if (isBatch) {
      const title = this.props.hasUnsavedChanges ?
        'Save or Revert the current batch edits before auto-tagging.' :
        'Auto-tag only the selected videos. Mynda will ask for confirmation before making changes.';
      searchBtn = (
        <span title={title}>
          <button
            type='button'
            id='edit-search-button'
            onClick={this.handleSearch}
            disabled={this.props.hasUnsavedChanges}
          >
            Auto-Tag Selected…
          </button>
        </span>
      );
      if (this.props.hasUnsavedChanges) {
        batchMessage = <span className='edit-search-batch-message'>Save or Revert this batch before Auto-Tag.</span>;
      }
    } else {
      searchBtn = this.state.searching ?
        (<img src='../images/loading-icon.gif' className='loading-icon' />) :
        (<button type='button' id='edit-search-button' onClick={this.handleSearch} title='Search OMDb for video information. Shows use series, season, and episode; other videos use IMDb ID, title, year, or filename. You can choose a result and edit it afterwards.'>Search</button>);
    }
    return (
        <div id='edit-search'>
          <div id='edit-search-controls'>
            {searchBtn}
            {batchMessage}
          </div>
          <table id='edit-search-results'>
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th></th>
                <th>{clearBtn}</th>
              </tr>
            </thead>
            <tbody>
              {isBatch ? null : this.state.results}
            </tbody>
          </table>
        </div>
    );

    // <div className="input-container controls">
    //   <input id="editor-search-imdbID" className="filled" type="text" placeholder="IMDb ID (optional)" />
    //   <div className="input-clear-button hover" onClick={() => {document.getElementById('editor-search-imdbID').value = ''}}></div>
    // </div>

  }
}

// edit fields for video object in MynEditor
class MynEditorEdit extends React.Component {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      // data: _.cloneDeep(props.video),
      validators: {
        people: {
          exp: /^[a-zA-Z0-9_\s\-\.',]+$/,
          tip: "Allowed: a-z A-Z 0-9 _ - . , ' [space]"
        },
        tags: {
          exp: /^[a-zA-Z0-9_\-\.&]+$/,
          tip: "Allowed: a-z A-Z 0-9 _ - . &"
        },
        generous: {
          exp: /^[^=;{}]+$/,
          tip: "Not allowed: = ; { }"
        },
        year: {
          exp: /^\d{4}$/,
          tip: "YYYY"
        },
        posint: {
          exp: { test: value => Number.isInteger(Number(value)) && Number(value)>0 },
          tip: "Positive integer"
        },
        nonnegativeInteger: {
          exp: { test: value => String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value)>=0 },
          tip: "Integer 0 or greater"
        },
        season: {
          exp: { test: value => String(value).toLowerCase() === 'extras' || (String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value)>=0) },
          tip: "Integer 0 or greater, or extras"
        },
        number: {
          exp: { test: value => !isNaN(Number(value)) },
          tip: "Number"
        },
        numrange: {
          exp: { test: (value,min,max) => !isNaN(Number(value)) && Number(value)>=min && Number(value)<=max },
          tip: (min,max) => `${min}-${max}`
        },
        money: {
          exp: { test: value => !isNaN(accounting.unformat(value)) && accounting.unformat(value) >= 0 },
          tip: "Non-negative monetary value"
        },
        imdb: {
          exp: /^tt\d+$/,
          tip: "Enter a valid IMDb ID"
        },
        everything: {
          exp: /.*/,
          tip: ""
        }
      }
    }

    this.render = this.render.bind(this);

    this.handleConfirmRevert = (event, response, data, checked) => {
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        console.log('option to override dialog was checked!');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs['MynEditorEdit-confirm-revert'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.props.revertChanges();
      } else {
        console.log('Reversion canceled by user');
      }
    };
  }

  requestRevert(e) {
    e.preventDefault();

    // whether the video has been changed since load or the last save
    const newHash = hashObject(this.props.video);
    const saved = this.props.saveHash === newHash;
    // console.log('video has changed since load/last save? ' + !saved);
    // console.log('\n' + this.props.saveHash + '\n' + newHash);

    // if the video has been changed without saving
    // and if the user hasn't previously selected the preference to override this confirmation dialog
    if (!saved && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynEditorEdit-confirm-revert'])) {
      // we ask the user to confirm, because this will erase any metadata
      // that hasn't been saved
      ipcRenderer.send(
        'generic-confirm',
        'MynEditorEdit-confirm-revert',
        {
          message: `Are you sure you want to revert to the saved values? You will lose any unsaved changes.`,
          checkboxLabel: `Don't show this dialog again`
        }
      );
    } else {
      // skip the dialog
      this.props.revertChanges();
    }
  }

  componentDidMount() {
    this._isMounted = true;
    ipcRenderer.on('MynEditorEdit-confirm-revert', this.handleConfirmRevert);

    // we're now doing the validating in MynEditor before it gets here, to avoid issues with the saveHash
    // validate the video in place (function fixes any broken values)
    // and also, if any changes were made (i.e. broken values fixed)
    // save the changes
    // if (validateVideo(this.props.video) !== true) {
    //   // this.props.saveChanges();
    // }
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('MynEditorEdit-confirm-revert', this.handleConfirmRevert);
    this._isMounted = false;
  }

  render() {
    if (this.props.show === false) {
      return null;
    }

    if (!this.props.video) {
      console.error('Error: no video object provided to MynEditorEdit');
      return null;
    }

    const video = this.props.video;
    const resetPatches = Object.values(this.props.resetPatches || {});

    // A batch reset can contain a different derived value for every video.
    // The common batch object must represent those differing values as blank,
    // which otherwise makes the editor look unchanged. Give every still-pending
    // reset field a normal form placeholder so the user can see what Save will
    // do. Once the user supplies an overriding value for a field, its ordinary
    // placeholder returns. (Ratings are handled per input below, because one
    // edited rating should not hide the reset marker from the other sources.)
    const isPendingResetField = (property, ignoreChanged = false) => {
      return video.id === 'batch' &&
        resetPatches.length > 0 &&
        (ignoreChanged || !this.props.changedFields || !this.props.changedFields.has(property)) &&
        resetPatches.every(patch => Object.prototype.hasOwnProperty.call(patch, property));
    };
    const resetPlaceholder = (property, ordinaryPlaceholder = '') => {
      return isPendingResetField(property) ? 'Reset' : ordinaryPlaceholder;
    };
    // validateVideo(video);

    // if (validateVideo(video) !== true) {
    //   console.log("Invalid video passed to editor: " + JSON.stringify(video));
    //   return (
    //     <div className="error-message">Error: Invalid video object</div>
    //   );
    // }

    /* FILENAME */
    // the user won't be able to edit the filename, but we need to display it
    let filename = (
      <div className='edit-field filename'>
        <div className="edit-field-editor">
          <MynOverflowTextMarquee text={this.props.video.filename} direction='left' ellipsis='fade' fadeSize='2em' />
        </div>
      </div>
    );

    /* TITLE */
    let title = (
      <div className='edit-field title'>
        <label className="edit-field-name" htmlFor="title">Title: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="title"
            placeholder={resetPlaceholder('title', '[Title]')}
            className="edit-field-title"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* IMDb ID */
    let imdbID = (
      <div className='edit-field imdbID'>
        <label className="edit-field-name" htmlFor="imdbID">IMDb ID: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="imdbID"
            placeholder={resetPlaceholder('imdbID')}
            className="edit-field-imdbID"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.imdb.exp}
            validatorTip={this.state.validators.imdb.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* YEAR */
    let year = (
      <div className='edit-field year'>
        <label className="edit-field-name" htmlFor="year">Year: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="year"
            placeholder={resetPlaceholder('year')}
            className="edit-field-year"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.year.exp}
            validatorTip={this.state.validators.year.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DIRECTOR */
    let director = (
      <div className='edit-field director'>
        <label className="edit-field-name" htmlFor="director">Director: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="director"
            placeholder={resetPlaceholder('director')}
            className="edit-field-director"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DIRECTORSORT */
    let directorsort = (
      <div className='edit-field directorsort'>
        <label className="edit-field-name" htmlFor="directorsort">Director Sort: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="directorsort"
            placeholder={resetPlaceholder('directorsort')}
            className="edit-field-directorsort"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DESCRIPTION */
    let description = (
      <div className='edit-field description'>
        <label className="edit-field-name" htmlFor="description">Description: </label>
        <div className="edit-field-editor">
          <textarea
            id="edit-field-description"
            name="description"
            value={this.props.video.description}
            placeholder={resetPlaceholder('description', '[Description]')}
            onChange={(e) => this.props.handleChange({'description':e.target.value})}
          />
        </div>
      </div>
    );

    /* TAGS */
    // <MynEditListWidget movie={this.state.video} property="tags" update={this.handleChange} />
    // <MynEditAddToList movie={this.state.video} property="tags" update={this.handleChange} validator={/^[a-zA-Z0-9_\-\.]+$/} options={["many","tags","happy","joy","existing","already-used"]} />
    let tags = (
      <div className='edit-field tags'>
        <label className="edit-field-name" htmlFor="tags">Tags: </label>
        <div className="edit-field-editor">
          <div className="select-container">
            <MynEditInlineAddListWidget
              object={this.props.video}
              property="tags"
              update={this.props.handleChange}
              options={this.props.settings.used.tags}
              storeTransform={value => value.toLowerCase()}
              validator={this.state.validators.tags.exp}
              validatorTip={this.state.validators.tags.tip}
              reportValid={this.props.reportValid}
            />
          </div>
        </div>
      </div>
    );

    /* ARTWORK */
    let artwork = (
      <div className='edit-field artwork'>
        <label className="edit-field-name" htmlFor="artwork">Artwork: </label>
        <div className="edit-field-editor">
          <MynEditArtwork
            movie={this.props.video}
            update={this.props.handleChange}
            placeholderImage={this.props.placeholderImage}
            placeholder={resetPlaceholder('artwork', 'Paste path/URL')}
          />
        </div>
      </div>
    );

    let subtitles = (
      <div className='edit-field subtitles'>
        <label className="edit-field-name" htmlFor="subtitles">Subtitles: </label>
        <div className="edit-field-editor">
          <MynEditSubtitles
            object={this.props.video}
            property={'subtitles'}
            update={this.props.handleChange}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
            marquee={true}
            overflowDirection={'left'}
          />
        </div>
      </div>
    );

    /* CAST */
    let cast = (
      <div className='edit-field cast'>
        <label className="edit-field-name" htmlFor="cast">Cast: </label>
        <div className="edit-field-editor">
          <MynEditInlineAddListWidget
            object={this.props.video}
            property="cast"
            placeholder={resetPlaceholder('cast', 'Add...')}
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* GENRE */
    let genre = (
      <div className='edit-field genre'>
        <label className="edit-field-name" htmlFor="genre">Genre: </label>
        <div className="edit-field-editor select-container select-hovericon">
          <MynEditText
            object={this.props.video}
            property="genre"
            placeholder={resetPlaceholder('genre')}
            className="edit-field-genre"
            update={this.props.handleChange}
            options={this.props.settings.used.genres}
            storeTransform={value => value.replace(/\b\w/g,letter => letter.toUpperCase())}
            validator={this.state.validators.tags.exp}
            validatorTip={this.state.validators.tags.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SERIES */
    let series = (
      <div className='edit-field series'>
        <label className="edit-field-name" htmlFor="series">Series: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="series"
            placeholder={resetPlaceholder('series')}
            className="edit-field-series"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SEASON */
    let season = (
      <div className='edit-field season'>
        <label className="edit-field-name" htmlFor="season">Season: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="season"
            placeholder={resetPlaceholder('season')}
            className="edit-field-season"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.season.exp}
            validatorTip={this.state.validators.season.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* EPISODE */
    let episode = (
      <div className='edit-field episode'>
        <label className="edit-field-name" htmlFor="episode">Episode: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="episode"
            placeholder={resetPlaceholder('episode')}
            className="edit-field-episode"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.nonnegativeInteger.exp}
            validatorTip={this.state.validators.nonnegativeInteger.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* KIND */
    let options = this.props.settings.used.kinds.map(kind => (
      <option key={kind} value={kind}>{kind}</option>
    ));
    // if this video's kind is no longer among the list of allowed kinds (probably because the user deleted that kind from the preferences pane)
    // we want to display it as the kind of the video, but not allow the user to select it as an option
    if (this.props.video.kind && this.props.video.kind !== '' && !this.props.settings.used.kinds.includes(this.props.video.kind)) {
      options.unshift(<option key='invalid' disabled hidden value={this.props.video.kind}>{this.props.video.kind}</option>);
    }
    options.unshift(<option key='none' disabled hidden value=''>{resetPlaceholder('kind')}</option>);
    let kind = (
      <div className='edit-field kind'>
        <label className="edit-field-name" htmlFor="kind">Kind: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="kind" className={isPendingResetField('kind') && !this.props.video.kind ? 'pending-reset' : ''} value={this.props.video.kind || ''} onChange={(e) => this.props.handleChange({'kind':e.target.value})}>
            {options}
          </select>
        </div>
      </div>
    );

    /* DATEADDED */
    let dateadded = (
      <div className='edit-field dateadded'>
        <label className="edit-field-name" htmlFor="dateadded">Date Added: </label>
        <div className="edit-field-editor">
          <MynEditDateWidget
            movie={this.props.video}
            property="dateadded"
            update={this.props.handleChange}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* LASTSEEN */
    let lastseen = (
      <div className='edit-field lastseen'>
        <label className="edit-field-name" htmlFor="lastseen">Last Seen: </label>
        <div className="edit-field-editor">
          <MynEditDateWidget
            movie={this.props.video}
            property="lastseen"
            update={this.props.handleChange}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SEEN */
    let seen = (
      <div className='edit-field seen'>
        <label className='edit-field-name' htmlFor="seen">Seen: </label>
        <div className="edit-field-editor">
          <MynEditSeenWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* WATCHLATER */
    let watchlater = (
      <div className='edit-field watchlater'>
        <label className='edit-field-name' htmlFor="watchlater">Watch Later: </label>
        <div className="edit-field-editor">
          <MynEditWatchlaterWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* POSITION */
    let position = (
      <div className='edit-field position'>
        <label className="edit-field-name" htmlFor="position">Position: </label>
        <div className="edit-field-editor">
          <MynEditPositionWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* RATING */
    let rating = (
      <div className='edit-field rating'>
        <label className="edit-field-name" htmlFor="rating">Rating: </label>
        <div className="edit-field-editor">
          <MynEditRatingWidget movie={this.props.video} update={this.props.handleChange} cancelBtn={true} />
        </div>
      </div>
    );

    /* RATINGS */
    // (not including the user rating, which is separate)
    let ratings = (
      <div className='edit-field ratings'>
        <label className="edit-field-name" htmlFor="ratings">Ratings: </label>
        <div className="edit-field-editor">
          <MynEditRatings
            property="ratings"
            video={this.props.video}
            update={this.props.handleChange}
            placeholder={isPendingResetField('ratings', true) ? 'Reset' : '#'}
            validator={this.state.validators.numrange.exp}
            validatorTip={this.state.validators.numrange.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* BOXOFFICE */
    let boxoffice = (
      <div className='edit-field boxoffice'>
        <label className="edit-field-name" htmlFor="boxoffice">Box Office: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="boxoffice"
            placeholder={resetPlaceholder('boxoffice')}
            className="edit-field-boxoffice"
            update={this.props.handleChange}
            options={null}
            storeTransform={value => value !== '' ? Math.round(accounting.unformat(value)) : ''}
            displayTransform={value => value !== '' ? accounting.formatMoney(value,'$',0) : ''}
            validator={this.state.validators.money.exp}
            validatorTip={this.state.validators.money.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* RATED */
    // create dropdown options for the different ratings systems
    // let options = {};
    // // populate movie and show with MPA and TV ratings, respectively;
    // // in the future we should expand to allow other content rating systems, perhaps by locale
    // // or else simply allow text entry instead of preset options
    // options.movie = ['Not Rated','G','PG','PG-13','R','NC-17','X'];
    // options.show = ['Not Rated','TV-G','TV-Y','TV-Y7','TV-PG','TV-14','TV-MA'];
    // // create JSX
    // try {
    //   options = options[this.props.video.kind].map(option => (<option key={option} value={option}>{option}</option>));
    // } catch(err) {
    //   options = (<option key='N/A' value='N/A'>N/A</option>);
    // }
    options = ['N/A','','G','PG','PG-13','R','NC-17','X','','TV-G','TV-Y','TV-Y7','TV-PG','TV-14','TV-MA','','Not Rated'];
    options = options.map((option,i) => {
      if (option !== '') {
        return (<option key={i} value={option}>{option}</option>);
      } else {
        // create separator
        return (<option key={i} disabled>{'\u2501'}{'\u2501'}{'\u2501'}{'\u2501'}</option>)
      }
    });
    options.unshift(<option key={options.length} disabled hidden value=''>{resetPlaceholder('rated')}</option>);
    let rated = (
      <div className='edit-field rated'>
        <label className="edit-field-name" htmlFor="rated">Rated: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="rated" className={isPendingResetField('rated') && !this.props.video.rated ? 'pending-reset' : ''} value={this.props.video.rated} onChange={(e) => this.props.handleChange({'rated':e.target.value})}>
            {options}
          </select>
        </div>
      </div>
    );

    /* LANGUAGES */
    let languages = (
      <div className='edit-field languages'>
        <label className="edit-field-name" htmlFor="languages">Languages: </label>
        <div className="edit-field-editor">
          <MynEditInlineAddListWidget
            object={this.props.video}
            property="languages"
            placeholder={resetPlaceholder('languages', 'Add...')}
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.generous.exp}
            validatorTip={this.state.validators.generous.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* COUNTRY */
    let country = (
      <div className='edit-field country'>
        <label className="edit-field-name" htmlFor="country">Country: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="country"
            placeholder={resetPlaceholder('country')}
            className="edit-field-country"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.generous.exp}
            validatorTip={this.state.validators.generous.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    const batchNewMixed = this.props.video.id === 'batch' && this.props.video.new === null;
    const newDescription = this.props.video.id === 'batch' ?
      "Keep selected videos in the 'New' playlist. A dash means the selection is mixed; leave it untouched to preserve each video's current status." :
      "Check to re-add this video to the 'New' playlist";
    let new_ = (
      <div className='edit-field new'>
        <label className="edit-field-name" htmlFor="new">New: </label>
        <div className="edit-field-editor">
          <input
            type='checkbox'
            ref={(input) => {
              if (input) input.indeterminate = batchNewMixed;
            }}
            checked={this.props.video.new === true}
            onChange={(e) => this.props.handleChange({'new': e.target.checked})}
          />
        </div>
        <div className='edit-field-description'>{newDescription}</div>
      </div>
    );

    let metadata = null;
    if (this.props.video.metadata) {
      metadata = (
        <div className='edit-field metadata'>
          <label className="edit-field-name" htmlFor="metadata">Metadata: </label>
          <div className="edit-field-editor">
            <table>
              <tbody>
                {Object.keys(this.props.video.metadata).map(key => {
                  // don't show the 'checked' boolean field
                  if (key === 'checked') return;
                  // format the field name
                  let formattedKey = key.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
                  // set the value
                  let value = this.props.video.metadata[key];
                  let formattedValue = value;
                  // special case value formatting
                  if (key === 'duration') formattedValue = value >= 60 ? `${Math.round(value / 60)} min` : `${Math.round(value)} sec`;

                  return (
                    <tr key={key}>
                      <td className='field'>{formattedKey}</td>
                      <td className='value'>{formattedValue}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // in the case that we're editing multiple videos, display a banner warning the user
    let batchNotification = null;
    let videoTable = null;
    if (this.props.video.id === 'batch') {
      const batchCount = Array.isArray(this.props.batch) ? this.props.batch.length : 0;
      // create a list of the videos we're editing
      if (this.props.batch) {
        videoTable = (
          <table id='batch-videos-table'>
            <thead>
              <tr>
                <th className='title'>Title</th>
                <th className='year'>Year</th>
                <th className='filename'>Filename</th>
              </tr>
            </thead>
            <tbody>
             {this.props.batch.map(v => {
               // Filename-derived batch resets remain pending until Save.
               // Preview each video's own patch here so the user can inspect
               // the newly detected titles rather than the stale saved ones.
               const previewVideo = {
                 ...v,
                 ...((this.props.resetPatches && this.props.resetPatches[v.id]) || {})
               };
               return (
                 <tr key={previewVideo.id}>
                  <td className='title'><MynOverflowTextMarquee text={previewVideo.title} ellipsis='fade' /></td>
                  <td className='year'>{previewVideo.year}</td>
                  <td className='filename'><MynOverflowTextMarquee text={previewVideo.filename} direction='left' ellipsis='fade' /></td>
                 </tr>
               );
             })}
            </tbody>
          </table>
       );
      }

      batchNotification = (
        <MynParagraphFolder
          id="edit-batch-notification"
          lede={`Editing ${batchCount} Video${batchCount === 1 ? '' : 's'}`}
          paragraph={videoTable}
          keepEllipsis={true}
        />
      );

    }

    return (
      <div id="edit-container">
        {batchNotification}
        <form onSubmit={this.props.saveChanges}>
          {filename}
          {title}
          {series}
          {season}
          {episode}
          {imdbID}
          {description}
          {year}
          {director}
          {directorsort}
          {cast}
          {genre}
          {tags}
          {kind}
          {rating}
          {seen}
          {watchlater}
          {lastseen}
          {position}
          {dateadded}
          {artwork}
          {subtitles}
          {ratings}
          {boxoffice}
          {rated}
          {country}
          {languages}
          {new_}
          {metadata}
          <button
            type="button"
            className="edit-field filename-reset-btn"
            onClick={this.props.resetFromFilename}
            disabled={this.props.resetPending}
            title="Re-detect identification from each filename and its folders, then clear downloaded catalog information so tagging can be tried again"
          >
            {this.props.resetPending ? 'Preparing Reset…' : 'Reset from Filename'}
          </button>
          <button className="edit-field revert-btn" onClick={(e) => this.requestRevert(e)}>Revert to Saved</button>
          <input
            className="edit-field save-btn"
            type="submit"
            value="Save"
            disabled={this.props.resetPending}
            title={this.props.resetPending ? 'Wait for the filename reset to finish before saving' : ''}
          />
        </form>
      </div>
    );
  }
}

class MynEdit extends React.Component {
  constructor(props) {
    super(props)
  }

  handleValidity(valid, property, element, tip) {
    if (!element) return;

    if (valid) {
      if (this.props.reportValid) {
        this.props.reportValid(property,true);
      }
      element.classList.remove("invalid");
    } else {
      if (this.props.reportValid) {
        this.props.reportValid(property,false);
      }
      element.classList.add("invalid");
    }

    // if the element doesn't already have an id, we need to create a unique one,
    // so that we can reference it below to add/remove the tip div
    if (!element.id) {
      element.id = uuidv4();
    }

    // show validator tip on the element, if we were given one
    let tipper = document.getElementById(property + '-tip-' + element.id);
    if (tipper) {
      tipper.parentNode.removeChild(tipper);
    }
    if (tip) {
      // console.log(tip);
      tipper = document.createElement('div')
      tipper.id = property + '-tip-' + element.id;
      tipper.className = "tip";
      tipper.innerHTML = tip;
      element.parentNode.appendChild(tipper);
    }
  }

  render() {
    return null;
  }
}

class MynEditWidget extends MynEdit {
  constructor(props) {
    super(props)
  }

  render() {
    return null;
  }
}


class MynEditRatings extends MynEdit {
  constructor(props) {
    super(props)

    this.state = {
      source : {
        "imdb" : {
          min: 0,
          max: 10,
          display: "IMDb",
          units: "/\u202F10"
        },
        "rt" : {
          min: 0,
          max: 100,
          display: "Rotten Tomatoes",
          units: "%"
        },
        "mc" : {
          min: 0,
          max: 100,
          display: "Metacritic",
          units: "/\u202F100"
        }
      }
    }

    this.table = React.createRef();
    // this.render = this.render.bind(this);
    // this.handleInput = this.handleInput.bind(this);
  }

  validateInput(target, value, source) {
    let min = this.state.source[source].min;
    let max = this.state.source[source].max;

    if (value === "") {
      super.handleValidity(true,this.props.property,target);
    } else if (this.props.validator.test(value,min,max)) {
      super.handleValidity(true,this.props.property,target);
    } else {
      super.handleValidity(false,this.props.property,target,this.props.validatorTip(min,max));
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
  }

  handleInput(target, value, source) {
    this.validateInput(target, value, source);

    let update = _.cloneDeep(this.props.video[this.props.property]);
    // update[source] = !isNaN(Number(value)) && value !== '' ? value / this.state.source[source].max : value;
    update[source] = value;
    // console.log('HMMM... ' + update[source]);
    this.props.update(this.props.property,update);
  }

  componentDidUpdate(oldProps) {
    // Controlled React inputs already receive their new displayed values from
    // props when Revert or Reset changes the ratings object. Revalidate those
    // programmatic values, but do not route them through handleInput(): doing
    // so falsely marked ratings as a user edit and made the later batch-save
    // override logic run even when the user never touched a rating field.
    if (!_.isEqual(oldProps.video[this.props.property],this.props.video[this.props.property])) {
      let inputs = Array.from(this.table.current.getElementsByClassName('ratings-input-input'));
      inputs.map(input => {
        // Identify the rating source from the input's imdb/rt/mc class.
        let source = Array.from(input.classList).find(theClass => Object.keys(this.state.source).includes(theClass));
        let value = this.props.video[this.props.property][source];
        if (value === undefined) {
          value = '';
        }
        this.validateInput(input, value, source);
      });
    }
  }

  render() {
    // value={!isNaN(Number(this.props.video[this.props.property][source])) && this.props.video[this.props.property][source] !== '' ? Math.round(Number(this.props.video[this.props.property][source]) * this.state.source[source].max * 10) / 10 : this.props.video[this.props.property][source]}
    return (
      <table ref={this.table}><tbody>
        {Object.keys(this.state.source).map((source) => {
          return (
            <tr key={source}>
              <td className="ratings-icon">
                <img src={`../images/logos/${source}-logo` + (source=='rt' && this.props.video[this.props.property][source]<60 && this.props.video[this.props.property][source] !== '' ? '-splat' : '') + '.png'} />
              </td>
              <td className="ratings-input">
                <input
                 className={"ratings-input-input " + source}
                 id={`edit-field-${this.props.property}-${source}`}
                 type="text"
                 name={source}
                 value={this.props.video[this.props.property][source] || ''}
                 placeholder={this.props.placeholder || '#'}
                 onChange={(e) => this.handleInput(e.target, e.target.value, source)}
                />
              </td>
              <td className="ratings-unit">
                {this.state.source[source].units}
              </td>
           </tr>
          );
        })}
      </tbody></table>
    );
  }
}

class MynClickToEditText extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      editing : false
    }
  }

  edit(e) {
    // e.stopPropagation();
    this.setState({editing:true});
  }

  endEdit(e) {
    e.preventDefault();
    e.stopPropagation();

    if (e.keyCode === 13) {
      // if the key hit was 'enter'
      // save the value and exit the editor
      this.setState({editing:false});
      this.props.save();
    } else if (e.keyCode === 27) {
      // if the key hit was 'esc'
      // exit the editor without saving
      // (also revert to the initial value)
      this.setState({editing:false});
      if (this.props.update) {
        this.props.update(this.props.property, this.state.initialValue);
      }
   }
  }

  componentDidMount() {
    // store the initial value in case the user wants to stop editing without saving
    this.state.initialValue = this.props.object[this.props.property];
  }

  render() {
    // if the user has clicked, display the editor;
    // also always display the editor if the value is empty/only white space
    if (this.state.editing || /^\s*$/.test(this.props.object[this.props.property])) {
      this.state.editing = true;
      return (
        <div onClick={(e) => {e.stopPropagation()}} onKeyUp={(e) => {this.endEdit(e)}}>
          <MynEditText {...this.props} />
        </div>
      );
    } else {
      if (this.props.doubleClick) {
        return (
          <div
            onDoubleClick={(e) => this.edit(e)}
            onClick={(e) => {
              // we must essentially pause the propagation of the (single) click event
              // to check if it was a double click (by checking the 'editing' state var),
              // and if it wasn't, register a click on the parent element to continue
              // the propagation upwards to be caught by any event handlers there may be
              e.stopPropagation();
              let parent = e.target.parentNode;
              setTimeout(() => {
                if (!this.state.editing) {
                    // console.log("SINGLE CLICK");
                    parent.click();
                }
              },150)
            }}
            style={{cursor:'text'}}
          >
            {this.props.object[this.props.property]}
          </div>
        );
      } else {
        return (
          <div onClick={(e) => {e.stopPropagation(); this.edit(e)}} style={{cursor:'text'}}>
            {this.props.object[this.props.property]}
          </div>
        );
      }
    }
  }
}

class MynEditText extends MynEdit {
  constructor(props) {
    super(props)

    this.state = {
      value: ''
    }

    this.input = React.createRef();
    this.clearInput = this.clearInput.bind(this);
  }

  handleInput(value) {
    if (this.props.uneditable) return;

    let target = this.input.current;
    if (value === undefined) {
      value = target.value;
    }

    // console.log("value: " + value);

    // keep the input field updated with what the user is typing
    this.setStateValue(value);

    // handle validation
    if (this.props.validator) {
      if (value === "" && this.props.allowedEmpty !== false) {
        super.handleValidity(true,this.props.property,target);
      } else if (this.props.validator.test(value)) {
        super.handleValidity(true,this.props.property,target);
      } else {
        super.handleValidity(false,this.props.property,target,this.props.validatorTip);
      }
    }

    // if we're given a transform function (i.e. we want the saved value to be different
    // in some way than the value of the input form), transform the value here before updating it
    if (this.props.storeTransform) {
      value = this.props.storeTransform(value);
    }
    this.props.update(this.props.property,value);
  }

  clearInput() {
    this.handleInput('');
  }

  setStateValuesFromProps() {
    this.setStateValue(this.props.object[this.props.property]);
  }

  // set state form value with optional transform
  setStateValue(value) {
    try {
      value = this.props.displayTransform(value);
    } catch(err) {

    }
    this.setState({value:value});

    // if there is anything in the input field, add a class to display the clear button
    let pseudoEmpty = this.props.displayTransform ? this.props.displayTransform('') : '';
    // console.log('display transform of empty string: ' + pseudoEmpty);
    if (value !== pseudoEmpty) {
      this.input.current.classList.add('filled');
    } else {
      this.input.current.classList.remove('filled');
    }
  }

  componentDidUpdate(oldProps) {
    if (oldProps.object[this.props.property] !== this.props.object[this.props.property]) {
      this.setStateValuesFromProps();
      // this.handleInput();
    }
  }

  componentDidMount() {
    this.setStateValuesFromProps();

    if (this.props.setFocus) {
      this.input.current.focus();
    }
  }

  render() {
    let options = null;
    let listName = null;
    let clearBtn = null;
    if (this.props.options) {
      listName = "used-" + this.props.property;
      options = (
        <datalist id={listName}>
          {this.props.options.map((option) => (<option key={option} value={option} />))}
        </datalist>
      );
    } else if (!this.props.noClear && !this.props.uneditable) {
      // only create a clear button if there's no dropdown and if the field is not uneditable
      clearBtn = (<div className="input-clear-button hover" onClick={this.clearInput}></div>);
    }

    return (
      <div>
        <input
          ref={this.input}
          className={(this.props.className || '') + (this.props.noClear ? ' no-clear' : '') + (this.props.uneditable ? ' uneditable' : '')}
          title={this.props.tooltip || null}
          list={listName}
          type="text"
          name="text"
          value={this.state.value}
          placeholder={this.props.placeholder || ''}
          onChange={() => this.handleInput()}
          readOnly={this.props.uneditable ? "readOnly" : ""}
        />
        {options}
        {clearBtn}
      </div>
    );
  }
}

class MynEditArtwork extends MynEdit {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      value: "",
      message: "",
      revertLink: null,
      original: props.movie.artwork
      // cancelDownload: () => { console.log('default cancel function') }
    }

    this.revert = React.createRef();
    this.input = React.createRef();
    this.dlMsg = React.createRef();
    this.container = React.createRef();
    this.downloadResponseChannel = null;
    this.downloadResponseHandler = null;
    this.downloadStatusTimer = null;

    this.handleArtworkSelected = (event, image) => {
      if (image) {
        this.update(image);
      } else {
        console.log("Unable to select file");
      }
    };
    ipcRenderer.on('editor-artwork-selected', this.handleArtworkSelected);

    // ipcRenderer.on('cancel-download', (event, cancelFunc, string) => {
    //   this.setState({cancelDownload: cancelFunc});
    //   console.log(string);
    // });
  }

  handleInput(event) {
    // update value as it's entered
    let value = event.target.value;
    this._isMounted && this.setState({value:value});

    let extReg = /\.(jpg|jpeg|png|gif)$/i;
    if (isValidURL(value) && extReg.test(value)) {
      console.log("Valid URL: " + value);
      // then this is a valid url with an image extension at the end
      // try to download it
      this.download(value);

    } else if (extReg.test(value)) {
      console.log("Possible local path: " + value);
      // then this MIGHT be a valid local path,
      // we'll see if we can find it
      this.handleLocalFile(value);
    } else {
      // do nothing?
      console.log("Neither URL nor local path (doing nothing): " + value);
    }

  }

  removeDownloadListener() {
    if (this.downloadResponseChannel && this.downloadResponseHandler) {
      ipcRenderer.removeListener(this.downloadResponseChannel, this.downloadResponseHandler);
    }
    this.downloadResponseChannel = null;
    this.downloadResponseHandler = null;
  }

  clearDownloadStatusTimer() {
    if (this.downloadStatusTimer) {
      clearTimeout(this.downloadStatusTimer);
      this.downloadStatusTimer = null;
    }
  }

  showDownloadStatus(message, downloading, clearAfter = 0) {
    this.clearDownloadStatusTimer();
    if (!this._isMounted) {
      return;
    }
    if (this.input.current) {
      this.input.current.style.visibility = downloading ? 'hidden' : 'visible';
    }
    if (this.dlMsg.current) {
      this.dlMsg.current.style.display = message ? 'block' : 'none';
    }
    this.setState({message: message});
    if (clearAfter) {
      this.downloadStatusTimer = setTimeout(() => {
        this.downloadStatusTimer = null;
        this.showDownloadStatus('', false);
      }, clearAfter);
    }
  }

  download(url, fallbackArtwork) {
    this.removeDownloadListener();
    if (!this._isMounted) {
      return;
    }

    // hide the input element and display message while downloading
    this.showDownloadStatus('Downloading', true);

    let responseChannel = `downloaded-editor-artwork-${process.pid}-${++nextEditorArtworkDownloadNumber}`;
    let restorePreviousArtwork = typeof fallbackArtwork !== 'undefined';
    let handleFailure = response => {
      let status = response && response.status;
      console.error('Unable to download artwork', response && response.message ? response.message : response);
      this.showDownloadStatus(
        status ? `Download failed (${status})` : 'Download failed',
        false,
        4000
      );

      if (restorePreviousArtwork) {
        // Never restore another remote URL: that would immediately trigger the
        // same download again. Keep the previous local file, or clear artwork.
        let safeFallback = fallbackArtwork && !isValidURL(fallbackArtwork) ? fallbackArtwork : '';
        if (this.props.movie.artwork !== safeFallback) {
          this.update(safeFallback);
        }
      }
    };
    let handleDownload = (event, response) => {
      if (this.downloadResponseChannel !== responseChannel) {
        return;
      }
      this.downloadResponseChannel = null;
      this.downloadResponseHandler = null;
      if (response && response.success) {
        this.showDownloadStatus('', false);
        this.update(response.message);
        console.log('Successfully downloaded artwork');
      } else {
        handleFailure(response);
      }
    };
    this.downloadResponseChannel = responseChannel;
    this.downloadResponseHandler = handleDownload;
    ipcRenderer.once(responseChannel, handleDownload);

    try {
      ipcRenderer.send('download', url, undefined, responseChannel);
    } catch(err) {
      this.removeDownloadListener();
      handleFailure({message: err && err.message ? err.message : err});
    }
  }

  handleLocalFile(path) {
    this._isMounted && fs.readFile(path, (err, data) => {
      if (err) {
        this.update(this.state.placeholderImage);
        return console.error(err);
      }
      this.update(path);
      console.log("read local file successfully, updated path");
    });
  }

  update(path) {
    this._isMounted && this.setState({value:''});

    this.props.update({'artwork':path});
  }

  handleBrowse(event) {
    ipcRenderer.send('editor-artwork-select');
    event.preventDefault();
  }

  handleRevert() {
    console.log("reverting! " + this.state.original);
    this.removeDownloadListener();
    this.showDownloadStatus('', false);
    this.update(this.state.original);
  }

  imageOver(event) {
    // this.revert.current.style.visibility = "visible";
  }

  imageOut(event) {
    // // //this is the original element the event handler was assigned to
    // // var e = event.toElement || event.relatedTarget;
    // // if (e.parentNode == this || e == this) {
    // //    return;
    // // }
    //
    // this.revert.current.style.visibility = "hidden";
  }

  componentDidUpdate(oldProps) {
    // console.log("artwork component updated");

    // if we're given a url ( for instance by the user clicking on a search result during auto-tagging)
    // then we want to download it, and point the movie metadata to the downloaded local file instead
    if (oldProps.movie.artwork !== this.props.movie.artwork && isValidURL(this.props.movie.artwork)) {
      console.log("artwork changed from outside (i.e. from search results)");
      this.download(this.props.movie.artwork, oldProps.movie.artwork || '');
    }
  }

  componentDidMount(props) {
    this._isMounted = true;
    // const container = this.container.current;

    // set listener for drag and drop functionality
    document.addEventListener('drop', (event) => {
        event.preventDefault();
        // event.stopPropagation();

        console.log(JSON.stringify(event.dataTransfer));

        for (const f of event.dataTransfer.files) {
          // Using the path attribute to get absolute file path
          console.log('Oh you touched me! ', f.path)
        }

        try {
          const files = event.dataTransfer.files;
          if (files.length === 1) {
            if (/image/.test(files[0].type)) {
              this.handleLocalFile(files[0].path);
            } else {
              console.log("Wrong file type: images only");
            }
          } else if (files.length === 0) {
            console.log("No files found");
          } else {
            console.log("Only 1 file at a time");
          }
        } catch(err) {
          console.error(err);
        }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('dragenter', (event) => {
      // console.log('File is in the Drop Space');
    });

    document.addEventListener('dragleave', (event) => {
      // console.log('File has left the Drop Space');
    });
  }

  componentWillUnmount() {
    this.removeDownloadListener();
    this.clearDownloadStatusTimer();
    ipcRenderer.removeListener('editor-artwork-selected', this.handleArtworkSelected);
    this._isMounted = false;
  }

  render() {
    return (
      <div ref={this.container}>
        <img
          id="edit-artwork-image"
          src={this.props.movie.artwork || this.props.placeholderImage}
          width="100"
          onMouseOver={(e) => this.imageOver(e)}
          onMouseLeave={(e) => this.imageOut(e)}
        />
        <div>
          <input ref={this.input} type="text" id="edit-field-artwork" value={this.state.value || ""} placeholder={this.props.placeholder || "Paste path/URL"} onChange={(e) => this.handleInput(e)} />
          <div ref={this.dlMsg} id="edit-field-artwork-dl-msg" style={{display:"none"}}>{this.state.message}</div>
        </div>
        <div id="edit-field-artwork-buttons">
          <div ref={this.revert} onClick={() => this.handleRevert()} className="edit-field-revert"></div>
          <button onClick={(e) => this.handleBrowse(e)}>Browse</button>
        </div>
      </div>
    );
  }
}

// ######  ###### //
class MynEditGraphicalWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      displayGraphic : [],
      property : "property",
      className : "class"
    }

    this.render = this.render.bind(this);
  }

  updateValue(value, event) {
    console.log("Changed " + this.props.movie.title + "'s " + this.state.property + " value to " + value);
    event.stopPropagation(); // clicking on the widget should not trigger a click on the whole row
    // this.props.movie[this.state.property] = value;

    // update the value
    if (this.props.update) {
      this.props.update(this.state.property,value);
    }

    // event.target.parentNode.classList.remove('over');
    findNearestOfClass(event.target,"edit-widget").classList.remove('over');
  }

  mouseOver(value,event) {
    this.updateGraphic(value);
    // event.target.parentNode.classList.add('over');
    findNearestOfClass(event.target,"edit-widget").classList.add('over');
  }

  mouseOut(target,event) {
    this.updateGraphic(this.props.movie[this.state.property]);
    target.classList.remove('over');
    // console.log("mouse out: " + target.classList)
    // try{
    //   event.stopPropagation();
    // } catch(error) {
    //   // console.log("called from <ul>");
    // }
  }

  componentDidMount(props) {
    this.setState({className : this.state.className + " edit-widget"})
    this.updateGraphic(this.props.movie[this.state.property]);
  }

  componentDidUpdate(oldProps) {
    // console.log('MynEditGraphicalWidget is updating ' + this.state.property + ' for ' + this.props.movie.title);
    if (!_.isEqual(oldProps.movie[this.state.property],this.props.movie[this.state.property])) {//(oldProps.movie[this.state.property] !== this.props.movie[this.state.property]) {
      this.updateGraphic(this.props.movie[this.state.property]);
    }
  }

  // updateGraphic(graphic) {
  //   this.setState({displayGraphic : graphic});
  // }

  render() {
    // return (<ul className={this.state.className} onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayGraphic}</ul>);
    return (<ul className={this.state.className}>{this.state.displayGraphic}</ul>);
  }
}

// ######  ###### //
class MynEditWidgetCheckmark extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      className : "checkmarkContainer"
    }

    this.render = this.render.bind(this);
  }

  updateGraphic(value) {
    let graphic = <li className={"checkmark " + (value ? "on" : "off")} onMouseOver={(e) => this.mouseOver(!this.props.movie[this.state.property],e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(!this.props.movie[this.state.property],e)}>{value ? this.state.onChar : this.state.offChar}</li>;
    this.setState({displayGraphic : graphic});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// ###### Graphical editor for the 'seen' checkmark ###### //
class MynEditSeenWidget extends MynEditWidgetCheckmark {
  constructor(props) {
    super(props)

    this.state = {
      property: "seen",
      className: "seen",
      onChar: "\u2714",
      offChar: "\u2718"
    }

    this.render = this.render.bind(this);
  }
}

// ###### Graphical editor for the 'watchlater' widget ###### //
class MynEditWatchlaterWidget extends MynEditWidgetCheckmark {
  constructor(props) {
    super(props)

    this.state = {
      property: "watchlater",
      className: "watchlater",
      onChar: "\u2665",
      offChar: "\u2661"
    }

    this.render = this.render.bind(this);
  }
}

// ###### Graphical editor for the 5-star user rating ###### //
class MynEditRatingWidget extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "ratings",
      className : "stars"
    }

    this.render = this.render.bind(this);
    this.updateGraphic = this.updateGraphic.bind(this);
  }

  updateGraphic(rating) {
    // sometimes the actual rating value will be passed to us here,
    // but other times, the whole ratings object will be passed,
    // in which case we want the value of the 'user' property
    if (rating.hasOwnProperty("user")) {
      rating = rating.user
    }

    let stars = [];
    let char = "";
    for (let i=1; i<=5; i++) {
      let starClass = "star ";

      // if (i === 0 && this.props.cancelBtn) {
      //   // char = "\u2298";
      //   // char="\u2205";
      //   // char="\u2715";
      //   // for some reason all these characters produce a weird bug where the stars get smaller????
      //
      //   starClass += "cancel";
      // } else if (i === 0 && !this.props.cancelBtn) {
      //   continue;
      /* } else*/ if (i <= rating) {
        char="\u2605";
        starClass += "filled";
      } else {
        char="\u2606";
        starClass += "empty";
      }
      let update = _.cloneDeep(this.props.movie[this.state.property]);
      update["user"] = i;
      stars.push(<li className={starClass} key={i} onMouseOver={(e) => this.mouseOver(i,e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(update,e)}>{char}</li>);
    }
    this.setState({displayGraphic : stars});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// ###### Graphical editor for the 'position' attribute ###### //
class MynEditPositionWidget extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "position",
      className : "position",
    }

    this.render = this.render.bind(this);
  }

  getPositionFromMouse(event) {
    let position = 0;
    const duration = this.props.movie.metadata ? this.props.movie.metadata.duration : null;

    try {
      let target = findNearestOfClass(event.target,'position-container');
      let widgetX = window.scrollX + target.getBoundingClientRect().left;
      let widgetWidth = target.clientWidth;
      let mouseX = event.clientX;

      position = (mouseX - widgetX) / widgetWidth * duration;
    } catch(err) {
      console.error('Error in MynEditPositionWidget: ' + err);
    }

    // console.log(
    //   'mouseX: ' + mouseX + '\n' +
    //   'widgetX: ' + widgetX + '\n' +
    //   // 'offsetLeft: ' + event.target.offsetLeft + '\n' +
    //   'widgetWidth: ' + widgetWidth + '\n' +
    //   '(mouseX - widgetX) / widgetWidth == ' + position / this.props.movie.metadata.duration
    // );

    return position;
  }

  updatePosition(event) {
    this.mouseOver(this.getPositionFromMouse(event),event);
  }

  updateGraphic(position) {
    const duration = this.props.movie.metadata ? Number(this.props.movie.metadata.duration) : null;
    if (!duration) return;

    position = Number(Math.min(Math.max(position,0),duration));
    let graphic = (
      <div className="position-widget">
        {/*<div className="position-outer"
          onMouseMove={(e) => this.updatePosition(e)}
          onMouseLeave={(e) => this.mouseOut(findNearestOfClass(event.target,'position-outer').parentElement,e)}
          onClick={(e) => this.updateValue(Math.round(position * 10)/10,e)}>
            {<div className="position-inner" style={{width:(position / duration * 100) + "%"}} />}
        </div>*/}

        <div className="position-container"
          onMouseMove={(e) => this.updatePosition(e)}
          onMouseLeave={(e) => this.mouseOut(findNearestOfClass(event.target,'position-widget'),e)}
          onClick={(e) => this.updateValue(Math.round(position * 10)/10,e)}
        >
          <div className="position-bar filled" style={{width:(position / duration * 100) + "%"}}/>
          <div className="position-bar empty" />
        </div>

        <div className="position-text">
          {position / duration > .01 ? `${Math.floor(position / 60)}:${(position % 60) < 10 ? '0' : ''}${Math.floor(position % 60)} \u2022 ` : null}
          {duration ? (duration >= 60 ? `${Math.round(duration / 60)} min` : `${Math.round(duration)} sec`) : null}
        </div>
      </div>
    );

    this.setState({displayGraphic : graphic});
  }

  // componentDidMount(props) {
  //   // ReactDOM.findDOMNode(this.refs.outer)
  //   return super.componentDidMount(props);
  // }

  // we have to override the super componentDidUpdate method
  // because in the case of the position widget, we need to check for
  // both a difference in position, but also a difference in duration
  componentDidUpdate(oldProps) {
    let duration;
    let oldDuration;
    if (this.props.movie.metadata) duration = this.props.movie.metadata.duration;
    if (oldProps.movie.metadata) oldDuration = oldProps.movie.metadata.duration;

    if (oldProps.movie.position !== this.props.movie.position || (!isNaN(duration) && oldDuration !== duration)) {
      // console.log('MynEditPositionWidget is updating for ' + this.props.movie.title);
      // console.log(`${oldProps.movie.position} !== ${this.props.movie.position} || ${oldDuration} !== ${duration}`);
      this.updateGraphic(this.props.movie.position);
    }
  }

  render() {
    // if the duration is 0, '', or does not exist, return nothing
    if (!this.props.movie.metadata || !this.props.movie.metadata.duration) {
      return null;
    } else {
      return super.render();
    }
  }
}

class MynShowPositionWidget extends React.Component {
  constructor(props) {
    super(props)

  }

  render() {
    const duration = this.props.video.metadata ? Number(this.props.video.metadata.duration) : null;
    if (!duration) return null;
    let position = Number(Math.min(Math.max(this.props.video.position,0),duration));

    return (
      <div className="position-widget">
        <div className="position-container">
          <div className="position-bar filled" style={{width:(position / duration * 100) + "%"}}/>
          <div className="position-bar empty" />
        </div>
        <div className="position-text" style={{display:(this.props.showText ? 'block' : 'none')}}>
          {position / duration > .01 ? `${Math.floor(position / 60)}:${(position % 60) < 10 ? '0' : ''}${Math.floor(position % 60)} \u2022 ` : null}
          {duration ? (duration >= 60 ? `${Math.round(duration / 60)} min` : `${Math.round(duration)} sec`) : null}
        </div>
      </div>
    );
  }
}

// ######  ###### //
class MynEditListWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      list: []
    }

    this.render = this.render.bind(this);
    this.updateList = this.updateList.bind(this);
  }

  updateList(list) {
    // console.log('ORIGINAL UPDATELIST')
    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  deleteItem(index, skipDialog) {
    if (this.props.deleteDialog && !skipDialog) {
      ipcRenderer.once('MynEditListWidget-confirm-delete-item', (event, response, index) => {
        if (response === 0) { // yes
          // delete item (pass 'true' so as not to prompt another dialog)
          this.deleteItem(index, true);
        } else {
          console.log('Deletion canceled by user')
        }
      });

      ipcRenderer.send('generic-confirm', 'MynEditListWidget-confirm-delete-item', `Are you sure you want to remove '${this.state.list[index]}'? ${this.props.deleteDialog}`, index);
      return;
    }

    var temp = this.state.list;
    temp.splice(index, 1);
    this.updateList(temp);
  }

  displayList() {
    return this.state.list.map((item, index) => {
      let displayItem
      try {
        displayItem = this.props.displayTransform(item);
      } catch(err) {
        displayItem = item
      }

      if (this.props.marquee) {
        displayItem = (<MynOverflowTextMarquee text={displayItem} direction={this.props.overflowDirection} ellipsis='fade' fadeSize='2em' />);
      }

      return (
        <li key={index} className="list-widget-item" title={item}>
          <pre>{displayItem}</pre>
          <div className="list-widget-delete-item inline-delete-button" onClick={() => this.deleteItem(index)}>
            {"\u2715"}
          </div>
        </li>
      );

    });
  }

  componentDidMount(props) {
    this.setState({list:this.props.object[this.props.property]});
  }

  componentDidUpdate(oldProps) {
    if (oldProps.object[this.props.property] !== this.props.object[this.props.property]) {
      this.setState({list:this.props.object[this.props.property]});
    }
  }

  render() {
    // return (<ul className={this.state.className} onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayGraphic}</ul>);
    return (<ul className={"list-widget-list " + this.props.property}>{this.displayList()}</ul>);
  }
}

// ######  ###### //

//<MynEditAddToList
//movie={this.state.video}
//property="cast"
//validator={/.*/g}
//options={null} />
class MynEditAddToList extends MynEditListWidget {
  constructor(props) {
    super(props)

    this.state = {
      id : "list-widget-add-" + props.property,
      value : ''
    }

    this.render = this.render.bind(this);
  }

  /* test for valid input */
  handleInput(event) {
    const input = document.getElementById(this.state.id + "-input");

    // update form field to reflect user actions, applying a transform if it was given
    try {
      this.setState({value:this.props.displayTransform(input.value)});
    } catch(err) {
      this.setState({value:input.value});
    }

    const item = input.value;
    if (item === "") {
      super.handleValidity(true,this.props.property,input);
    } else if (this.props.validator.test(item)) {
      super.handleValidity(true,this.props.property,input);
    } else {
      super.handleValidity(false,this.props.property,input,this.props.validatorTip);
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
  }

  addItem(event) {
    const input = document.getElementById(this.state.id + "-input");
    let item = input.value;
    if (item === "") {
      // do nothing
    } else if (this.props.validator.test(item)) {
      // if we're given a transform function (i.e. we want the saved value to be different
      // in some way than the value of the input form), transform the value here before updating it
      if (this.props.storeTransform) {
        item = this.props.storeTransform(item);
        // console.log('transformed to ' + item);
      }

      let temp = this.state.list;
      try {
        if (!this.state.list.includes(item)) {
          temp.push(item);
        }
      } catch(e) {
        temp = [item];
      }
      this.updateList(temp);
      // input.value = '';
      this.setState({value:''});
    } else {
      // do nothing
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
    event.preventDefault();
    // event.stopPropagation();
  }

  // if Enter is pressed, add item
  keyDown(event) {
    if (event.key === "Enter") {
      this.addItem(event);
    }
  }

  render() {
    let options = null;
    let listName = null;
    if (this.props.options) {
      listName = "used-" + this.props.property;
      options = (
        <datalist id={listName}>
          {this.props.options.map((option) => (<option key={option} value={option} />))}
        </datalist>
      );
    }

    return (
      <div id={this.state.id} className={"list-widget-add select-container " + (this.props.inline || "") + (this.props.options ? " select-hovericon" : "") + (options ? " datalist" : "")}>
        <input type="text" list={listName} id={this.state.id + "-input"} className="list-widget-add-input" placeholder={this.props.placeholder || "Add..."} value={this.state.value} minLength="1" onChange={(e) => this.handleInput(e)} onKeyDown={(e) => this.keyDown(e)} />
        <button className="editor-inline-button" onClick={(e) => this.addItem(e)}>{"\uFE62"}</button>
        {options}
      </div>
    );
  }
}

// Can either call MynEditListWidget followed by MynEditAddToList
// or, alternatively, call this class, which places the add-to-list
// field within the list itself, at the end
class MynEditInlineAddListWidget extends MynEditListWidget {
  constructor(props) {
    super(props)
  }
  render() {
    return (
      <ul className={"list-widget-list " + this.props.property}>
        {this.displayList()}
        <MynEditAddToList object={this.props.object} property={this.props.property} update={this.props.update} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.props.validator} validatorTip={this.props.validatorTip} placeholder={this.props.placeholder} />
      </ul>
    );
  }
}

class MynEditSubtitles extends MynEditListWidget {
  constructor(props) {
    super(props)


    this.validator = {
      test: (val) => (val && val !== '' && fs.existsSync(val))
    }

    this.validatorTip = 'File does not exist';

    // this.input = React.createRef();

    this.handleSubtitleSelected = (event, subs) => {
      if (subs) {
        let update = [...this.props.object[this.props.property], ...subs];
        this.updateList(update);
      } else {
        console.log("Unable to select subtitle file(s): nothing returned from server");
      }
    };

    this.render = this.render.bind(this);
    this.addToListUpdate = this.addToListUpdate.bind(this);
  }

  // update(property,list) {
  //   if (input.value !== '' && fs.existsSync(input.value)) {
  //     let update = [...this.props.video.subtitles, input.value]
  //     this.props.update('subtitles',update);
  //   }
  // }

  // override updateList from MynEditListWidget to check if the file exists;
  // we're also using the validator function passed to MynEditAddToList
  // to do an existence check as the user types a file name,
  // because that gives visual feedback before the user tries to add the file;
  // (note: MynEditAddToList has its own updateList function, which is also called
  // when the user adds an item, which may be confusing: MynEditAddToList's own
  // updateList function , but we're passing THIS updateList
  // function to MynEditAddToList as its props.update function (well, through
  // this.addToListUpdate which just fixes the parameters), which it runs when the
  // user clicks to add; we do that so we can reuse this logic, mainly to prevent
  // the user from adding a duplicate, though it also checks for existence again)
  //
  // so to summarize: this function runs when the user clicks 'open' from the
  // browse dialog window, and when the user clicks the add (+) button next to the
  // text input field (if there is valid input in it)
  updateList(list) {
    // console.log('NEW UPDATELIST')
    let added = list.filter(el => !this.state.list.includes(el));
    let rejected = [];
    added.map(sub => {
      if (typeof sub !== 'string' || !fs.existsSync(sub)) {
        rejected.push(sub);
      }
    })

    // filter nonexistent files and get rid of duplicates
    list = Array.from(new Set(list.filter(el => !rejected.includes(el))));

    if (rejected.length > 0) {
      alert(`The following subtitle files could not be found:\n${rejected.map(el=>'\n'+el)}`);
    }

    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  // passed to MynEditAddToList as its props.update function,
  // all we do is take the list parameter and call updateList
  // with it, since that function doesn't take the property parameter
  addToListUpdate(property,list) {
    this.updateList(list);
  }

  emptyList() {
    this.updateList([]);
  }

  componentDidMount() {
    super.componentDidMount();
    ipcRenderer.on('editor-subtitle-selected', this.handleSubtitleSelected);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('editor-subtitle-selected', this.handleSubtitleSelected);
  }


  render() {
    return (
      <ul className={"list-widget-list browse subtitles"}>
        {this.displayList()}
        <li className='list-widget-add-with-browse'>
          <MynEditAddToList object={this.props.object} property={this.props.property} update={this.addToListUpdate} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.validator} validatorTip={this.validatorTip} />
          <button className='list-widget-browse editor-inline-button' onClick={() => ipcRenderer.send('editor-subtitle-select')}><div className='icon-container'></div></button>
        </li>
        <li>
          <button className='' onClick={() => this.emptyList()}>Clear All Subtitles</button>
        </li>
      </ul>
    );
  }
}

// <MynEditDateWidget movie={this.state.video} property="cast" update={this.handleChange} />
class MynEditDateWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      inputValue : "",
      inputValueTimestamp : null,
      userFeedback : null,
      valid : true
    }

    this.input = React.createRef();
  }

  isValidDate(d) {
    return d instanceof Date && !isNaN(d);
  }

  // we may want to use a library for this for more robustitudinality and such
  // cleanDateInput(input) {
  //   try {
  //     // get rid of ordinal suffixes
  //     input = input.replace(/(\d+)(?:st|nd|rd|th)/gi, (match,$1) => $1);
  //
  //     // rough-and-tumble convert to military time, deleting "am" and "pm"
  //     input = input.replace(/((\d{1,2})(:\d\d)?(:\d\d)?)(am?|pm?)/gi, (...groups) => {
  //       groups = groups.filter(el => el !== undefined); // clean array of undefined matches
  //       console.log(groups);
  //       let ampm = groups.findIndex(el => el.match(/^am?$|^pm?$/i));
  //       console.log("ampm index: " + ampm);
  //       if (!isNaN(groups[2]) && groups[2] < 12 && groups[ampm].match(/p/i)) {
  //         groups[2] = parseInt(groups[2]) + 12;
  //       }
  //       return groups.slice(2,ampm).join('');
  //     });
  //
  //     // console.log("cleaned input: " + input);
  //   } catch(error) {
  //     console.log(error);
  //   }
  //   return input;
  // }

  handleValidity(valid, tip) {
    let element = this.input.current;
    super.handleValidity(valid,this.props.property,element,tip);
  }

  handleInput(event) {
    // update the state variable so that the form input reflects what is typed
    this.setState({inputValue: event.target.value});

    // now figure out if it's a valid date
    // and if so, update the parent object
    let value = event.target.value;//this.cleanDateInput(event.target.value);
    try {
      let date = Date.parse(value);

      // if field is empty, reset to valid, pass null to parent
      if (value === "") {
        this.handleValidity(true);
        this.props.update(this.props.property,null);

      // if field is a valid date, reset to valid, pass timestamp of date to parent
      } else if (this.isValidDate(date)) {
        let timestamp = Math.round(date.getTime() / 1000);
        this.handleValidity(true, date.toString("M/d/yyyy, hh:mm:ss tt"));//date.toString().replace(/\sGMT.*$/,''));
        this.props.update(this.props.property,timestamp);

      // if we're here, whatever's in the field is invalid; reset to invalid,
      // pass null to parent;
      } else {
        this.handleValidity(false, "Invalid Date");
        this.props.update(this.props.property,null);
      }
    } catch(error) {
      console.error(error);
    }
  }

  setStateValuesFromProps() {
    let timestamp = this.props.movie[this.props.property];
    if (timestamp) {
      let value = timestamp;
      let date = new Date(timestamp * 1000);
      if (this.isValidDate(date)) {
        value = date.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
      }
      this.setState({
        inputValue : value,
        inputValueTimestamp: timestamp
      });
    }
  }

  componentDidMount(props) {
    // set initial value
    this.setStateValuesFromProps();
  }

  componentDidUpdate(oldProps) {
    // console.log("PROPSCHANGE\nold: " + oldProps.movie[this.props.property] + "\nnew: " + this.props.movie[this.props.property] + '\nste: ' + this.state.inputValueTimestamp);
    if (oldProps.movie[this.props.property] != this.props.movie[this.props.property]) {// && this.props.movie[this.props.property] != this.state.inputValueTimestamp) {
      this.setStateValuesFromProps();
      super.handleValidity(true);
    }
  }

  render() {
    return (
      <div className={"date-widget " + this.props.property}>
        <input ref={this.input} type="text" value={this.state.inputValue} placeholder={this.props.property} onChange={(e) => this.handleInput(e)} />
      </div>
    );
  }
}

class MynDropdown extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      list : props.list
    }

    this.showList = this.showList.bind(this);
    this.hideList = this.hideList.bind(this);
    this.list = React.createRef();
  }

  showList(e) {
    clearTimeout(this.mouseTimer);
    this.mouseTimer = setTimeout(() => {
      this.list.current.style.overflowY = 'visible';
      this.list.current.classList.add('expanded');
    },100);
  }

  hideList(e) {
    clearTimeout(this.mouseTimer);
    this.mouseTimer = setTimeout(() => {
      this.list.current.style.overflowY = 'hidden';
      this.list.current.classList.remove('expanded');
    },200);
  }


  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.list,this.props.list)) {
      this.setState({list:this.props.list});
    }
  }

  render() {
    let list = this.state.list.filter(item => typeof item !== "undefined" && item !== null);

    return (
      <ul ref={this.list} className='dropdown-list'>
        {list.map((item,i) => (
          <li
            key={i}
            className={`dropdown-item${this.props.selected === i ? ' selected' : ' unselected'}${i === 0 ? ' first' : ''}${i === list.length-1 ? ' last' : ''}`}
            onMouseOver={this.showList}
            onMouseOut={this.hideList}
          >
            {item}
          </li>
        ))}
      </ul>
    );
  }
}

class MynRecentlyWatched extends MynDropdown {
  constructor(props) {
    super(props)

    this.playNextVideo = this.playNextVideo.bind(this);
  }

  findNextVideoInSeries(id) {
    const current = library.media.find(video => video && video.id === id);
    if (!current || !current.series) return null;

    const sortNumber = value => {
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
    };

    const related = library.media
      .filter(video => video && video.series === current.series)
      .sort((a,b) => {
        const seasonDiff = sortNumber(a.season) - sortNumber(b.season);
        if (seasonDiff !== 0) return seasonDiff;

        const episodeDiff = sortNumber(a.episode) - sortNumber(b.episode);
        if (episodeDiff !== 0) return episodeDiff;

        return a.title.localeCompare(b.title);
      });

    const currentIndex = related.findIndex(video => video.id === id);
    return currentIndex >= 0 && related[currentIndex + 1]
      ? related[currentIndex + 1].id
      : null;
  }

  playNextVideo(id) {
    if (id) {
      this.props.playVideo(id);
    } else {
      console.error('Cannot play next video; none was found');
    }
  }

  componentDidMount() {
    this.createListItems();
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.list,this.props.list)) {
      this.createListItems();
    }
  }

  createListItems() {
    if (this.props.list && Array.isArray(this.props.list)) {
      const list = this.props.list.map(id => {
        let video = library.media.find(video => video && video.id === id);
        if (!video) return null;

        let nextVidID = this.findNextVideoInSeries(id);

        return (
          <div className='container' key={id}>
            <div className='video' onClick={() => this.props.playVideo(video.id)}>
              <div className='artwork' style={{backgroundImage:`url('${video.artwork ? URL.pathToFileURL(video.artwork) : URL.pathToFileURL(placeholderImage.replace(/^\.\.\//,''))}')`}} />
              <div className='title-position-container'>
                <div className='title'><MynOverflowTextMarquee text={video.title} /></div>
                {video.position > 0 ? <MynShowPositionWidget video={video} /> : null}
              </div>
            </div>
            <div className='next-btn' onClick={() => this.playNextVideo(nextVidID)}><img src='../images/ff-icon_white.png' title='Play next video in series' alt='Icon by Font Awesome by Dave Gandy - https://fortawesome.github.com/Font-Awesome, CC BY-SA 3.0, https://commons.wikimedia.org/w/index.php?curid=24230861' /></div>
          </div>
        );
      });
      this.setState({list:list});
    }
  }

  render() {
    return super.render();
  }
}

// accepts a 'lede' prop and a 'paragraph' prop;
// displays only the lede
// until the user clicks the icon to unfold the whole paragraph
// additional props:
// 'hideLede' : whether to hide the lede when the paragraph is expanded
// 'className' and 'id' pass the class and id to the main div of the component
// 'keepEllipsis' : whether to keep the ellipsis when the paragraph is expanded
class MynParagraphFolder extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      expanded : false
    }

    // this.input = React.createRef();
    this.render = this.render.bind(this);
    this.toggle = this.toggle.bind(this);
  }

  toggle(e) {
    this.setState({ expanded : !this.state.expanded });
  }

  render() {
    return (
      <div onClick={this.toggle} id={this.props.id} className={'paragraph-fold ' + this.props.className} style={{display:'flex'/*, alignItems: (this.state.expanded ? 'flex-start' : 'center')*/}}>

        <div className='twirl-icon' style={{ cursor : 'pointer', fontStyle : 'normal', opacity: '.6'/*, lineHeight: '0px'/*, transform : (this.state.expanded ? 'rotate(90deg)' : 'rotate(0deg)') */}}>
          { this.state.expanded ? '\u25BC ' : '\u25B6 ' }
        </div>

        <div className='text-container'>

          <span className='lede' style={{cursor: 'pointer', display: this.props.hideLede ? (!this.state.expanded ? '' : 'none') : ''}}>
            {' ' + (this.state.expanded ? this.props.lede : this.props.lede.replace(/[.,;]\s*$/,''))}
            {this.props.keepEllipsis ? '\u2026' : (this.state.expanded ? ' ' : '\u2026')}
          </span>

          <span className='paragraph' style={{display: this.state.expanded ? '' : 'none'}}>
            {this.props.paragraph}
          </span>

        </div>

      </div>
    );
  }
}

class MynTooltip extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      id : uuidv4(),
      timeout : null,
      shown : false
    }

    this.tipDiv = null;
    this.iconDiv = React.createRef();
    this.render = this.render.bind(this);
    this.showTip = this.showTip.bind(this);
    this.hideTip = this.hideTip.bind(this);
  }

  showTip(x,y) {
    this.state.shown = true;
    // show the div
    this.tipDiv.style.display = 'block';

    // if (typeof x === 'undefined' || typeof y === 'undefined') {
    //   // set the div position based on the mouse position
    //   let x = e.clientX;
    //   let y = e.clientY;
    // }

    // set the div position based on the icon div's position
    // let x = this.iconDiv.current.getBoundingClientRect().left;
    // let y = this.iconDiv.current.getBoundingClientRect().top;

    let fontSize = window.getComputedStyle(this.tipDiv, null).getPropertyValue('font-size');
    let maxWidth = Math.min(parseFloat(fontSize) * 25,window.innerWidth);
    let minWidthIfWrapping = Math.min(parseFloat(fontSize) * 20,window.innerWidth); // we'll set this as the minimum width, but only if the text is long enough to fill it
    let width = this.tipDiv.offsetWidth;

    // we have to set the white space to nowrap just long enough to get the scrollWidth
    // in order to see if the text is wrapping
    // this.tipDiv.style.whiteSpace = 'nowrap';
    let scrollWidth = this.tipDiv.scrollWidth;
    this.tipDiv.style.whiteSpace = 'normal';


    if (scrollWidth > minWidthIfWrapping) {
      // console.log('wrapping...');
      // if the text is long enough to fill the minimum width we've set, set the width to at least that;
      width = Math.max(width,minWidthIfWrapping);
      this.tipDiv.style.width = width + 'px';
    }
    // now test if the div will overflow off the right side of the window
    // and if so, move it over to the left
    let rightOverflow = x + width - window.innerWidth;
    if (rightOverflow > 0) x -= rightOverflow;

    this.tipDiv.style.left = x + 'px';
    this.tipDiv.style.top = (y + parseFloat(fontSize)) + 'px';
    this.tipDiv.style.maxWidth = maxWidth + 'px';


    // console.log('font size: ' + fontSize);
    // console.log('element width: ' + this.tipDiv.offsetWidth);
    // console.log('min width if wrapping: ' + minWidthIfWrapping);
    // console.log('scroll width: ' + scrollWidth);
    // console.log('window width: ' + window.innerWidth);
    // console.log('right overflow: ' + rightOverflow);
    // console.log(`x: ${x}, y: ${y}`);
  }

  hideTip() {
    this.state.shown = false;
    this.tipDiv.style.display = 'none';
    clearTimeout(this.state.timeout);
  }

  toggleTip(e) {
    e.stopPropagation();

    if (this.state.shown) {
      this.hideTip();
    } else {
      this.showTip(e.pageX,e.pageY);
    }
  }

  componentDidMount() {
    // const tipDiv = (
    //   <div ref={this.tip} className='tip' id={this.state.id}>
    //     {this.props.tip}
    //   </div>
    // );

    this.tipDiv = document.createElement('div');
    this.tipDiv.classList.add('tooltip');
    this.tipDiv.id = this.state.id;
    this.tipDiv.innerHTML = this.props.tip;

    document.body.appendChild(this.tipDiv);
  }

  componentWillUnmount() {
    // const tipDiv = document.getElementById(this.state.id);
    document.body.removeChild(this.tipDiv);
  }

  render() {
    return (
      <div
        ref={this.iconDiv}
        className={`tooltip-icon ${this.props.shade ? this.props.shade : ''}`}
        onMouseEnter={(e) => {let x = e.pageX; let y = e.pageY; this.state.timeout = setTimeout(() => this.showTip(x,y),200)}}
        onMouseLeave={this.hideTip}
        onClick={(e) => this.toggleTip(e)}
      />
    );
  }
}

// helper function to test whether a video object is a valid video
// all it does right now is check for top-level properties
// eventually it should do more than that
function validateVideo(video) {
  if (typeof video === undefined || video === null) {
    return false;
  }
  // let repaired = _.cloneDeep(video);
  let repaired = video; // don't clone, because we want to alter the video in place
  let oldVidCopy = _.cloneDeep(video); // but do clone a copy for comparison at the end

  const properties = {
    'id':'string',
    'title':'string',
    'year':'integer',
    'series':'string',
    'season':'integer',
    'episode':'integer',
    'director':'string',
    'directorsort':'string',
    'cast':'array',
    'description':'string',
    'genre':'string',
    'tags':'array',
    'seen':'boolean',
    'position':'integer',
    'ratings':'object',
    'dateadded':'integer',
    'lastseen':'integer',
    'kind':'string',
    'filename':'string',
    'artwork':'string',
    'subtitles':'array',
    'boxoffice':'number',
    'rated':'string',
    'languages':'array',
    'country':'string',
    'metadata':'object',
    'imdbID':'string',
    'seriesImdbID':'string',
    'autotag_tried':'boolean',
    'dvd':'boolean',
    'watchlater':'boolean'
  };

  let vidProps = Object.keys(video);
  let propKeys = Object.keys(properties);
  for (const property of propKeys) {
    // if (vidProps.includes(property)) {
      // repair any malformed properties
      switch(properties[property]) {
        // ratings and metadata
        case 'object' :
          if (typeof video[property] === 'undefined' || typeof video[property] !== 'object' || typeof video[property] === null) {
            if (property === 'metadata') {
              repaired[property] = {
                "codec" : "",
                "duration" : 0,
                "width" : 0,
                "height" : 0,
                "aspect_ratio" : "",
                "framerate" : 0,
                "audio_codec" : "",
                "audio_layout" : "",
                "audio_channels" : 0
              }
            } else {
              repaired[property] = {};
            }
          }
          break;
        // tags, cast, languages
        case 'array' :
          if (!Array.isArray(video[property])) {
            repaired[property] = [];
          }
          break;
        // year, season, episode, position, dateadded, lastseen
        // season also permits the special "extras" category
        case 'integer' :
          if (property === 'season' && String(video[property]).toLowerCase() === 'extras') {
            repaired[property] = 'extras';
            break;
          }
          repaired[property] = parseInt(video[property]);
          if (!Number.isInteger(repaired[property])) {
            repaired[property] = ''; // going with empty string instead of some integer like 0 or -1, for a variety of reasons
          }
          break;
        // boxoffice
        case 'number' :
          if (isNaN(video[property])) {
            // repaired[property] = 0;
            repaired[property] = ''; // we want to go with an empty string here, because the editor is set up to treat the empty string as, effectively, an unset value
          }
          break;
        // seen
        case 'boolean' :
          if (typeof video[property] !== 'boolean') {
            repaired[property] = false;
          }
          break;
        // most things
        case 'string' :
          if (typeof video[property] !== 'string') {
            repaired[property] = '';
          }
      }
    // } else {
    //   // the property doesn't exist, so create it
    //   repaired[property] = '';
    // }
  }

  // Video fields are intentionally universal rather than kind-dependent.
  // Keep the parent-series field present everywhere, but never retain a value
  // on a movie or custom kind where it would have no meaning.
  if (repaired.kind !== 'show') {
    repaired.seriesImdbID = '';
  }

  // if no id, create one
  if (!video.id || video.id === '') {
    video.id = uuidv4();
    console.log('validateVideo had to create an ID for this video: ' + video.filename);
  }

  // if the ratings object doesn't have all the sources, fill it with empty values;
  // most things will work fine if we don't do this, but the bit of logic
  // that tests whether or not a video has changed in the video editor since last save
  // breaks without the keys present in this object (MynEditRatings doesn't
  // add them on load, but DOES add them on revert-to-saved, making MynEditorEdit think
  // that the video has changed even right after it's reverted)
  const keys = Object.keys(video.ratings);
  const sources = ['imdb','rt','mc','user'];
  sources.map(source => {
    if (!keys.includes(source)) video.ratings[source] = '';
  });

  if (!_.isEqual(oldVidCopy,repaired)) {
    // console.log('video had to be repaired: ' + video.title);
    // return repaired;
    return false;
  } else {
    return true;
  }
}

// helper function to determine if a string is a valid URL
function isValidURL(s) {
  try {
    let url = new URL.URL(s);
    return url.host !== '';
  } catch (error) {
    return false;
  }
}

// finds first element with targetClass, either the element itself,
// or the nearest of its ancestors; this prevents bubbling problems
// by ensuring that we know which element we're operating on,
// instead of relying on event.target, which could be a child element
function findNearestOfClass(element, targetClass) {
  while (!element.classList.contains(targetClass) && (element = element.parentElement));
  return element;
}

// https://stackoverflow.com/a/40610459
function getObjectDiff(obj1, obj2) {
  const diff = Object.keys(obj1).reduce((result, key) => {
    if (!obj2.hasOwnProperty(key)) {
      result.push(key);
    } else if (_.isEqual(obj1[key], obj2[key])) {
      const resultKeyIndex = result.indexOf(key);
      result.splice(resultKeyIndex, 1);
    }
    return result;
  }, Object.keys(obj2));

  return diff;
}

function getArrayDiff(arr1,arr2) {
  arr1 = _.cloneDeep(arr1);
  arr2 = _.cloneDeep(arr2);
  let diff = [];

  arr1.map((el,index) => {
    let found = false;
    for (let i=0; i<arr2.length; i++) {
      if (_.isEqual(el,arr2[i])) {
        arr2.splice(i, 1);
        found = true;
        break;
      }
    }
    if (!found) {
      diff.push(el);
    }
  });

  diff = [...diff,...arr2];
  return diff;
}

function isEqualIgnoreFuncs(obj1,obj2) {
  // console.log('-----isEqualIgnoreFuncs----');

  // console.log('Originals...');
  // console.log(obj1);
  // console.log(obj2);
  // console.log(`isEqual? ${_.isEqual(obj1,obj2)}`);

  const shallowCloneNoFunc = (obj) => {
    let copy = {}
    Object.keys(obj).map((key) => {
      if (!_.isFunction(obj[key]))
        copy[key] = obj[key];
    });
    return copy;
  };

  const deepCloneNoFunc = (obj) => {
    let copy = {}
    Object.keys(obj).map((key) => {
      if (!_.isFunction(obj[key]))
        copy[key] = _.cloneDeep(obj[key]);
    });
    return copy;
  };


  let new1 = _.cloneDeepWith(obj1,deepCloneNoFunc);
  let new2 = _.cloneDeepWith(obj2,deepCloneNoFunc);

  // console.log('NoFunc Clones...');
  // console.log(new1);
  // console.log(new2);
  // console.log(`isEqual? ${_.isEqual(new1,new2)}`);

  return _.isEqual(new1,new2);
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {    // Update state so the next render will show the fallback UI.
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {    // You can also log the error to an error reporting service
    console.log(error);
    console.log(errorInfo);
  }

  render() {
    if (this.state.hasError) {      // You can render any custom fallback UI
      return <h2>Something went wrong.</h2>;
    }
    return this.props.children;
  }
}

const library = new Library;
ReactDOM.render(<Mynda library={library}/>, document.getElementById('root'));
