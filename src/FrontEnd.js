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
const Collections = require('./Collections.js');
const Collection = require('./Collection.js');
const dl = require('./download');
const omdb = require('../omdb');
const axios = require('axios');
const accounting = require('accounting');
const { DragDropContext, Droppable, Draggable } = require('react-beautiful-dnd');
const hashObject = require('object-hash');
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

      filteredVideos : [], // list of videos to display: can be filtered by a playlist or a search query or whatever; this is what is displayed
      playlistVideos : [], // list of videos filtered by the playlist only; this is used to execute a search query on
      view : "flat", // whether to display a flat table or a hierarchical view
      detailMovie : null,
      currentPlaylistID : null,
      prevQuery : '',

      // openablePane: null
      show : {
        settingsPane : false,
        editorPane : false
      }
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

  showDetails(id, rowID, e) {
    let detailMovie = null;
    try {
      detailMovie = this.state.filteredVideos.filter(video => video.id === id)[0]
    } catch(error) {
      console.log("Error: could not find video " + id)
    }
    this.setState({detailRowID: rowID, detailMovie: detailMovie});
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
    let rect = el.getBoundingClientRect();
    return (
         (rect.x + rect.width) < 0
      || (rect.y + rect.height) < 0
      || (rect.x > window.innerWidth || rect.y > window.innerHeight)
    );
  }

  // tells if the table row for a given video id
  // is visible: i.e. it is within the viewport (not scrolled offscreen)
  // and its collections hierarchy is expanded (if applicable)
  isRowVisible(rowID) {
    // first find the row
    let row = null;
    try {
      row = document.getElementsByClassName('movie-row ' + rowID)[0];
    } catch(err) {
      console.log('Cannot tell if row is visible. Unable to find row for movie ' + rowID);
      return false;
    }

    // then test if it is scrolled out of view
    let boundary = document.getElementById('library-pane').getBoundingClientRect();
    let rect = row.getBoundingClientRect();
    let inViewport = false;
    if (rect.top < window.innerHeight || rect.bottom > boundary.top) {
      inViewport = true;
    }

    // then test if it or any of its parents is set to display:none
    let isNotHidden = row.offsetParent !== null;

    // return if it its scroll position is onscreen and it is not hidden
    // return inViewport && isNotHidden;
    return false; // just until we get the rest of the infrastructure written
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
      let name = playlist ? playlist.name : 'nonexistent';
      console.error(`Unable to execute filter for ${name} playlist: ${err}`);
    }
    return filteredVids;
  }

  // called from the nav component to change the current playlist
  setPlaylist(id,element) {
    if (!element) {
      element = document.getElementById("playlist-" + id);
    }

    // if this playlist is one of the tabs, visually bring that tab to the front
    if (element) {
      Array.from(element.parentNode.children).map((child) => { child.classList.remove('selected') });
      element.classList.add('selected');
    }

    // set the playlist
    let videos = this.playlistFilter(id);
    let playlist = this.state.playlists.filter(playlist => playlist.id == id)[0];
    let view = playlist ? playlist.view : null;
    this.setState({playlistVideos : videos, filteredVideos : videos, view : view, currentPlaylistID : id})
    // this.setState({}); // filteredVideos is what is actually displayed
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
    //     paneJSX = <MynEditor video={this.state.detailMovie} collections={this.state.collections} settings={this.state.settings} hideFunction={() => {this.hideOpenablePane(name)}}/>
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

      // if the collections were changed
      if (address.includes('collections')) {
        console.log('collections was edited');
        this.setState({collections : this.props.library.collections}, () => {
          // we don't need to update the playlist here, because
          // if the collections were edited, a video was edited too with
          // the corresponding change to the video object;
          // and that will cause the playlist to re-render
        });
      }

      // if a movie was changed
      if (address.includes('media')) {
        console.log('a video was edited');
        // update the currently displayed playlist
        this.setPlaylist(this.state.currentPlaylistID);
        // update movie in details pane (we don't know if this is the movie that was edited, but just in case)
        this.setState({detailMovie : this.state.videos.filter(video => video.id === this.state.detailMovie.id)[0]});
      }

      // if a playlist was changed
      if (address.includes('playlists')) {
        console.log('a playlist was edited');
        // reload the playlists, and then re-render the current playlist
        this.setState({playlists:this.props.library.playlists}, () => {
          this.setPlaylist(this.state.currentPlaylistID);
        });
      }

      // if the settings were changed
      if (address.includes('settings')) {
        console.log('settings was edited');
        this.setState({settings : this.props.library.settings}, () => {
        });
        // if (address === 'settings.preferences.defaultcolumns') {
        //
        // }
      }


    };
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
    let columns;
    try {
      let playlist = this.state.playlists.filter(playlist => playlist.id == this.state.currentPlaylistID)[0];
      columns = playlist.columns;
    } catch(err) {
      // no current playlist yet, set columns to an empty array
      columns = [];
    }

    return (
      <div id='grid-container'>
        <MynNav playlists={this.state.playlists} setPlaylist={this.setPlaylist} search={this.search} showSettings={() => {this.showOpenablePane("settingsPane")}}/>
        <MynLibrary movies={this.state.filteredVideos} collections={this.state.collections} view={this.state.view} columns={columns} displayColumnName={this.displayColumnName} calcAvgRatings={this.calcAvgRatings} showDetails={this.showDetails} />
        <MynDetails movie={this.state.detailMovie} rowID={this.state.detailRowID} settings={this.state.settings} showEditor={() => {this.showOpenablePane("editorPane")}} scrollToVideo={this.scrollToVideo} isRowVisible={this.isRowVisible} />
        <MynSettings show={this.state.show.settingsPane} view='folders' settings={this.state.settings} videos={this.state.videos} playlists={this.state.playlists} collections={this.state.collections} displayColumnName={this.displayColumnName} hideFunction={() => {this.hideOpenablePane('settingsPane')}}/>
        <MynEditor show={this.state.show.editorPane} video={this.state.detailMovie} collections={this.state.collections} settings={this.state.settings} hideFunction={() => {this.hideOpenablePane('editorPane')}}/>
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
              return (<li key={playlist.id} id={"playlist-" + playlist.id} style={{zIndex: 100 - index}} className={playlist.view} onClick={(e) => this.props.setPlaylist(playlist.id,e.target)}>{playlist.name}</li>);
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
      movies: _.cloneDeep(props.movies),
      collections: _.cloneDeep(props.collections),
      hierarchy : null,
      vidsInHierarchy : [],
      sortReport : {}
    }

    this.render = this.render.bind(this);
    this.createCollectionsMap = this.createCollectionsMap.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
    this.reportSort = this.reportSort.bind(this);
    // this.findCollections = this.findCollections.bind(this);
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.movies,this.props.movies)) {
      console.log('MynLibrary movies was changed!');
      this.setState({movies:_.cloneDeep(this.props.movies)});
    }
    if (!_.isEqual(oldProps.collections,this.props.collections)) {
      console.log('MynLibrary collections was changed!');
      this.setState({collections:_.cloneDeep(this.props.collections)});
    }
  }

  componentDidMount() {
    // console.log(this.props.movies);
    //
    // this.setState({movies:this.props.movies},() => {
    //   console.log(this.state.movies);
    // });
    //
  }

  createCollectionsMap() {
    // console.log("Creating new collections map");
    this.state.hierarchy = this.state.collections.map(collection => (this.findCollections(collection)));

    // create dummy collection of leftover videos, if any
    let leftovers = this.state.movies.filter(v => !this.state.vidsInHierarchy.includes(v.id));
    let uncategorized = {
      id: 'uncategorized',
      name: '[Uncategorized]',
      videos: leftovers.map(v => {return {id:v.id}})
    }
    // and add it to the hierarchy
    this.state.hierarchy.push(this.findCollections(uncategorized));
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
          if (this.state.movies.filter(movie => (object.videos[i].id === movie.id)).length > 0) {
            // add video to list of videos for this collection
            videos.push(object.videos[i]);
            // also add its id to the vidsInHierarchy list
            // (later we'll compare this to this.state.movies to see what leftovers we have;
            // i.e. videos in the playlist that are not part of any collections)
            if (object.name !== '[Uncategorized]') { // we don't want to add the leftovers themselves to vidsInHierarchy, or else they won't be displayed
              this.state.vidsInHierarchy.push(object.videos[i].id);
            }
            // set flag
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
        let movies = this.state.movies.filter(movie => (videos.filter(collectionVideo => (collectionVideo.id === movie.id)).length > 0))
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

        // console.log('Creating table for collection: ' + JSON.stringify(object));
        // console.log(JSON.stringify(movies));
        // wrap the movies in the last collection div,
        // then hand them off to MynLibTable with an initial sort by 'order'
        return (
          <div className="collection collapsed" key={object.name}>
            <h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1>
            <div className="container hidden">
              <Droppable droppableId={object.id}>
                {(provided) => (
                  <MynLibTable
                    movies={movies}
                    view={this.props.view}
                    initialSort={this.state.sortReport[object.id] ? this.state.sortReport[object.id].key : "order"}
                    initialSortAscending={this.state.sortReport[object.id] ? this.state.sortReport[object.id].ascending : true}
                    columns={this.props.columns}
                    displayColumnName={this.props.displayColumnName}
                    calcAvgRatings={this.props.calcAvgRatings}
                    collectionID={object.id}
                    showDetails={this.props.showDetails}
                    reportSort={this.reportSort}
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

  toggleExpansion(e) {
    let element = e.target;
    // let siblings = Array.from(element.parentNode.childNodes).filter(node => (node !== e.target));
    // siblings.map(node => (node.classList.toggle("hidden")));
    let childrenContainer = element.parentNode.getElementsByClassName("container")[0]
    childrenContainer.classList.toggle("hidden");
    element.parentNode.classList.toggle("expanded");
    element.parentNode.classList.toggle("collapsed");
  }

  // when an instance of MynTable is sorted, it reports back here
  // so that we can keep track. The only reason we need to do that
  // is because we only allow drag-n-drop to work if a table is sorted by order
  reportSort(id,key,ascending) {
    this.state.sortReport[id] = {key:key,ascending:ascending};
    // console.log(JSON.stringify(this.state.sortReport));
  }

  onDragEnd(result) {
    console.log(JSON.stringify(result));
    const { destination, source, draggableId } = result;

    // if anything moved at all
    if (destination) {
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


      // get video id
      let videoID = draggableId.split('_')[0];
      let newOrder, newIndex;

      // make a deep copy of the whole collections object for modification, which we'll save when we're done
      let colsCopy = new Collections(_.cloneDeep(this.state.collections));

      let oldOrder = colsCopy.get(source.droppableId).videos.filter(v => v.id === videoID)[0].order;
      // console.log('old order: ' + oldOrder);

      // get source collection and destination collection
      let srcCol, destCol;
      if (destination.droppableId !== 'uncategorized') {
        destCol = colsCopy.get(destination.droppableId);
      }
      if (source.droppableId !== 'uncategorized') {
        srcCol = colsCopy.get(source.droppableId);
      }

      // only do anything if
      if (
        // the video was moved to a different collection that doesn't already contain it
        (destination.droppableId !== source.droppableId && !destCol.containsVideo(videoID))
        ||
        // or the video was moved to a different position within the same collection
        (destination.index !== source.index && destination.droppableId === source.droppableId)
      ) {

        // remove video from original position
        if (srcCol) {
          srcCol.removeVideo(videoID);
        }

        // add video to new position
        if (destCol) {

          // first we must find the proper index where the video was dropped
          newIndex = destination.index;
          // if (destination.droppableId === source.droppableId && source.index < destination.index) {
          //   // for the special case that we're dropping the video later in the same collection, the index must be adjusted
          //   newIndex = destination.index + 1;
          // }
          // apparently not anymore???

          // and then create an order based on the order of the previous video
          if (newIndex > 0) {
            let prevOrder = destCol.videos[newIndex - 1].order;
            // if the video is being dropped between two decimal orders of the same integer value
            if (destCol.videos[newIndex + 1] && Math.floor(prevOrder) === Math.floor(destCol.videos[newIndex + 1].order)) {
              // set the new order to 0.1 higher than the previous video
              newOrder = prevOrder + 0.1;

              // otherwise if the old order is not an integer, we want to try to preserve its decimal value
            } else if (!Number.isInteger(oldOrder)) {
              // set the new order either to the integer part of the previous video plus the decimal part of the old order of this video,
              // or to 0.1 higher than the previous video, whichever is higher
              newOrder = Math.max(prevOrder + 0.1,oldOrder - Math.floor(oldOrder) + Math.floor(prevOrder));
            } else {
                // set the video to 1 higher than the previous video
                newOrder = Math.floor(destCol.videos[newIndex - 1].order) + 1;
            }
          } else {
            newOrder = 1;
          }

          // add the video
          destCol.addVideo(videoID, newOrder, newIndex);
        }


        // prior to saving, we'll update the state variables;
        // saving will cause a re-render, but it's slow, so we want
        // to force one before then
        // this.state.movies.splice(vidIndex,1,video);
        this.setState({movies:this.state.movies,collections:colsCopy.getAll()});

        // save the updated video and collections object
        // library.replace("media." + vidIndex, video);
        library.replace("collections", colsCopy.getAll());
      }
    }
  }

  render() {
    // console.log('----MynLibrary RENDER----');
    let content = null;

    // if the playlist view is hierarchical, create multiple tables
    // in a hierarchy based on the collections that the videos in this
    // playlist are members of, and display that hierarchy
    if (this.props.view === "hierarchical") {
      this.createCollectionsMap();

      content = (
        <DragDropContext onDragEnd={this.onDragEnd}>
          <div id="collections-container">
            {this.state.hierarchy}
          </div>
        </DragDropContext>
      )

    // if the playlist view is flat, we only need to display one table
    } else if (this.props.view === "flat") {

      content = (
        <MynLibTable
          movies={this.state.movies}
          view={this.props.view}
          columns={this.props.columns}
          displayColumnName={this.props.displayColumnName}
          calcAvgRatings={this.props.calcAvgRatings}
          showDetails={this.props.showDetails}
        />
      )

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

    this.state = {
      sortKey: null,
      sortAscending: true,
      sortedRows: [],
      displayOrderColumn: "table-cell",
      lockedRow: null,
      vidOrderDisplay: {},
      vidOrderDisplayTemplate: (video,order) => {
          let rowID = this.state.rowID(video.id);
          return (
            <div style={{cursor:'text'}} onClick={(e) => this.orderClick(video, rowID, e)}>
              {order}
            </div>
          );
        },
      rowID: (vidID) => vidID + (this.props.collectionID ? `_${this.props.collectionID}` : '')

    }

    this.requestSort = this.requestSort.bind(this);
    this.reset = this.reset.bind(this);
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

  rowHovered(id, rowID, e) {
    // show details in details pane
    if (!this.state.lockedRow) {
      this.props.showDetails(id, rowID, e);
    }
  }

  rowOut(id, rowID, e) {
    // hide details in details pane
    // this.props.showDetails(null, e);
  }

  rowClick(id, rowID, e) {
    const row = findNearestOfClass(e.target,'movie-row');

    // first remove the 'locked' class from any currently locked row
    if (this.state.lockedRow !== null) {
      document.getElementById(this.state.lockedRow).classList.remove('locked');
    }

    // if this row is already locked, unlock it
    if (this.state.lockedRow === rowID) {
      this.setState({lockedRow : null});
      row.classList.remove('locked');
      setTimeout(() => {
        row.classList.add('unlocking');
        setTimeout(() => {
          row.classList.remove('unlocking');
        },1000);
      },50);
      setTimeout(() => {row.classList.remove('unlocking');},1000);
    } else {
      // if a different row, or no row, was locked,
      // lock this row
      this.setState({lockedRow : rowID});
      row.classList.add('locked');
      this.props.showDetails(id, rowID, e); // this is necessary in case we go from one locked row to another without unlocking in between
    }
  }

  // called when the user clicks on the 'order' cell of a row
  // brings up an inline editor to change the order
  orderClick(video, rowID, e) {
    // don't trigger a click on the whole row
    e.stopPropagation();

    // add listener for the Enter key, to save the value
    const cell = findNearestOfClass(e.target,'order');
    cell.addEventListener('keyup', (e) => { if (e.keyCode === 13) this.orderSave(e,order,video)}, {once:false});

    // replace the contents of the cell with the editor
    let valid = false;
    let order = video.order;
    let vidOrderDisplay = _.cloneDeep(this.state.vidOrderDisplay);
    vidOrderDisplay[video.id] = (
      <div onClick={(e) => {e.stopPropagation()}}>
        <MynEditText
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
        />
      </div>
    );
    this.setState({vidOrderDisplay:vidOrderDisplay},() => {
      console.log(JSON.stringify(this.state.vidOrderDisplay));
      this.reset(false); // force the table to rerender, preserving vidOrderDisplay
    });
  }

  // called when the user hits enter in the inline 'order' editor
  orderSave(e,order,video) {
    e.preventDefault();
    e.stopPropagation();
    // e.target.removeEventListener()
    // console.log(e.target);

    // update the order
    //this.props.collectionID

    // replace the contents of the cell with the new order value
    // (and a click event listener to enable another edit)
    console.log('Saving order as ' + order);
    let vidOrderDisplay = _.cloneDeep(this.state.vidOrderDisplay);
    vidOrderDisplay[video.id] = this.state.vidOrderDisplayTemplate(video,order);
    this.setState({vidOrderDisplay:vidOrderDisplay},() => {
      this.reset(false,true); // force the table to re-render
    });
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

  requestSort(key, ascending) {
    // console.log(key);
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

    let sortFunctions = {
     title: (a, b) => this.removeArticle(a.title).toLowerCase() > this.removeArticle(b.title).toLowerCase(),
     year: (a, b) => a.year > b.year,
     director: (a, b) => {let a_ds = a.directorsort === '' ? a.director : a.directorsort; let b_ds = b.directorsort === '' ? b.director : b.directorsort; return a_ds.toLowerCase() > b_ds.toLowerCase()},
     genre: (a, b) => a.genre.toLowerCase() > b.genre.toLowerCase(),
     seen: (a, b) => a.seen > b.seen,
     ratings_user: (a, b) => a.ratings.user > b.ratings.user,
     dateadded: (a, b) => {let a_added = isNaN(parseInt(a.dateadded)) ? -1 : parseInt(a.dateadded); let b_added = isNaN(parseInt(b.dateadded)) ? -1 : parseInt(b.dateadded); return a_added > b_added;},
     order: (a, b) => a.order > b.order,
     kind: (a, b) => a.kind.toLowerCase() > b.kind.toLowerCase(),
     lastseen: (a, b) => {let a_ls = isNaN(parseInt(a.lastseen)) ? -1 : parseInt(a.lastseen); let b_ls = isNaN(parseInt(b.lastseen)) ? -1 : parseInt(b.lastseen); return a_ls > b_ls;},
     ratings_rt: (a, b) => {let a_r = a.ratings.rt ? a.ratings.rt : -1; let b_r = b.ratings.rt ? b.ratings.rt : -1; return a_r > b_r},
     ratings_imdb: (a, b) => {let a_r = a.ratings.imdb ? a.ratings.imdb : -1; let b_r = b.ratings.imdb ? b.ratings.imdb : -1; return a_r > b_r},
     ratings_mc: (a, b) => {let a_r = a.ratings.mc ? a.ratings.mc : -1; let b_r = b.ratings.mc ? b.ratings.mc : -1; return a_r > b_r},
     ratings_avg: (a, b) => this.props.calcAvgRatings(a.ratings,'sort') > this.props.calcAvgRatings(b.ratings,'sort'),
     boxoffice: (a, b) => a.boxoffice > b.boxoffice,
     rated: (a, b) => ratedOrder[a.rated.toUpperCase()] > ratedOrder[b.rated.toUpperCase()],
     country: (a, b) => a.country.toLowerCase() > b.country.toLowerCase(),
     languages: (a, b) => a.languages[0].toLowerCase() > b.languages[0].toLowerCase(),
     duration: (a, b) => parseInt(a.duration) > parseInt(b.duration)
    }

    let rows = this.props.movies.sort((a, b) => {

      let result = sortFunctions[key](a, b) ? 1 : -1;
      result *= ascending ? 1 : -1;

      return result;
    }).map((movie, index) => {
      // this will ensure that we have a unique id for the row
      // even if we're in a hierarchical playlist in which a video can appear
      // in more than one table (in different collections)
      // let rowID = movie.id + (this.props.collectionID ? `_${this.props.collectionID}` : '');
      let rowID = this.state.rowID(movie.id);

      let displaydate = (date) => {
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
      // let seenmark = movie.seen ? "\u2714" : "\u2718"

      // if (movie.order === undefined) {
      //   movie.order = null;
      // }

      let cellJSX = {
        order: (<td key="order" className="order" style={{display:this.state.displayOrderColumn}}>{this.state.vidOrderDisplay[movie.id]}</td>),
        title: (<td key="title" className="title" onMouseEnter={(e) => this.titleHovered(e)} onMouseLeave={(e) => this.titleOut(e)}><div className="table-title-text">{movie.title}</div></td>),
        year: (<td key="year" className="year centered mono">{movie.year}</td>),
        director: (<td key="director" className="director">{movie.director}</td>),
        genre: (<td key="genre" className="genre">{movie.genre}</td>),
        seen: (<td key="seen" className="seen centered"><MynEditSeenWidget movie={movie} update={(...args) => this.saveEdited(movie, ...args)} /></td>),
        ratings_user: (<td key="ratings_user" className="ratings_user centered"><MynEditRatingWidget movie={movie} update={(...args) => this.saveEdited(movie, ...args)} /></td>),
        dateadded: (<td key="dateadded" className="dateadded centered mono">{displaydate(movie.dateadded)}</td>),
        kind: (<td key="kind" className="kind">{movie.kind ? movie.kind.replace(/\b\w/g,ltr=>ltr.toUpperCase()) : null}</td>),
        lastseen: (<td key="lastseen" className="lastseen centered mono">{displaydate(movie.lastseen)}</td>),
        ratings_rt: (<td key="ratings_rt" className="ratings_rt ratings centered">{movie.ratings.rt ? movie.ratings.rt + '%' : ''}</td>),
        ratings_imdb: (<td key="ratings_imdb" className="ratings_imdb ratings centered">{movie.ratings.imdb ? Number(movie.ratings.imdb).toFixed(1) : ''}</td>),
        ratings_mc: (<td key="ratings_mc" className="ratings_mc ratings centered">{movie.ratings.mc ? movie.ratings.mc : ''}</td>),
        ratings_avg: (<td key="ratings_avg" className="ratings_avg ratings centered">{this.props.calcAvgRatings(movie.ratings)}</td>),
        boxoffice: (<td key="boxoffice" className="boxoffice">{movie.boxoffice === 0 ? '' : accounting.formatMoney(Number(movie.boxoffice),'$',0).replace(/,(\d{3})$/,(...grps) => Math.round(grps[1]/10)>0 ? `.${Math.round(grps[1]/10).toString().replace(/0$/,'')}k` : 'k').replace(/,(\d{3})(\.\d{1,2})?k$/,(...grps) => Math.round(grps[1]/10)>0 ? `.${Math.round(grps[1]/10).toString().replace(/0$/,'')}M` : 'M').replace(/,(\d{3})(\.\d{1,2})?M$/,(...grps) => Math.round(grps[1]/10)>0 ? `.${Math.round(grps[1]/10).toString().replace(/0$/,'')}B` : 'B')}</td>),
        rated: (<td key="rated" className="rated">{movie.rated}</td>),
        country: (<td key="country" className="country">{movie.country}</td>),
        languages: (<td key="languages" className="languages">{movie.languages[0]}</td>),
        duration: (<td key="duration" className="duration">{Math.round(Number(movie.duration)/60)}min</td>)
      };

      let cells = this.props.columns.map(column => cellJSX[column]);

      let row = (
        <tr
          className={"movie-row " + rowID}
          id={rowID}
          key={movie.id}
          onMouseOver={(e) => this.rowHovered(movie.id, rowID, e)}
          onMouseOut={(e) => this.rowOut(movie.id, rowID, e)}
          onClick={(e) => this.rowClick(movie.id, rowID, e)}
        >
          {cellJSX.order}
          {cells}
        </tr>
      );

      if (this.props.provided) {
        // row.props.ref = this.props.provided.innerRef;
        // row.props = {...row.props, ...this.props.provided.draggableProps}
        return (
          <Draggable key={rowID} draggableId={rowID} index={index}>
            {(provided) => (
              React.cloneElement(row, { ref: provided.innerRef, ...provided.draggableProps, ...provided.dragHandleProps })
            )}
          </Draggable>
        );
      } else {
        return row;
      }
    });

    // set the sort state in state
    this.setState({ sortKey: key, sortAscending: ascending , sortedRows: rows});

    // report the sort state to MynLibrary
    if (this.props.reportSort) {
      this.props.reportSort(this.props.collectionID,key,ascending);
    }
  }

  // re-render the table by requesting a new sort (if initialSort === true, sort by initial values,
  // rather than the current values)
  reset(initialSort,resetOrder) {
    if (initialSort || resetOrder) {
      this.props.movies.map(movie => {
        // we display the order property through a state variable
        // because when the user wants to edit the order, we use the state variable
        // to display an editor; we must initially populate that variable with the order itself
        // inside a div with a click event that calls up the editor
        this.state.vidOrderDisplay[movie.id] = this.state.vidOrderDisplayTemplate(movie,movie.order);
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
      // console.log("initial: " + initial);
      // console.log("this.state.sortKey: " + this.state.sortKey);
      // console.log("this.props.initialSort: " + this.props.initialSort);
      // console.log("this.props.initialSortAscending: " + this.props.initialSortAscending);

      // sort by initial (default) values
      this.state.sortKey = null;
      try {
        this.requestSort(this.props.initialSort, this.props.initialSortAscending);
      } catch(e) {
        // console.log('No initial sort parameter, sorting by title');
        this.requestSort('title');
      }
    } else {
      // if initial is false, sort by the current value
      // console.log("Sort key is not null?: " + this.state.sortKey);
      this.requestSort(this.state.sortKey, this.state.sortAscending);
    }
  }

  removeArticle(string) {
    return string.replace(/^(?:a\s|the\s)/i,"")
  }

  saveEdited(originalVid, ...args) {
    // console.log('save-edited!!!');
    let changes = {};
    if (args.length == 2 && typeof args[0] === "string") {
      changes[args[0]] = args[1];
    } else if (args.length == 1 && typeof args[0] === "object") {
      changes = args[0];
    } else {
      throw 'Incorrect parameters passed to saveEdited in MynLibTable';
    }
    // console.log('changes == ' + JSON.stringify(changes));

    // user confirmation dialog
    ipcRenderer.send('save-video-confirm', changes, originalVid);

  }

  componentDidMount(props) {
    // this.props.movies.map(movie => console.log(JSON.stringify(movie)));
    // populate and sort the table (by initial values)
    this.reset(true);
  }

  componentDidUpdate(oldProps) {
    // console.log('UPDATING MynTable');
    if (!_.isEqual(oldProps.movies,this.props.movies)) {
      // console.log('MynTable props changed!!!');
      // re-render the table (sorting by the current values)
      this.reset(false);

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
    // console.log('----MynLibTable RENDER----');

    // if this table is part of a hierarchical playlist,
    // we'll give it an id corresponding to the collection it is within
    let tableID = '';
    if (this.props.view === 'hierarchical' && this.props.collectionID) {
      tableID = 'table-' + this.props.collectionID;
    }

    // if this table is part of a hierarchical playlist,
    // then the rows are meant to be drag-n-droppable (using reacr-beautiful-dnd)
    // in which case MynLibrary will have given us the 'provided' prop,
    // so if it has, we add the appropriate bits to make the table body droppable
    let tBody = null;
    if (this.props.provided) {
      tBody = (
        <tbody ref={this.props.provided.innerRef} {...this.props.provided.droppableProps}>
          {this.state.sortedRows}
          {this.props.provided.placeholder}
        </tbody>
      );
    } else {
      tBody = (
        <tbody>
          {this.state.sortedRows}
        </tbody>
      );
    }

    return  (<table className="movie-table" id={tableID}>
              <thead>
                <tr id="main-table-header-row">
                  <th onClick={() => this.requestSort('order')} style={{display:this.state.displayOrderColumn}}>#</th>
                  {this.props.columns.map(col => (
                    <th key={col} onClick={() => this.requestSort(col)}>{this.props.displayColumnName(col)}</th>
                  ))}
                </tr>
              </thead>
              {tBody}
            </table>)
  }
}

// ###### Details Pane: contains details of the hovered/clicked video ###### //
class MynDetails extends React.Component {
  constructor(props) {
    super(props)

    this.render = this.render.bind(this);
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

  clickDescrip(e) {
    if (this.props.settings.preferences.hidedescription === "hide") {
      try {
        document.getElementById('detail-description').classList.toggle('hide');
      } catch(err) {
        console.log(err);
      }
    }
  }

  displayRatings() {
    let ratings = this.props.movie.ratings;
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

  componentDidUpdate(oldProps) {
    this.setTitleMarquee();
    if (!_.isEqual(oldProps.movie, this.props.movie)) {
      // this.setTitleMarquee();
      if (this.props.settings.preferences.hidedescription === "hide") {
        try {
          document.getElementById('detail-description').classList.add('hide');
        } catch(err) {
          console.log('Error: could not find detail description: ' + err);
        }
      }
    }

    // if the user has scrolled, we want to show or not show the scroll button
    // depending on whether the row of the details movie is still in view
    if (oldProps.libraryScroll !== this.props.libraryScroll) {
      if (this.scrollBtn.current && !this.props.isRowVisible(rowID)) {
        console.log(movie.title + ' is NOT visible!');
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
      const movie = this.props.movie
      details = (
        <ul>
          <li className="detail" id="detail-artwork"><img src={movie.artwork || '../images/qmark.png'} /></li>
          <li className="detail" id="detail-title"><div className="detail-title-text">{movie.title}</div></li>
          <li className="detail" id="detail-position"><MynEditPositionWidget movie={movie} /></li>
          <li className={"detail " + this.props.settings.preferences.hidedescription} id="detail-description" onClick={(e) => this.clickDescrip(e)}><div>{movie.description}</div></li>
          <li className="detail" id="detail-ratings">{this.displayRatings()}</li>
          <li className="detail" id="detail-director"><span className="label">Director:</span> {movie.director}</li>
          <li className="detail" id="detail-cast"><span className="label">Cast:</span> {movie.cast.join(", ")}</li>
          <li className="detail" id="detail-tags"><span className="label">Tags:</span> {movie.tags.map((tag) => <span key={tag}>{tag} </span>)}</li>
          <li className="detail" id="detail-rated"><span className="label">Rated:</span> {movie.rated}</li>
          <li className="detail" id="detail-country"><span className="label">Country:</span> {movie.country}</li>
          <li className="detail" id="detail-languages"><span className="label">Languages:</span> {movie.languages.join(", ")}</li>
          {movie.boxoffice > 0 ? (<li className="detail" id="detail-boxoffice"><span className="label">Box Office:</span> {accounting.formatMoney(movie.boxoffice,'$',0) || ''}</li>) : null}
          <li className="detail" id="detail-dateadded"><span className="label">Date Added:</span> {this.displayDate(movie.dateadded)}</li>
          <li className="detail" id="detail-lastseen"><span className="label">Last Seen:</span> {this.displayDate(movie.lastseen)}</li>

        </ul>
      );

      scrollBtn = (
        <div id='details-scroll-btn' ref={this.scrollBtn} className='clickable' style={{display: this.props.isRowVisible(this.props.rowID) ? 'none' : 'block'}} onClick={() => this.props.scrollToVideo(this.props.rowID)}>
          Scroll to Row
        </div>
      );

    } catch (error) {
      // eventually we'll put some kind of better placeholder here
      details = <div>No Details</div>
      editBtn = null; // in the case of no movie, we don't want an edit button
      scrollBtn = null; // same with this

      // console.error(error.toString());

      // validateVideo(this.props.movie);
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

class MynOpenablePane extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      paneID: ''
    }

    this.render = this.render.bind(this);

    ipcRenderer.on('MynOpenablePane-confirm-exit', (event, response, id, checked) => {
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        console.log('option to override dialog was checked!');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.overridedialogs) {
          prefs.overridedialogs = {};
        }
        prefs.overridedialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // close pane
        this.props.hideFunction(id);
      } else {
        console.log('Exit pane cancelled by user')
      }
    });
  }

  closePane(id,confirm,msg) {
    try {
      // in case confirm is a function instead of just a boolean
      confirm = confirm();
    } catch(err) {}

    // if we're supposed to confirm before exiting:
    // i.e. the confirm boolean variable tells us whether the pane wants us to confirm exit,
    // but that can be overridden by the user preference to override the confirmation dialog,
    // hence the rest of the conditional here
    if (confirm && (!this.props.settings.preferences.overridedialogs || !this.props.settings.preferences.overridedialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`])) {
      ipcRenderer.send(
        'generic-confirm',
        'MynOpenablePane-confirm-exit',
        {
          message: msg || 'Are you sure you want to exit?',
          checkboxLabel: `Don't show this dialog again`
        },
        id
      );
    } else {
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
        <div className="openable-close-btn" onClick={() => this.closePane(this.state.paneID,content.confirmExit,content.confirmMsg)}>{"\u2715"}</div>
        {content.jsx}
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
      settingView: null,
      settingViewName: props.view,
      delaySave: false,
      timer: null
    }
  }

  setStateViewsFromProps(callback) {
    let views = {
      folders :     (<MynSettingsFolders      save={this.save} folders={this.props.settings.watchfolders} kinds={this.props.settings.used.kinds} />),
      playlists :   (<MynSettingsPlaylists    save={this.save} playlists={this.props.playlists} defaultcolumns={this.props.settings.preferences.defaultcolumns} displayColumnName={this.props.displayColumnName} />),
      collections : (<MynSettingsCollections  save={this.save} collections={this.props.collections} videos={this.props.videos} />),
      // themes :      (<MynSettingsThemes       save={this.save} themes={this.props.settings.themes} />),
      preferences : (<MynSettingsPrefs        save={this.save} settings={this.props.settings} displayColumnName={this.props.displayColumnName} />)
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
    this.setState({settingView : this.state.views[view], settingViewName : view});

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
    if (!_.isEqual(oldProps,this.props)) {
      // console.log('MynSettings: PROPS HAVE CHANGED:\n' + JSON.stringify(this.props.show));

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
      console.error("Unable to find list of media kinds in library: " + e.toString());
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
    // console.log('Changed target folder to ' + folder);

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
      console.error("Error finding watchfolders from library: " + e.toString());
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

    ipcRenderer.on('MynSettingsPlaylists-confirm-delete-playlist', (event, response, id) => {
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
      filterFunction : "false",
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

    let playlists = this.state.playlists.map((playlist,i) => (
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
      hidedescription : props.settings.preferences.hidedescription,
      kinds : props.settings.used.kinds,
      overridedialogs : props.settings.preferences.overridedialogs
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
        address = "settings.preferences.hidedescription";
        this.setState({hidedescription:value});
        break;
      case "kinds" :
        address = "settings.used.kinds";
        this.setState({kinds:value});
        break;
      case "override-dialogs" :
        address = "settings.preferences.overridedialogs";
        let new_od = _.cloneDeep(this.state.overridedialogs);
        new_od[subProp] = value;
        value = new_od;
        this.setState({overridedialogs:value});
        break;
    }

    let saveObj = {};
    saveObj[address] = value;
    this.props.save(saveObj);
  }

  render() {
    const dialogDescriptions = {
      'MynEditorSearch-confirm-select' : 'Confirm selection of search result in video editor',
      'MynEditor-confirm-exit' : 'Confirm on exiting video editor without saving',
      'MynEditorEdit-confirm-revert' : 'Confirm on reverting to saved values in video editor'
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
              validator={/^[a-zA-Z0-9_\-\.&]+$/}
              validatorTip={"Allowed: a-z A-Z 0-9 _ - . &"}
              reportValid={() => {}}
            />
          </li>
          <li id='settings-prefs-hidedescrip' className='subsection'>
            <h2>Hide Descriptions:</h2>
            <input
              type='checkbox'
              checked={this.state.hidedescription === "hide" ? true : false}
              onChange={(e) => this.update('hide-description',e.target.checked ? "hide" : "show")}
            />
            Hide plot summaries
          </li>
          <li id='settings-prefs-showdialogs' className='subsection' style={{display: this.props.settings.preferences.overridedialogs && Object.keys(this.props.settings.preferences.overridedialogs).length > 0 ? 'block' : 'none'}}>
            <h2>Show Dialogs:</h2>
            {this.state.overridedialogs ? Object.keys(this.state.overridedialogs).map(dialogName => (
              <div key={dialogName}>
                <input
                  type='checkbox'
                  checked={!this.state.overridedialogs[dialogName]}
                  onChange={(e) => this.update('override-dialogs',!e.target.checked,dialogName)}
                />
                {dialogDescriptions[dialogName] || dialogName}
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

    return (
      <div className="row" id={'settings-playlists-row-' + playlist.id} ref={this.props.innerRef} {...this.props.provided.draggableProps}>
        <div className='cell drag-button' {...this.props.provided.dragHandleProps}>{'\u2630'}</div>

        <div className='cell tab'><input type='checkbox' checked={playlist.tab} onChange={(e) => this.props.updateValue(this.props.index,'tab',e.target.checked)} /></div>

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
          />
        </div>

        <div className='header filter' id={'edit-filter-header-' + playlist.id} style={{display: 'none'}}>Filter</div>

        <div className="cell filter" id={'edit-filter-field-' + playlist.id} style={{display: 'none'}}>
          <textarea
            className='edit-filter-field'
            name="playlist filter"
            value={playlist.filterFunction}
            placeholder={'Enter a boolean expression to be executed on each video object: e.g. video.genre === \'Action\''}
            onChange={(e) => this.props.updateValue(this.props.index,'filterFunction',e.target.value)}
          />
        </div>

        <div className='header columns' id={'edit-columns-header-' + playlist.id} style={{display: 'none'}}>Columns</div>

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

        <div className='cell view'>
          <div className='select-container select-alwaysicon'>
            <select value={playlist.view} onChange={(e) => this.props.updateValue(this.props.index,'view',e.target.value)}>
              <option value='flat'>Flat</option>
              <option value='hierarchical'>Hierarchical</option>
            </select>
          </div>
        </div>

        <div className='cell edit-btn'>
          <button onClick={() => this.props.showEditPlaylist(playlist)}>Edit</button>
        </div>

        <div className='cell delete-btn'>
          <button onClick={() => this.props.deletePlaylist(playlist)}>Delete</button>
        </div>
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
  }

  addCollection(e) {
    e.stopPropagation();

    // DOM element of parent collection
    const parentEl = findNearestOfClass(e.target,'collection');

    // if we found a parent collection element
    let parentCol, parentChildren;
    if (parentEl) {
      // get the actual collection object of the parent
      parentCol = getCollectionObject(parentEl.id.split('_')[1], this.state.collections, false);

      // then get the parent's array of child collections, creating one if it doesn't already exist
      if (!parentCol.collections) {
        parentCol.collections = [];
      }
      parentChildren = parentCol.collections;
    } else {
      // if we did not, we're adding a top-level collection,
      // so set parentChildren to the top-level array itself
      parentChildren = this.state.collections;
    }

    try {
      console.log('Parent collection: ' + parentCol.name);
    } catch(err) {
      console.log('Parent collection: top level (none)');
    }

    parentChildren.push({
      "id" : "1-1",
      "name" : "Example",
      "videos" : [
        { "id" : 7, "order" : 1}
      ]
    });

    // this.state.collections is actually altered in place
    // but we need to explicitly set it in order to get a re-render
    this.setState({collections: this.state.collections});
  }

  createAddCollectionBtn() {
    return (
      <div key='add' className='add-collection clickable' onClick={(e) => this.addCollection(e)}>
        <h1>{'\uFF0B'}</h1>
      </div>
    );
  }

  findCollections(collections) {
    let collectionsJSX = collections.map(collection => {
      let children = null;
      let addButton = null;

      // if this collection has child collections
      if (collection.collections) {
        // attach those collections as children
        children = this.findCollections(collection.collections);

        // and create an add button so the user can create more child collections;
        // since this is not a bottom-level collection containing videos,
        // it is allowed to have child collections
        addButton = this.createAddCollectionBtn();

      // if the collection does not have child collections,
      // it is a bottom-level collection, probably containing videos
      // (though it may not contain videos)
      // so if it contains videos, attach those videos as children
      } else if (collection.videos) {
        children = collection.videos.sort((a,b) => a.order > b.order ? 1 : a.order < b.order ? -1 : 0).map(vidToken => {
          let video = null;
          try {
            video = this.props.videos.filter(video => video.id === vidToken.id)[0];

            return (
              <div key={vidToken.order} className='video'>
                {vidToken.order}: {video.title}
              </div>
            );
          } catch(err) {
            console.error(`Error: could not find video (id: ${vidToken.id}) from collection "${collection.name}" in library`);
          }
          return null;
        });
      // if the collection contains neither collections nor videos
      // it is an empty bottom-level collection, in which case the user
      // is still allowed to create a child collection for it
      // (making it no longer a bottom-level collection)
      // so we create an add button
      } else {
        addButton = this.createAddCollectionBtn();
      }

      return (
        <div key={collection.id} id={'settings-col_' + collection.id} className='collection'>
          <header>
            <h1>{collection.name}</h1>
            {addButton}
          </header>
          {children}
        </div>
      );
    });

    return (
        <div className='collections'>
          {collectionsJSX}
        </div>
    );
  }

  render() {
    return (
      <div id='settings-collections'>
        {this.createAddCollectionBtn()}
        {this.findCollections(this.state.collections)}
      </div>
    );
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
    let vidCols = props.video && collections ? collections.getVideoCollections(props.video.id) : {};
    // let videoWithCols = {...props.video, ...vidCols};
    let videoWithCols = props.video;
    if (videoWithCols) videoWithCols.collections = vidCols;

    this.state = {
      paneID: 'editor-pane',
      video: _.cloneDeep(videoWithCols), // add collections to video object during editing, so we can use the validation machinery (and the hash, to see if the user has made a change)
      collections: collections,
      placeholderImage: "../images/qmark.png",
      valid: {},
      saveHash: hashObject(videoWithCols)
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
          collection.addVideo(this.state.video.id,collectionUpdate[id]);
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
            collection.removeVideo(this.state.video.id);
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
            let success = collection.updateOrder(this.state.video.id, collectionUpdate[id]);
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
      const newArtworkPath = path.join(artworkFolder, uuidv4() + fileExt);
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
    // (delete the temporary collections information from the video,
    // we don't want to save this)
    let temp = _.cloneDeep(this.state.video);
    delete temp.collections;
    let index = library.media.findIndex((video) => video.id === this.props.video.id);
    library.replace("media." + index, temp);

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

    // save hash so that later we can check if the video has changed,
    // in order to ask the user if they want to save before exiting
    this.setState({saveHash: hashObject(this.state.video) });

  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.video,this.props.video)) {
      // console.log('MynEditor props.video has changed!!!');

      // attach a temporary collections object to each video,
      // containing information on all the collections the video is a part of
      let collections = this.props.collections ? new Collections(_.cloneDeep(this.props.collections)) : null;
      let vidCols = this.props.video && collections ? collections.getVideoCollections(this.props.video.id) : {};
      // let videoWithCols = {...this.props.video, ...vidCols};
      let videoWithCols = this.props.video;
      if (videoWithCols) videoWithCols.collections = vidCols;

      this.setState({
        video: _.cloneDeep(videoWithCols),
        collections : collections
      });

      // when a new movie is loaded, update the saveHash
      // (which is used for testing whether or not anything has changed since last save)
      this.setState({saveHash: hashObject(videoWithCols)});
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

        <MynEditorEdit
          show={this.props.show}
          video={this.state.video}
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
        return !_.isEqual(this.props.video,this.state.video);
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
      searchBaseURL: `http://www.omdbapi.com/?apikey=${omdb.key}`,
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
        if (!prefs.overridedialogs) {
          prefs.overridedialogs = {};
        }
        prefs.overridedialogs['MynEditorSearch-confirm-select'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.retrieveResult(video);
      } else {
        console.log('Selection cancelled by user')
      }
    });
  }

  // search online movie database to auto-fill fields
  handleSearch(event) {
    event.preventDefault();
    let urlParts = [this.state.searchBaseURL];

    // first check to see if the user has entered an IMDb ID
    let imdbSearchID = document.getElementById('editor-search-imdbID').value;
    if (imdbSearchID !== '') {
      // if they have, then we add that to the search
      urlParts.push(`i=${imdbSearchID}`);
    } else {
      // otherwise, we want to query the database using the existing field values
      // of the movie object, if present; OMDB only allows us to search by Title,
      // Year, and Type;
      // if the title field is empty, we will substitute the file name
      const filename = this.props.video.filename.match(/[^/]+$/)[0]; // get just the filename from the path // /[^/]+(?=\.\w{2,4}$)/
      console.log('filename: ' + filename);
      const titleQuery = this.props.video.title !== '' ? this.props.video.title : filename;
      const yearQuery = this.props.video.year !== '' ? this.props.video.year : null
      const typeQuery = this.props.video.kind === 'movie' ? 'movie' : this.props.video.kind === 'show' ? 'episode' : null;

      // compose query url
      urlParts.push(`s=${titleQuery}`);
      if (yearQuery) urlParts.push(`y=${yearQuery}`);
      if (typeQuery) urlParts.push(`type=${typeQuery}`);
    }

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
    } else if (results.Response === 'False') { // || !results.hasOwnProperty('Search')) {
      // then there were no results found
      // during testing, just use an alert to tell the user
      this.setState({results:null});
      alert('No results found! Try editing the title and searching again, or enter the IMDb ID for an exact match.');
    } else {
      // if we're here, we got results
      console.log(results);

      // if the user entered an IMDb ID, then only one movie object should have been returned
      // instead of an array of search results; in this case, we'll just package that movie
      // into an array so that we can display it as though it were a single-hit search result
      if (!results.hasOwnProperty('Search')) {
        results.Search = [
          {
            Poster: results.Poster,
            Title: results.Title,
            Type: results.Type,
            Year: results.Year,
            imdbID: results.imdbID
          }
        ];
      }

      // display search results
      let movies = results.Search.map((movie) => {
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
    }
  }

  clearSearch() {
    this.setState({results:null});
  }

  chooseResult(movie) {
    // if the user hasn't previously selected the preference to override this confirmation dialog
    if (!this.props.settings.preferences.overridedialogs || !this.props.settings.preferences.overridedialogs['MynEditorSearch-confirm-select']) {
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
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            newData.directorsort = /^\w+\s\w+$/.test(response.data.Director) ? response.data.Director.replace(/^(\w+)\s(\w+)$/,($match,$1,$2) => `${$2}, ${$1}`) : response.data.Director; // if the director field consists only of a first and last name separated by a space, set directorsort to 'lastname, firstname', otherwise, leave as-is and let the user edit it manually
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            newData.cast = response.data.Actors.split(', ');
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            newData.genre = response.data.Genre.split(', ')[0]; // just pick the first genre for genre, since we only allow one
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            newData.languages = response.data.Language.split(', ');
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            newData.tags = Array.from(new Set(response.data.Genre.split(', ').map((item) => item.toLowerCase()).concat(this.props.video.tags))); // add new tags to existing tags, removing duplicates
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          let ratings = _.cloneDeep(this.props.video.ratings);
          try {
            ratings.imdb = Number(response.data.Ratings.filter(object => object.Source == "Internet Movie Database")[0].Value.match(/^[\d\.]+(?=\/)/)); // / 10;
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            ratings.rt = Number(response.data.Ratings.filter(object => object.Source == "Rotten Tomatoes")[0].Value.match(/^\d+/)); // / 100;
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          try {
            ratings.mc = Number(response.data.Ratings.filter(object => object.Source == "Metacritic")[0].Value.match(/^\d+(?=\/)/)); // / 100;
          } catch(err) { console.error(`OMDB parse: ${err}`); }
          newData.ratings = ratings;

          // put the new data into the editor fields
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
          <div id='edit-search-controls'>
            {searchBtn}
            <div className="input-container controls">
              <input id="editor-search-imdbID" className="filled" type="text" placeholder="IMDb ID (optional)" />
              <div className="input-clear-button hover" onClick={() => {document.getElementById('editor-search-imdbID').value = ''}}></div>
            </div>
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
        if (!prefs.overridedialogs) {
          prefs.overridedialogs = {};
        }
        prefs.overridedialogs['MynEditorEdit-confirm-revert'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.props.revertChanges();
      } else {
        console.log('Reversion cancelled by user');
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
    if (!saved && (!this.props.settings.preferences.overridedialogs || !this.props.settings.preferences.overridedialogs['MynEditorEdit-confirm-revert'])) {
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

    // validate the video in place (function fixes any broken values)
    // and also, if any changes were made (i.e. broken values fixed)
    // save the changes
    if (validateVideo(this.props.video) !== true) {
      this.props.saveChanges();
    }
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  render() {
    if (this.props.show === false) {
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

    /* KIND */
    let options = this.props.settings.used.kinds.map(kind => (
      <option key={kind} value={kind}>{kind}</option>
    ));
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
            property="collections"
            collections={this.props.collections}
            update={this.props.handleChange}
            validator={this.state.validators.number.exp}
            validatorTip={this.state.validators.number.tip}
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
    } else if (!this.props.noClear) {
      // only create a clear button if there's no dropdown
      clearBtn = (<div className="input-clear-button hover" onClick={this.clearInput}></div>);
    }

    return (
      <div>
        <input
          ref={this.input}
          className={(this.props.className || '') + (this.props.noClear ? ' no-clear' : '')}
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
    this._isMounted && ipcRenderer.send('download', url);
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

  render() {
    if (this.props.movie.duration === 0 || this.props.movie.duration === '') {
      return null;
    } else {
      return super.render();
    }
  }
}

// ######  ###### //
class MynEditListWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      list: []
    }

    ipcRenderer.on('MynEditListWidget-confirm-delete-item', (event, response, index) => {
      if (response === 0) { // yes
        // delete item (pass 'true' so as not to prompt another dialog)
        this.deleteItem(index, true);
      } else {
        console.log('Deletion cancelled by user')
      }
    });

    this.render = this.render.bind(this);
    this.updateList = this.updateList.bind(this);
  }

  updateList(list) {
    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  deleteItem(index, skipDialog) {
    if (this.props.deleteDialog && !skipDialog) {
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

      return (<li key={index} className="list-widget-item">{displayItem}<div className="list-widget-delete-item inline-delete-button" onClick={() => this.deleteItem(index)}>{"\u2715"}</div></li>);
    });
  }

  componentDidMount(props) {
    this.updateList(this.props.object[this.props.property]);
  }

  componentDidUpdate(oldProps) {
    if (oldProps.object[this.props.property] !== this.props.object[this.props.property]) {
      this.updateList(this.props.object[this.props.property]);
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
    'director':'string',
    'directorsort':'string',
    'cast':'array',
    'description':'string',
    'genre':'string',
    'tags':'array',
    'seen':'boolean',
    'position':'integer',
    'duration':'integer',
    'ratings':'object',
    'dateadded':'integer',
    'lastseen':'integer',
    'kind':'string',
    'filename':'string',
    'artwork':'string',
    'collections':'object',
    'boxoffice':'number',
    'rated':'string',
    'languages':'array',
    'country':'string'
  };

  let vidProps = Object.keys(video);
  let propKeys = Object.keys(properties);
  for(const property of propKeys){
    if (vidProps.includes(property)) {
      // repair any malformed properties
      switch(properties[property]) {
        // ratings, collections
        case 'object' :
          if (typeof video[property] !=='object' || typeof video[property] === null) {
            repaired[property] = {};
          }
          break;
        // tags, cast, languages
        case 'array' :
          if (!Array.isArray(video[property])) {
            repaired[property] = [];
          }
          break;
        // id, year, position, duration, dateadded, lastseen
        case 'integer' :
          repaired[property] = parseInt(video[property]);
          if (!Number.isInteger(repaired[property])) {
            repaired[property] = ''; // going with empty string instead of some integer like 0 or -1, for a variety of reasons
          }
          break;
        // boxoffice
        case 'number' :
          if (isNaN(video[property])) {
            repaired[property] = 0;
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
    } else {
      // the property doesn't exist, so create it
      repaired[property] = '';
    }
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
  const sources = ['imdb','rt','mc'];
  sources.map(source => {
    if (!keys.includes(source)) video.ratings[source] = '';
  });

  if (!_.isEqual(oldVidCopy,repaired)) {
    console.log('video had to be repaired: ' + video.title);
    // return repaired;
    return false;
  } else {
    return true;
  }
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
ReactDOM.render(<Mynda library={library}/>, document.getElementById('root'));
