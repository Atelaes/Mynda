//const React = require('React');

class Mynda extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      videos : library.media,
      playlists : library.playlists,
      collections : library.collections,
      settings: library.settings,
      filteredVideos : [],
      view : "flat", // whether to display a flat table or a hierarchical view
      detailId: null,
      detailMovie: {},
      settingsPane: null
    }

    this.render = this.render.bind(this);
    this.playlistFilter = this.playlistFilter.bind(this);
    this.setPlaylist = this.setPlaylist.bind(this);
    this.showDetails = this.showDetails.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.showSettings = this.showSettings.bind(this);
    this.hideSettings = this.hideSettings.bind(this);
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

    return this.state.videos.filter(video => eval(playlist.filterFunction))
  }

  // called from the nav component to change the current playlist
  setPlaylist(id,element) {
    // this.state.currentPlaylistID = id
    this.setState({filteredVideos : this.playlistFilter(id), view : this.state.playlists.filter(playlist => playlist.id == id)[0].view})
    Array.from(element.parentNode.children).map((child) => { child.classList.remove('selected') });
    element.classList.add('selected');
    // alert(this.state.currentPlaylistID)
  }

  showSettings() {
    this.setState({"settingsPane" : <MynSettings settings={this.state.settings} hideFunction={this.hideSettings}/>});
  }

  hideSettings() {
    this.setState({"settingsPane" : null});
  }

  // set the initial playlist
  componentDidMount(props) {
    // let playlist = library.playlists[0];
    // this.setState({filteredVideos : this.playlistFilter(playlist.id), view : playlist.view})
    // this.setPlaylist(playlist.id, document.getElementById('playlist-nav').getElementsByTagName('li')[0]);
    document.getElementById('playlist-nav').getElementsByTagName('li')[0].click();
  }

  render () {
    return (<div id='grid-container'> <MynNav playlists={this.state.playlists} setPlaylist={this.setPlaylist} showSettings={this.showSettings}/> <MynTableContainer movies={this.state.filteredVideos} collections={this.state.collections} view={this.state.view} showDetails={this.showDetails} /> <MynDetails movie={this.state.detailMovie} /> {this.state.settingsPane}</div>);
  }
}

// ###### Nav bar: contains playlist tabs and search field ###### //
class MynNav extends React.Component {
  constructor(props) {
    super(props)

    this.render = this.render.bind(this);
  }

  render() {
    return (<div id="nav-bar">
        <ul id="playlist-nav">
          {this.props.playlists.map((playlist, index) => (
            <li key={playlist.id} style={{zIndex: 9999 - index}} className={playlist.view} onClick={(e) => this.props.setPlaylist(playlist.id,e.target)}>{playlist.name}</li>
          ))}
        </ul>
        <div id="search-field"><span id="search-label">Search: </span><input type="text" placeholder="Search..." /></div>
        <div id="settings-button" onClick={() => this.props.showSettings()}>{"\u2699"}</div>
      </div>)
  }
}



// ###### Table Container: parent of MynTable, decides whether to display one table (in a flat view), or a hierarchy of tables (in the heirarchical view) ###### //
class MynTableContainer extends React.Component {
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
      let flag = false;
      let videos = []
      try {
        // if this collection has a video in our playlist
        for (let i=0; i<object.videos.length; i++) {
          if (this.props.movies.filter(movie => (object.videos[i].id === movie.id)).length > 0) {
            videos.push(object.videos[i]);
            flag = true;
          }
        }
      } catch(e) {
        console.log("Error, no videos found in this collection: " + e.toString());
      }
      // if the flag is true, that means there were videos from our playlist
      // in this collection, so wrap them in JSX and return them upward
      if (flag) {
        // find only the movie objects (from the playlist) that match the videos found in this collection
        let movies = this.props.movies.filter(movie => (videos.filter(collectionVideo => (collectionVideo.id === movie.id)).length > 0))
        // console.log('movies: ' + JSON.stringify(movies) + '\nVideos from collection: ' + JSON.stringify(videos));
        try {
          // add the 'order' property to each movie for this collection
          // (making a deep copy of each movie object)
          movies = movies.map(movie => {
            const movieCopy = JSON.parse(JSON.stringify(movie));
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
        // then hand them off to MynTable with an initial sort by 'order'
        return (<div className="collection collapsed" key={object.name}><h1 onClick={(e) => this.toggleExpansion(e)}>{object.name}</h1><div className="container hidden"><MynTable movies={movies} initialSort="order" showDetails={this.props.showDetails} /></div></div>)
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

      content = (<MynTable movies={this.props.movies} view={this.props.view} showDetails={this.props.showDetails} />)

    } else {
      console.log('Playlist has bad "view" parameter ("' + this.props.view + '"). Should be "flat" or "hierarchical"');
      return null
    }
    return (<div id="library-pane">{content}</div>);
  }
}

// ###### Table: contains list of movies in the selected playlist ###### //
class MynTable extends React.Component {
  constructor(props) {
    super(props)
    this.render = this.render.bind(this);

    this.state = {
      sortKey: null,
      sortDirection: 'ascending',
      sortedRows: [],
      displayOrderColumn: "table-cell"
    }

    this.requestSort = this.requestSort.bind(this);
    this.onChange = this.onChange.bind(this);
    this.render = this.render.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.componentDidUpdate = this.componentDidUpdate.bind(this);
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
    if (e.target.tagName == 'TD') { // only execute on the title cell, not the title text container within it
      let titleDiv = e.target.getElementsByClassName("table-title-text")[0];
      if (titleDiv.offsetWidth < titleDiv.scrollWidth) { // text is overflowing
        titleDiv.classList.add('overflow');
      }
    }
  }

  titleOut(e) {
    // console.log("leave");
    e.stopPropagation();
    // remove the 'overflow' class in case it was added
    if (e.target.tagName == 'TD') { // only execute on the title cell, not the title text container within it
      let titleDiv = e.target.getElementsByClassName("table-title-text")[0];
      titleDiv.classList.remove('overflow');
    }
  }

  requestSort(key) {

    let direction = 'ascending';
    if (this.state.sortKey === key && this.state.sortDirection === 'ascending') {
     direction = 'descending';
    }
    let asc = direction === 'ascending' ? true : false;
    let sortFunctions = {
     title: (a, b) => this.removeArticle(a.title) > this.removeArticle(b.title),
     year: (a, b) => a.year > b.year,
     director: (a, b) => a.directorsort > b.directorsort,
     genre: (a, b) => a.genre > b.genre,
     seen: (a, b) => a.seen > b.seen,
     rating: (a, b) => a.rating > b.rating,
     dateadded: (a, b) => parseInt(a.dateadded) > parseInt(b.dateadded),
     order: (a, b) => a.order > b.order
    }

    let rows = this.props.movies.sort((a, b) => {

      let result = sortFunctions[key](a, b);
      result = asc ? result : !result;

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
        <td className="seen centered"><MynSeenCheckmark movie={movie} /></td>
        <td className="rating centered"><MynRatingStars movie={movie} /></td>
        <td className="dateadded centered mono">{displaydate}</td>
      </tr>
    )})

    this.setState({ sortKey: key, sortDirection: direction , sortedRows: rows});
  }

  onChange() {
    // decide whether to show the 'order' column
    // if (this.props.movies.filter(movie => (movie.order === undefined || movie.order === null)).length == this.props.movies.length) {
      // if none of the movies handed to us have an "order" property
      //    (not within the collections property, but a top-level "order" property—
      //    this property does not exist in the library JSON, but is assigned by MynTableContainer
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

  componentDidMount(props) {
    // this.props.movies.map(movie => console.log(JSON.stringify(movie)));
    this.onChange();
  }

  componentDidUpdate(oldProps) {
    if (oldProps.movies !== this.props.movies) {
      this.onChange();
    }
  }

  render() {
    return  (<table id="movie-table">
              <thead>
                <tr id="main-table-header-row">
                  <th onClick={() => this.requestSort('order')} style={{display:this.state.displayOrderColumn}}>#</th>
                  <th onClick={() => this.requestSort('title')}>Title</th>
                  <th onClick={() => this.requestSort('year')}>Year</th>
                  <th onClick={() => this.requestSort('director')}>Director</th>
                  <th onClick={() => this.requestSort('genre')}>Genre</th>
                  <th onClick={() => this.requestSort('seen')}>Seen</th>
                  <th onClick={() => this.requestSort('rating')}>Rating</th>
                  <th onClick={() => this.requestSort('dateadded')}>Added</th>
                </tr>
              </thead>
              <tbody>
                {this.state.sortedRows}
              </tbody>
            </table>)
  }
}

// ######  ###### //
class MynGraphicalEditWidget extends React.Component {
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
    console.log("Changed " + this.props.movie.title + "'s " + this.state.property + " value to " + value + "! ...but not really. JSON library has not been updated!");
    event.stopPropagation(); // clicking on the stars should not trigger a click on the whole row
    this.props.movie[this.state.property] = value;
    event.target.parentNode.classList.remove('over');
  }

  mouseOver(value,event) {
    this.updateGraphic(value);
    event.target.parentNode.classList.add('over');
  }

  mouseOut(target,event) {
    this.updateGraphic(this.props.movie[this.state.property]);
    target.classList.remove('over');
    // console.log("RATING OUT: " + target.classList)
    try{
      event.stopPropagation();
    } catch(error) {
      // console.log("called from <ul>");
    }
  }

  componentDidMount(props) {
    this.setState({className : this.state.className + " edit-widget"})
    this.updateGraphic(this.props.movie[this.state.property]);
  }

  componentDidUpdate(oldProps) {
    if (oldProps.movie[this.state.property] !== this.props.movie[this.state.property]) {
      this.updateGraphic(this.props.movie[this.state.property]);
    }
  }

  // updateGraphic(graphic) {
  //   this.setState({displayGraphic : graphic});
  // }

  render() {
    return (<ul className={this.state.className} onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayGraphic}</ul>);
  }
}

// ######  ###### //
class MynRatingStars extends MynGraphicalEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "rating",
      className : "stars"
    }

    this.render = this.render.bind(this);
  }

  updateGraphic(rating) {
    let stars = [];
    let char = "";
    for (let i=1; i<=5; i++) {
      if (i <= rating) {
        char="\u2605";
      } else {
        char="\u2606";
      }
      stars.push(<li className="star" key={i} onMouseOver={(e) => this.mouseOver(i,e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(i,e)}>{char}</li>);
    }
    this.setState({displayGraphic : stars});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// ######  ###### //
class MynSeenCheckmark extends MynGraphicalEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "seen",
      className : "checkmarkContainer"
    }

    this.render = this.render.bind(this);
  }

  updateGraphic(seen) {
    let graphic = <li className="checkmark" onMouseOver={(e) => this.mouseOver(!this.props.movie.seen,e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(!this.props.movie.seen,e)}>{seen ? "\u2714" : "\u2718"}</li>;
    this.setState({displayGraphic : graphic});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// // ######  ###### //
// class MynStars extends React.Component {
//   constructor(props) {
//     super(props)
//
//     this.state = {
//       displayStars : [],
//     }
//
//     this.render = this.render.bind(this);
//   }
//
//   updateRating(rating, event) {
//     console.log("Rated " + this.props.movie.title + " " + rating + " stars!");
//     event.stopPropagation(); // clicking on the stars should not trigger a click on the whole row
//     this.props.movie.rating = rating;
//     event.target.parentNode.classList.remove('over');
//   }
//
//   ratingOver(rating,event) {
//     this.updateStars(rating);
//     event.target.parentNode.classList.add('over');
//   }
//
//   ratingOut(target,event) {
//     this.updateStars(this.props.movie.rating);
//     target.classList.remove('over');
//     // console.log("RATING OUT: " + target.classList)
//     try{
//       event.stopPropagation();
//     } catch(error) {
//       // console.log("called from <ul>");
//     }
//   }
//
//   componentDidMount(props) {
//     this.updateStars(this.props.movie.rating);
//   }
//
//   componentDidUpdate(oldProps) {
//     if (oldProps.movie.rating !== this.props.movie.rating) {
//       this.updateStars(this.props.movie.rating);
//     }
//   }
//
//   updateStars(rating) {
//     let stars = [];
//     let char = "";
//     for (let i=1; i<=5; i++) {
//       if (i <= rating) {
//         char="\u2605";
//       } else {
//         char="\u2606";
//       }
//       stars.push(<li className="star" key={i} onMouseOver={(e) => this.ratingOver(i,e)} onMouseOut={(e) => this.ratingOut(e.target.parentNode,e)} onClick={(e) => this.updateRating(i,e)}>{char}</li>);
//     }
//     this.setState({displayStars : stars});
//   }
//
//   render() {
//     return (<ul className="stars" onMouseOut={(e) => this.ratingOut(e.target)}>{this.state.displayStars}</ul>);
//   }
// }

// ###### Details pane: contains details of the hovered/clicked video ###### //
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

  componentDidUpdate(oldProps) {
    try {
      let titleDiv = document.getElementById('detail-title').getElementsByClassName('detail-title-text')[0];
      if (titleDiv.offsetWidth < titleDiv.scrollWidth) { // text is overflowing
        titleDiv.classList.add('overflow');
      }
    } catch(e) {

    }
  }

  render() {
    let details
    try {
      const movie = this.props.movie
      details = (<ul>
          <li className="detail" id="detail-artwork"><img src={movie.artwork} /></li>
          <li className="detail" id="detail-title"><div className="detail-title-text">{movie.title}</div></li>
          <li className="detail" id="detail-position"><div className="position-outer"><div className="position-inner" style={{width:(movie.position / movie.duration * 100) + "%"}} /></div></li>
          <li className="detail" id="detail-description">{movie.description}</li>
          <li className="detail" id="detail-director"><span className="label">Director:</span> {movie.director}</li>
          <li className="detail" id="detail-cast"><span className="label">Cast:</span> {movie.cast.join(", ")}</li>
          <li className="detail" id="detail-tags"><span className="label">Tags:</span> {movie.tags}</li>
          <li className="detail" id="detail-lastseen"><span className="label">Last Seen:</span> {this.lastseenDisplayDate(movie.lastseen)}</li>
        </ul>);
    } catch (error) {
      details = <div>No Details</div>
      // console.log(error.toString());
    }

    return  (<aside id="details-pane">
              {details}
            </aside>)
  }
}

class MynSettings extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      settingView: null
    }

    this.render = this.render.bind(this);
  }

  setView(view) {
    let views = {
      folders : (<MynSettingsFolders folders={this.props.settings.watchfolders}/>),
      themes : (<MynSettingsThemes />)
    }
    this.setState({settingView : views[view]});
  }

  componentDidMount(props) {
    this.setView('folders');
  }

  render() {
    return (<div id="settings-pane">
      <div id="close-settings-button" onClick={() => this.props.hideFunction()}>{"\u2715"}</div>
      <ul>
        <li onClick={() => this.setView("folders")}>Folders</li>
        <li onClick={() => this.setView("themes")}>Themes</li>
      </ul>
      <div id="settings-content">{this.state.settingView}</div>
    </div>)
  }
}

class MynSettingsFolders extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    return (<h1>I'm a Folders!!!</h1>)
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



ReactDOM.render(<Mynda />, document.getElementById('root'));
