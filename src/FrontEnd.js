const React = require('react');
const ReactDOM = require('react-dom');
const electron = require('electron');
const { ipcRenderer } = require('electron');
const os = require('os');
const _ = require('lodash');
const DateJS = require('datejs');
const URL = require("url");
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const Collections = require('./Collections.js');
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
const pathToFFmpeg = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(pathToFFmpeg);
const ffprobe = require('ffprobe');
let ffprobeStatic = {};
try {
  ffprobeStatic = require('ffprobe-static');
} catch(err) {console.warn('Warning: ffprobe-static not installed')}
const placeholderImage = "../images/qmark.png";


// let savedPing = {};

class Mynda extends React.Component {
  constructor(props) {
    super(props)

    let library = this.props.library;

    this.state = {
      videos : library.media,
      playlists : library.playlists,
      collections : library.collections,
      settings: library.settings,
      recentlyWatched: library.recently_watched, // a list of the id's of the x most-recently-watched videos
      // recentlyWatched : ["a14fdec2-97db-5d2f-b537-f001493f0c48","f7fb6360-d4d9-582e-b162-f35c5fe1d406","72b9f3a0-aafe-50c6-8411-c0598b7cded8","d487a789-1799-5ed4-b2a9-786ddc474cf5","dd6d32e1-4427-5c9a-8a62-be284ea7ae00"],

      filteredVideos : [], // list of videos to display: can be filtered by a playlist or a search query or whatever; this is what is displayed
      playlistVideos : [], // list of videos filtered by the playlist only; this is used to execute a search query on
      playlistLength : {}, // will contain the number of videos in each playlist (playlist id as key)
      view : "flat", // whether to display a flat table or a hierarchical view
      columns : [], // the list of columns to display for the current playlist
      detailVideo : null,
      currentPlaylistID : null,
      prevQuery : '',
      selectedRows : {},

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
    this.showDetails = this.showDetails.bind(this);
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
      collections : library.collections,
      settings: library.settings
    });
  }

  handleHoveredRow(vidID, rowID) {
    // if nothing is selected, populate the details pane with the video of the row being hovered
    if (_.isEmpty(this.state.selectedRows)) {
      this.showDetails(vidID, rowID);
    }
  }

  forceRowHover(vidID, rowID) {
    this.state.selectedRows = {};
    this.handleHoveredRow(vidID,rowID);
  }

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
    let highestRow = '' + Number.MAX_SAFE_INTEGER;
    let selected = [];
    Object.keys(this.state.selectedRows).map(tableID => {
      // add the selected videos from this table
      selected = [...selected, ...this.state.selectedRows[tableID].rows];

      // // if this table's highest row is higher than the highest so far,
      // // save this table's highest row as highestRow;
      // // the comparison itself is a little cutesy; since the row ID is what we have,
      // // and the row id takes the form ${videoID}_${collectionID}, where the collection id
      // // is an ordered series of indices describing where the collection is in the structure
      // // (e.g. '0-3-1' being the 2nd child of the 4th child of the 1st collection),
      // // we can take advantage of this by converting the string to a number and doing a simple
      // // numerical comparison: for instance, '0-3-1' becomes 0.031, and is smaller than '1-3-1' (0.131);
      // // the only wrinkle being that if we're in a flat playlist that only contains one table,
      // // there is no collection ID appended to the video ID, the row ID is just identical to the video ID;
      // // so we have to test for that before doing the comparison
      // if (/_/.test(this.state.selectedRows[tableID].highestRow)) {
      //   let thisRowCompare = Number(this.state.selectedRows[tableID].highestRow.replace(/^.*_/,'').replace(/\D+/g,'').replace(/^/,'.'));
      //   let highestRowCompare = Number(highestRow.replace(/^.*_/,'').replace(/\D+/g,'').replace(/^/,'.'));
      //   if (thisRowCompare < highestRowCompare) {
      //     highestRow = this.state.selectedRows[tableID].highestRow;
      //   }
      // } else {
      //   highestRow = this.state.selectedRows[tableID].highestRow;
      // }

      // if there is no underscore, then this should be the only table,
      // so this table's highest row is the overall highest row
      if (!/_/.test(this.state.selectedRows[tableID].highestRow)) {
        highestRow = this.state.selectedRows[tableID].highestRow;
      } else {
        // otherwise, store what was after the underscore (which will either be
        // a collection id like '0-3-1', or 'uncategorized') so that
        // we can compare it to the overall highest row so far to see which is higher on the page
        // (keeping in mind that lower numbers are higher on the page)

        let thisRowCompare = this.state.selectedRows[tableID].highestRow.replace(/^.*_/,'').replace('uncategorized',(Number.MAX_SAFE_INTEGER - 1) + '').split('-')
        let highestRowCompare = highestRow.replace(/^.*_/,'').replace('uncategorized',(Number.MAX_SAFE_INTEGER - 1) + '').split('-');

        // now compare each element, hierarchically
        for (let i=0; i<thisRowCompare.length; i++) {
          if (i >= highestRowCompare.length) break; // if b ran out, but we were equal up to this point, a should be later than b, so we leave highest row as highest row
          // if (thisRowCompare[i] > highestRowCompare[i]) return 1;
          if (Number(thisRowCompare[i]) < Number(highestRowCompare[i])) {
            highestRow = this.state.selectedRows[tableID].highestRow;
            break;
          }
          // if the value at this array index was equal for both rows, we loop to the next one,
          // and so on, until we find the earliest index where the values are not equal
        }
      }

    });

    if (selected.length === 0) {
      highestRow = null;
    }

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

  showDetails(id, rowID) {
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
        if (key === 'id' || key === 'metadata' || key === 'collections') return;
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
      console.log(JSON.stringify(batchObject));

      this.setState({detailRowID: rowID, detailVideo: batchObject, batchVids: batchVids});
      return;
    }

    let detailVideo = null;
    try {
      detailVideo = this.state.filteredVideos.filter(video => video.id === id)[0]
    } catch(error) {
      console.log("Error: could not find video " + id)
    }

    // note if the video is the first or last video in the playlist (as currently sorted)
    // so that in the video editor, we can gray out the 'next' or 'previous' button
    let boundaryFlag = '';
    if (/*this.state.playlistRowManifest.length > 0 && */this.state.playlistRowManifest[0].rowID === rowID) boundaryFlag = 'first';
    if (/*this.state.playlistRowManifest.length > 0 && */this.state.playlistRowManifest[this.state.playlistRowManifest.length-1].rowID === rowID) boundaryFlag = 'last';

    this.setState({detailRowID: rowID, detailVideo: detailVideo, detailRowBoundaryFlag: boundaryFlag});
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

    // first find index of the current detail vid in the playlistRowManifest
    let index;
    this.state.playlistRowManifest.map((row,i) => {
      if (row.rowID === this.state.detailRowID) index = i;
    });
    if (typeof index === "undefined") return console.error('Could not find current detail vid in manifest');

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
  // and its collections hierarchy is expanded (if applicable)
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
      } catch(error) {
        console.error("Error: no playlists found, displaying nothing")
        playlist = { "filter_function" : "false" } // just display nothing
      }
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
    let playlist = this.state.playlists.filter(playlist => playlist && playlist.id == id)[0];
    let view = playlist ? playlist.view : null; // set the view state variable to this playlist's view
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
    this.setState({playlistVideos : videos, filteredVideos : videos, view : view, currentPlaylistID : id, flatDefaultSort : flatDefaultSort, columns : columns});


    // reset the details pane
    // this line causes an error I don't understand yet
    // this.showDetails('hi','hihi');
  }

  // called when the search input is changed
  // change the filteredVideos state variable to those videos that match query
  search(e) {
    let query = e.target.value;
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
  // if it is provided, it could either be a video id or a row id;
  // if it's a row id, select that row and play the video;
  // if it's a video id, find the highest row featuring that video,
  // select that row, then play the video;
  async playVideo(id) {
    if (id) {
      let row, vidID;
      if (/_/.test(id)) {
        row = this.state.playlistRowManifest.filter(r => r.rowID === id)[0];
        if (row) vidID = row.vidID;
      } else {
        row = this.findVideoRows(id)[0];
        vidID = id;
      }
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

    // let paneJSX;
    // switch(name) {
    //   case "settingsPane":
    //     paneJSX = <MynSettings settings={this.state.settings} playlists={this.state.playlists} collections={this.state.collections} displayColumnName={this.displayColumnName} hideFunction={() => {this.hideOpenablePane(name)}}/>
    //     break;
    //   case "editorPane":
    //     paneJSX = <MynEditor video={this.state.detailVideo} collections={this.state.collections} settings={this.state.settings} hideFunction={() => {this.hideOpenablePane(name)}}/>
    //     break;
    // };
    // this.setState({openablePane:paneJSX});
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

      // if the collections were changed
      if (address.includes('collections')) {
        console.log('collections was edited');
        this.setState({collections : this.props.library.collections}, () => {
          // we don't need to update the playlist here, because
          // if the collections were edited, a video was edited too with
          // the corresponding change to the video object;
          // and that will cause the playlist to re-render

          // ^^ THE ABOVE IS NO LONGER TRUE; we've since removed the redundant
          // collections information from the video objects; it remains to be
          // seen whether we need to update the playlist explicitly here or not

          // update video in details pane (we don't know if this video was affected, but just in case)
          this.refreshDetails(timeout);
          // this.setState({detailVideo : this.state.videos.filter(video => video.id === this.state.detailVideo.id)[0]});
          // this.setState({detailVideo : null}); // for some reason this appears to work, and the above (commented) line does not. Not sure why.
        });
      }

      // if the whole media array was replaced at one time
      // (this happens when a watchfolder is removed)
      if (address === 'media') {
        console.log('library.media was replaced. Refreshing videos');

        this.setState({videos:library.media});
      }

      // if a movie was changed
      if (address.includes('media')) {
        console.log('a video was edited');
        // // change the videoEditFlag, which components can listen for to find out if a video was edited
        // // (if they don't care which one or what the change was)
        // this.setState({videoEditFlag:uuidv4()});


        // update the currently displayed playlist
        this.setPlaylist(this.state.currentPlaylistID);

        // check all the playlist lengths (pass true to skip the one we just set above)
        this.setPlaylistLengths(true);

        // update movie in details pane (we don't know if this is the movie that was edited, but just in case)
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
          />
        </ErrorBoundary>
        <ErrorBoundary>
          <MynLibrary
            videos={this.state.filteredVideos}
            collections={this.state.collections}
            settings={this.state.settings}
            playlistID={this.state.currentPlaylistID}
            view={this.state.view}
            flatDefaultSort={this.state.flatDefaultSort}
            columns={this.state.columns}
            displayColumnName={this.displayColumnName}
            calcAvgRatings={this.calcAvgRatings}
            showDetails={this.showDetails}
            playVideo={this.playVideo}
            handleSelectedRows={this.handleSelectedRows}
            handleHoveredRow={this.handleHoveredRow}
            selectedRows={this.state.selectedRows}
            reportSortedManifest={this.reportSortedManifest}
            recentlyWatched={this.state.recentlyWatched}
          />
        </ErrorBoundary>
        <ErrorBoundary>
          <MynDetails
            video={this.state.detailVideo}
            rowID={this.state.detailRowID}
            settings={this.state.settings}
            showEditor={() => {this.showOpenablePane("editorPane")}}
            scrollToVideo={this.scrollToVideo}
            isRowVisible={this.isRowVisible}
          />
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
          collections={this.state.collections}
          displayColumnName={this.displayColumnName}
          hideFunction={() => {this.hideOpenablePane('settingsPane')}}
        />
        <MynEditor
          show={this.state.show.editorPane}
          video={this.state.detailVideo}
          batch={this.state.batchVids}
          collections={this.state.collections}
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
                if (v.new) {
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
                  {playlist.id === 'new' && numVids > 0 ? <div id='nav-message'>({numVids})</div> : null}
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

// ###### Library Pane: parent of MynLibTable, decides whether to display one table (in a flat view), or a hierarchy of tables (in the hierarchical view) ###### //
class MynLibrary extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      videos: _.cloneDeep(props.videos),
      collections: _.cloneDeep(props.collections),
      hierarchy : null,
      vidsInHierarchy : [],
      sortReport : {},
      dragging : false,
      addToExistingColID : '',
      manifest: {},
      isExpanded: {}
    }

    this.deleteBtn = object => {
      if (object.id === 'uncategorized') { return null }
      else {
        return (
          <div className="delete-collection clickable" onClick={(e) => this.deleteCollection(e,object)}>{'\u2715'}</div>
        );
      }
    };

    this.addBtn = object => {
      if (object.id === 'uncategorized') { return null }
      else {
        return (
          <Droppable droppableId={object.id + '-'} direction="horizontal">
            {(provided) => (
              <div className="collection-btn-container add collection-btn clickable" ref={provided.innerRef} {...provided.droppableProps}>
                {'\uFF0B'}
              </div>
            )}
          </Droppable>
        );
      }
    };

    this.render = this.render.bind(this);
    this.createCollectionsMap = this.createCollectionsMap.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
    this.onDragStart = this.onDragStart.bind(this);
    this.reportSort = this.reportSort.bind(this);
    this.reportSortedManifest = this.reportSortedManifest.bind(this);

    // this.findCollections = this.findCollections.bind(this);



    ipcRenderer.on('MynLibrary-confirm-convertTerminalCol', (event, response, dragData, checked) => {
      // console.log('CONFIRMATION OF ADDING A CHILD COLLECTION TO A TERMINAL COLLECTION HAS FIRED')
      // console.log(event);
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        console.log('option to override dialog was checked!');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs['MynLibrary-confirm-convertTerminalCol'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // add the collection
        this.addCollection(dragData);
      } else {
        console.log('Creation of collection canceled by user');
      }
    });
  }

  componentDidUpdate(oldProps) {
    let videos = false;
    let collections = false;
    let playlist = false;

    if (!_.isEqual(oldProps.videos,this.props.videos)) {
      console.log('MynLibrary videos was changed!');
      videos = true;
    }
    if (!_.isEqual(oldProps.collections,this.props.collections)) {
      console.log('MynLibrary collections was changed!');
      collections = true;
    }
    if (!_.isEqual(oldProps.columns,this.props.columns)) {
      console.log('MynLibrary columns was changed!');
      videos = true;
    }
    if (oldProps.settings.preferences.include_user_rating_in_avg !== this.props.settings.preferences.include_user_rating_in_avg) {
      console.log('MynLibrary include_user_rating_in_avg was changed!');
      videos = true;
    }

    if (oldProps.playlistID !== this.props.playlistID) {
      console.log('MynLibrary playlist was changed!');
      playlist = true;
    }

    // if (videos) this.setState({videos:_.cloneDeep(this.props.videos)});
    // if (collections) this.setState({collections:_.cloneDeep(this.props.collections)});
    // if (videos || collections) this.createCollectionsMap();
    if (videos && !collections) {
      this.setState({videos:_.cloneDeep(this.props.videos)},()=>this.createCollectionsMap());
    } else if (collections && !videos) {
      this.setState({collections:_.cloneDeep(this.props.collections)},()=>this.createCollectionsMap());
    } else if (collections && videos) {
      this.setState({
        videos:_.cloneDeep(this.props.videos),
        collections:_.cloneDeep(this.props.collections)
      },()=>this.createCollectionsMap());
    }

    if (collections || playlist) this.state.manifest = {};
  }

  componentDidMount() {
    // console.log(this.props.videos);
    //
    // this.setState({videos:this.props.videos},() => {
    //   console.log(this.state.videos);
    // });
    //
    this.createCollectionsMap();
  }

  createCollectionsMap() {
    // console.log("Creating new collections map");
    this.state.hierarchy = this.state.collections.map(collection => this.findCollections(collection));

    // create dummy collection of leftover videos, if any
    let leftovers = this.state.videos.filter(v => !this.state.vidsInHierarchy.includes(v.id));
    let uncategorized = {
      id: 'uncategorized',
      name: '[Uncategorized]',
      videos: leftovers.map(v => {return {id:v.id}})
    }
    // and add it to the hierarchy
    this.state.hierarchy.push(this.findCollections(uncategorized));

    this.setState({hierarchy:this.state.hierarchy});
  }

  // recursive function that walks down the collections and returns each branch
  // as JSX if and only if it contains one of the videos in our playlist
  findCollections(object) {
    if (!object) return null;

    // if this object contains sub-collections
    if (object.collections) {
      let results = []
      // loop through the subcollections and call ourselves recursively on each one
      for (let i=0; i<object.collections.length; i++) {
        let jsx = this.findCollections(object.collections[i]);
        // if jsx is not null, that means the recursive call returned some JSX
        // containing collections with videos from our playlist
        if (jsx !== null) {
          results.push(jsx);
        }
      }
      // if there were any videos returned from the level below,
      // wrap them in a div and return them upward to the next level
      if (results.length > 0) {
        let editColNameValid;

        let colContainerID = `collection-${object.id}`;

        return (
          <div className="collection collapsed" key={object.name}>
            <h1
              className="collection-header"
              onClick={(e) => this.toggleExpansion(e,colContainerID)}
              onMouseOver={(e) => {this.expandOnDragOver(e,colContainerID); if (this.state.dragging) e.target.parentNode.classList.add('drag-over')}}
              onMouseOut={(e) => {e.target.parentNode.classList.remove('drag-over')}}
            >
              <MynClickToEditText
                object={object}
                property='name'
                update={(prop,value) => { if (editColNameValid) object.name = value }}
                save={() => {
                  if (editColNameValid) {
                    let cols = new Collections(this.state.collections);
                    cols.sortAll();
                    library.replace("collections", cols.getAll());
                  }
                }}
                options={null}
                validator={/^[^=;{}]+$/}
                validatorTip={'Not allowed: = ; { }'}
                allowedEmpty={true}
                reportValid={(prop,valid) => { editColNameValid = valid }}
                noClear={true}
                setFocus={true}
                doubleClick={true}
              />
            </h1>
            {this.deleteBtn(object)}
            {this.addBtn(object)}
            <div className="container hidden">{results}</div>
          </div>
        );
      } else {
        return null;
      }
    } else {
      // we're at a bottom-level collection
      let vidsWereFound = false;
      let collectionVids = []
      try {
        // if this collection has a video in our playlist
        for (let i=0; i<object.videos.length; i++) {
          if (this.state.videos.filter(v => (object.videos[i].id === v.id)).length > 0) {
            // add video to list of videos for this collection
            collectionVids.push(object.videos[i]);
            // also add its id to the vidsInHierarchy list
            // (later we'll compare this to this.state.videos to see what leftovers we have;
            // i.e. videos in the playlist that are not part of any collections)
            if (object.name !== '[Uncategorized]') { // we don't want to add the leftovers themselves to vidsInHierarchy, or else they won't be displayed
              this.state.vidsInHierarchy.push(object.videos[i].id);
            }
            // set flag
            vidsWereFound = true;
          }
        }
      } catch(e) {
        // console.log("No videos found in this collection: " + e.toString());
      }
      // if the flag is true, that means there were videos from our playlist
      // in this collection, so wrap them in JSX and return them upward
      if (vidsWereFound) {
        // find only the video objects (from the playlist) that match the videos found in this collection
        let colVidsInPlaylist = this.state.videos.filter(playlistVideo => (collectionVids.filter(collectionVideo => (collectionVideo.id === playlistVideo.id)).length > 0))
        // console.log('videos: ' + JSON.stringify(colVidsInPlaylist) + '\nVideos from collection: ' + JSON.stringify(collectionVids));
        try {
          // add the 'order' property to each video for this collection
          // (making a deep copy of each video object)
          colVidsInPlaylist = colVidsInPlaylist.map(v => {
            const vidCopy = _.cloneDeep(v); //JSON.parse(JSON.stringify(v));
            vidCopy.order = collectionVids.filter(collectionVideo => (collectionVideo.id === vidCopy.id))[0].order;
            // console.log(JSON.stringify(vidCopy));
            return vidCopy;
          });
          // console.log(JSON.stringify(colVidsInPlaylist))
        } catch(e) {
          console.log('Error assigning order to videos in collection ' + object.name + ': ' + e.toString());
        }

        let editColNameValid; // used in MynClickToEditText props below
        let name;
        if (object.id === 'uncategorized') {
          name = object.name;
        } else {
          name = (
           <MynClickToEditText
             object={object}
             property='name'
             update={(prop,value) => { if (editColNameValid) object.name = value }}
             save={() => {
               if (editColNameValid) {
                 let cols = new Collections(this.state.collections);
                 cols.sortAll();
                 library.replace("collections", cols.getAll());
               }
             }}
             options={null}
             validator={/^[^=;{}]+$/}
             validatorTip={'Not allowed: = ; { }'}
             allowedEmpty={true}
             reportValid={(prop,valid) => { editColNameValid = valid }}
             noClear={true}
             setFocus={true}
             doubleClick={true}
           />
         );
        }

        let tableID = 'table-' + object.id;
        let colContainerID = `collection-${object.id}`;
        // if (!this.state.manifest[tableID]) this.state.manifest[tableID] = [];

        // console.log('Creating table for collection: ' + JSON.stringify(object));
        // console.log(JSON.stringify(colVidsInPlaylist));
        // wrap the videos in the last collection div,
        // then hand them off to MynLibTable with an initial sort by 'order'
        return (
          <div className="collection collapsed" key={object.name}>
          <h1
            className="collection-header"
            onClick={(e) => this.toggleExpansion(e,colContainerID)}
            onMouseOver={(e) => {this.expandOnDragOver(e,colContainerID); if (this.state.dragging) e.target.classList.add('drag-over')}}
            onMouseOut={(e) => {e.target.classList.remove('drag-over')}}
          >
            {name}
            {object.id === 'uncategorized' ? (<MynTooltip shade='dark' tip={`Videos in this playlist that are not part of any collection appear here. Use the dropdown below to add them to an existing collection, or drag and drop them to any collections above, or you can add a video to collections from the video editor (by clicking on the Edit button in the details pane). To view and edit the entire collections structure, go to Settings ${'\u279E'} Collections.`} />) : null}
          </h1>
            {this.deleteBtn(object)}
            {this.addBtn(object)}
            <div className="container hidden">
              {object.id === 'uncategorized' ? (
                <Droppable droppableId={this.state.addToExistingColID ? this.state.addToExistingColID : 'dummy'}>
                  {(provided, snapshot) => (
                    <MynLibAddExistingCollection
                      collections={this.state.collections}
                      choose={(id) => { this.setState({addToExistingColID:id}) }}
                      provided={provided}
                      snapshot={snapshot}
                      selected={this.state.addToExistingColID !== ''}
                    />
                  )}
                </Droppable>
              ) : null }
              <Droppable droppableId={object.id}>
                {(provided) => (
                  <MynLibTable
                    tableID={tableID}
                    movies={colVidsInPlaylist}
                    collections={_.cloneDeep(this.state.collections)}
                    settings={this.props.settings}
                    playlistID={this.props.playlistID}
                    view={this.props.view}
                    isExpanded={this.state.isExpanded[colContainerID]}
                    initialSort={this.state.sortReport[object.id] ? this.state.sortReport[object.id].key : "order"}
                    initialSortAscending={this.state.sortReport[object.id] ? this.state.sortReport[object.id].ascending : true}
                    columns={this.props.columns}
                    displayColumnName={this.props.displayColumnName}
                    calcAvgRatings={this.props.calcAvgRatings}
                    collectionID={object.id}
                    showDetails={this.props.showDetails}
                    playVideo={this.props.playVideo}
                    handleSelectedRows={this.props.handleSelectedRows}
                    handleHoveredRow={this.props.handleHoveredRow}
                    selectedRows={this.props.selectedRows}
                    reportSort={this.reportSort}
                    reportSortedManifest={this.reportSortedManifest}
                    provided={provided}
                  />
                )}
              </Droppable>
            </div>
          </div>
        )
      } else {
        return null;
      }
    }
  }

  // expand or collapse a collection
  toggleExpansion(e,colContainerID) {
    //console.log('TOGGLING!');
    console.log(colContainerID);
    // 'e' may either be an event or an element
    let element;
    if (e.target) {
      element = findNearestOfClass(e.target,'collection-header');
    } else {
      element = e;
    }
    // let siblings = Array.from(element.parentNode.childNodes).filter(node => (node !== e.target));
    // siblings.map(node => (node.classList.toggle("hidden")));
    let childrenContainer = element.parentNode.getElementsByClassName("container")[0];
    childrenContainer.classList.toggle("hidden");
    element.parentNode.classList.toggle("expanded");
    element.parentNode.classList.toggle("collapsed");

    this.state.isExpanded[colContainerID] = !this.state.isExpanded[colContainerID];

    // this.setState({isExpanded:this.state.isExpanded});

    // So.........
    // this here (below) is not ideal, but let me explain:
    // this.createCollectionsMap() used to be called IN the render function,
    // so it was happening all the fucking time; this is better than that;
    // since I took that out, when a collection is expanded,
    // the table within it no longer knows that it has been expanded,
    // since the JSX for the table is in the state.hierarchy variable, which only gets
    // updated from this.createCollectionsMap(), so we're calling it here manually;
    // ultimately, the real solution is to rewrite MynLibrary and MynLibTable
    // altogether (because we should be toggling whole subsets of collections, not
    // just the tables at their bottom); a medium-term solution would be to move
    // the MynLibTable call outside the hierarchy, emptying and replacing it here
    // when its collection gets toggled; I'm just not interested in doing that now;
    this.createCollectionsMap();
  }

  // when dragging a video row over a collapsed collection header, expand that collection (after a delay)
  expandOnDragOver(e,colContainerID) {
    // console.log('OVER!');
    // console.log('this.state.dragging == ' + this.state.dragging);

    let btn = e.target;

    // only do anything if we're dragging something
    if (this.state.dragging) {
      // if the button we're dragging over is for a collapsed collection,
      // we wait a second and then expand it
      let collection = findNearestOfClass(e.target,'collection');
      console.log(collection.className);
      console.log(collection.key);
      if (collection.classList.contains('collapsed')) {
        console.log('COLLAPSED!');
        setTimeout(() => this.toggleExpansion(btn,colContainerID),1000);
      }
    }
  }

  // when an instance of MynTable is sorted, it reports back here
  // so that we can keep track. The only reason we need to do that
  // is because we only allow drag-n-drop to work if a table is sorted by order
  reportSort(id,key,ascending) {
    this.state.sortReport[id] = {key:key,ascending:ascending};
    // console.log(JSON.stringify(this.state.sortReport));
  }

  onDragStart() {
    this.setState({dragging:true});
    let cols = Array.from(document.getElementById('library-pane').getElementsByClassName('collection'));
    cols.map(el => {
      el.classList.add('dragging');
    });
  }

  onDragEnd(result) {
    this.setState({dragging:false});
    let cols = Array.from(document.getElementById('library-pane').getElementsByClassName('collection'));
    cols.map(el => {
      el.classList.remove('dragging');
    });

    console.log(JSON.stringify(result));
    const { destination, source, draggableId } = result;

    // if anything moved at all
    if (destination) {
      // check if we have dropped the video onto a '+' button,
      // and if we did, we want to create a new collection as a child of
      // the collection whose '+' button it was
      if (destination.droppableId[destination.droppableId.length-1] === '-') {
        this.addCollectionConfirm(result);
        return;
      }

      // first, if the destination table isn't sorted by order,
      // do nothing, and inform the user
      try {
        // console.log('Table ' + destination.droppableId + ' sort report----------');
        // console.log('key: ' + this.state.sortReport[destination.droppableId].key);
        // console.log('asc: ' + this.state.sortReport[destination.droppableId].ascending);
        if (this.state.sortReport[destination.droppableId].key !== 'order') {
          // ultimately of course we'll want something less invasive than an alert here
          alert('Sort by Order to drag n\' drop');
          return;
        }
      } catch(err) {
        console.error('Error getting sort report for table ' + destination.droppableId);
      }


      let rows = [];

      // if multiple videos were selected, and the dragged video was one of them,
      // we need to move them all; if the dragged video was not one of them,
      // we just need to move that one, but then also deselect the others
      // to make that clearer to the user
      if (this.props.selectedRows) {
        let selectedFlag = false;
        Object.keys(this.props.selectedRows).map(key => {
          if (this.props.selectedRows[key].rows) {
            this.props.selectedRows[key].rows.map(vidID => {
              let row = `${vidID}_${key.replace(/^table-/,'')}`;
              console.log(`Row: ${row}, draggableId: ${draggableId}`)
              rows.push(row);
              if (row === draggableId) selectedFlag = true;
            });
          }
        });

        // if the dragged row was NOT among the selected,
        // empty the rows array and just put the one video into it
        if (!selectedFlag) {
          rows = [];
          rows.push(draggableId);
        }
        // either way, we now have an array of rows to move
      }
      console.log('ROWS ********* ')
      console.log(rows);

      // make a deep copy of the whole collections object for modification, which we'll save when we're done
      let colsCopy = new Collections(_.cloneDeep(this.state.collections));

      // loop through all selected rows and move them
      rows.map((row,addedIndex) => {
        // get video id
        let videoID = row.split('_')[0];
        let srcID = row.split('_')[1];

        let newOrder, newIndex;

        // get source collection and destination collection
        let srcCol, destCol;
        let oldOrder = 0;
        if (destination.droppableId !== 'uncategorized') {
          destCol = colsCopy.get(destination.droppableId);
        }
        // if (source.droppableId !== 'uncategorized') {
        if (srcID && srcID !== 'uncategorized') {
          srcCol = colsCopy.get(srcID);
          oldOrder = colsCopy.get(srcID).videos.filter(v => v && v.id === videoID)[0].order;
        }
        // console.log('old order: ' + oldOrder);

        // only do anything if
        if (
          // the video was moved to a different collection that doesn't already contain it (or destCol doesn't exist, i.e. the video was moved to 'uncategorized')
          (destination.droppableId !== srcID && (!destCol || !colsCopy.containsVideo(destCol,videoID)))
          ||
          // or the video was moved to a different position within the same collection
          (destination.index !== source.index && destination.droppableId === srcID)
        ) {

          // remove video from original position
          if (srcCol) {
            colsCopy.removeVideo(srcCol,videoID);
          }

          // add video to new position
          if (destCol) {

            // first we must find the proper index where the video was dropped
            newIndex = destination.index + addedIndex;
            // if (destination.droppableId === source.droppableId && source.index < destination.index) {
            //   // for the special case that we're dropping the video later in the same collection, the index must be adjusted
            //   newIndex = destination.index + 1;
            // }
            // apparently not anymore???

            // add the video (the addVideo method will figure out the correct order property,
            // so we just pass it null and let it figure it out)
            colsCopy.addVideo(destCol, videoID, null, newIndex, oldOrder);
          }
        }
      });

      // prior to saving, we'll update the state variables;
      // saving will cause a re-render, but it's slow, so we want
      // to force one before then
      // this.state.videos.splice(vidIndex,1,video);
      this.setState({videos:this.state.videos,collections:colsCopy.getAll()});

      // save the updated video and collections object
      // library.replace("media." + vidIndex, video);
      library.replace("collections", colsCopy.getAll());
    }
  }

  // when a video is dragged to the plus button on the right side of a collection,
  // this function is called; it creates a new child collection and adds the dragged video to it
  addCollectionConfirm(result) {
    const { destination, source, draggableId } = result;
    // console.log('ADDING COLLECTION AS CHILD OF ' + destination.droppableId);
    // console.log('AND ADDING VIDEO ' + draggableId + ' TO IT.');

    // get parent collection
    let cols = new Collections(this.state.collections);
    const parent = cols.get(destination.droppableId.slice(0,-1));
    console.log('destination.droppableId == ' + destination.droppableId);
    console.log('Adding child collection to ' + parent.name);

    // if the user is trying to add a child collection to a terminal collection
    // i.e. one that contains videos,
    // the only way that is allowed is to make the collection non-terminal,
    // which means removing all the videos from it.
    // so we have to give the user a confirmation dialog before doing that.
    if (parent.videos) {
      // if the user hasn't previously selected the preference to override this confirmation dialog
      if (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynLibrary-confirm-convertTerminalCol']) {
        ipcRenderer.send(
          'generic-confirm',
          'MynLibrary-confirm-convertTerminalCol',
          {
            message: `Are you sure you want to add a child collection to ${parent.name}? Doing this will remove all videos from this collection, including any videos in it that don't appear in this playlist.`,
            checkboxLabel: `Don't show this dialog again`
          },
          result
        );
      } else {
        // the user had checked the box to override the confirmation dialog
        this.addCollection(result);
      }
    } else {
      // if the collection is not terminal, we don't need a confirmation dialog, just add a child collection to it
      this.addCollection(result);
    }
  }

  addCollection(result) {
    const { destination, source, draggableId } = result;
    const videoID = draggableId.split('_')[0];
    const cols = new Collections(this.state.collections);
    const parent = cols.get(destination.droppableId.slice(0,-1));

    // if the parent is a terminal collection,
    // convert it to a non-terminal collection;
    // (at this point we've already gotten confirmation from the user)
    if (parent.videos) {
      delete parent.videos;
    }

    // create new collection and add video to it
    const newCol = cols.addChild(parent,'');
    cols.addVideo(newCol,videoID);

    // delete video from old collection
    if (source.droppableId !== 'uncategorized') {
      const srcCol = cols.get(source.droppableId);
      cols.removeVideo(srcCol,videoID);
    }

    // save changes
    library.replace("collections", cols.getAll());
  }

  deleteCollection(e,object) {
    console.log("DELETING COLLECTION");
    console.log(JSON.stringify(object));

    ipcRenderer.once('delete-collection-confirm', (event, response, collectionID) => {
      console.log(response);
      console.log('collectionID == ' + collectionID);

      const collections = new Collections(this.state.collections);
      const collection = collections.get(collectionID);

      if (response === 0) { // remove videos
        console.log('Removing videos')
        this.state.videos.map(v => {
          collections.removeVideo(collection,v.id);
        });
        console.log(JSON.stringify(collection));
        library.replace("collections", collections.getAll());

      } else if (response === 1) { // delete collection
        console.log('Deleting collection');
        collections.deleteCollection(collectionID);
        library.replace("collections", collections.getAll());

      } else { // cancel, do nothing
        console.log('Deletion canceled by user')
      }
    });

    ipcRenderer.send('delete-collection-confirm', object);
  }

  reportSortedManifest(tableID, rows) {
    // console.log(rows);

    // if (rows.length > 0) this.state.sortedManifest.push(rows);
    if (rows.length === 0) {
      delete this.state.manifest[tableID];
    } else {
      this.state.manifest[tableID] = rows;
    }

    let sortedManifest = [];
    Object.keys(this.state.manifest).map(key => {
      sortedManifest.push(this.state.manifest[key])
    });

    sortedManifest.sort((a,b) => {
      // a_col and b_col should be the collection id of that table,
      // or if in a flat playlist, they will be undefined
      // (in which case there should only be one table anyway)
      try {
        let a_col = a[0].rowID.split('_')[1];
        let b_col = b[0].rowID.split('_')[1];
      } catch(err) {
        console.log(err);
        return 0;
      }

      // if either one is undefined, we shouldn't even be here, but return 0 anyway just in case;
      if (typeof a_col === "undefined" || typeof b_col === "undefined") return 0;

      // ensure 'uncategorized' ends up at the end;
      a_col = a_col.replace('uncategorized',Number.MAX_SAFE_INTEGER);
      b_col = b_col.replace('uncategorized',Number.MAX_SAFE_INTEGER);

      // split the collection id into an array
      a_col = a_col.split('-');
      b_col = b_col.split('-');

      // now sort by each element, hierarchically
      for (let i=0; i<a_col.length; i++) {
        if (i >= b_col.length) return 1; // if b ran out, but we were equal up to this point, a should be later than b
        if (a_col[i] > b_col[i]) return 1;
        if (a_col[i] < b_col[i]) return -1;
      }
      return 0; // if we made it all the way through the loop, that means the collection id's were identical
    });

    // now that it's sorted, create a single array of every row
    // in the playlist to be passed to up to Mynda
    let sortedManifestFlat = [];
    sortedManifest.map(table => {
      sortedManifestFlat = [...sortedManifestFlat, ...table];
    })

    // console.log('==== sortedManifestFlat ====');
    // console.log(sortedManifestFlat);
    this.props.reportSortedManifest(sortedManifestFlat);
  }

  render() {
    // console.log('----MynLibrary RENDER----');
    let tables = null;
    this.state.manifest = {};

    // if the playlist view is hierarchical, create multiple tables
    // in a hierarchy based on the collections that the videos in this
    // playlist are members of, and display that hierarchy
    if (this.props.view === "hierarchical") {
      // this.createCollectionsMap();

      tables = (
        <DragDropContext onDragEnd={this.onDragEnd} onDragStart={this.onDragStart}>
          <div id="collections-container">
            {this.state.hierarchy}
          </div>
        </DragDropContext>
      )

    // if the playlist view is flat, we only need to display one table
    } else if (this.props.view === "flat") {

      let tableID = 'table';
      // this.state.manifest[tableID] = [];

      tables = (
        <MynLibTable
          tableID={tableID}
          movies={this.state.videos}
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
        />
      )

    } else {
      console.log('Playlist has bad "view" parameter ("' + this.props.view + '"). Should be "flat" or "hierarchical"');
      return null
    }

    let playlist;
    try {
      playlist = library.playlists.filter(p => p.id === this.props.playlistID)[0];
    } catch(err) {}
    let playlistBar = (
      <MynPlaylistBar
        playlist={playlist}
        recentlyWatched={this.props.recentlyWatched}
        collections={this.state.collections}
        playVideo={this.props.playVideo}
      />
    );


    return (
      <div id="library-pane" className="pane">
        {playlistBar}
        {tables}
      </div>
    );
  }
}

class MynPlaylistBar extends React.Component {
  constructor(props) {
    super(props)

  }

  autotag(e) {
    ipcRenderer.send('autotag');
  }

  changeView(view) {
    library.replace(`playlists.id=${this.props.playlist.id}`,{...this.props.playlist,view:view});
  }

  render() {
    if (typeof this.props.playlist === "undefined") return null;

    return (
      <div className="playlist-bar">

        <div className="pb-element recent">
          <div className="pb-text">Recently Viewed:</div>
          <MynRecentlyWatched list={this.props.recentlyWatched} collections={this.props.collections} selected={0} playVideo={this.props.playVideo} />
        </div>

        <div className="pb-element view">
          <div className="pb-text">View:</div>
          <div className="select-container select-alwaysicon">
            <select value={this.props.playlist.view} onChange={(e) => this.changeView(e.target.value)}>
              <option value='flat'>Flat</option>
              <option value='hierarchical'>Hierarchical</option>
            </select>
          </div>
        </div>

        <button className="pb-element autotag" onClick={this.autotag.bind(this)}>Auto-tag</button>
      </div>
    );
  }
}

// ###### Table: contains list of movies in the selected playlist ###### //
class MynLibTable extends React.Component {
  constructor(props) {
    super(props)

    this._isMounted = false;

    // create an id for this table;
    // if it appears within a hierarchical playlist,
    // there could be multiple tables (one for each collection that appears in the playlist),
    // so in a hierarchical playlist, we append the collection id
    if (this.props.tableID) {
      this.tableID = this.props.tableID;
    } else {
      this.tableID = 'table';
      if (props.view === 'hierarchical' && props.collectionID) {
        this.tableID = 'table-' + props.collectionID;
      }
    }

    this.clickTimer = null;

    this.state = {
      tHeadContent: null,
      tBodyContent: null,
      sortKey: null,
      sortAscending: true,
      sortedRows: [],
      displayOrderColumn: "table-cell",
      batchSelected: [],
      rowID: (vidID) => vidID + (this.props.collectionID ? `_${this.props.collectionID}` : ''),
      idFromRowID: (rowID) => (this.props.collectionID ? rowID.replace(new RegExp('_' + this.props.collectionID + '$'),'') : rowID),
      shiftDown: false,
      ctrlDown: false,
      include_user_rating_in_avg: props.settings.preferences.include_user_rating_in_avg
    }

    // this.keyDown = this.keyDown.bind(this);
    // this.keyUp = this.keyUp.bind(this);
    this.requestSort = this.requestSort.bind(this);
    this.reset = this.reset.bind(this);
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

  rowHovered(id, rowID, e) {
    // show details in details pane on hovering a row
    // except if a row has been locked (because then we want that video's details
    // to persist in the details pane until it's unlocked), or if multiple
    // videos have been selected (in which case we will show a special batch-edit
    // screen in the details pane)
    // if (!this.state.batchSelected || this.state.batchSelected.length === 0) {
      this.props.handleHoveredRow(id, rowID, e);
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
  // (which would have been selected from other collections in the same playlist,
  // i.e. in other instances of MynLibTable)
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
    //console.log(`SORTING TABLE ${this.tableID} by ${key}`);

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
     order: (a, b) => [a.order, b.order],
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
     duration: (a, b) => [a.metadata ? parseInt(a.metadata.duration)-1 : null, b.metadata ? parseInt(b.metadata.duration)-1 : null] // - 1 because we use 0 when we don't have a duration, but the sort function doesn't treat 0 as empty (it does treat -1 as empty);
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
          displayOrderColumn={this.state.displayOrderColumn}
          vidOrderDisplay={this.state.vidOrderDisplay}
          settings={this.props.settings}
          collections={this.props.collections}
          collectionID={this.props.collectionID}
          calcAvgRatings={this.props.calcAvgRatings}
          columns={this.props.columns}
          rowHovered={(...args) => this.rowHovered(...args)}
          rowOut={(...args) => this.rowOut(...args)}
          rowClick={(...args) => this.rowClick(...args)}
        />
      );

      if (this.props.provided) {
        // row.props.ref = this.props.provided.innerRef;
        // row.props = {...row.props, ...this.props.provided.draggableProps}
        row.jsx = (
          <Draggable key={rowID} draggableId={rowID} index={index}>
            {(provided, snapshot) => {
              // adjust style of row while it's being dragged
              let draggableProps = _.cloneDeep(provided.draggableProps);
              draggableProps.style.opacity = snapshot.isDragging ? 0.5 : 1;

              return React.cloneElement(rowJSX,
                {
                  innerInnerRef: provided.innerRef,
                  innerDragP: draggableProps,
                  innerDragHP: provided.dragHandleProps
                });
            }}
          </Draggable>
        );
      } else {
        row.jsx = rowJSX;
      }

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

    // report the sort state to MynLibrary
    if (this.props.reportSort) {
      this.props.reportSort(this.props.collectionID,key,ascending);
    }

  }

  showHide(initialSort,resetOrder) {
    // if in a hierarchical playlist and this table is collapsed, render nothing
    if (this.props.view === 'hierarchical' && !this.props.isExpanded) {
      this.setState({tBodyContent:null, tHeadContent:null});

    // otherwise, whether in an expanded table in a hierarchical playlist,
    // or in a table in a flat playlist, render the table
    } else {
      this.reset(initialSort,resetOrder);

      // report the sorted rows to MynLibrary
      this.props.reportSortedManifest(this.tableID,this.state.sortedRows);

      // if this table is part of a hierarchical playlist,
      // then the rows are meant to be drag-n-droppable (using react-beautiful-dnd)
      // in which case MynLibrary will have given us the 'provided' prop,
      // so if it has, we add the appropriate bits to make the table body droppable
      // console.log(`The sorted rows are ${this.state.sortedRows}.`);

      let tBodyContent = this.state.sortedRows.map(row => row.jsx);

      let tHeadContent = (
        <tr id="main-table-header-row">
          <th onClick={() => this.requestSort('order')} style={{display:this.state.displayOrderColumn}}>#</th>
          {this.props.columns.map(col => (
            <th key={col} onClick={() => this.requestSort(col)}>{this.props.displayColumnName(col)}</th>
          ))}
        </tr>
      );

      this.setState({tBodyContent:tBodyContent, tHeadContent:tHeadContent});
    }
  }

  // re-render the table by requesting a new sort (if initialSort === true, sort by initial values,
  // rather than the current values)
  reset(initialSort,resetOrder) {
    // do not render the table if we're in a collapsed collection in a hierarchical playlist
    if (this.props.view === 'hierarchical' && !this.props.isExpanded) {
      console.log("this.props.view === 'hierarchical' && !this.props.isExpanded");
      return;
    }

    console.log('RESETTING');
    if (initialSort || resetOrder) {
      console.log("RESETTING ORDER");
      this.props.movies.map(movie => {
        // we display the order property through a state variable
        // because when the user wants to edit the order, we use the state variable
        // to display an editor; we must initially populate that variable with the order itself
        // inside a div with a click event that calls up the editor
        // this.state.vidOrderDisplay[movie.id] = this.state.vidOrderDisplayTemplate(movie,movie.order);
      });
    }

    // decide whether to show the 'order' column
    // if (this.props.movies.filter(movie => (movie.order === undefined || movie.order === null)).length == this.props.movies.length) {
      // if none of the movies handed to us have an "order" property
      //    (not within the collections property, but a top-level "order" property—
      //    this property does not exist in the library JSON, but is assigned by MynLibrary
      //    in the case of showing a hierarchical view)
      // then hide the 'order' column with CSS
    if (this.props.view === 'flat') {
      this.state.displayOrderColumn = "none";
    } else {
      this.state.displayOrderColumn = "table-cell";
    }

    // if we're told to set to initial values (or if there is no current value)
    if (initialSort || this.state.sortKey === null) {
      console.log("initial: " + initialSort);
      console.log("this.state.sortKey: " + this.state.sortKey);
      console.log("this.props.initialSort: " + this.props.initialSort);
      console.log("this.props.initialSortAscending: " + this.props.initialSortAscending);

      // sort by initial (default) values
      this.state.sortKey = null;
      try {
        this.requestSort(this.props.initialSort, this.props.initialSortAscending);
        console.log('sorting by initialSort')
      } catch(e) {
        console.log("No initial sort parameter")
        console.log(`flatDefaultSort: ${this.props.flatDefaultSort}
                   \ncolumns: ${this.props.columns}`);
        // no initial sort parameter, so if the playlist has a default sort column, use that
        if (this.props.flatDefaultSort && this.props.columns.includes(this.props.flatDefaultSort)) {
          console.log("Sorting by flatDefaultSort: " + this.props.flatDefaultSort);
          this.requestSort(this.props.flatDefaultSort);
        } else {
          console.log("Also, no flatDefaultSort, so sorting by [Title]");
          // if not, sort by title
          this.requestSort('title');
        }
      }
    } else {
      // if initial is false, sort by the current value
      console.log("Sort key is not null?: " + this.state.sortKey);
      this.requestSort(this.state.sortKey, this.state.sortAscending);
    }

  }

  removeArticle(string) {
    if (typeof string !== 'string') return string;
    return string.replace(/^(?:a\s|the\s)/i,"")
  }


  componentDidUpdate(oldProps) {
    // let propsDiff = getObjectDiff(oldProps,this.props);
    // if (propsDiff.length === 0) return;
    // console.log(Date.now());
    if (_.isEqual(oldProps,this.props)) {
      // console.log(Date.now());
      // console.log('----------------')
      return;
    }

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

    // if the playlist was changed, reset the playlist,
    // sorting by the table by initial values (props.initialSort if it exists, or flatDefaultSort)
    if (oldProps.playlistID !== this.props.playlistID) {
      console.log("MynLibTable ============= PLAYLIST WAS CHANGED to " + this.props.playlistID);
      // setTimeout(() => this.reset(true,true), 1000);
      this.showHide(true,true);
    } else if (this.props.view === 'flat' || this.props.isExpanded) {
      // console.log('playlist is the same, checking if any videos changed...');
      // if the playlist was NOT changed, but
      // if any videos in the playlist were changed...
      // (or if the setting to include user ratings in avg was changed)

      // console.log("USER_RATING_IN_AVG STATE == " + this.state.include_user_rating_in_avg);
      // console.log("USER_RATING_IN_AVG PROPS == " + this.props.settings.preferences.include_user_rating_in_avg);

      // we have to sort the movies array before comparing it,
      // otherwise the conditional fires when the elements change order,
      // whereas we want them to change only when a movie is changed, added, or removed
      let tempOld = _.cloneDeep(oldProps.movies).sort((a,b) => a.id > b.id ? 1 : (a.id < b.id ? -1 : 0));
      let tempNew = _.cloneDeep(this.props.movies).sort((a,b) => a.id > b.id ? 1 : (a.id < b.id ? -1 : 0));
      // console.log(tempOld);
      // console.log(tempNew);
      if (!_.isEqual(tempOld,tempNew) || this.state.include_user_rating_in_avg !== this.props.settings.preferences.include_user_rating_in_avg) {
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
        this.showHide(false,true);
      }
    }

    if (oldProps.isExpanded !== this.props.isExpanded) {
      console.log(`isExpanded change from ${oldProps.isExpanded} to ${this.props.isExpanded}`);
      this.showHide(false,true);
    }

  }

  componentDidMount(props) {
    this._isMounted = true;
    // console.log("--MOUNTED--");
    // this.props.movies.map(movie => console.log(JSON.stringify(movie)));
    // render the table
    this.showHide(true,true);

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

    // return this.state.content;

    return (
      <div className="movie-table-container">
        <table className="movie-table" id={this.tableID}>
          <thead>
            {this.state.tHeadContent}
          </thead>
          {(() => {
            if (this.props.provided) {
              return (
                <tbody ref={this.props.provided.innerRef} {...this.props.provided.droppableProps}>
                  {this.state.tBodyContent}
                  {this.props.provided.placeholder}
                </tbody>
              );
            } else {
              return (
                <tbody>
                  {this.state.tBodyContent}
                </tbody>
              );
            }
          })()}
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

    // set the JSX for the 'order' column (which is only displayed in a hierarchical playlist) separately,
    // because it's rather wordy. It's editable by double clicking, so we need to use MynClickToEditText
    let order;
    let orderJSX = (
      <td key="order" className="order" style={{display:this.props.displayOrderColumn}}>
        <MynClickToEditText
          object={video}
          property='order'
          update={(prop,value) => { console.log(value); /*if (valid)*/ order = value}}
          options={null}
          storeTransform={v => {v = v.replace(/\s+/g,''); if (v === '') {return v} else {return Math.round(Number(v) * 10) / 10}}}
          validator={{test:v => !isNaN(Number(v))}}
          validatorTip={'#'}
          allowedEmpty={true}
          reportValid={(prop,value) => {/*valid = value;*/}}
          noClear={true}
          setFocus={true}
          doubleClick={true}
          save={() => {
            console.log('Saving order as ' + order);

            // update the order and save to library
            if (order && this.props.collections) {
              let cols = new Collections(this.props.collections);
              let col = cols.get(this.props.collectionID);
              cols.removeVideo(col,video.id);
              cols.addVideo(col,video.id,order);
              library.replace("collections", cols.getAll());
            } else {
              // if 'order' is falsy (e.g. null will be passed if the user hits escape)
              // then we just keep the old order
              order = video.order;
            }
          }}
      />
      </td>
    );

    let cellJSX = {
      // order: (<td key="order" className="order" style={{display:this.props.displayOrderColumn}}>{this.props.vidOrderDisplay[video.id]}</td>),
      order: orderJSX,
      title: (<td key="title" className="title"><MynOverflowTextMarquee class="table-title-text" text={video.title} ellipsis='fade' /></td>),
      year: (<td key="year" className="year centered mono">{video.year}</td>),
      director: (<td key="director" className="director">{video.director}</td>),
      genre: (<td key="genre" className="genre">{video.genre}</td>),
      seen: (<td key="seen" className="seen centered"><MynEditSeenWidget movie={video} update={(...args) => this.saveEdited(video, ...args)} /></td>),
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
      duration: (<td key="duration" className="duration">{video.metadata.duration !== 0 && video.metadata.duration !== null ? `${Math.round(Number(video.metadata.duration)/60)} min` : ''}</td>)
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
        ref={this.props.innerInnerRef}
        {...this.props.innerDragP}
        {...this.props.innerDragHP}
        vid_id={video.id}
        onMouseOver={(e) => this.props.rowHovered(video.id, rowID, e)}
        onMouseOut={(e) => this.props.rowOut(video.id, rowID, e)}
        onClick={(e) => this.props.rowClick(video.id, rowID, index, e)}
      >
        {cellJSX.order}
        {cells}
      </tr>
    );
  }
}

// A dropdown list of terminal collections,
// meant to be displayed at the top of the 'Uncategorized' collection
// and used as a drop-zone for a video row, to add that video to the chosen collection;
// this allows the user to add a video in the playlist to an existing collection
// that doesn't already appear in the playlist
class MynLibAddExistingCollection extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      options: this.getOptions()
    }

    this.render = this.render.bind(this);
    this.handleChange = this.handleChange.bind(this);
  }

  getOptions() {
    let options = {};
    let cols = new Collections(this.props.collections);
    // get all terminal collections as a flat list (pass 'true' to include barren collections that aren't technically designated terminal)
    cols.getAllTerminal(true).map((c) => {
      let idArr = c.id.split('-');
      let ancestry = idArr.map((el,i) => {
        let id = idArr.slice(0,i+1).join('-');
        let ancestor = cols.get(id);
        return ancestor ? ancestor.name : null;
      });
      let displayStr = ancestry.join(' \u27A5 ');

      options[displayStr] = c.id;
    });

    console.log(JSON.stringify(options))

    return options;
  }

  handleChange(e) {
    console.log("CHANGE")
    let container = document.getElementById('library-addToExistingCollection');
     if (container) {
       console.log("adding class")
       container.classList.add('changing');
       setTimeout(() => {container.classList.remove('changing')},1000);

       container.classList.add('selected');
     }
     this.props.choose(e.target.value);
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.collections,this.props.collections)) {
      this.setState({options:this.getOptions()});
    }
  }

  render() {
    return (
      <div id="library-addToExistingCollection" ref={this.props.provided.innerRef} {...this.props.provided.droppableProps}>
        {/*<label className="edit-field-name" htmlFor="collections">Drop to Add: </label>*/}
        <div className="select-container select-alwaysicon">
          <select name="collections" defaultValue="" onChange={this.handleChange}>
            <option value="" disabled hidden>[Choose a collection and drop a video here to add to it]</option>
            {Object.keys(this.state.options).map((opt,i) => (
              <option key={i} value={this.state.options[opt]}>{opt}</option>
            ))}
          </select>
        </div>
        <div style={{height:'0'}}>
          {this.props.provided.placeholder}
        </div>
      </div>
    );
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
    let details;
    let editBtn = (<div id="edit-button" onClick={() => this.props.showEditor()}>Edit</div>);
    let scrollBtn = null;

    try {
      const video = this.props.video;
      let imageURL = video.artwork ? URL.pathToFileURL(video.artwork).pathname : '';
      details = (
        <ul>
          <li className="detail" id="detail-artwork"><div className="optional-artwork-duplicate" style={{backgroundImage:`url('${imageURL}')`}}></div><img id="detail-artwork-img" src={video.artwork || '../images/qmark-details.png'} /></li>
          <li className="detail" id="detail-title"><MynOverflowTextMarquee class="detail-title-text" text={video.title} /></li>
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

// ###### Player Pane: plays the video ###### //
class MynPlayer extends MynOpenablePane {
  constructor(props) {
    super(props)

    this.state = {
      video: props.video,
      subtitleTracks: null,
      paneID: 'player-pane',
      // startedMuxing: false,
      errorMessage: null,
      showLoadingIndicator: false,
      tries: 0
    }

    this.loadingIndicator = null;


    // callbacks to hand off to Stream.js, for different events ffmpeg sends back
    this.callbacks = {
      codecData : (outputPath) => {
        // // called periodically throughout the process;
        // // we only want to know that progress has started, so we use a flag
        // if (this.state.startedMuxing == false) {
        //   this.state.startedMuxing = true;
          // once the process has started, we'll check for the ffmpeg output
          // and when it exists, add it to the video element
          this.checkForStreamPlaylist(outputPath);
        // }
      },
      error : (err) => {
        // turn off loading icon
        this.setState({showLoadingIndicator:false});

        // unset video player height
        try {
          this.player.current.setAttribute('height','');
        } catch(e) {
          console.log('unable to unset video height after ffmpeg error: ' + e);
        }

        // display error message to user
        this.setState({errorMessage:(
          <div className='error-message'>
            <div className='header'>Error Loading Video</div>
            {err.message}
          </div>
        )});
      }
    }

    this.render = this.render.bind(this);
    this.onblur = this.onblur.bind(this);
    this.onplay = this.onplay.bind(this);
    this.onpause = this.onpause.bind(this);
    this.onseeked = this.onseeked.bind(this);
    this.ontimeupdate = this.ontimeupdate.bind(this);
    this.onended = this.onended.bind(this);
    this.player = React.createRef();
  }

  // ========================================== //
  // ========== VIDEO EVENT HANDLERS ========== //
  // ========================================== //

  onplay(e) {
    console.log("PLAYING!!!!!")

    // log that we played the video, but only after 10 seconds
    this.logPlayTimeout = setTimeout(() => {console.log('Logging that we played ' + this.state.video.title); this.props.logPlayed(this.state.video.id)},10000);
  }

  onpause(e) {
    console.log("PAUSING!!!!!");
    this.updatePosition(e.target.currentTime);
    clearTimeout(this.logPlayTimeout);
  }

  onseeked(e) {
    console.log(`SOUGHT to ${e.target.currentTime} !!!!!`);
    this.updatePosition(e.target.currentTime);

  }

  ontimeupdate(e) {
    if (!this.timeupdateTimeout) {
      let target = e.target;
      this.timeupdateTimeout = setTimeout(()=> {
        this.updatePosition(target.currentTime);
      },5000);
    }
  }

  onended(e) {
    // in case the video was shorter than the 10 seconds or whatever,
    // or was started less than 10 seconds from the end,
    // we want to log that we played the video here.
    clearTimeout(this.logPlayTimeout);
    this.props.logPlayed(this.state.video.id);
  }

  updatePosition(time) {
    clearTimeout(this.timeupdateTimeout);
    this.timeupdateTimeout = null;
    this.state.video.position = Math.round(time * 10) / 10;
    console.log('UPDATING POSITION TO ' + this.state.video.position);
    library.replace(`media.id=${this.state.video.id}`,this.state.video);
  }

  // called when exiting MynPlayer
  onExit() {
    console.log('EXIT CALLBACK');

    clearTimeout(this.logPlayTimeout);

    let position;
    try {
      position = this.player.current.currentTime;
    } catch(err) {
      position = this.state.video.position;
    }
    let duration = this.state.video.metadata.duration; // we don't try to get this from the video element, in case of an ffmpeg stream that isn't finished, the duration won't be correct
    console.log(`position: ${position}, duration: ${duration}`);
    // if (!duration) return;

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

  // key commands for the video player;
  // spacebar already works natively,
  // as does escape to exit fullscreen;
  keyCommand(e) {
    let isFullscreen = document.fullscreenElement !== null;

    // ESC
    if (e.keyCode === 27 && !isFullscreen) {
      // while not in fullscreen, use escape to close the video;
      // don't do anything while in fullscreen, because escape already exits fullscreen natively
      this.props.hideFunction();
    }
  }

  seekVideoTo(time) {
    let vid = this.player.current;
    if (vid) {
      time = Math.max(Math.min(time,vid.duration),0);
      vid.currentTime = time;
    } else {
      console.error('Tried to seek, but could not find video');
    }
  }

  // keep focus on the video element
  onblur(e) {
    e.target.focus();
  }


  // ========================================== //
  // =========== CREATING THE VIDEO =========== //
  // ========================================== //

  showLoadingIndicator() {
    console.log('Setting timeout for loading indicator...');
    this.loadingIndicatorTimeout = setTimeout(() => {
      console.log('Actually showing loading indicator!');
      this.state.loadingIndicator = (
        <img className='loading' src='../images/loading-icon.gif' />
      );
    },500);
  }

  hideLoadingIndicator() {
    console.log('Canceling timeout for/hiding loading indicator');
    clearTimeout(this.loadingIndicatorTimeout);
    this.state.loadingIndicator = null;
  }

  checkForStreamPlaylist(playlist) {
    this.state.tries += 1;
    console.log('Checking for .m3u8 file: ' + playlist);
    fs.stat(playlist, (err, stat) => {
      if(err == null) {
        console.log('File exists');
        this.createFFmpegVideo(playlist);
      } else if(err.code === 'ENOENT') {
        // file does not exist, wait a second and check again
        if (this.state.tries < 15) {
          this.createVidTimeout = setTimeout(() => {
            this.checkForStreamPlaylist(playlist);
          },1000);
        } else {
          // display error message to user
          this.setState({errorMessage:(
            <div className='error-message'>
              <div className='header'>Error Loading Video</div>
              Could not locate stream output
            </div>
          )});
          this.setState({showLoadingIndicator:false});
        }
      } else {
        console.log('Some other error: ', err.code);
        this.setState({errorMessage:(
          <div className='error-message'>
            <div className='header'>Error Loading Video</div>
            Could not locate stream output: unknown problem
          </div>
        )});
        this.setState({showLoadingIndicator:false});
      }
    });

  }

  createFFmpegVideo(streamPath) {
    this.setState({showLoadingIndicator:false});

    console.log('Connecting video element to ffmpeg stream');
    let video;
    try {
      video = this.player.current;
    } catch(err) {
      console.error(err);
    }
    if (!video) {
      console.log('MynPlayer did not create video; video element does not exist');
      return;
    }

    // const source = '../video_stream/output.m3u8'
    const source = `../${streamPath}`;

    if(Hls.isSupported()) {
      this.hls = new Hls();
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED,() => {
        video.currentTime = 0;
        video.play();

        // this is a little hacky, but we had to set the height manually
        // in the render function, so that the player would be the right
        // height for the video before the video loads;
        // but once the video loads, we don't want the height set, we want
        // it to adjust naturally based on the width (in case the window resizes, for instance);
        // so we unset it here, now that the video is loaded
        setTimeout(() => {
          video.setAttribute('height','');
        },500);

      });
      this.hls.loadSource(source);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      console.log('the other option...');
      // video.addEventListener('canplay',function() {
      //   video.play();
      // });
      // video.src = source;
    } else {

    }
  }

  createFFmpegStream() {
    this.state.errorMessage = null;
    // console.log('MynPlayer video: ' + JSON.stringify(this.state.video));
    this.stream = new Stream();
    this.stream.createStream(this.state.video.filename,this.state.video.id,this.callbacks);
  }

  setUpVideo() {
    this.createSubtitleTracks();

    let promise;
    if (this.player.current) {
      this.player.current.src = this.state.video.filename;
      this.player.current.focus(); // so that the key commands will work
      promise = this.player.current.play();
    } else {
      console.error('Could not play video at all; could not find video element');
    }

    if (typeof promise !== "undefined") {
      promise.then(() => {
        console.log('Browser can play video natively!');
        this.seekVideoTo(this.state.video.position);
        this.setState({showLoadingIndicator:false});
      }).catch((err) => {
        // for now, don't try to make an ffmpeg stream, it's too buggy. We'll figure it out later
        console.error(`Browser could not play video natively`);
        this.setState({errorMessage:(
          <div className='error-message'>
            <div className='header'>Error Loading Video</div>
            This video format cannot be played natively
          </div>
        ), showLoadingIndicator:false});

        // console.error(`Browser could not play video natively, using HLS fallback: ${err}`);
        // this.createFFmpegStream();
      });
    } else {
      console.error('Video player promise was undefined');
    }

  }

  // ========== HANDLING SUBTITLES =========== //

  async createSubtitleTracks() {
    if (!this.state.video) return null;

    const tempFolder = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');
    const createFilename = (origName) => `${this.state.video.id}-${crypto.createHash('sha1').update(origName).digest('hex')}.vtt`;
    let subtitles = [];

    // ======= Convert external subs ======= //
    this.state.video.subtitles.map((sub,index) => {
      // create a unique filename for each converted subtitle file based on the video id and a hash of the original filename
      let vttFilename = createFilename(sub);
      let vttFilePath = path.join(tempFolder,vttFilename)

      let subName = '';
      try {
        subName = path.basename(sub,path.extname(sub)).toLowerCase().replace(path.basename(this.state.video.filename,path.extname(this.props.video.filename)).toLowerCase(),'').replace(/\b\w/g,(l) => l.toUpperCase());
      } catch(err) {console.error(err)}
      if (subName === '') subName = `Track ${index+1}`;

      fs.createReadStream(sub)
        .pipe(subtitle.parse())
        // .pipe(subtitle.resync(-100))
        .pipe(subtitle.stringify({ format: 'WebVTT' }))
        .pipe(fs.createWriteStream(vttFilePath));

      // let trackLabel = `Track ${index+1}`;
      let subObj = {
        path: vttFilePath,
        name: subName,
        lang: 'English'
      }
      subtitles.push(subObj);

      // return (
      //   <track key={vttFilename} label={trackLabel} kind="subtitles" srcLang="en" src={vttFilePath} />
      // );
    });

    // ======= Extract and convert internal subs ======= //
    let vidInfo;
    try {
      vidInfo = await ffprobe(this.state.video.filename, { path: ffprobeStatic.path });
      console.log(vidInfo);
    } catch(err) {
      console.error(err);
    }
    try {
      vidInfo.streams.map(stream => {
        // loop over the various data streams that ffprobe found in the video;
        // if any of these are subtitle streams, extract them as external files;

        if (stream.codec_type === 'subtitle') {
          let filepath = path.join(tempFolder,`internal${stream.index}.vtt`);

          let subObj = {
            path: filepath,
            name: stream.tags && stream.tags.title ? stream.tags.title : `Track ${subtitles.length+1}`,
            lang: stream.tags ? stream.tags.language : ''
          }
          subtitles.push(subObj);

          let cmd = ffmpeg(this.state.video.filename, {
            timeout:60
          }).outputOptions([
            `-map 0:${stream.index}`
          ]).on('codecData', (data) => {
            console.log('==== FFMPEG codecData ====');
            console.log(data);
            console.log(JSON.stringify(data));

            // setTimeout(()=>cmd.kill(),15000);


          }).on('end', (stdout, stderr) => {
            console.log('==== FFMPEG end ====');
            console.log(stdout);

          }).on('error', (err) => {
            console.log('==== FFMPEG error ====');
            console.log(err.message);
            // fs.unlink(tempFile, () => {
            //   console.log('deleted temp file used by ffmpeg');
            // });
          }).save(filepath);
        }

      });
    } catch(err) {
      // if we don't have ffprobe we'll probably end up here
    }

    // create track tags and set them in state to be rendered
    let tracks = subtitles.map((sub, index) =>
      (<track key={sub.path} label={sub.name} kind="subtitles" srcLang="en" src={sub.path} />)
    );
    this.setState({subtitleTracks:tracks});
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

    if (!this.props.show) {
      this.state.errorMessage = null;
      this.state.showLoadingIndicator = false;
      this.state.tries = 0;
    }

  }

  render() {
    let jsx = null;

    if (this.props.show) {
      // we decide whether to show the loading indicator
      // using functions instead of just doing it directly in the JSX
      // because we want to use a brief timeout before actually displaying it
      if (this.state.showLoadingIndicator) {
        this.showLoadingIndicator();
      } else {
        this.hideLoadingIndicator();
      }

      // default size for the video player if no video size is found in the metadata
      let width = 800;
      let height = '';
      // let height = 600;

      // get dimensions from the metadata
      if (this.state.video && this.state.video.metadata) {
        let probedWidth = this.state.video.metadata.width;
        let probedHeight = this.state.video.metadata.height;
        console.log(`width: ${probedWidth}, height: ${probedHeight}`);
        if (!isNaN(probedWidth) && probedWidth > 0) {
          width = probedWidth;
          // style.width = Math.min(probedWidth,window.innerWidth) + 'px';
          if (!isNaN(probedHeight) && probedHeight > 0) {
            // style.height = Math.min(probedHeight,window.innerHeight) + 'px';
            try {
              height = parseFloat(this.player.current.offsetWidth) * probedHeight / probedWidth;
            } catch(err) {}
          } else {
            // if we got a valid width but not a height, let the height be automatic
            height='';
          }
        }
      }

      jsx = (
        <div id="video-container" style={{width:width + 'px'}} onKeyUp={(e) => this.keyCommand(e)}>
          <video
            controls
            id="video-player"
            ref={this.player}
            width={width}
            height={height}
            onBlur={this.onblur}
            onPlay={this.onplay}
            onPause={this.onpause}
            onSeeked={this.onseeked}
            onTimeUpdate={this.ontimeupdate}
            onEnded={this.onended}
          >
            {this.state.subtitleTracks}
          </video>
          {this.state.loadingIndicator}
          {this.state.errorMessage}
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
      collections : (<MynSettingsCollections  save={this.save} collections={this.props.collections} videos={this.props.videos} settings={this.props.settings} />),
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
              <div className="header cell view" title="Flat view displays items as a simple list. Hierarchical view displays items as a collections tree.">View</div>
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
      console.error('Not address was provided to save.');
    }
  }

  render() {
    const dialogDescriptions = {
      'MynEditorSearch-confirm-select' : 'Confirm selection of search result in video editor',
      'MynEditor-confirm-exit' : 'Confirm on exiting video editor without saving',
      'MynEditorEdit-confirm-revert' : 'Confirm on reverting to saved values in video editor',
      'MynLibrary-confirm-convertTerminalCol' : (
        <span>
          {'Confirm on dragging a video to a collection in the library pane'}
          <br/>
          {'when it would mean deleting its child collections'}
          <MynTooltip tip={`A collection can either contain other collections or videos, but not both. If it contains videos, it is a 'terminal' collection. If you drag a video into a non-terminal collection, it must remove any child collections from itself (and grandchildren, etc., recursively) in order to convert itself to a terminal collection which can contain the video(s) you want to add to it. This will permanently delete all of its descendant collections (though any videos contained therein will not be affected aside from their participation in the deleted collections).`} />
        </span>
      ),
      'MynLibTable-confirm-inlineEdit' : (
        <span>
          {'Confirm when editing a video directly from a widget'}
          <br/>
          {'in a table row (e.g. the rating stars)'}
        </span>
      ),
      'MynSettingsCollections-confirm-convertToNonTerminal' : (
        <span>
          {'Confirm adding a child collection in the settings pane'}
          <br/>
          {'when it would mean removing the videos from the parent collection'}
          <MynTooltip tip={`A collection can either contain other collections or videos, but not both. If it contains videos, it is a 'terminal' collection. If you add a child collection to a terminal collection (by clicking its ${'\uFF0B'} button in the Settings ${'\u279E'} Collections pane), it must remove any videos from itself in order to convert itself to a non-terminal collection. This will NOT remove the videos from the library itself, nor from any other collections they might be in.`} />
        </span>
      ),
      'MynSettingsCollections-confirm-delete' : 'Confirm deletion of collections in the settings pane'
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
            <option value='hierarchical'>Hierarchical</option>
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

class MynSettingsCollections extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      collections : _.cloneDeep(props.collections)
    }


    ipcRenderer.on('MynSettingsCollections-confirm-delete', (event, response, id, checked) => {
      if (response === 0) { // yes
        // delete the collection
        // we were passed the id, but we need to pass the actual collection to deleteCollection
        // (the dialog can't pass the whole collection through ipcRenderer because it seems
        // to break the reference to the actual object, so we just pass the id and pick it back up on the other side)
        let collections = new Collections(this.state.collections);
        let c = collections.get(id);
        this.deleteCollection(null, c, null, true);

        // if the user checked the option to override this dialog next time
        if (checked) {
          console.log('option to override dialog was checked!');
          let prefs = _.cloneDeep(this.props.settings.preferences);
          if (!prefs.override_dialogs) {
            prefs.override_dialogs = {};
          }
          prefs.override_dialogs['MynSettingsCollections-confirm-delete'] = true;
          library.replace("settings.preferences",prefs);
        }
      } else {
        console.log('Deletion canceled by user')
      }
    });

    ipcRenderer.on('MynSettingsCollections-confirm-convertToNonTerminal', (event, response, parentID, checked) => {
      if (response === 0) { // yes
        // add the collection
        // console.log("Yes Add Collection!!! Hurray!!");

        // we were passed the id, but we need to pass the actual collection to addCollection
        // (the dialog can't pass the whole collection through ipcRenderer because it seems
        // to break the reference to the actual object, so we just pass the id and pick it back up on the other side)
        let collections = new Collections(this.state.collections);
        let c = collections.get(parentID);
        this.addCollection(null, c, false);

        // if the user checked the option to override this dialog next time
        if (checked) {
          console.log('option to override dialog was checked!');
          let prefs = _.cloneDeep(this.props.settings.preferences);
          if (!prefs.override_dialogs) {
            prefs.override_dialogs = {};
          }
          prefs.override_dialogs['MynSettingsCollections-confirm-convertToNonTerminal'] = true;
          library.replace("settings.preferences",prefs);
        }
      } else {
        console.log('Add collection canceled by user')
      }
    });

    this.onDragEnd = this.onDragEnd.bind(this);
    this.onDragStart = this.onDragStart.bind(this);
  }

  addCollection(e, parentCol, isTerminal) {
    if (e) e.stopPropagation();

    let parentID;
    if (parentCol) parentID = parentCol.id;

    console.log(JSON.stringify(parentCol))

    // if this is a terminal collection, and
    // if the user hasn't previously checked the option to override it,
    // show the user a confirmation dialog before adding a collection,
    // (because that will necessitate deleting any videos it has)
    if (isTerminal && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs[`MynSettingsCollections-confirm-convertToNonTerminal`])) {
      ipcRenderer.send(
        'generic-confirm',
        'MynSettingsCollections-confirm-convertToNonTerminal',
        {
          message: `Are you sure you want to add a child collection to '${parentCol.name}'? This will remove all the videos from this collection (though the videos themselves will remain in the library).`,
          checkboxLabel: `Don't show this dialog again`
        },
        parentID
      );
      return;
    }

    let collections = new Collections(this.state.collections);
    let newCol;

    // if we got a parent collection
    if (parentCol) {
      // convert it to non-terminal if needed (removing any videos it has)
      // and add the new child
      // if (!parentCol.c) parentCol = new Collection(parentCol); // wrap it in a class if it isn't already
      collections.convertToNonTerminal(parentCol);
      newCol = collections.addChild(parentCol);
    } else {
      // if we weren't given a parentID we assume we're adding a child to the
      // top-level collections object
      newCol = collections.addCollection({name:''},true);
    }

    // console.log('NEW COLLECTION: ' + JSON.stringify(newCol));
    // console.log('NEW COLLECTION from master: ' + JSON.stringify(collections.get(newCol.id)));

    // this.state.collections is actually altered in place
    // but we need to explicitly set it in order to get a re-render
    // after which we save to the library
    this.setState({collections: collections.getAll()}, () => {
      this.props.save({'collections':this.state.collections});
    });
  }

  deleteCollection(e, c, isTerminal, dialogConfirmed) {
    if (e) e.stopPropagation();

    // if the user hasn't previously checked the option to override it,
    // show the user a confirmation dialog before deleting the collection
    if (!dialogConfirmed && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs[`MynSettingsCollections-confirm-delete`])) {
      ipcRenderer.send(
        'generic-confirm',
        'MynSettingsCollections-confirm-delete',
        {
          message: `Are you sure you want to delete '${c.name}'? (${ !isTerminal ? 'this will delete all of its child collections as well, though ' : '' }the videos themselves will remain in the library)`,
          checkboxLabel: `Don't show this dialog again`
        },
        c.id
      );
      return;
    }

    // if we're here, the user has either confirmed the dialog or
    // they have opted to skip the dialog,
    // so delete the collection
    console.log('Deleting ' + c.name);
    let collections = new Collections(this.state.collections);
    collections.deleteCollection(c.id);

    // this.state.collections is actually altered in place
    // but we need to explicitly set it in order to get a re-render
    // after which we save to the library
    this.setState({collections: collections.getAll()}, () => {
      this.props.save({'collections':this.state.collections});
    });
  }

  createAddCollectionBtn(c, isTerminal) {
    return (
      <div key='add' className={'add collection-btn clickable' + (isTerminal ? ' terminal' : '')} onClick={(e) => this.addCollection(e,c,isTerminal)}>
        <h1>{'\uFF0B'}</h1>
      </div>
    );
  }

  createDeleteCollectionBtn(c, isTerminal) {
    return (
      <div key='delete' className={'delete collection-btn clickable' + (isTerminal ? ' terminal' : '')} onClick={(e) => this.deleteCollection(e,c,isTerminal)}>
        <h1><div style={{transform: 'rotate(45deg)'}}>{'\uFF0B'}</div></h1>
      </div>
    );
  }

  onDragStart() {
    this.setState({dragging:true});
  }

  onDragEnd(result) {
    this.setState({dragging:false});

    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      console.log(`
        dragged ID: ${draggableId}\n
        src ID:     ${source.droppableId}\n
        dst ID:     ${destination.droppableId}\n
        src index:  ${source.index}\n
        dst index:  ${destination.index}
      `);
    } else {
      console.log('Drag did not result in a move');
    }
  }

  findCollections(collections) {
    if (!collections) return null;

    // if collections is a class object, unwrap it
    if (collections.c) collections = collections.c;

    let collectionsJSX = collections.map(collection => {
      if (!collection) return null;

      let children = null;
      let isTerminal = false;

      // if this collection has child collections
      if (collection.collections) {
        // attach those collections as children
        children = this.findCollections(collection.collections);

      // if the collection does not have child collections,
      // it is a bottom-level collection, probably containing videos
      // (though it may not contain videos)
      // so if it contains videos, attach those videos as children
      } else if (collection.videos && collection.videos.length > 0) {
        // set isTerminal to true in order to tell the addButton
        // (which we create later) to give the user a confirmation dialog
        // before adding a child (because doing so will delete its videos)
        isTerminal = true;

        let childrenEls = collection.videos.sort((a,b) => a.order > b.order ? 1 : a.order < b.order ? -1 : 0).map(vidToken => {
          let video = null;
          try {
            video = this.props.videos.filter(video => video && video.id === vidToken.id)[0];

            return (
              <div key={vidToken.order} className='video'>
                <div className='order'>{vidToken.order}</div> {video.title}
              </div>
            );
          } catch(err) {
            console.error(`MynSettingsCollections Error: could not find video (id: ${vidToken.id}) from collection "${collection.name}" in library`);
          }
          return null;
        });

        children = (
          <div className='videos' style={{ display : (this.state.dragging ? 'none' : 'block') }}>
            {childrenEls}
          </div>
        );

      // if the collection contains neither collections nor videos
      // it is an empty bottom-level collection, in which case the user
      // is still allowed to create a child collection for it
      // (making it no longer a bottom-level collection)
      // so we leave isTerminal false
      } else {
      }

      // create an add button so the user can create more child collections;
      // in the case of a terminal collection containing videos, isTerminal
      // will tell the button to use a confirmation dialog, because adding a child
      // collection will convert it to a non-terminal collection,
      // deleting all the videos in it
      let addButton = this.createAddCollectionBtn(collection, isTerminal);

      let deleteButton = this.createDeleteCollectionBtn(collection, isTerminal);

      let editColNameValid;
      let index = parseInt(collection.id.match(/\d+$/)[0]);
      // console.log("INDEX for " + collection.id + " : " + index);

      return (
        <Draggable key={collection.id} draggableId={collection.id} index={index}>
          {(provided, snapshot) => {

            // let draggableProps = _.cloneDeep(provided.draggableProps);
            // draggableProps.style.opacity = snapshot.isDragging ? 0.5 : 1;
            // console.log(JSON.stringify(snapshot));

            return (
              <div
                key={collection.id}
                id={'settings-col_' + collection.id}
                className='collection'
                ref={provided.innerRef}
                {...provided.draggableProps}
              >
                <header>
                  <h1 {...provided.dragHandleProps} style={{cursor:'grab'}}>
                    <MynClickToEditText
                      object={collection}
                      property='name'
                      update={(prop,value) => { if (editColNameValid) collection.name = value }}
                      save={() => {
                        if (editColNameValid) {
                          let cols = new Collections(this.state.collections);
                          cols.sortAll();
                          library.replace("collections", cols.getAll());
                        }
                      }}
                      options={null}
                      validator={/^[^=;{}]+$/}
                      validatorTip={'Not allowed: = ; { }'}
                      allowedEmpty={true}
                      reportValid={(prop,valid) => { editColNameValid = valid }}
                      noClear={true}
                      setFocus={true}
                      doubleClick={true}
                    />

                    ({collection.id})
                  </h1>
                  <div className='collection-btn-container'>
                    {deleteButton}
                    {addButton}
                  </div>
                </header>
                <div style={{display: (snapshot.isDragging ? 'none' : 'block') }}>
                  {children}
                </div>
              </div>
            )
          }}
        </Draggable>
      );
    });

    // create a droppableId for this collections level
    // by recreating the parent collection's id from its 1st member
    let droppableId = '-';
    for (let col of collections) {
      try {
        let match = col.id.match(/.+(?=-\d+$)/);
        if (match !== null && match.length > 0) {
          droppableId = match[0];
          break;
        }
      } catch(err) {
        // do nothing, keep looping
      }
    }
    // console.log('DROPPABLE ID matches == ' + JSON.stringify(id));

    return (
      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => {
          // console.log(JSON.stringify(snapshot));
          return (
            <div className='collections' ref={provided.innerRef} {...provided.droppableProps}>
              {collectionsJSX}
              <div style={{display:'none'}/*{ maxHeight: '45px', border: '1px solid red', overflow : 'hidden', backgroundColor : (snapshot.isUsingPlaceholder ? 'red' : 'initial') }*/}>
                {provided.placeholder}
              </div>
            </div>
          )
        }}
      </Droppable>
    );
  }

  render() {
    return (
      <div id='settings-collections'>
        {this.createAddCollectionBtn()}
        <DragDropContext onDragStart={this.onDragStart} onDragEnd={this.onDragEnd}>
          {this.findCollections(this.state.collections)}
        </DragDropContext>
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
    let collections = props.collections ? new Collections(_.cloneDeep(props.collections)) : null;
    // let vidCols = props.video && collections ? collections.getVideoCollections(props.video.id) : {};
    // // let videoWithCols = {...props.video, ...vidCols};
    // let videoWithCols = props.video;
    // if (videoWithCols) videoWithCols.collections = vidCols;

    this.state = {
      paneID: 'editor-pane',
      // video: /_.cloneDeep(videoWithCols), // add collections to video object during editing, so we can use the validation machinery (and the hash, to see if the user has made a change)
      collections: collections,
      placeholderImage: placeholderImage,
      valid: {},
      // saveHash: hashObject(videoWithCols),
      changed: new Set()
    }

    this.render = this.render.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.revertChanges = this.revertChanges.bind(this);
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
    // if we were passed two arguments, treat them as prop,value
    if (args.length == 2 && typeof args[0] === "string") {
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

    this._isMounted && this.setState({video : update});

    // in addition to updating the video object, in the special case that the collections were changed,
    // we need to update the master collections object in the library
    if (args[0] == "collections" || args[0].collections) { // collections was updated
      // console.log("args[0] == " + JSON.stringify(args[0]));
      const collectionUpdate = args[1] || args[0].collections;
      // console.log("collectionUpdate == " + JSON.stringify(collectionUpdate));
      // console.log("original collections == " + JSON.stringify(this.state.video.collections));

      let collectionsCopy = new Collections(this.state.collections.getAll(true)); // pass 'true' to get a deep copy

      // add video to any new collections
      const addedIDs = Object.keys(collectionUpdate).filter((key) => !Object.keys(this.state.video.collections).includes(key));
      // console.log(`addedIDs == ${addedIDs}`);
      for (const id of addedIDs) {
        // let collection = getCollectionObject(id, collectionsCopy, false);
        // if (collection) {
        //   collection.videos.push({
        //     id: this.state.video.id,
        //     order: collectionUpdate[id]
        //   });
        // } else {
        //   console.error(`Unable to add ${this.state.video.title} to collection ${id}. Unable to retrieve collection object from that id.`);
        // }
        let collection = collectionsCopy.get(id);
        if (collection) {
          collectionsCopy.addVideo(collection,this.state.video.id,collectionUpdate[id]);
        } else {
          console.error(`Unable to add ${this.state.video.title} to collection ${id}. Unable to retrieve collection object from that id.`);
        }
      }

      // delete video from any deleted collections
      Object.keys(this.state.video.collections).forEach((id) => {
        if (!Object.keys(collectionUpdate).includes(id)) {
          // let collection = getCollectionObject(id, collectionsCopy, false);
          let collection = collectionsCopy.get(id);
          if (collection) {
            collectionsCopy.removeVideo(collection,this.state.video.id);
            // collection.videos = collection.videos.filter(video => video.id !== this.state.video.id);
          } else {
            console.error(`Unable to remove ${this.state.video.title} from collection ${id}. Unable to retrieve collection object from that id.`);
          }
        }
      });

      // update any changes to the order number of this video in its collections
      const ids = Object.keys(collectionUpdate);
      for (const id of ids) {
        let collection = collectionsCopy.get(id);//getCollectionObject(id, collectionsCopy, false);
        if (collection) {
          try {
            // console.log("Updating order of collection " + id + " to " + collectionUpdate[id]);
            // let index = collection.videos.indexOf(collection.videos.filter(v => v.id === this.state.video.id)[0]);
            // collection.videos[index].order = collectionUpdate[id];
            let success = collectionsCopy.updateOrder(collection,this.state.video.id,collectionUpdate[id]);
            // console.log("success? " + success);
          } catch(err) {
            console.error(`Unable to update order property for ${this.state.video.title} in collection ${id}. Video not found in that collection.`);
          }
        } else {
          console.error(`Unable to update order property for ${this.state.video.title} in collection ${id}. Unable to retrieve collection object from that id.`);
        }
      }

      // console.log("collections after change: " + JSON.stringify(collectionsCopy));
      this._isMounted && this.setState({collections : collectionsCopy});
    }

    // just for debugging:
    let changedFields = []
    this.state.changed.forEach(field => {changedFields.push(field)});
    console.log('Changed Fields: ' + changedFields.join(', '));
  }

  revertChanges() {
    // console.log('reverting...');
    // event.preventDefault();
    // this._isMounted && this.setState(
    //   {
    //     video : _.cloneDeep(this.props.video),
    //     collections : _.cloneDeep(this.props.collections)
    //   }
    // );
    this.componentDidUpdate({video:null});

  }

  saveChanges(event) {
    if (event) {
      event.preventDefault();
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
        // loop through the videos we're editing
        this.props.batch.map(video => {
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

          // save this video to the library
          let temp = _.cloneDeep(video);
          delete temp.collections;
          let index = library.media.findIndex(v => v.id === video.id);
          library.replace("media." + index, temp);
        });

      } else {
        console.error('The video objects were not supplied to MynEditor when editing multiple videos');
      }
    } else {
      // SINGLE VIDEO
      // save the video data in library.media
      // (delete the temporary collections information from the video,
      // we don't want to save this)
      let temp = _.cloneDeep(this.state.video);
      delete temp.collections;
      temp.autotag_tried = false; // reset this flag whenever a video is saved
      let index = library.media.findIndex((video) => video && video.id === this.props.video.id);
      library.replace("media." + index, temp);
    }

    // then, if any collections were changed, save the collections object in library.collections
    if (!_.isEqual(this.props.collections,this.state.collections.getAll())) {
      library.replace("collections", this.state.collections.getAll());
    }

    // then, add any new tags to the library.settings.used.tags list so they'll be available
    // as options for the next video the user edits
    let tags = [...this.props.settings.used.tags];
    tags = tags.concat(this.state.video.tags.filter(tag => tags.indexOf(tag) < 0)).sort();
    library.replace("settings.used.tags",tags);

    // and then do the same for genres
    let genres = [...this.props.settings.used.genres];
    if (this.state.video.genre !== '' && genres.indexOf(this.state.video.genre) < 0) {
      // library.add("settings.used.genres.0",this.state.video.genre);
      genres.push(this.state.video.genre);
      genres.sort();
      library.replace("settings.used.genres",genres);
    }

    // console.log('object when saving:');
    // console.log(this.state.video);

    // save hash so that later we can check if the video has changed
    // (in order to ask the user if they want to save before exiting)
    // and reset the 'changed' set (which keeps track of which fields
    // are changed before saving)
    this.setState({
      saveHash: hashObject(this.state.video),
      changed: new Set()
    });
  }

  componentDidUpdate(oldProps) {
    let collections = this.props.collections ? new Collections(_.cloneDeep(this.props.collections)) : null;
    let vidCols = this.props.video && collections ? collections.getVideoCollections(this.props.video.id) : {};
    let oldVidCols = oldProps.video ? oldProps.video.collections : {};


    // if the video has changed (and we have to check whether its collections have changed independently,
    // since the collections information is no longer contained in the video object itself)
    if (!_.isEqual(oldProps.video,this.props.video) || !_.isEqual(oldVidCols,vidCols)) {
      // console.log('MynEditor props.video has changed!!!\n' + JSON.stringify(this.props.video));

      if (this.props.video) this.props.video.collections = vidCols;

      // create a copy of the video for editing
      let videoEditPrepped = _.cloneDeep(this.props.video);

      if (videoEditPrepped) {
        // attach a temporary collections object to each video,
        // containing information on all the collections the video is a part of;
        // videoEditPrepped.collections = vidCols;

        // if we're dealing with a 'batch object', which is to say,
        // we're editing multiple videos (for which the batch object
        // contains only the values all the videos have in common),
        // save an unedited copy of this batch object for comparison
        // when it's time to save the changes
        if (videoEditPrepped.id === 'batch') {
          this.state.batchObjectUnedited = _.cloneDeep(videoEditPrepped);
        }

        // set the 'new' property to false, so that when the movie is saved,
        // it will be removed from the 'New' playlist
        videoEditPrepped.new = false;

        // fix any broken properties/values
        validateVideo(videoEditPrepped);

        // console.log('object when something changed:');
        // console.log(videoEditPrepped);

        this.setState({
          video : videoEditPrepped,
          collections : collections,
          changed : new Set(),
          saveHash: hashObject(videoEditPrepped) // when a new video is loaded, update the saveHash (which is used for testing whether or not anything has changed since last save)
        });
      }
    }
  }

  goToPrevious() {
    if (this.props.detailRowBoundaryFlag !== 'first') {
      if (this.state.changed.size > 0)
        this.saveChanges();
      this.props.goToPrevious();
    }
  }

  goToNext() {
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

    return (
      <div>
        <MynEditorSearch
          video={this.state.video}
          settings={this.props.settings}
          placeholderImage={this.state.placeholderImage}
          handleChange={this.handleChange}
        />

        <div className={'editor-next-prev-btns ' + this.props.detailRowBoundaryFlag}>
          <div className='btn editor-prev-btn' onClick={()=>this.goToPrevious()}>
            <div style={{display:"inline-block",transform:"scaleX(-1)"}}>{'\u25B8'}</div> Previous
          </div>
          <div className='separator'>|</div>
          <div className='btn editor-next-btn' onClick={()=>this.goToNext()}>
            Next <div style={{display:"inline-block"}}>{'\u25B8'}</div>
          </div>
        </div>

        <MynEditorEdit
          show={this.props.show}
          video={this.state.video}
          batch={this.props.batch}
          collections={this.state.collections ? this.state.collections.c : []}
          settings={this.props.settings}
          handleChange={this.handleChange}
          revertChanges={this.revertChanges}
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
        return this.state.saveHash !== newHash;
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

    ipcRenderer.on('MynEditorSearch-confirm-select', (event, response, video, checked) => {
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
    });
  }

  // search online movie database to auto-fill fields
  async handleSearch(event) {
    event.preventDefault();
    this.setState({searching:true});
    let resultsObject = await OmdbHelper.search(this.props.video);
    this.setState({searching:false});
    //console.log(results);
    if (resultsObject.success) {
      let results = resultsObject.data;
      if (!Array.isArray(results)) {
        results = [
          {
            Poster: results.artwork,
            Title: results.title,
            Type: results.type,
            Year: results.year,
            imdbID: results.imdbID
          }
        ];
      }

      let movies = results.map((movie) => {
        if (movie.Type === 'series') return; // don't want to display series results

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
    } else {
      alert('No results found! Try editing the title and searching again, or enter the IMDb ID for an exact match.');
    }
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

    // next, we have to get the actual movie object from the database
    OmdbHelper.search(movie).then(responseObject => {
      if (!responseObject.success) {
        return console.log('Error: no result found: ' + response.data);
      } else {
        this.props.handleChange(responseObject.data);
      }
    })
  }

  render() {
    let clearBtn = this.state.results ? (<div id='edit-search-clear-button' className='clickable' onClick={this.clearSearch} title='Clear search results'>{"\u2715"}</div>) : null;
    let searchBtn = this.state.searching ? (<img src='../images/loading-icon.gif' className='loading-icon' />) : (<button id='edit-search-button' onClick={this.handleSearch} title='Search online database for movie information (based on IMDb ID if present, then title and year if present, otherwise filename). You will be able to choose a result and manually edit afterwards.'>Search</button>);
    return (
        <div id='edit-search'>
          <div id='edit-search-controls'>
            {searchBtn}
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
              {this.state.results}
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

    ipcRenderer.on('MynEditorEdit-confirm-revert', (event, response, data, checked) => {
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
    });
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

    // we're now doing the validating in MynEditor before it gets here, to avoid issues with the saveHash
    // validate the video in place (function fixes any broken values)
    // and also, if any changes were made (i.e. broken values fixed)
    // save the changes
    // if (validateVideo(this.props.video) !== true) {
    //   // this.props.saveChanges();
    // }
  }

  componentWillUnmount() {
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
            placeholder={'[Title]'}
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
            placeholder={'[Description]'}
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
            className="edit-field-season"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.posint.exp}
            validatorTip={this.state.validators.posint.tip}
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
            className="edit-field-episode"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.posint.exp}
            validatorTip={this.state.validators.posint.tip}
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
    options.unshift(<option key='none' disabled hidden value=''></option>);
    let kind = (
      <div className='edit-field kind'>
        <label className="edit-field-name" htmlFor="kind">Kind: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="kind" value={this.props.video.kind || ''} onChange={(e) => this.props.handleChange({'kind':e.target.value})}>
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

    /* COLLECTIONS */
    let collections = (
      <div className='edit-field collections'>
        <label className="edit-field-name" htmlFor="collections">Collections: </label>
        <MynParagraphFolder className="edit-field-description" lede="Add and subtract the video to and from existing collections here." paragraph="In order to create new collections or edit the existing structure, go to the settings pane. Deleting and adding collections can also be done directly in the library pane (when viewing a playlist hierarchically)." />
        <div className="edit-field-editor">
          <MynEditCollections
            video={this.props.video}
            property="collections"
            collections={this.props.collections}
            update={this.props.handleChange}
            validator={this.state.validators.number.exp}
            validatorTip={this.state.validators.number.tip}
            reportValid={this.props.reportValid}
            batch={!!this.props.batch}
          />
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
    options.unshift(<option key={options.length} disabled hidden value=''></option>);
    let rated = (
      <div className='edit-field rated'>
        <label className="edit-field-name" htmlFor="rated">Rated: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="rated" value={this.props.video.rated} onChange={(e) => this.props.handleChange({'rated':e.target.value})}>
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

    let new_ = (
      <div className='edit-field new'>
        <label className="edit-field-name" htmlFor="new">New: </label>
        <div className="edit-field-editor">
          <input
            type='checkbox'
            checked={this.props.video.new}
            onChange={(e) => this.props.handleChange({'new': !this.props.video.new})}
          />
        </div>
        <div className='edit-field-description'>Check to re-add this video to the 'New' playlist</div>
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
             {this.props.batch.map(v => (
                 <tr key={v.id}>
                  <td className='title'><MynOverflowTextMarquee text={v.title} ellipsis='fade' /></td>
                  <td className='year'>{v.year}</td>
                  <td className='filename'><MynOverflowTextMarquee text={v.filename} direction='left' ellipsis='fade' /></td>
                 </tr>
             ))}
            </tbody>
          </table>
       );
      }

      batchNotification = (
        <MynParagraphFolder
          id="edit-batch-notification"
          lede="Editing Multiple Videos"
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
          {lastseen}
          {position}
          {dateadded}
          {artwork}
          {subtitles}
          {collections}
          {ratings}
          {boxoffice}
          {rated}
          {country}
          {languages}
          {new_}
          {metadata}
          <button className="edit-field revert-btn" onClick={(e) => this.requestRevert(e)}>Revert to Saved</button>
          <input className="edit-field save-btn" type="submit" value="Save" />
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

  handleInput(target, value, source) {
    let min = this.state.source[source].min;
    let max = this.state.source[source].max;

    // let target = event.target;
    // let value = target.value;
    if (value === "") {
      super.handleValidity(true,this.props.property,target);
    } else if (this.props.validator.test(value,min,max)) {
      super.handleValidity(true,this.props.property,target);
    } else {
      super.handleValidity(false,this.props.property,target,this.props.validatorTip(min,max));
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }

    let update = _.cloneDeep(this.props.video[this.props.property]);
    // update[source] = !isNaN(Number(value)) && value !== '' ? value / this.state.source[source].max : value;
    update[source] = value;
    // console.log('HMMM... ' + update[source]);
    this.props.update(this.props.property,update);
  }

  componentDidUpdate(oldProps) {
    // this will trigger when we hit the 'revert to saved' button
    if (!_.isEqual(oldProps.video[this.props.property],this.props.video[this.props.property])) {
      // we have to reset each field back, which is actually a little convoluted since there are 3 of them

       // get array of each input and loop over them
      let inputs = Array.from(this.table.current.getElementsByClassName('ratings-input-input'));
      inputs.map(input => {
        // get the source for this input by comparing the classList to the state object, picking the one that matches one of the state object's keys (convoluted, right?)
        let source = Array.from(input.classList).find(theClass => Object.keys(this.state.source).includes(theClass));
        let value = this.props.video[this.props.property][source];
        // if the value does not exist in the video object, we have to supply our own empty string;
        // if it does, we have to multiply it to produce the appropriate display value
        if (value === undefined) {
          value = '';
        }
        // if (!isNaN(Number(value))) {
        //   value *= this.state.source[source].max;
        // } else {
        //   value = ''
        // }
        // now we can call handleInput to update the input values
        this.handleInput(input, value, source);
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
                 placeholder={'#'}
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

class MynEditCollections extends MynEdit {
  constructor(props) {
    super(props)

    this.state = {
    }

    this.render = this.render.bind(this);
    // this.addCollection = this.addCollection.bind(this);

  }

  createAddCollectionBtn(parentID) {
    return (
      <div
        className="collection-add clickable"
        onClick={this.showAddField}
        title="Add a sub-collection to this collection"
      >
        {"\uFE62"}
      </div>
    )
  }

  showAddField(event) {
    try {
      let field = findNearestOfClass(event.target,'collection').getElementsByClassName("add-collection-form")[0];
      // event.target.parentNode.parentNode.getElementsByClassName("add-collection-form")[0].style.display = "block";

      field.style.display = field.style.display == "block" ? "none" : "block";
    } catch(err) {
      console.error('There are no subcollections to add to');
    }
  }

  addCollection(event, name, parent) {
    event.preventDefault();

    // hide the add node form
    findNearestOfClass(event.target,'add-collection-form').style.display = "none";

    // get the collection object the user wants to add
    let parentList;
    if (parent) {
      parentList = parent.collections;
    } else {
      // if no parent was passed, we take it from the top level
      parentList = this.props.collections;
    }

    let collection;
    try {
      collection = parentList.filter(collection => collection && collection.name === name)[0];
    } catch(err) {
      console.error(`Could not find collection to add video to it: ${err}`);
    }

    try {
      // if this is not a terminal node,
      if (collection.collections) {

        // reveal the jsx for that collection
        document.getElementById("collection-" + collection.id).style.display = 'block';

        // add a dropdown form for the children
        // let names = collection.collections.map(child => child.name);
        // event.target.parentNode.parentNode.appendChild(this.createAddNodeForm(names));

        // if this is a terminal node
        // all we have to do is add this video to this node and trigger a re-render
      } else if (collection.videos) {
        console.log('adding this video to ' + collection.name + '!!!');

        // initially, set the order to the smallest (positive) unused (integer) order number
        // in this collection; the user can edit it to whatever they want afterwards
        let order = 0;
        let used = true;
        while (used) {
          order++;
          used = collection.videos.filter(vid => vid.order == order).length > 0;
        }

        let updated = _.cloneDeep(this.props.video.collections);
        updated[collection.id] = order;
        this.update({ collections : updated });
        // the update function will take care of updating the library.collections object to correspond to our edit
      }
    } catch(err) {
      console.error('Unable to add video to collection: ' + err);
    }
  }

  // addCollection(event, name, parentID) {
  //   event.preventDefault();
  //
  //   // make a deep copy of the whole collections object for this video,
  //   // we will alter the copy, and then update the video object with the copy
  //   let copy = _.cloneDeep(this.props.video.collections);
  //
  //   // find the parent collection object by traversing the parentID
  //   let parent = copy;
  //   // console.log(parent);
  //   let map = parentID.split('-');
  //   map.map((nodeIndex, index) => {
  //     console.log(parent);
  //     if (index < map.length - 1) {
  //       parent = parent[nodeIndex].collections;
  //     } else {
  //       parent = parent[nodeIndex];
  //     }
  //   });
  //
  //   // if parent.order then this is a terminal node.
  //   // since non-terminal nodes cannot contain videos, and adding a child to this collection
  //   // will make it no longer terminal, we must warn the user;
  //   // in particular because there may be other videos occupying this node as well,
  //   // and adding a child will erase them from this collection
  //   let order;
  //   if (parent.order) {
  //     // later we'll make this into a proper confirmation dialog
  //     alert('Warning! AAAHHHH what are you doing!?!!!');
  //
  //     order = parent.order;
  //     delete parent.order;
  //     parent.collections = [];
  //   }
  //
  //   event.target.parentNode.querySelector('input').value = "";
  //   event.target.parentNode.style.display = "none";
  //
  //   // create new collection to be added
  //   let newCollection = {
  //     id : parentID + '-' + parent.collections.length,
  //     name : name,
  //     order : 0
  //   };
  //
  //   // if the parent was a terminal node, we'll take the order property for this video
  //   // from that node and make it the order property for this video of this node instead
  //   // otherwise we'll just default to an order of 0 and let the user edit it after the update
  //   if (order) {
  //     newCollection.order = order;
  //   }
  //   parent.collections.push(newCollection);
  //
  //   // console.log(copy);
  //
  //   // do the update
  //   this.props.update({'collections':copy});
  // }

  // addToCollection(collectionID, video, order) {
  //
  // }

  deleteFromCollection(collection) {
    // alert('deleting from collection ' + collection.name);

    let collectionUpdate = _.cloneDeep(this.props.video.collections);
    delete collectionUpdate[collection.id];
    this.update({ collections : collectionUpdate });
  }

  createAddNodeForm(options,collection) {
    options = options.map(option => (<option key={option}>{option}</option>));

    if (options.length > 0) {
      return (
        <div className="add-collection-form select-container inline select-alwaysicon" style={{display:"none"}}>
          <select name="name">{options}</select>
          <button className="editor-inline-button" onClick={(e) => this.addCollection(e,e.target.parentNode.querySelector('select').value,collection)}>{"\uFE62"}</button>
        </div>
      );
    } else {
      return null;
    }
  }

  // createCollectionNode(collection, index) {
  //   let contents;
  //   // if this collection has child collections
  //   if (collection.collections) {
  //     try {
  //       // recurse on those children
  //       contents = collection.collections.map((child, index) => this.createCollectionNode(child, index));
  //     } catch(err) {
  //       contents = "[Error: sub-collections found, but unable to display]";
  //       console.error(contents + ': ' + err);
  //     }
  //   } else {
  //     // this collection does not have child collections
  //     // which means it's a terminal node, so display the movie order and the delete button
  //     try {
  //       contents = (
  //         <div className="collection-terminal-node">
  //           <div className="collection-order">order: {collection.order}</div>
  //           <div className="delete-btn clickable" onClick={() => this.deleteFromCollection(collection)}>{"\u2715"}</div>
  //         </div>
  //       );
  //     } catch(err) {
  //       contents = "[Error: unable to find terminal node]";
  //       console.error(contents + ': ' + err);
  //     }
  //   }
  //
  //   return (
  //     <div className="collection" key={index}>
  //       <div className="collection-name">{collection.name}</div>
  //       {this.createAddCollectionBtn(collection.id)}
  //       <div className="add-collection-form" style={{display:"none"}}>
  //         <input type="text" name="name" placeholder="Collection Name" />
  //         <button onClick={(e) => this.addCollection(e,e.target.parentNode.querySelector('input').value,collection.id)}>Add</button>
  //       </div>
  //       {contents}
  //     </div>
  //   );
  // }

  // create display of tree of collections in which this movie participates
  createCollectionsMap() {
    // console.log("Creating new collections map");
    let results = []
    this.props.collections.map(collection => (this.findCollections(collection))).map(result => {
      if (!result) return;

      // put hidden collections (ones that this video doesn't belong to, but the user might add it to)
      // at the top of the list, so that when they're added, the user can see them easily
      if (result.show) {
        results.push(result.jsx);
      } else {
        results.unshift(result.jsx);
      }
    });

    // return results, adding the 'older-sister' class
    // to all but the last one
    return results.map((jsx,i) =>{
      if (i < results.length-1) {
        return React.cloneElement(jsx,
          {
            className : 'collection older-sister'
          });
      }
      return jsx;
    });
  }

  // recursive function that walks down the collections and returns each branch as JSX
  // if it contains this video, display it to the user, otherwise hide it
  findCollections(collection) {
    if (!collection) return null;

    let results = []
    let childrenOpts = []
    let show = false;

    // if this object contains sub-collections, then it's a non-terminal node,
    // so we recurse on its children
    if (collection.collections && collection.collections.length > 0) {
      // loop through the subcollections and call ourselves recursively on each one
      for (let i=0; i<collection.collections.length; i++) {
        let child = this.findCollections(collection.collections[i]);

        // if this child isn't being shown (i.e. our video isn't in its branch)
        // add it to the beginning of the results array, so that if the user adds it, it appears at the top;
        // also add it to the list of options to display to the user for adding the video to its branch
        if (child) {
          try {
            if (child.show === false) {
              results.unshift(child)
              childrenOpts.push(collection.collections[i].name);
            } else {
              // if the child IS being shown, add it to the end of the results array,
              // so that it appears after any hidden collections that the user might add
              results.push(child);
            }
          } catch(err) {
            console.error(err);
            console.log(`i==${i}, collection.collections[i]==${JSON.stringify(collection.collections[i])}`);
          }
        }
      }
      // if there are no child collections within this collection;
      // add the terminal node JSX to the results array
      // test whether one of the videos is this video
      // and if it is, show the terminal node; otherwise, hide it
    } else if (collection.videos || !collection.collections || collection.collections.length === 0) {
      // we're at a bottom-level collection

      // if there is no videos array, create one
      if (!collection.videos) {
        collection.videos = [];
        delete collection.collections;
      }

      try {
        let index = collection.videos.findIndex(video => video.id == this.props.video.id);
        if (index !== -1) {
          show = true; // if our video was in this collection, show the node, otherwise hide it
        } else {
          show = false;
        }

        let contents;
        try {
          // create JSX for the terminal node. If our video is not in this collection,
          // the order will be undefined (we display an empty string), but nothing will be shown anyway
          contents = (
            <div key={'terminal-' + collection.id} className="collection-terminal-node">
              {!this.props.batch ? (<div className="collection-order">Order: <input type="text" className="filled" value={this.props.video.collections[collection.id] || ''} onChange={(e) => this.updateOrder(e.target.value, e.target, collection)} /><div className="input-clear-button always" onClick={(e) => this.clearOrder(e, collection)}></div></div>) : null }
              <div className="inline-delete-button clickable" onClick={() => this.deleteFromCollection(collection)}>{"\u2715"}</div>
            </div>
          );
        } catch(err) {
          contents = "[Error: unable to display terminal node]";
          console.error(contents + ': ' + err);
        }
        results.push({jsx: contents});
      } catch(err) {
        console.error("Error, no videos found in this terminal collection node. That should not happen (malformed collections object in library settings?): " + err);
      }
    }

    // if there were any collections returned from the level below,
    // or any videos found at this level, they will be in the results array;
    // place them within this collection and return them upward to the next level;
    // if (results.length > 0) {
    // if (true) {
      // if any results have their 'show' as positive
      // set show here to true
      for (const result of results) {
        if (result && result.show === true) {
          show = true;
          break;
        }
      }

      return {
        show: show,
        jsx: (
          <div key={collection.id} className="collection" id={"collection-" + collection.id} style={{display: show ? 'block' : 'none'}}>
            <div className="collection-header">
              <div className="collection-name">{collection.name}</div>
              {childrenOpts.length > 0 ? this.createAddCollectionBtn(collection.id) : null}
            </div>
            {childrenOpts.length > 0 ? this.createAddNodeForm(childrenOpts,collection) : null}
            <div className="children">
              {results.map((result,i) => {
                if (!result) return null;

                // console.log('child show ? ' + result.show);
                // figure out if this child is an older sister to any
                // other collections that are visible
                // (just so we can add a class for display purposes)
                let olderSister = false;
                for (let j=i+1; j<results.length; j++) {
                  if (results[j].show === true) {
                    olderSister = true;
                    break;
                  }
                }
                if (olderSister) {
                  // console.log("OLDER SISTER")
                  // then we're an older sister, and we want to display a vertical gradient border
                  // below ourselves, for which we have to add class 'older-sister' to the jsx
                  return React.cloneElement(result.jsx,
                    {
                      className : 'collection older-sister'
                    });
                }
                return result.jsx;
              })}
            </div>
          </div>
      )};
      // return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden">{results}</div></div>);
    // } else {
      // if there were no sub-collections found, or in the case of a terminal node,
      // if none of the videos was this video, return null
      // return null;
    // }
    // let vidsWereFound = false;
    // let videos = []
    // try {
    //   // if this collection contains our video
    //   for (let i=0; i<collection.videos.length; i++) {
    //     if (this.props.movies.filter(movie => (collection.videos[i].id === movie.id)).length > 0) {
    //       videos.push(object.videos[i]);
    //       vidsWereFound = true;
    //     }
    //   }
    // } catch(e) {
    //   console.log("Error, no videos found in this collection: " + e.toString());
    // }
    // // if the flag is true, that means there were videos from our playlist
    // // in this collection, so wrap them in JSX and return them upward
    // if (vidsWereFound) {
    //   // find only the movie objects (from the playlist) that match the videos found in this collection
    //   let movies = this.props.movies.filter(movie => (videos.filter(collectionVideo => (collectionVideo.id === movie.id)).length > 0))
    //   // console.log('movies: ' + JSON.stringify(movies) + '\nVideos from collection: ' + JSON.stringify(videos));
    //   try {
    //     // add the 'order' property to each movie for this collection
    //     // (making a deep copy of each movie object)
    //     movies = movies.map(movie => {
    //       const movieCopy = _.cloneDeep(movie); //JSON.parse(JSON.stringify(movie));
    //       movieCopy.order = videos.filter(collectionVideo => (collectionVideo.id === movieCopy.id))[0].order;
    //       // console.log(JSON.stringify(movieCopy));
    //       return movieCopy;
    //     });
    //     // console.log(JSON.stringify(movies))
    //   } catch(e) {
    //     console.log('Error assigning order to videos in collection ' + object.name + ': ' + e.toString());
    //   }
    //   // console.log(JSON.stringify(movies));
    //   // wrap the movies in the last collection div,
    //   // then hand them off to MynLibTable with an initial sort by 'order'
    //   return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden"><MynLibTable movies={movies} initialSort="order" showDetails={this.props.showDetails} /></div></div>)
    // } else {
    //   return null;
    // }
  }

  clearOrder(event, collection) {
    this.updateOrder('',findNearestOfClass(event.target,'collection-order').getElementsByTagName("input")[0],collection);
  }

  updateOrder(order, target, collection) {
    if (!collection) return;

    // let target = event.target;
    // let order = event.target.value;
    // order = !isNaN(Number(order)) && Number(order) !== 0 ? Number(order) : !isNaN(parseInt(order)) ? parseInt(order) : '';
    // order = !isNaN(Number(order)) ? Math.round(Number(order) * 10)/10 : '';
    console.log(order);
    let updated = _.cloneDeep(this.props.video.collections);
    // console.log("Before: " + JSON.stringify(updated));
    updated[collection.id] = order;
    // console.log("After: " + JSON.stringify(updated));
    this.update({collections: updated});

    if (this.props.validator.test(order)) {
      super.handleValidity(true,this.props.property,target);
    } else {
      super.handleValidity(false,this.props.property,target,this.props.validatorTip);
    }

    if (order !== '') {
      target.classList.add('filled');
    } else {
      target.classList.remove('filled');
    }
  }

  update(prop) {
    // hide the add forms
    Array.from(document.getElementById('editor-pane').getElementsByClassName('add-collection-form')).forEach(form => {form.style.display = 'none'});

    this.props.update(prop);
  }

  render() {
    let collections;
    // if (this.props.video.collections && Object.keys(this.props.video.collections).length > 0) {
      collections = this.createCollectionsMap();
    // } else {
    //   collections = (<div>[No Collections]</div>);
    // }

    // get list of top-level collections that this video does not belong within,
    // in order to display as dropdown options when the user clicks the top level + button
    let childrenOpts = this.props.collections.filter(collection => collection && Object.keys(this.props.video.collections).filter(key => key.split('-')[0] === collection.id).length == 0).map(collection => collection.name);

    return (
      <div className="top-level collection">
      <div className="collection-header">
        {childrenOpts.length > 0 ? this.createAddCollectionBtn(null) : null}
      </div>
      {childrenOpts.length > 0 ? this.createAddNodeForm(childrenOpts,null) : null}
      <div className="children">
        {collections}
      </div>
      </div>
    );
  }
}

// a wrapper for MynEditText that only shows the edit field when clicked
// (otherwise just shows the value), and takes a save function that's
// triggered when the user hits 'enter'
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
        <datalist className={listName}>
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

    ipcRenderer.on('editor-artwork-selected', (event, image) => {
      if (image) {
        this.update(image);
      } else {
        console.log("Unable to select file");
      }
    });

    /*ipcRenderer.on('downloaded', (event, response) => {
      if (response.success) {
        this.props.update({'artwork':response.message});
        console.log('Successfully downloaded artwork');
      } else {
        console.log("Unable to download file: " + response.message);
        this.update(this.props.placeholderImage);
      }

      // on finishing, whether successful or not,
      // hide message and show input field again
      try {
        this.input.current.style.visibility = 'visible';
      } catch(err) {
        console.error(err);
        try {
          document.getElementById('edit-field-artwork').style.visibility = 'visible';
        } catch(err1) {
          console.error(err1);
        }
      }
      try {
        this.dlMsg.current.style.display = 'none';
      } catch(err) {
        console.error(err);
        try {
          document.getElementById('edit-field-artwork-dl-msg').style.display = 'none';
        } catch(err1) {
          console.error(err1);
        }
      }

      this._isMounted && this.setState({message: ""});

    });*/

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

  download(url) {
    // hide the input element and display message while downloading
    this.input.current.style.visibility = 'hidden'
    this._isMounted && this.setState({message: "downloading"});
    this.dlMsg.current.style.display = 'block';

    // download
    this._isMounted && ipcRenderer.send('download', url, );
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
    // this.state.cancelDownload(); // in case there's a download in progress, cancel it
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
      this.download(this.props.movie.artwork);
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
          <input ref={this.input} type="text" id="edit-field-artwork" value={this.state.value || ""} placeholder="Paste path/URL" onChange={(e) => this.handleInput(e)} />
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
    let graphic = <li className="checkmark" onMouseOver={(e) => this.mouseOver(!this.props.movie[this.state.property],e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(!this.props.movie[this.state.property],e)}>{value ? "\u2714" : "\u2718"}</li>;
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
      property : "seen"
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
          {displayItem}
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
      <div id={this.state.id} className={"list-widget-add select-container " + (this.props.inline || "") + (this.props.options ? " select-hovericon" : "")}>
        <input type="text" list={listName} id={this.state.id + "-input"} className="list-widget-add-input" placeholder="Add..." value={this.state.value} minLength="1" onChange={(e) => this.handleInput(e)} />
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
        <MynEditAddToList object={this.props.object} property={this.props.property} update={this.props.update} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.props.validator} validatorTip={this.props.validatorTip} />
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

    ipcRenderer.on('editor-subtitle-selected', (event, subs) => {
      if (subs) {
        let update = [...this.props.object[this.props.property], ...subs];
        this.updateList(update);
      } else {
        console.log("Unable to select subtitle file(s): nothing returned from server");
      }
    });

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


  render() {
    return (
      <ul className={"list-widget-list browse subtitles"}>
        {this.displayList()}
        <li className='list-widget-add-with-browse'>
          <MynEditAddToList object={this.props.object} property={this.props.property} update={this.addToListUpdate} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.validator} validatorTip={this.validatorTip} />
          <button className='list-widget-browse editor-inline-button' onClick={() => ipcRenderer.send('editor-subtitle-select')}><div className='icon-container'></div></button>
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

  // given a video id,
  // find the next video (by order) in all of its collections;
  // return an array of objects, where each object is of the form
  // {
  //   v_id: next_video_id,
  //   c_id: collection_id,
  //   order: next_video_order
  // }
  findNextVideoInCollection(id) {
    let allCols = new Collections(this.props.collections);
    let ourVidCols = allCols.getVideoCollections(id);
    return Object.keys(ourVidCols).map(c_id => {
      let c = allCols.get(c_id);
      if (c) {
        let nextVidID = allCols.getNextVideo(c,ourVidCols[c_id]);

        // if we found a video and it exists in media (because it could be in inactive_media)
        if (nextVidID && library.media.filter(v => v.id === nextVidID).length > 0) {
          return {
            v_id:nextVidID,
            c_id:c_id,
            order: allCols.getVidOrder(c,nextVidID)
          }
        }
      }
    });
  }

  playNextVideo(vidInfo) {
    // vidInfo takes the form
    // {
    //   v_id: video_id,
    //   c_id: collection_id,
    //   order: video_order
    // }

    if (vidInfo) {
      console.log('playing next video');
      console.log(vidInfo);

      this.props.playVideo(vidInfo.v_id);

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
      this.state.list = this.props.list.map(id => {

        let video = library.media.filter(v => v.id === id);
        if (video.length > 0) {
          video = video[0];
        } else {
          return null;
        }

        // console.log(`Videos after ${video.title}`);
        // console.log(this.findNextVideoInCollection(id));

        // find the next video after this one in all its collections;
        // if the video isn't in any collections, or it's the last one in its collections,
        // we'll get an empty array;
        // for now, we're just going to link to ONE of the collections;
        // later, we'll need to offer the user a choice of which one
        let nextVidID = this.findNextVideoInCollection(id)[0];

        return (
          <div className='container'>
            <div className='video' onClick={() => this.props.playVideo(video.id)}>
              <div className='artwork' style={{backgroundImage:`url('${video.artwork ? URL.pathToFileURL(video.artwork) : URL.pathToFileURL(placeholderImage.replace(/^\.\.\//,''))}')`}} />
              <div className='title-position-container'>
                <div className='title'><MynOverflowTextMarquee text={video.title} /></div>
                {video.position > 0 ? <MynShowPositionWidget video={video} /> : null}
              </div>
            </div>
            <div className='next-btn' onClick={() => this.playNextVideo(nextVidID)}><img src='../images/ff-icon_white.png' title='Play next video in collection' alt='Icon by Font Awesome by Dave Gandy - https://fortawesome.github.com/Font-Awesome, CC BY-SA 3.0, https://commons.wikimedia.org/w/index.php?curid=24230861' /></div>
          </div>
        );
      });
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
    'collections':'object',
    'boxoffice':'number',
    'rated':'string',
    'languages':'array',
    'country':'string',
    'metadata':'object',
    'imdbID':'string',
    'autotag_tried':'boolean',
    'dvd':'boolean'
  };

  let vidProps = Object.keys(video);
  let propKeys = Object.keys(properties);
  for (const property of propKeys) {
    // if (vidProps.includes(property)) {
      // repair any malformed properties
      switch(properties[property]) {
        // ratings, collections, metadata
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
        // id, year, position, dateadded, lastseen
        case 'integer' :
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

// finds and returns a collection object in <collectionsRoot> from its id (<id>);
// if <copy> (a boolean) is true, return a copy instead of the original;
// <collectionsRoot> should be (optionally a copy of) the entire library.collections array;
function getCollectionObject(id, collectionsRoot, copy) {
  // initially set collections to the root of the master collections array
  // then we'll walk down the tree using the id, which is descriptive of the tree structure
  let collections = collectionsRoot;

  // split the id into an array that we can loop over
  const map = id.split('-');

  // find the collection object by traversing the id
  let result;
  try {
    map.map((nodeIndex, index) => {
      try {
        result = collections[nodeIndex];
        if (collections[nodeIndex].collections) {
          collections = collections[nodeIndex].collections;
        }
      } catch (err) {
        throw `Could not find collection object: failed at element ${index} of ${map}. ${err}`;
      }
    });
  } catch(err) {
    console.error(err);
    // in case of error, return nothing
    return;
  }

  // return the collection
  return copy ? _.cloneDeep(result) : result;
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
