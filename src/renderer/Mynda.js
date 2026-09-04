// Root renderer component and application-level state coordination.
const React = require('react');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const {
  library,
  frontendLog,
  libraryViewLog,
  playerLog
} = require('./RendererRuntime.js');
const {batchNewState, batchRatingsState, validateVideo} = require('./RendererUtils.js');
const {ErrorBoundary, MynNotify} = require('./SharedComponents.js');
const {MynNav} = require('./Navigation.js');
const {MynLibrary, MynDetails} = require('./LibraryView.js');
const {MynSettings} = require('./Settings.js');
const {MynEditor} = require('./Editor.js');
const {MynPlayer} = require('./Player.js');

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
    this.scanWatchfolders = this.scanWatchfolders.bind(this);
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
    libraryViewLog.debug('Library row selection changed', {
      selectedVideoCount: allSelected.rows.length,
      selectedTableCount: Object.keys(this.state.selectedRows).length,
      highestRow: allSelected.highestRow
    });

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
      libraryViewLog.debug('Building batch details', {
        requestedVideoCount: vidIDs.length
      });
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
        if (key === 'ratings') {
          batchObject.ratings = batchRatingsState(videos);
          return;
        }
        // test each video's value for this key against that of the first video
        let testValue = _.cloneDeep(videos[0][key]);
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
      libraryViewLog.debug('Batch details ready', {
        videoCount: videos.length,
        sharedFieldCount: Object.keys(batchObject).length,
        newState: batchObject.new
      });

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
        libraryViewLog.warn('Could not resolve details video from the filtered library', {
          videoID: id,
          error: error
        });
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
    libraryViewLog.debug('Moving details selection', {
      offset: amount,
      currentRowID: this.state.detailRowID,
      manifestRowCount: this.state.playlistRowManifest.length
    });

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
        libraryViewLog.warn('Could not find the current details video in the row manifest', {
          currentRowID: this.state.detailRowID,
          manifestRowCount: this.state.playlistRowManifest.length
        });
        return;
      }
    }

    this.goToRow(this.state.playlistRowManifest[index + amount]);

    // we could use the following lines instead of the above if we just wanted to hover it:
    // let row = this.state.playlistRowManifest[index + amount];
    // this.forceRowHover(row.vidID, row.rowID);
  }

  goToRow(row) {
    if (!row) {
      libraryViewLog.warn('Could not find the requested row to move to');
      return;
    }

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
      libraryViewLog.warn('Could not find the requested table row to scroll to', {
        rowID: rowID
      });
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
      libraryViewLog.warn('Could not determine whether an element is off-screen', {
        error: err
      });
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
      libraryViewLog.warn('Could not find a row while checking its visibility', {
        rowID: rowID,
        error: err
      });
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
      libraryViewLog.warn('Could not measure a row while checking its visibility', {
        rowID: rowID,
        error: err
      });
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
      libraryViewLog.warn('Could not find the requested playlist; displaying the first playlist', {
        playlistID: id,
        error: error
      });
      try {
        playlist = this.state.playlists[0] // display the first one
        id = playlist.id
      } catch(error) {
        libraryViewLog.error('No playlists were available to display', {error: error});
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
      libraryViewLog.error('Could not execute a playlist filter', {
        playlistID: playlist && playlist.id,
        playlistName: name,
        error: err
      });
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
      libraryViewLog.warn('Could not set the requested playlist; using the first playlist', {
        playlistID: id,
        error: e
      });
      try {
        playlist = this.state.playlists[0] // display the first one
        id = playlist.id
      } catch(e) {
        libraryViewLog.error('No playlists were available while setting the current playlist', {
          error: e
        });
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
        libraryViewLog.warn('Playback video was not in the current playlist; using its library record', {
          videoID: id,
          playlistID: this.state.currentPlaylistID
        });

        let video = this.state.videos.filter(v => v.id === vidID)[0];
        if (video) {
          await this.setState({detailVideo: video});
        } else {
          playerLog.error('Could not play video because its library record was not found', {
            videoID: id
          });
          return;
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

  scanWatchfolders() {
    try {
      ipcRenderer.send('scan-watchfolders');
    } catch(err) {
      frontendLog.error('Could not request a watchfolder scan', {
        error: err && err.stack ? err.stack : String(err)
      });
    }
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
      libraryViewLog.error('Could not display the initial playlist', {error: e});
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
      frontendLog.debug('Renderer received a library save notification', {
        address: address
      });

      // if the whole media array was replaced at one time
      // (this happens when a watchfolder is removed or a batch is saved),
      // first put that replacement array into React state. setState() is
      // asynchronous, so rebuilding the playlist outside its callback would
      // make playlistFilter() read the old this.state.videos array and leave
      // the table showing stale data even though library.json was saved.
      if (address === 'media') {
        frontendLog.debug('Refreshing renderer state after media replacement');

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
        frontendLog.debug('Refreshing renderer state after a video edit', {
          address: address
        });
        this.setPlaylist(this.state.currentPlaylistID);
        this.setPlaylistLengths(true);
        this.refreshDetails(timeout);
      }

      // if a playlist was changed
      if (address.includes('playlists')) {
        // // change the playlistEditFlag, which components can listen for to find out if a video was edited
        // // (if they don't care which one or what the change was)
        // this.setState({playlistEditFlag:uuidv4()});

        frontendLog.debug('Refreshing renderer state after a playlist edit', {
          address: address
        });
        // reload the playlists, and then re-render the current playlist
        this.setState({playlists:this.props.library.playlists}, () => {

          this.setPlaylist(this.state.currentPlaylistID);

          // check all the playlist lengths (pass true to skip the one we just set above)
          this.setPlaylistLengths(true);
        });
      }

      // if the settings were changed
      if (address.includes('settings')) {
        frontendLog.debug('Refreshing renderer state after a settings edit', {
          address: address
        });
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
    libraryViewLog.debug('Refreshing details pane', {
      videoID: this.state.detailVideo && this.state.detailVideo.id
    });
    if (this.state.detailVideo) {
      if (this.state.detailVideo.id !== 'batch') {
        this.setState({detailVideo : this.state.videos.filter(video => video && video.id === this.state.detailVideo.id)[0]});
      } else {
        // if the detailVideo id is 'batch', that means multiple rows are selected;
        // calling handleSelectedRows with no parameters will reset the details pane and the editor
        // to correspond appropriately to the selected rows (without adding any new rows)
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          libraryViewLog.debug('Refreshing batch details after save');
          this.handleSelectedRows();
        },500);
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
            scanWatchfolders={this.scanWatchfolders}
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

module.exports = {Mynda};
