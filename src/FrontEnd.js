const React = require('react');
const ReactDOM = require('react-dom');
const electron = require('electron');
const { ipcRenderer } = require('electron');
const _ = require('lodash');
const DateJS = require('datejs');
const URL = require("url").URL;
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const dl = require('./download');
const omdb = require('../omdb');
const axios = require('axios');
const accounting = require('accounting');
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
let savedPing = {};

class Mynda extends React.Component {
  constructor(props) {
    super(props)
    let library = this.props.library;
    this.state = {
      videos : library.media,
      playlists : library.playlists,
      collections : library.collections,
      settings: library.settings,

      filteredVideos : [], // list of videos to display: can be filtered by a playlist or a search query or whatever; this is what is displayed
      playlistVideos : [], // list of videos filtered by the playlist only; this is used to execute a search query on
      view : "flat", // whether to display a flat table or a hierarchical view
      detailId: null,
      detailMovie: {},
      currentPlaylistID : null,
      prevQuery: '',

      settingsPane: null,
      editorPane: null,
    }

    this.render = this.render.bind(this);
    this.playlistFilter = this.playlistFilter.bind(this);
    this.setPlaylist = this.setPlaylist.bind(this);
    this.search = this.search.bind(this);
    this.showDetails = this.showDetails.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    // this.showSettings = this.showSettings.bind(this);
    // this.hideSettings = this.hideSettings.bind(this);
  }

  displayColumnName(name) {
    const substitutions = {
      "ratings_user" : "rating",
      "dateadded" : "added",
      "lastseen" : "seen",
      "ratings_rt" : (<img src="../images/logos/rt-logo.png" />),
      "ratings_imdb" : (<img src="../images/logos/imdb-logo.png" />),
      "ratings_metacritic" : (<img src="../images/logos/metacritic-logo.png" />),
      "ratings_avg" : "avg rating",
      "boxoffice" : "box office",
      "languages" : "language",
      "duration" : "runtime",
    }

    let result = name;

    if (Object.keys(substitutions).includes(name)) {
      result = substitutions[name];
    }

    if (typeof result === 'string') {
      result = result.replace(/\b\w/g,(letter) => letter.toUpperCase());
    }

    return result;
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

  showDetails(id, e) {
    let detailMovie = {};
    try {
      detailMovie = this.state.filteredVideos.filter(video => video.id === id)[0]
    } catch(error) {
      console.log("Error: could not find video " + id)
    }
    this.setState({detailId: id, detailMovie: detailMovie});
  }

  // filter the movies we'll hand off to the table component
  // based on the given playlist
  playlistFilter(id) {
    let playlist;
    try {
      playlist = this.state.playlists.filter(playlist => playlist.id == id)[0]
    } catch(error) {
      console.log("Error: could not find playlist " + id + ", displaying first playlist")
      try {
        playlist = this.state.playlists[0] // display the first one
      } catch(error) {
        console.log("Error: no playlists found, displaying nothing")
        playlist = { "filterFunction" : "false" } // just display nothing
      }
    }
    let filteredVids = [];
    try {
      filteredVids = this.state.videos.filter(video => eval(playlist.filterFunction))
    } catch(err) {
      console.error(`Unable to execute filter for ${playlist.name} playlist: ${err}`);
    }
    return filteredVids;
  }

  // called from the nav component to change the current playlist
  setPlaylist(id,element) {
    if (!element) {
      element = document.getElementById("playlist-" + id);
    }
    let videos = this.playlistFilter(id);
    this.setState({playlistVideos : videos, filteredVideos : videos, view : this.state.playlists.filter(playlist => playlist.id == id)[0].view, currentPlaylistID : id})
    // this.setState({}); // filteredVideos is what is actually displayed
    Array.from(element.parentNode.children).map((child) => { child.classList.remove('selected') });
    element.classList.add('selected');
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

  showOpenablePane(name) {
    // apply 'blurred' class to all other panes
    Array.from(document.getElementsByClassName('pane')).map((pane) => {
      pane.classList.add('blurred');
    });

    let stateObj = {};
    switch(name) {
      case "settingsPane":
        stateObj[name] = <MynSettings settings={this.state.settings} playlists={this.state.playlists} collections={this.state.collections} displayColumnName={this.displayColumnName} hideFunction={() => {this.hideOpenablePane(name)}}/>
        break;
      case "editorPane":
        stateObj[name] = <MynEditor video={this.state.detailMovie} collections={this.state.collections} settings={this.state.settings} hideFunction={() => {this.hideOpenablePane(name)}}/>
        break;
    };
    this.setState(stateObj);
  }

  hideOpenablePane(name) {
    let stateObj = {};
    stateObj[name] = null;
    this.setState(stateObj);

    // remove 'blurred' class from all panes
    Array.from(document.getElementsByClassName('pane')).map((pane) => {
      pane.classList.remove('blurred');
    });
  }

  // set the initial playlist
  componentDidMount(props) {
    // this.loadLibrary();
    // let playlist = library.playlists[0];
    // this.setState({filteredVideos : this.playlistFilter(playlist.id), view : playlist.view})
    // this.setPlaylist(playlist.id, document.getElementById('nav-playlists').getElementsByTagName('li')[0]);
    try {
      document.getElementById('nav-playlists').getElementsByTagName('li')[0].click();
    } catch(e) {
      console.log("Error displaying first playlist: no playlists found? " + e.toString());
    }

    // this callback function will be executed by Library.js every time
    // something is saved. So here we must take any actions necessary to update
    // the view in real time whenever that happens
    savedPing.saved = (address) => {
      console.log('MYNDA KNOWS WE SAVED!!!, address is ' + address);

      // if a movie was changed
      if (address.includes('media')) {
        console.log('a video was edited')
        // update the currently displayed playlist
        this.setPlaylist(this.state.currentPlaylistID);
        // update movie in details pane (we don't know if this is the movie that was edited, but just in case)
        this.setState({detailMovie : this.state.videos.filter(video => video.id === this.state.detailMovie.id)[0]});
      }

      // if a playlist was changed
      if (address.includes('playlists')) {
        console.log('a playlist was edited')
        // reload the playlists, and then re-render the current playlist
        this.setState({playlists:this.props.library.playlists}, () => {
          this.setPlaylist(this.state.currentPlaylistID);
        });
      }

    };
  }

  componentDidUpdate(oldProps) {
    console.log('UPDATING MYNDA');
    console.log('lastUpdate: ' + this.props.lastUpdate);
    // console.log('results: ' + this.state.filteredVideos.map((video) => video.title));
    if (oldProps.lastUpdate !== this.props.lastUpdate) {
      console.log('Mynda props.library.media changed!!!');
      this.setPlaylist(this.state.currentPlaylistID);
    }
  }

  render () {
    return (
      <div id='grid-container'>
        <MynNav playlists={this.state.playlists} setPlaylist={this.setPlaylist} search={this.search} showSettings={() => {this.showOpenablePane("settingsPane")}}/>
        <MynLibrary movies={this.state.filteredVideos} collections={this.state.collections} view={this.state.view} displayColumnName={this.displayColumnName} showDetails={this.showDetails} />
        <MynDetails movie={this.state.detailMovie} showEditor={() => {this.showOpenablePane("editorPane")}}/>
        {this.state.settingsPane}
        {this.state.editorPane}
      </div>
    );
  }
}

// ###### Nav Pane: contains playlist tabs and search field ###### //
class MynNav extends React.Component {
  constructor(props) {
    super(props)

    this.render = this.render.bind(this);
  }

  clearSearch(e) {
    const input = document.getElementById("search-input");
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true })); // necessary to trigger the search function
  }

  render() {
    return (<div id="nav-pane" className="pane">
        <ul id="nav-playlists">
          {this.props.playlists.map((playlist, index) => {
            // if playlist is selected to be displayed in as a tab in the navbar
            if (playlist.tab) {
              return (<li key={playlist.id} id={"playlist-" + playlist.id} style={{zIndex: 9999 - index}} className={playlist.view} onClick={(e) => this.props.setPlaylist(playlist.id,e.target)}>{playlist.name}</li>);
            } else {
              // eventually we'll add the others to a dropdown/flyout menu
            }
          })}
        </ul>
        <div id="nav-controls">
          <div id="search-field" className="input-container controls"><span id="search-label">Search: </span><input id="search-input" className="empty" type="text" placeholder="Search..." onInput={(e) => this.props.search(e)} /><div id="search-clear-button" className="input-clear-button always" onClick={(e) => this.clearSearch(e)}></div></div>
          <div id="settings-button" className="controls" onClick={() => this.props.showSettings()}></div>
        </div>
      </div>)
  }
}



// ###### Library Pane: parent of MynLibTable, decides whether to display one table (in a flat view), or a hierarchy of tables (in the heirarchical view) ###### //
class MynLibrary extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      hierarchy : null
    }

    this.render = this.render.bind(this);
    this.createCollectionsMap = this.createCollectionsMap.bind(this);
    // this.findCollections = this.findCollections.bind(this);
  }

  componentDidUpdate(oldProps) {
    // if (oldProps.movies !== this.props.movies) {
    //   // erase the top-level 'order' property added on any previous render,
    //   // so that on this update we can add them only if we need them
    //   this.props.movies.map(movie => {
    //     if (movie.order !== undefined) {
    //       movie.order = null
    //     }
    //   });
    // }
  }

  createCollectionsMap() {
    console.log("Creating new collections map");
    this.state.hierarchy = this.props.collections.map(collection => (this.findCollections(collection)));
  }

  // recursive function that walks down the collections and returns each branch
  // as JSX if and only if it contains one of the movies in our playlist
  findCollections(object) {
    // if this object contains sub-collections
    if (object.collections) {
      let results = []
      // loop through the subcollections and call ourselves recursively on each one
      for (let i=0; i<object.collections.length; i++) {
        let jsx = this.findCollections(object.collections[i]);
        // if jsx is not null, that means the recursive call returned some JSX
        // containing collections with movies from our playlist
        if (jsx !== null) {
          results.push(jsx);
        }
      }
      // if there were any videos returned from the level below,
      // wrap them in a div and return them upward to the next level
      if (results.length > 0) {
        return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden">{results}</div></div>);
      } else {
        return null;
      }
    } else {
      // we're at a bottom-level collection
      let vidsWereFound = false;
      let videos = []
      try {
        // if this collection has a video in our playlist
        for (let i=0; i<object.videos.length; i++) {
          if (this.props.movies.filter(movie => (object.videos[i].id === movie.id)).length > 0) {
            videos.push(object.videos[i]);
            vidsWereFound = true;
          }
        }
      } catch(e) {
        console.log("Error, no videos found in this collection: " + e.toString());
      }
      // if the flag is true, that means there were videos from our playlist
      // in this collection, so wrap them in JSX and return them upward
      if (vidsWereFound) {
        // find only the movie objects (from the playlist) that match the videos found in this collection
        let movies = this.props.movies.filter(movie => (videos.filter(collectionVideo => (collectionVideo.id === movie.id)).length > 0))
        // console.log('movies: ' + JSON.stringify(movies) + '\nVideos from collection: ' + JSON.stringify(videos));
        try {
          // add the 'order' property to each movie for this collection
          // (making a deep copy of each movie object)
          movies = movies.map(movie => {
            const movieCopy = _.cloneDeep(movie); //JSON.parse(JSON.stringify(movie));
            movieCopy.order = videos.filter(collectionVideo => (collectionVideo.id === movieCopy.id))[0].order;
            // console.log(JSON.stringify(movieCopy));
            return movieCopy;
          });
          // console.log(JSON.stringify(movies))
        } catch(e) {
          console.log('Error assigning order to videos in collection ' + object.name + ': ' + e.toString());
        }
        // console.log(JSON.stringify(movies));
        // wrap the movies in the last collection div,
        // then hand them off to MynLibTable with an initial sort by 'order'
        return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden"><MynLibTable movies={movies} initialSort="order" displayColumnName={this.props.displayColumnName} showDetails={this.props.showDetails} /></div></div>)
      } else {
        return null;
      }
    }
  }

  toggleExpansion(e) {
    let element = e.target;
    // let siblings = Array.from(element.parentNode.childNodes).filter(node => (node !== e.target));
    // siblings.map(node => (node.classList.toggle("hidden")));
    let childrenContainer = element.parentNode.getElementsByClassName("container")[0]
    childrenContainer.classList.toggle("hidden");
    element.parentNode.classList.toggle("expanded");
    element.parentNode.classList.toggle("collapsed");
  }

  render() {
    let content = null;
    if (this.props.view === "hierarchical") {
      this.createCollectionsMap();

      content = (<div id="collections-container">{this.state.hierarchy}</div>)

    } else if (this.props.view === "flat") {

      content = (<MynLibTable movies={this.props.movies} view={this.props.view} displayColumnName={this.props.displayColumnName} showDetails={this.props.showDetails} />)

    } else {
      console.log('Playlist has bad "view" parameter ("' + this.props.view + '"). Should be "flat" or "hierarchical"');
      return null
    }
    return (<div id="library-pane" className="pane">{content}</div>);
  }
}

// ###### Table: contains list of movies in the selected playlist ###### //
class MynLibTable extends React.Component {
  constructor(props) {
    super(props)
    this.render = this.render.bind(this);

    this.state = {
      sortKey: null,
      sortAscending: true,
      sortedRows: [],
      displayOrderColumn: "table-cell"
    }

    this.requestSort = this.requestSort.bind(this);
    this.onChange = this.onChange.bind(this);
    this.render = this.render.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.componentDidUpdate = this.componentDidUpdate.bind(this);

    ipcRenderer.on('save-video-confirm', (event, response, changes, originalVid) => {
      if (response === 0) { // yes
        // save video to library
        let updated = { ...originalVid, ...changes };
        let index = library.media.findIndex((video) => video.id === updated.id);
        library.replace("media." + index, updated);
      } else {
        console.log('Edit cancelled by user')
      }
    });
  }

  rowHovered(id, e) {
    // show details in details pane
    this.props.showDetails(id, e);
  }

  rowOut(id, e) {
    // hide details in details pane
    // this.props.showDetails(null, e);
  }

  titleHovered(e) {
    // console.log("enter");
    e.stopPropagation();
    // detect if the movie title is too long for the table cell
    // and if so, add the 'overflow' class during mouseover
    // so the css can show the whole thing, however it wants to handle that
    // if (e.target.tagName == 'TD') { // only execute on the title cell, not the title text container within it
    //   let titleDiv = e.target.getElementsByClassName("table-title-text")[0];
    //   if (titleDiv.offsetWidth < titleDiv.scrollWidth) { // text is overflowing
    //     titleDiv.classList.add('overflow');
    //   }
    // }
  }

  titleOut(e) {
    // console.log("leave");
    e.stopPropagation();
    // // remove the 'overflow' class in case it was added
    // if (e.target.tagName == 'TD') { // only execute on the title cell, not the title text container within it
    //   let titleDiv = e.target.getElementsByClassName("table-title-text")[0];
    //   titleDiv.classList.remove('overflow');
    // }
  }

  requestSort(key) {
    // the default direction of a sort is ascending
    let ascending = true;

    // except for the following fields, which should have a default sort direction of descending
    let descendingFields = ['ratings_user','dateadded'];
    if (descendingFields.includes(key)) {
      ascending = false;
    }

    // if the user clicked on the same column that was previously sorted by,
    // then we override the defaults and just reverse the sort direction of the previous sort
    if (this.state.sortKey === key) {
     ascending = !this.state.sortAscending;
    }

    let sortFunctions = {
     title: (a, b) => this.removeArticle(a.title) > this.removeArticle(b.title),
     year: (a, b) => a.year > b.year,
     director: (a, b) => a.directorsort > b.directorsort,
     genre: (a, b) => a.genre > b.genre,
     seen: (a, b) => a.seen > b.seen,
     ratings_user: (a, b) => a.ratings.user > b.ratings.user,
     dateadded: (a, b) => parseInt(a.dateadded) > parseInt(b.dateadded),
     order: (a, b) => a.order > b.order
    }

    let rows = this.props.movies.sort((a, b) => {

      let result = sortFunctions[key](a, b) ? 1 : -1;
      result *= ascending ? 1 : -1;

      return result;
    }).map((movie) => {
      let displaydate = new Date(movie.dateadded * 1000)
      displaydate = displaydate.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
      // let seenmark = movie.seen ? "\u2714" : "\u2718"

      // if (movie.order === undefined) {
      //   movie.order = null;
      // }

      return (
        <tr className="movie-row" key={movie.id} onMouseOver={(e) => this.rowHovered(movie.id,e)} onMouseOut={(e) => this.rowOut(movie.id,e)}>
          <td className="order" style={{display:this.state.displayOrderColumn}}>{movie.order}</td>
          <td className="title" onMouseEnter={(e) => this.titleHovered(e)} onMouseLeave={(e) => this.titleOut(e)}><div className="table-title-text">{movie.title}</div></td>
          <td className="year centered mono">{movie.year}</td>
          <td className="director">{movie.director}</td>
          <td className="genre">{movie.genre}</td>
          <td className="seen centered"><MynEditSeenWidget movie={movie} update={(...args) => this.saveEdited(movie, ...args)} /></td>
          <td className="ratings_user centered"><MynEditRatingWidget movie={movie} update={(...args) => this.saveEdited(movie, ...args)} /></td>
          <td className="dateadded centered mono">{displaydate}</td>
        </tr>
    )});

    this.setState({ sortKey: key, sortAscending: ascending , sortedRows: rows});
  }

  onChange() {


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

    // set initial sort
    this.state.sortKey = null;
    try {
      this.requestSort(this.props.initialSort);
    } catch(e) {
      // console.log('No initial sort parameter, sorting by title');
      this.requestSort('title');
    }
  }

  removeArticle(string) {
    return string.replace(/^(?:a\s|the\s)/i,"")
  }

  saveEdited(originalVid, ...args) {
    console.log('save-edited!!!');
    let changes = {};
    if (args.length == 2 && typeof args[0] === "string") {
      changes[args[0]] = args[1];
    } else if (args.length == 1 && typeof args[0] === "object") {
      changes = args[0];
    } else {
      throw 'Incorrect parameters passed to saveEdited in MynLibTable';
    }
    console.log('changes == ' + JSON.stringify(changes));

    // user confirmation dialog
    ipcRenderer.send('save-video-confirm', changes, originalVid);

  }

  componentDidMount(props) {
    // this.props.movies.map(movie => console.log(JSON.stringify(movie)));
    this.onChange();
  }

  componentDidUpdate(oldProps) {
    console.log('UPDATING MynTable');
    // if (oldProps.movies !== this.props.movies) {
    if (!_.isEqual(oldProps.movies,this.props.movies)) {
      console.log('MynTable props changed!!!');
      this.onChange();

    }

    // set the width of each OVERFLOWING title div to the width of the content minus the width of the actual cell
    // so that when the CSS marquee scrolls to 100%, that means it will scroll just enough to show the end of the text;
    // and give it the 'overflow' class so the css can scroll it (or whatever it wants to do)
    Array.from(document.getElementsByClassName('movie-table')).map((table) => {
      Array.from(table.getElementsByClassName('table-title-text')).map((titleDiv) => {
        // if (titleDiv.innerHTML == 'The Adventures of Buckaroo Banzai Across the 8th Dimension') {
        // if (titleDiv.innerHTML == 'The Matrix') {
        //   console.log(titleDiv.innerHTML);
        //   console.log('parent offsetWidth: ' + titleDiv.parentNode.offsetWidth);
        //   console.log('self offsetWidth: ' + titleDiv.offsetWidth);
        //   console.log('scrollWidth: ' + titleDiv.scrollWidth);
        // }

         // text is overflowing
        if (titleDiv.parentNode.offsetWidth < titleDiv.scrollWidth) {// && !/\boverflow\b/.test(titleDiv.className)) {
          // console.log('--found overflowing title: ' + titleDiv.innerHTML);
          titleDiv.style.marginRight = titleDiv.parentNode.offsetWidth; // necessary to force the parent element (the <td>) to stay wide; otherwise if this is the only overflowing row, the <td> will shrink if we don't add this margin
          titleDiv.style.width = titleDiv.scrollWidth - titleDiv.parentNode.offsetWidth;

          titleDiv.classList.add('overflow');
        }

        // console.log('width: ' + titleDiv.style.width);
      });
    });

  }

  render() {
    return  (<table className="movie-table">
              <thead>
                <tr id="main-table-header-row">
                  <th onClick={() => this.requestSort('order')} style={{display:this.state.displayOrderColumn}}>#</th>
                  <th onClick={() => this.requestSort('title')}>{this.props.displayColumnName('title')}</th>
                  <th onClick={() => this.requestSort('year')}>Year</th>
                  <th onClick={() => this.requestSort('director')}>Director</th>
                  <th onClick={() => this.requestSort('genre')}>Genre</th>
                  <th onClick={() => this.requestSort('seen')}>Seen</th>
                  <th onClick={() => this.requestSort('ratings_user')}>Rating</th>
                  <th onClick={() => this.requestSort('dateadded')}>Added</th>
                </tr>
              </thead>
              <tbody>
                {this.state.sortedRows}
              </tbody>
            </table>)
  }
}

// ###### Details Pane: contains details of the hovered/clicked video ###### //
class MynDetails extends React.Component {
  constructor(props) {
    super(props)

    this.render = this.render.bind(this);

  }

  lastseenDisplayDate(lastseen) {
    let date;
    let displaydate = "";
    if (lastseen === null) {
      return "(never)";
    }
    try {
      date = new Date(parseInt(lastseen) * 1000);
      displaydate = date.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
    } catch(e) {
      console.log("MynDetails: could not resolve date for lastseen: " + e.toString());
      displaydate = "";
    }
    return displaydate;
  }

  // if the title text overflows its container,
  // set up title div with the appropriate width and class name for the css to apply a marquee effect
  setTitleMarquee() {
    try {
      let titleDiv = document.getElementById('detail-title').getElementsByClassName('detail-title-text')[0];
      // titleDiv.style.width = '100%';
      titleDiv.style.width = window.getComputedStyle(titleDiv.parentNode, null).getPropertyValue('width');
      let computed = window.getComputedStyle(titleDiv, null);
      // console.log(titleDiv.innerHTML);
      // console.log('width: ' + titleDiv.style.width);
      // console.log('actual width: ' + computed.getPropertyValue('width'));
      // console.log('offsetWidth: ' + titleDiv.offsetWidth);
      // console.log('scrollWidth: ' + titleDiv.scrollWidth);
      // console.log('getBoundingClientRect().width: ' + titleDiv.getBoundingClientRect().width);
      // console.log('padding: ' + computed.getPropertyValue('padding-left') + computed.getPropertyValue('padding-left'));
      // console.log('font-size: ' + computed.getPropertyValue('font-size'));
      // console.log('margin-right: ' + computed.getPropertyValue('margin-right'));

      if (titleDiv.offsetWidth < titleDiv.scrollWidth) { // text is overflowing
        titleDiv.style.width = titleDiv.scrollWidth - titleDiv.offsetWidth;
        titleDiv.classList.add('overflow');
      } else {
        titleDiv.classList.remove('overflow');
      }

      // console.log('new width: ' + titleDiv.style.width);
    } catch(e) {

    }
  }

  componentDidUpdate(oldProps) {
    this.setTitleMarquee();
  }

  componentDidMount() {
    // this.setTitleMarquee();
  }

  render() {
    let details;
    let editBtn = (<div id="edit-button" onClick={() => this.props.showEditor()}>Edit</div>);

    try {
      const movie = this.props.movie
      details = (
        <ul>
          <li className="detail" id="detail-artwork"><img src={movie.artwork} /></li>
          <li className="detail" id="detail-title"><div className="detail-title-text">{movie.title}</div></li>
          <li className="detail" id="detail-position"><MynEditPositionWidget movie={movie} /></li>
          <li className="detail" id="detail-description">{movie.description}</li>
          <li className="detail" id="detail-director"><span className="label">Director:</span> {movie.director}</li>
          <li className="detail" id="detail-cast"><span className="label">Cast:</span> {movie.cast.join(", ")}</li>
          <li className="detail" id="detail-tags"><span className="label">Tags:</span> {movie.tags.map((tag) => <span key={tag}>{tag} </span>)}</li>
          <li className="detail" id="detail-lastseen"><span className="label">Last Seen:</span> {this.lastseenDisplayDate(movie.lastseen)}</li>
        </ul>
      );
    } catch (error) {
      // eventually we'll put some kind of better placeholder here
      details = <div>No Details</div>
      // console.log(error.toString());

      if (!isValidVideo(this.props.movie)) {
        details = null;
        editBtn = null;
      }
    }

    return  (
      <aside id="details-pane" className="pane">
        {editBtn}
        {details}
      </aside>
    )
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

  // child class must supply 'content' variable when calling super.render()
  render(content) {
    return (
      <div id={this.state.paneID} className="pane openable-pane">
        <div className="openable-close-btn" onClick={() => this.props.hideFunction(this.state.paneID)}>{"\u2715"}</div>
        {content}
      </div>
    );
  }
}

// ###### Settings Pane: allows user to edit settings. Only appears when user clicks to open it ###### //
class MynSettings extends MynOpenablePane {
  constructor(props) {
    super(props)

    this.save = this.save.bind(this);

    this.state = {
      paneID: 'settings-pane',

      views: {
        folders :     (<MynSettingsFolders      save={this.save} folders={this.props.settings.watchfolders} kinds={this.props.settings.used.kinds} />),
        playlists :   (<MynSettingsPlaylists    save={this.save} playlists={this.props.playlists} />),
        collections : (<MynSettingsCollections  save={this.save} collections={this.props.collections} />),
        // themes :      (<MynSettingsThemes       save={this.save} themes={this.props.settings.themes} />),
        preferences :     (<MynSettingsPrefs      save={this.save} settings={this.props.settings} />)
      },
      settingView: null,
      delaySave: false,
      timer: null
    }

  }

  save(saveObj) {
    // if the timer is already running
    if (this.state.timer !== null) {
      // cancel the old timer before we set a new one
      clearTimeout(this.state.timer);
    }

    // set new delay timer
    console.log('Setting new timer...');
    this.state.timer = setTimeout(() => {
      console.log('Timer ended; saving');

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
    this.setState({settingView : this.state.views[view]});

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
      console.log('There was an error updating classes for the settings tabs: ' + e.toString());
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
        console.log('Unable to add "selected" class to tab in settings component: ' + e.toString());
      }
    }
    try {
      element.classList.add("selected");
    } catch(e) {
    }
  }

  createContentJSX() {
    const tabs = [];
    Object.keys(this.state.views).forEach((tab,i) => {
      tabs.push(<li key={tab} id={"settings-tab-" + tab} className="tab" onClick={(e) => this.setView(tab,e,i)}>{tab.replace(/\b\w/g,(letter) => letter.toUpperCase())}</li>)
    });

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
    // set the view to the 'folders' tab
    this.setView('folders');
  }

  componentDidUpdate(props) {
  }

  render() {
    return super.render(this.createContentJSX());
  }
}

// <li onClick={() => this.setView("folders")}>Folders</li>
// <li onClick={() => this.setView("themes")}>Themes</li>


class MynSettingsFolders extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      existingFolders : [],
      folderToAdd: null
    }

    ipcRenderer.on('settings-watchfolder-selected', (event, args) => {
      this.changeTargetFolder(args);
    });

    ipcRenderer.on('settings-watchfolder-add-error', (event, args) => {
      
    });
  }

  // create JSX for an options dropdown of the possible media kinds
  formFieldKindOptions() {
    let options;
    try {
      options = this.props.kinds.map((kind) => (
        <option key={kind} value={kind}>{kind.replace(/\b\w/g,(letter) => letter.toUpperCase())}</option>
      ));
      options.unshift(<option key="none" value="none">(none)</option>);
    } catch(e) {
      console.log("Unable to find list of media kinds in library: " + e.toString());
      // should display error message to user
    }
    return options;
  }

  editRemove(path, index) {
    console.log("user wants to remove " + path + " which is at index " + index);
  }

  editKind(event, index) {
    console.log("user wants to change 'kind' to " + event.target.value + " for folder at index " + index);
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
    console.log(submitObject);
    ipcRenderer.send('settings-watchfolder-add', submitObject);
  }

  displayFolders() {
    let folders;
    try {
      folders = this.state.existingFolders.map((folder, index) => (
        <tr key={index}>
          <td className='path'>{folder.path}</td>
          <td>
            <span className='select-container select-alwaysicon'>
              <select value={folder.defaults.kind} onChange={(e) => this.editKind(e,index)}>{this.formFieldKindOptions()}</select>
            </span>
          </td>
          <td><button onClick={() => this.editRemove(folder.path, index)}>Remove</button></td>
        </tr>
      ));
    } catch(e) {
      console.log("Error finding watchfolders from library: " + e.toString());
    }
    return folders;
  }

  componentDidMount() {
    this.setState({existingFolders: this.props.folders})
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
            <button onClick={() => ipcRenderer.send('settings-watchfolder-select')}>Browse</button>
            <button onClick={this.submitFolderToServer}>Add</button>
          </div>
        </div>

        <div id="settings-folders-folders" className='subsection'>
          <h2>Watchfolders</h2>
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Default Kind</th>
                <th>Remove</th>
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

    ipcRenderer.on('generic-confirm', (event, response, id) => {
      if (response === 0) { // yes
        // delete playlist
        let playlists = _.cloneDeep(this.state.playlists).filter(playlist => playlist.id !== id);
        this.setState({playlists:playlists}, () => {
          this.updateValue(); // force a save to the library
        });
      } else {
        console.log('Deletion cancelled by user')
      }
    });

    this.updateValue = this.updateValue.bind(this);
    this.reportValid = this.reportValid.bind(this);
    this.showEditPlaylistFilter = this.showEditPlaylistFilter.bind(this);
    this.deletePlaylist = this.deletePlaylist.bind(this);
    this.addPlaylist = this.addPlaylist.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
  }

  updateValue(index,prop,value) {
    console.log(`Updating ${index}: ${prop} = ${value}`);
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

  showEditPlaylistFilter(playlist) {
    let editField = document.getElementById('edit-filter-field-' + playlist.id);
    if (editField.style.display === 'none') {
      editField.style.display = 'block';
    } else {
      editField.style.display = 'none';
    }
  }

  deletePlaylist(playlist) {
    let playlistName = playlist.name != '' ? `the '${playlist.name}' playlist` : 'this playlist'
    ipcRenderer.send('generic-confirm', `Are you sure you want to delete ${playlistName}?`, playlist.id);
  }

  addPlaylist() {
    let newPlaylist = {
      id : uuidv4(),
      name : "",
      filterFunction : "false",
      view : "flat",
      tab : true
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
    console.log(JSON.stringify(this.state.playlists));

    let playlists = this.state.playlists.map((playlist,i) => (
      <Draggable key={playlist.id} draggableId={'' + playlist.id} index={i}>
        {(provided) => (
          <MynSettingsPlaylistsTableRow
            playlist={playlist}
            index={i}
            updateValue={this.updateValue}
            showEditPlaylistFilter={this.showEditPlaylistFilter}
            deletePlaylist={this.deletePlaylist}
            reportValid={this.reportValid}
            innerRef={provided.innerRef}
            provided={provided}
          />
        )}
      </Draggable>
    ));

    // add a divider at the end of the tab==true playlists
    // for (let i=0; i<this.state.playlists.length; i++) {
    //   if (this.state.playlists[i-1] && !this.state.playlists[i].tab && this.state.playlists[i-1].tab) {
    //     playlists.splice(i,0,(<tr id='settings-playlists-rowdivider' key='-1'><td/><td/><td/><td/><td/><td/></tr>));
    //   }
    // }

    return (
      <div id='settings-playlists'>
        <DragDropContext onDragEnd={this.onDragEnd}>
          <table id='settings-playlists-table'>
            <thead>
              <tr>
                <th></th>
                <th title="Checked playlists will display as tabs. Unchecked playlists will only appear in the dropdown">Tab</th>
                <th>Name</th>
                <th title="Flat view displays items as a simple list. Hierarchical view displays items as a collections tree.">View</th>
                <th></th>
                <th><button onClick={() => this.addPlaylist()}>Add...</button></th>
              </tr>
            </thead>
              <Droppable droppableId='settings-playlist-table'>
                {(provided) => (
                  <tbody ref={provided.innerRef} {...provided.droppableProps}>
                    {playlists}
                    {provided.placeholder}
                  </tbody>
                )}
              </Droppable>
          </table>
        </DragDropContext>
      </div>
    );
  }
}

class MynSettingsPrefs extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      defCols : {
        used : _.cloneDeep(props.settings.preferences.defaultcolumns.used),
        unused : _.cloneDeep(props.settings.preferences.defaultcolumns.unused)
      },
      hideDescrip : props.settings.preferences.hidedescription
    }
  }

  render() {
    return (
      <div id='settings-preferences'>
        <ul>
          <li id='settings-prefs-cols' className='subsection'>Default Columns for new playlists:
            <MynSettingsColumns used={this.state.defCols.used} unused={this.state.defCols.unused} />
          </li>
          <li id='settings-prefs-hidedescrip' className='subsection'>Hide video plot descriptions</li>
        </ul>
      </div>
    );
  }
}

class MynSettingsColumns extends React.Component {
  constructor(props) {
    super(props);

    this.onDragEnd = this.onDragEnd.bind(this);
  }

  onDragEnd(result) {
    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      // move the item
      const movedItems = this.props[source.droppableId].splice(source.index,1);
      this.props[destination.droppableId].splice(destination.index, 0, movedItems[0]);
    }
  }

  render() {
    return (
      <DragDropContext onDragEnd={this.onDragEnd}>
        <div>
          <Droppable droppableId='used'>
            {(provided) => (
              <ul className="columns-list used" ref={provided.innerRef} {...provided.droppableProps}>
                {this.props.used.map((col,i) => (
                  <Draggable key={col} draggableId={col} index={i}>
                    {(provided) => (
                      <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{col}</li>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </ul>
            )}
          </Droppable>
          <Droppable droppableId='unused'>
          {(provided) => (
            <ul className="columns-list unused" ref={provided.innerRef} {...provided.droppableProps}>
              {this.props.unused.map((col,i) => (
                <Draggable key={col} draggableId={col} index={i}>
                  {(provided) => (
                    <li ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{col}</li>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </ul>
          )}
          </Droppable>
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

    return (
      <tr id={'settings-playlists-row-' + playlist.id} ref={this.props.innerRef} {...this.props.provided.draggableProps}>
        <td className='drag-button' {...this.props.provided.dragHandleProps}>{'\u2630'}</td>
        <td className='checkbox'><input type='checkbox' checked={playlist.tab} onChange={(e) => this.props.updateValue(this.props.index,'tab',e.target.checked)} /></td>
        <td className='name-and-filter'>
          <MynEditText
            object={playlist}
            property='name'
            update={(...args) => this.props.updateValue(this.props.index,...args)}
            options={null}
            validator={/[^\s]/}
            validatorTip={'At least 1 non-whitespace character'}
            allowedEmpty={false}
            reportValid={this.props.reportValid}
          />
          <div id={'edit-filter-field-' + playlist.id} style={{display: 'none'}}>
            Filter:
            <textarea
              className='edit-filter-field'
              name="playlist filter"
              value={playlist.filterFunction}
              placeholder={'Enter a boolean expression to be executed on each video object: e.g. video.genre === \'Action\''}
              onChange={(e) => this.props.updateValue(this.props.index,'filterFunction',e.target.value)}
            />
          </div>
        </td>
        <td className='view'>
          <div className='select-container select-alwaysicon'>
            <select value={playlist.view} onChange={(e) => this.props.updateValue(this.props.index,'view',e.target.value)}>
              <option value='flat'>Flat</option>
              <option value='hierarchical'>Hierarchical</option>
            </select>
          </div>
        </td>
        <td>
          <button onClick={() => this.props.showEditPlaylistFilter(playlist)}>Edit</button>
        </td>
        <td>
          <button onClick={() => this.props.deletePlaylist(playlist)}>Delete</button>
        </td>
      </tr>
    );
  }
}

class MynSettingsCollections extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    return (<h1>I'm a Collections!!!</h1>)
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
      video: _.cloneDeep(props.video),
      collections: _.cloneDeep(props.collections),
      placeholderImage: "../images/qmark.png",
      valid: {}
    }

    this.render = this.render.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.revertChanges = this.revertChanges.bind(this);
    this.saveChanges = this.saveChanges.bind(this);
    this.reportValid = this.reportValid.bind(this);
  }

  reportValid(property,valid) {
    if (typeof valid === 'boolean') {
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
    if (args.length == 2 && typeof args[0] === "string") {
      update = this.state.video;
      update[args[0]] = args[1];
    } else if (args.length == 1 && typeof args[0] === "object") {
      update = { ...this.state.video, ...args[0] };
    } else {
      throw 'Incorrect parameters passed to handleChange in MynEditor';
    }

    this._isMounted && this.setState({video : update});

    // in addition to updating the video object, in the special case that the collections were changed,
    // we need to update the master collections object in library.settings
    if (args[0] == "collections" || args[0].collections) { // collections was updated
      // console.log("args[0] == " + JSON.stringify(args[0]));
      const collectionUpdate = args[1] || args[0].collections;
      // console.log("collectionUpdate == " + JSON.stringify(collectionUpdate));
      // console.log("original collections == " + JSON.stringify(this.state.video.collections));

      let collectionsCopy = _.cloneDeep(this.state.collections);

      // add video to any new collections
      const addedIDs = Object.keys(collectionUpdate).filter((key) => !Object.keys(this.state.video.collections).includes(key));
      // console.log(`addedIDs == ${addedIDs}`);
      for (const id of addedIDs) {
        let collection = getCollectionObject(id, collectionsCopy, false);
        if (collection) {
          collection.videos.push({
            id: this.state.video.id,
            order: collectionUpdate[id]
          });
        } else {
          console.error(`Unable to add ${this.state.video.title} to collection ${id}. Unable to retrieve collection object from that id.`);
        }
      }

      // delete video from any deleted collections
      Object.keys(this.state.video.collections).forEach((id) => {
        if (!Object.keys(collectionUpdate).includes(id)) {
          let collection = getCollectionObject(id, collectionsCopy, false);
          if (collection) {
            collection.videos = collection.videos.filter(video => video.id !== this.state.video.id);
          } else {
            console.error(`Unable to remove ${this.state.video.title} from collection ${id}. Unable to retrieve collection object from that id.`);
          }
        }
      });

      // console.log("collections after change: " + JSON.stringify(collectionsCopy));
      this._isMounted && this.setState({collections : collectionsCopy});
    }
  }

  revertChanges(event) {
    // console.log('reverting...');
    event.preventDefault();
    this._isMounted && this.setState(
      {
        video : _.cloneDeep(this.props.video),
        collections : _.cloneDeep(this.props.collections)
      }
    );
  }

  saveChanges(event) {
    event.preventDefault();

    /* make sure all the fields are valid before submitting */
    // console.log(JSON.stringify(this.state.valid));
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
    if (this._isMounted) {
      const artworkFolder = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork');
      const newArtworkPath = path.join(artworkFolder, uuidv4() + this.state.video.artwork.match(/.\w{3,4}$/)[0]);
      const oldArtworkPath = path.resolve(__dirname, this.state.video.artwork); // create the correct absolute path, in case it was a relative one
      fs.copyFile(oldArtworkPath, newArtworkPath, (err) => {
        if (err) {
          console.error(err);
        } else {
          console.log('artwork was copied successfully: ' + newArtworkPath);
        }
      });
      this.handleChange({'artwork':newArtworkPath});
      // console.log("updated state var: " + this.state.video.artwork);
    }

    /* Submit */
    // console.log('saving...');

    // first, save the video data in library.media
    let index = library.media.findIndex((video) => video.id === this.props.video.id);
    library.replace("media." + index, this.state.video);

    // then, if any collections were changed, save the collections object in library.collections
    if (!_.isEqual(this.props.collections,this.state.collections)) {
      library.replace("collections", this.state.collections);
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
          placeholderImage={this.state.placeholderImage}
          handleChange={this.handleChange}
        />

        <MynEditorEdit
          video={this.state.video}
          collections={this.state.collections}
          settings={this.props.settings}
          handleChange={this.handleChange}
          revertChanges={this.revertChanges}
          saveChanges={this.saveChanges}
          placeholderImage={this.state.placeholderImage}
          reportValid={this.reportValid}
        />
      </div>
    );
  }

  render() {
    return super.render(this.createContentJSX());
  }

}

class MynEditorSearch extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      results: null,
      searchBaseURL: `http://www.omdbapi.com/?apikey=${omdb.key}`,
      searching: false
    }

    this.handleSearch = this.handleSearch.bind(this);
    this.clearSearch = this.clearSearch.bind(this);
    this.render = this.render.bind(this);
  }

  // search online movie database to auto-fill fields
  handleSearch(event) {
    event.preventDefault();

    // we want to query the database using the existing field values
    // of the movie object, if present;
    // if the title field is empty, we will substitute the file name
    const filename = this.props.video.filename.match(/[^/]+(?=\.\w{2,4}$)/)[0]; // get just the filename from the path
    console.log('filename: ' + filename);
    const titleQuery = this.props.video.title !== '' ? this.props.video.title : filename;
    const yearQuery = this.props.video.year !== '' ? this.props.video.year : null
    const typeQuery = this.props.video.kind === 'movie' ? 'movie' : this.props.video.kind === 'show' ? 'episode' : null;

    // compose query url
    let urlParts = [this.state.searchBaseURL];
    urlParts.push(`s=${titleQuery}`);
    if (yearQuery) urlParts.push(`y=${yearQuery}`);
    if (typeQuery) urlParts.push(`type=${typeQuery}`);

    // execute query
    this.executeSearchQuery(urlParts);
  }

  executeSearchQuery(urlParts) {
    this.setState({searching:true});
    axios({
      method: 'get',
      url: urlParts.join('&'),
      timeout: 20000,
    })
      .then((response) => {
        console.log(urlParts.join('&'));

        if (response.status !== 200) {
          return console.log(response.status + ': ' + response.statusText);
        }

        // if we didn't get any results, try again with fewer search parameters
        if (response.data.Response == "False" && urlParts.length > 2) {
          console.log('nothing found, trying again with less');
          this.executeSearchQuery(urlParts.slice(0, -1));
          return;
        }

        this.handleSearchResults(response.data);
      })
      .catch((error) => {
        this.handleSearchResults({Error:error});
        return;
      })
      .then(() => {
        // always executed
      });
  }

  handleSearchResults(results) {
    this.setState({searching:false});
    if (!results.hasOwnProperty('Response')) {
      // then there was an error getting the search results;
      // during testing, just use an alert to tell the user
      // and clear the previous results
      this.clearSearch();
      alert('Error getting search results: ' + results.Error);
    } else if (results.Response === 'False' || !results.hasOwnProperty('Search')) {
      // then there were no results found
      // during testing, just use an alert to tell the user
      this.setState({results:null});
      alert('No results found! Try editing the title and searching again.');
    } else {
      console.log(results);
      // display search results
      let movies = results.Search.map((movie) => {
        if (movie.Type === 'series') return; // don't want to display series results

        if (!isValidURL(movie.Poster)) {
          movie.Poster = this.props.placeholderImage;
        }

        return (
          <tr key={movie.imdbID} onClick={() => (this.chooseResult(movie))}>
            <td className='artwork'><img src={movie.Poster} width='50' /></td>
            <td className='title'>{movie.Title}</td>
            <td className='year'>{movie.Year}</td>
            <td><a href={`https://www.imdb.com/title/${movie.imdbID}`} target='_blank' onClick={(e) => {e.stopPropagation()}}>IMDb</a></td>
          </tr>
        );
      });
      this.setState({results:movies});
    }
  }

  clearSearch() {
    this.setState({results:null});
  }

  chooseResult(movie) {
    // first we ask the user to confirm, because this will overwrite any metadata
    // the movie currently has (although the revert button will still work until
    // the user saves the changes)
    // for the moment, we're just sending a browser alert; later we'll make this an electron confirmation dialog
    alert('chose ' + movie.imdbID + '!!');
    this.clearSearch();

    // next, we have to get the actual movie object from the database
    axios({
      method: 'get',
      url: this.state.searchBaseURL + '&i=' + movie.imdbID,
      timeout: 20000,
    })
      .then((response) => {
        if (response.status !== 200) {
          return console.log(response.status + ': ' + response.statusText);
        }

        console.log(response.data);
        if (response.data.Response === 'False') {
          return console.log('Error: no result found: ' + response.data);
        } else {
          // if we're here, we have the movie, so all we have to do is overwrite
          // the existing values with the new ones;
          const newData = {
            title: response.data.Title,
            description: response.data.Plot,
            artwork: response.data.Poster, // the MynEditArtwork component will do the work to actually download the image from this url and change the reference to the local file when finished
            year: response.data.Year,
            director: response.data.Director,
            kind: response.data.Type === 'episode' ? 'show' : response.data.Type,
            country: response.data.Country,
            rated: response.data.Rated,
          };
          try {
            newData.boxoffice = accounting.parse(response.data.BoxOffice) || 0; //parseInt(response.data.BoxOffice.replace(/[^0-9.-]/g,'')) || null, // this may fail miserably in other locales, but assuming OMDB always uses $0,000,000.00 format, it'll be fine
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            newData.directorsort = /^\w+\s\w+$/.test(response.data.Director) ? response.data.Director.replace(/^(\w+)\s(\w+)$/,($match,$1,$2) => `${$2}, ${$1}`) : response.data.Director; // if the director field consists only of a first and last name separated by a space, set directorsort to 'lastname, firstname', otherwise, leave as-is and let the user edit it manually
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            newData.cast = response.data.Actors.split(', ');
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            newData.genre = response.data.Genre.split(', ')[0]; // just pick the first genre for genre, since we only allow one
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            newData.languages = response.data.Language.split(', ');
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            newData.tags = Array.from(new Set(response.data.Genre.split(', ').map((item) => item.toLowerCase()).concat(this.props.video.tags))); // add new tags to existing tags, removing duplicates
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          let ratings = _.cloneDeep(this.props.video.ratings);
          try {
            ratings.imdb = Number(response.data.Ratings.filter(object => object.Source == "Internet Movie Database")[0].Value.match(/^[\d\.]+(?=\/)/)); // / 10;
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            ratings.rt = Number(response.data.Ratings.filter(object => object.Source == "Rotten Tomatoes")[0].Value.match(/^\d+/)); // / 100;
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          try {
            ratings.metacritic = Number(response.data.Ratings.filter(object => object.Source == "Metacritic")[0].Value.match(/^\d+(?=\/)/)); // / 100;
          } catch(err) { console.log(`OMDB parse: ${err}`); }
          newData.ratings = ratings;

          console.log(newData);
          this.props.handleChange(newData);
        }
      })
      .catch((error) => {
        return console.error(error);
      })
      .then(() => {
        // always executed
      });
  }

  render() {
    let clearBtn = this.state.results ? (<div id='edit-search-clear-button' className='clickable' onClick={this.clearSearch} title='Clear search results'>{"\u2715"}</div>) : null;
    let searchBtn = this.state.searching ? (<img src='../images/loading-icon.gif' className='loading-icon' />) : (<button id='edit-search-button' onClick={this.handleSearch} title='Search online database for movie information (based on title and year if present, otherwise filename). You will be able to choose a result and manually edit afterwards.'>Search</button>);
    return (
        <div id='edit-search'>
          {searchBtn}
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
        numrange: {
          exp: { test: (value,min,max) => !isNaN(Number(value)) && Number(value)>=min && Number(value)<=max },
          tip: (min,max) => `${min}-${max}`
        },
        money: {
          exp: { test: value => !isNaN(accounting.unformat(value)) && accounting.unformat(value) >= 0 },
          tip: "Non-negative monetary value"
        },
        everything: {
          exp: /.*/,
          tip: ""
        }
      }
    }

    this.render = this.render.bind(this);
  }

  componentDidMount() {
    this._isMounted = true;
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  render() {
    const video = this.props.video;
    if (!isValidVideo(video)) {
      console.log("Invalid video passed to editor");
      return (
        <div className="error-message">Error: Invalid video object</div>
      );
    }

    /* TITLE */
    let title = (
      <div className='edit-field title'>
        <label className="edit-field-name" htmlFor="title">Title: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="title"
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
              movie={this.props.video}
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

    /* CAST */
    let cast = (
      <div className='edit-field cast'>
        <label className="edit-field-name" htmlFor="cast">Cast: </label>
        <div className="edit-field-editor">
          <MynEditInlineAddListWidget
            movie={this.props.video}
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

    /* KIND */
    let options = this.props.settings.used.kinds.map(kind => (
      <option key={kind} value={kind}>{kind}</option>
    ));
    let kind = (
      <div className='edit-field kind'>
        <label className="edit-field-name" htmlFor="kind">Kind: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="kind" value={this.props.video.kind} onChange={(e) => this.props.handleChange({'kind':e.target.value})}>
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
          <MynEditSeenWidget movie={this.props.video} />
        </div>
      </div>
    );

    /* POSITION */
    let position = (
      <div className='edit-field position'>
        <label className="edit-field-name" htmlFor="position">Position: </label>
        <div className="edit-field-editor">
          <MynEditPositionWidget movie={this.props.video} />
        </div>
      </div>
    );

    /* RATING */
    let rating = (
      <div className='edit-field rating'>
        <label className="edit-field-name" htmlFor="rating">Rating: </label>
        <div className="edit-field-editor">
          <MynEditRatingWidget movie={this.props.video} />
        </div>
      </div>
    );

    /* COLLECTIONS */
    let collections = (
      <div className='edit-field collections'>
        <label className="edit-field-name" htmlFor="collections">Collections: </label>
        <div className="edit-field-description">Add and subtract the video to and from existing collections. In order to create new collections or edit the existing structure, go to the settings pane.</div>
        <div className="edit-field-editor">
          <MynEditCollections
            video={this.props.video}
            collections={this.props.collections}
            update={this.props.handleChange}
            validator={this.state.validators.posint.exp}
            validatorTip={this.state.validators.posint.tip}
            reportValid={this.props.reportValid}
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
            storeTransform={value => Math.round(accounting.unformat(value))}
            displayTransform={value => accounting.formatMoney(value,'$',0)}
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
            movie={this.props.video}
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

    return (
      <div id="edit-container">
        <form onSubmit={this.props.saveChanges}>
          {title}
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
          {collections}
          {ratings}
          {boxoffice}
          {rated}
          {country}
          {languages}
          <button className="edit-field revert-btn" onClick={(e) => this.props.revertChanges(e)}>Revert to Saved</button>
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
        "metacritic" : {
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
      collection = parentList.filter(collection => collection.name === name)[0];
    } catch(err) {
      console.error('This collection has no subcollections');
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

        // initially, set the order to the smallest unused order number in this collection;
        // the user can edit it to whatever they want afterwards
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
      console.error('Unable to add collection: ' + err);
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
      // put hidden collections (ones that this video doesn't belong to, but the user might add it to)
      // at the top of the list, so that when they're added, the user can see them easily
      if (result.show) {
        results.push(result.jsx);
      } else {
        results.unshift(result.jsx);
      }
    });
    return results;
  }

  // recursive function that walks down the collections and returns each branch as JSX
  // if it contains this video, display it to the user, otherwise hide it
  findCollections(collection) {
    let results = []
    let childrenOpts = []
    let show = false;

    // if this object contains sub-collections, then it's a non-terminal node,
    // so we recurse on its children
    if (collection.collections) {
      // loop through the subcollections and call ourselves recursively on each one
      for (let i=0; i<collection.collections.length; i++) {
        let child = this.findCollections(collection.collections[i]);

        // if this child isn't being shown (i.e. our video isn't in its branch)
        // add it to the beginning of the results array, so that if the user adds it, it appears at the top;
        // also add it to the list of options to display to the user for adding the video to its branch
        if (child.show === false) {
          results.unshift(child)
          childrenOpts.push(collection.collections[i].name);
        } else {
          // if the child IS being shown, add it to the end of the results array,
          // so that it appears after any hidden collections that the user might add
          results.push(child);
        }
      }
      // if there are no sub-collections within this collection
      // there should be videos (if not, something went wrong)
      // if there are videos, add the terminal node JSX to the results array
      // test whether one of the videos is this video
      // and if it is, show the terminal node; otherwise, hide it
    } else if (collection.videos) {
      // we're at a bottom-level collection
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
              <div className="collection-order">Order: <input type="text" className="filled" value={this.props.video.collections[collection.id] || ''} onChange={(e) => this.updateOrder(e.target.value, e.target, collection)} /><div className="input-clear-button always" onClick={(e) => this.clearOrder(e, collection)}></div></div>
              <div className="inline-delete-button clickable" onClick={() => this.deleteFromCollection(collection)}>{"\u2715"}</div>
            </div>
          );
        } catch(err) {
          contents = "[Error: unable to display terminal node]";
          console.error(contents + ': ' + err);
        }
        results.push({jsx: contents});
      } catch(err) {
        console.error("Error, no videos found in this terminal collection node. That should not happen (malformed collections object in library settings?): " + e.toString());
      }
    }

    // if there were any collections returned from the level below,
    // or any videos found at this level, they will be in the results array;
    // place them within this collection and return them upward to the next level;
    if (results.length > 0) {
      // if any results have their 'show' as positive
      // set show here to true
      for (const result of results) {
        if (result.show === true) {
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
                if (i < results.length - 1 && results[i+1].show == true) {
                  // then we're an older sister, and we want to display a vertical gradient border
                  // below ourselves, for which we have to add class 'niece' to the 'children' div
                  // within result.jsx ...somehow
                }
                return result.jsx;
              })}
            </div>
          </div>
      )};
      // return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden">{results}</div></div>);
    } else {
      // if there were no sub-collections found, or in the case of a terminal node,
      // if there none of the videos was this video, return null
      return null;
    }
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
    // let target = event.target;
    // let order = event.target.value;
    order = !isNaN(Number(order)) && Number(order) !== 0 ? Number(order) : !isNaN(parseInt(order)) ? parseInt(order) : '';
    console.log(order);
    let updated = _.cloneDeep(this.props.video.collections);
    updated[collection.id] = order;
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
    let childrenOpts = this.props.collections.filter(collection => Object.keys(this.props.video.collections).filter(key => key.split('-')[0] === collection.id).length == 0).map(collection => collection.name);

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
    let target = this.input.current;
    if (value === undefined) {
      value = target.value;
    }

    console.log("value: " + value);

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
    } else {
      // only create a clear button if there's no dropdown
      clearBtn = (<div className="input-clear-button hover" onClick={this.clearInput}></div>);
    }

    return (
      <div>
        <input
          ref={this.input}
          className={this.props.className || ''}
          list={listName}
          type="text"
          name="text"
          value={this.state.value}
          placeholder={this.props.placeholder || ''}
          onChange={() => this.handleInput()}
        />
        {options}
        {clearBtn}
      </div>
    );
  }
}


// class MynEditTextOld extends React.Component {
//   constructor(props) {
//     super(props)
//
//     this.input = React.createRef();
//   }
//
//   handleInput() {
//     let target = this.input.current;
//     let value = target.value;
//     if (value === "") {
//       this.props.handleValidity(true,this.props.property,target);
//     } else if (this.props.validator.test(value)) {
//       this.props.handleValidity(true,this.props.property,target);
//     } else {
//       this.props.handleValidity(false,this.props.property,target,this.props.validatorTip);
//       // console.log('validation error!');
//       // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
//     }
//     this.props.update(this.props.property,value);
//   }
//
//   componentDidUpdate(oldProps) {
//     if (oldProps.movie[this.props.property] !== this.props.movie[this.props.property]) {
//       this.handleInput();
//     }
//   }
//
//   render() {
//     let options = null;
//     let listName = null;
//     if (this.props.options) {
//       listName = "used-" + this.props.property;
//       options = (
//         <datalist id={listName}>
//           {this.props.options.map((option) => (<option key={option} value={option} />))}
//         </datalist>
//       );
//     }
//
//     return (
//       <div>
//         <input
//           ref={this.input}
//           id={"edit-field-" + this.props.property}
//           list={listName}
//           type="text"
//           name="text"
//           value={this.props.movie[this.props.property]}
//           placeholder={'[' + this.props.property + ']'}
//           onChange={(e) => this.handleInput(e)}
//         />
//         {options}
//       </div>
//     );
//   }
// }

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

    ipcRenderer.on('downloaded', (event, response) => {
      if (response.success) {
        this.props.update({'artwork':response.message});
        console.log('Successfully downloaded artwork');
      } else {
        console.log("Unable to download file: " + response.message);
        this.update(this.props.placeholderImage);
      }

      // on finishing, whether successful or not,
      // hide message and show input field again
      this.input.current.style.visibility = 'visible';
      this._isMounted && this.setState({message: ""});
      this.dlMsg.current.style.display = 'none';

    });

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
      console.log("Valid URL? " + value);
      // then this is a valid url with an image extension at the end
      // try to download it
      this.download(value);

    } else if (extReg.test(value)) {
      console.log("Possible local path? " + value);
      // then this MIGHT be a valid local path,
      // we'll see if we can find it
      this.handleLocalFile(value);
    } else {
      // do nothing?
    }

  }

  download(url) {
    // hide the input element and display message while downloading
    this.input.current.style.visibility = 'hidden'
    this._isMounted && this.setState({message: "downloading"});
    this.dlMsg.current.style.display = 'block';

    // download
    this._isMounted && ipcRenderer.send('download', url);
  }

  handleLocalFile(path) {
    this._isMounted && fs.readFile(path, (err, data) => {
      if (err) {
        this.update(this.state.placeholderImage);
        return console.error(err);
      }
      this.update(path);
      console.log("Asynchronous read successful");
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
      console.log("artwork changed from outside?!");
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
          src={this.props.movie.artwork}
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
    console.log("Changed " + this.props.movie.title + "'s " + this.state.property + " value to " + value.user + "! ...but not really. JSON library has not been updated!");
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
      if (i <= rating) {
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
    let target = findNearestOfClass(event.target,'position-outer');
    let widgetX = window.scrollX + target.getBoundingClientRect().left;
    let widgetWidth = target.clientWidth;
    let mouseX = event.clientX;

    let position = (mouseX - widgetX) / widgetWidth * this.props.movie.duration;

    // console.log(
    //   'mouseX: ' + mouseX + '\n' +
    //   'widgetX: ' + widgetX + '\n' +
    //   // 'offsetLeft: ' + event.target.offsetLeft + '\n' +
    //   'widgetWidth: ' + widgetWidth + '\n' +
    //   '(mouseX - widgetX) / widgetWidth == ' + position / this.props.movie.duration
    // );

    return position;
  }

  updatePosition(event) {
    this.mouseOver(this.getPositionFromMouse(event),event);
  }

  updateGraphic(position) {
    position = Math.min(Math.max(position,0),this.props.movie.duration);
    let graphic = (
      <div className="position-outer"
        onMouseMove={(e) => this.updatePosition(e)}
        onMouseLeave={(e) => this.mouseOut(findNearestOfClass(event.target,'position-outer').parentElement,e)}
        onClick={(e) => this.updateValue(position,e)} >
          <div className="position-inner" style={{width:(position / this.props.movie.duration * 100) + "%"}} />
      </div>
    );

    this.setState({displayGraphic : graphic});
  }

  // componentDidMount(props) {
  //   // ReactDOM.findDOMNode(this.refs.outer)
  //   return super.componentDidMount(props);
  // }
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
    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  deleteItem(index) {
    var temp = this.state.list;
    temp.splice(index, 1);
    this.updateList(temp);
  }

  displayList() {
    return this.state.list.map((item, index) => (
      <li key={index} className="list-widget-item">{item}<div className="list-widget-delete-item inline-delete-button" onClick={() => this.deleteItem(index)}>{"\u2715"}</div></li>
    ));
  }

  componentDidMount(props) {
    this.updateList(this.props.movie[this.props.property]);
  }

  componentDidUpdate(oldProps) {
    if (oldProps.movie[this.props.property] !== this.props.movie[this.props.property]) {
      this.updateList(this.props.movie[this.props.property]);
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
      id : "list-widget-add-" + props.property
    }

    this.render = this.render.bind(this);
  }

  /* test for valid input */
  handleInput(event) {
    const input = document.getElementById(this.state.id + "-input");
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
      input.value = '';
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
        <input type="text" list={listName} id={this.state.id + "-input"} className="list-widget-add-input" placeholder="Add..." minLength="1" onChange={(e) => this.handleInput(e)} />
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
        <MynEditAddToList movie={this.props.movie} property={this.props.property} update={this.props.update} options={this.props.options} storeTransform={this.props.storeTransform} inline="inline" validator={this.props.validator} validatorTip={this.props.validatorTip} />
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
      console.log(error);
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

// helper function to test whether a video object is a valid video
// all it does right now is check for top-level properties
// eventually it should do more than that
function isValidVideo(video) {
  const properties = [
    'id',
    'title',
    'year',
    'director',
    'directorsort',
    'cast',
    'description',
    'genre',
    'tags',
    'seen',
    'position',
    'duration',
    'ratings',
    'dateadded',
    'lastseen',
    'kind',
    'filename',
    'artwork',
    'collections',
    'boxoffice',
    'rated',
    'languages',
    'country'
  ];

  for(const property of properties){
    if (Object.keys(video).includes(property)) {
       continue;
    } else {
       return false;
    }
  }
  return true;
}

// helper function to determine if a string is a valid URL
function isValidURL(s) {
  try {
    new URL(s);
    return true;
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

const library = new Library;
ReactDOM.render(<Mynda library={library} lastUpdate={library.lastUpdate}/>, document.getElementById('root'));
