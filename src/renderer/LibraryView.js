// Library tables, series grouping, details, and playlist-level controls.
const React = require('react');
const {ipcRenderer, shell} = require('electron');
const os = require('os');
const _ = require('lodash');
const URL = require('url');
const accounting = require('accounting');
const {
  library,
  libraryViewLog,
  playerLog,
  placeholderImage,
  disableConfirmationDialog
} = require('./RendererRuntime.js');
const {
  removeLeadingArticle,
  validateVideo,
  findNearestOfClass,
  getObjectDiff,
  getArrayDiff
} = require('./RendererUtils.js');
const {MynOverflowTextMarquee} = require('./SharedComponents.js');
const {
  MynEditSeenWidget,
  MynEditWatchlaterWidget,
  MynEditRatingWidget,
  MynEditPositionWidget,
  MynShowPositionWidget
} = require('./EditorFields.js');

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
      libraryViewLog.error('Playlist has an invalid view', {
        playlistID: this.props.playlistID,
        view: this.props.view,
        allowedViews: ['flat', 'series']
      });
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
          mediaRevision={this.props.mediaRevision}
          playVideo={this.props.playVideo}
          toggleCompact={this.toggleCompact}
          changeView={this.props.changeView}
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
    // Match title sorting in the flat library table: leading articles do not
    // determine where a series appears, but remain visible in its heading.
    let seriesKeys = Object.keys(this.state.manifest);
    seriesKeys.sort((a,b) => {
      const aSortTitle = removeLeadingArticle(a).toLowerCase();
      const bSortTitle = removeLeadingArticle(b).toLowerCase();
      return aSortTitle > bSortTitle ? 1 : (aSortTitle < bSortTitle ? -1 : 0);
    });

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
    this.props.changeView(view);
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
          <MynRecentlyWatched
            list={this.props.recentlyWatched}
            mediaRevision={this.props.mediaRevision}
            selected={0}
            playVideo={this.props.playVideo}
          />
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

      playerLog.debug('Playback requested by double-clicking a library row', {
        videoID: id,
        rowID: rowID
      });
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
    libraryViewLog.debug('Sorting library table', {
      tableID: this.tableID,
      sortKey: key,
      requestedAscending: ascending,
      videoCount: this.props.movies.length
    });

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
     title: (a, b) => [removeLeadingArticle(a.title).toLowerCase(),removeLeadingArticle(b.title).toLowerCase()],
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

    libraryViewLog.debug('Library table sorting finished', {
      tableID: this.tableID,
      sortKey: key,
      ascending: ascending,
      rowCount: rows.length
    });
  }

  // Sort the rows and rebuild the table content.
  reset(sortValue) {
    libraryViewLog.debug('Resetting library table', {
      tableID: this.tableID,
      requestedSort: sortValue,
      currentSortKey: this.state.sortKey
    });

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
      libraryViewLog.debug('Library table rows were unselected externally', {
        tableID: this.tableID
      });
      this.setState({batchSelected:[]},this.handleBatch);
    }
    // if the selection of rows in this table was otherwise changed from the outside
    // (though I don't know when that would happen besides a simple unselection)
    // update the state variable
    if (this.props.selectedRows[this.tableID] && oldProps.selectedRows[this.tableID] && !_.isEqual(this.props.selectedRows[this.tableID],oldProps.selectedRows[this.tableID]) && this.props.selectedRows[this.tableID].rows) {
      libraryViewLog.debug('Library table selection changed externally', {
        tableID: this.tableID,
        selectedVideoCount: this.props.selectedRows[this.tableID].rows.length
      });
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
      libraryViewLog.debug('Library table playlist changed', {
        tableID: this.tableID,
        previousPlaylistID: oldProps.playlistID,
        playlistID: this.props.playlistID
      });
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
      let columnsChanged = !_.isEqual(oldProps.columns, this.props.columns);
      if (moviesChanged || includeUserRatingChanged || columnsChanged) {
        libraryViewLog.debug('Library table data changed', {
          tableID: this.tableID,
          moviesChanged: moviesChanged,
          includeUserRatingChanged: includeUserRatingChanged,
          columnsChanged: columnsChanged
        });
        // let diff = getArrayDiff(tempOld,tempNew);
        // console.log(diff);
        // diff.map(key => {
        //   console.log(`Old[${key}]: ${tempOld[key].title}\nNew[${key}]: ${tempNew[key].title}`);
        // });
        // console.log(`old rating_in_avg: ${this.state.include_user_rating_in_avg}, new rating_in_avg: ${this.props.settings.preferences.include_user_rating_in_avg}`);
        // for some reason, comparing oldProps did not work for this, because oldProps and this.props were always the same; I have no idea why; so we just use a state variable to compare
        this.state.include_user_rating_in_avg = this.props.settings.preferences.include_user_rating_in_avg;

        // Rebuild the cached header and row JSX when the visible columns
        // change. Preserve the current sort when its column is still present;
        // otherwise return to the playlist's normal initial-sort behavior.
        let activeSortColumnWasRemoved = columnsChanged &&
          !this.props.columns.includes(this.state.sortKey);
        this.reset(activeSortColumnWasRemoved ? 'initial-sort' : undefined);
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
        libraryViewLog.debug('Inline video edit canceled by user', {
          videoID: originalVid && originalVid.id
        });
      }

      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (skipDialog && response === 0) {
        // console.log('option to override dialog was checked!');
        disableConfirmationDialog('MynLibTable-confirm-inlineEdit', libraryViewLog);
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
      libraryViewLog.warn('Could not format a date in the details pane', {
        value: value,
        error: e
      });
      displaydate = "";
    }
    return displaydate;
  }

  clickDescrip(e) {
    // if (this.props.settings.preferences.hide_description === "hide") {
      try {
        document.getElementById('detail-description').classList.toggle('hide');
      } catch(err) {
        libraryViewLog.warn('Could not toggle the details description', {error: err});
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
      libraryViewLog.error('Bad arguments were supplied to the details-pane video save', {
        argumentCount: args.length,
        argumentTypes: args.map(value => typeof value)
      });
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
          libraryViewLog.warn('Could not find the details description while applying visibility preferences', {
            error: err
          });
        }
      }
    }

    // if the user has scrolled, we want to show or not show the scroll button
    // depending on whether the row of the details video is still in view
    if (oldProps.libraryScroll !== this.props.libraryScroll) {
      if (this.scrollBtn.current && !this.props.isRowVisible(this.props.rowID)) {
        libraryViewLog.debug('Details video row is outside the visible library area', {
          videoID: this.props.video && this.props.video.id,
          title: this.props.video && this.props.video.title
        });
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
      playerLog.debug('No next video was found in the series');
    }
  }

  componentDidMount() {
    this.createListItems();
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.list,this.props.list) ||
      oldProps.mediaRevision !== this.props.mediaRevision) {
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

module.exports = {
  MynLibrary,
  MynLibSeries,
  MynPlaylistBar,
  MynLibTable,
  MynLibTableRow,
  MynDetails,
  MynDropdown,
  MynRecentlyWatched
};
