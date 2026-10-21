const path = require('path');
const {EventEmitter} = require('events');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures.js');
const {deepFreeze} = require('../src/library/LibraryProtocol.js');

require('@babel/register')({
  presets: [require.resolve('@babel/preset-react')],
  extensions: ['.js'],
  ignore: [/node_modules/],
  cache: false
});

const ipcRenderer = new EventEmitter();
ipcRenderer.sent = [];
ipcRenderer.send = function send(channel, ...args) {
  this.sent.push({channel, args});
};
const logEntries = [];
const testLog = level => (message, data) => logEntries.push({level, message, data});
const logger = {
  debug: testLog('debug'),
  info: testLog('info'),
  warn: testLog('warn'),
  error: testLog('error')
};

function placeholder(name) {
  const Component = props => React.createElement('div', {'data-mynda-component': name}, props.children);
  Component.displayName = name;
  return Component;
}

class Boundary extends React.Component {
  render() { return this.props.children; }
}

const runtimeLibrary = libraryFixture();
runtimeLibrary.replaceCalls = [];
runtimeLibrary.replace = function replace(address, value) {
  this.replaceCalls.push({address, value});
};

const savedPing = {};
global.window = {mynda: {app: {platform: process.platform},
  scan: {start: async () => { ipcRenderer.sent.push({channel: 'scan-watchfolders', args: []}); }}}};
const {Mynda} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'Mynda.js'),
  {
    'electron': {ipcRenderer},
    './RendererRuntime.js': {
      library: runtimeLibrary,
      frontendLog: logger,
      libraryViewLog: logger,
      playerLog: logger,
      savedPing
    },
    './SharedComponents.js': {ErrorBoundary: Boundary, MynNotify: placeholder('notify')},
    './Navigation.js': {MynNav: placeholder('navigation')},
    './LibraryView.js': {
      MynLibrary: placeholder('library'),
      MynDetails: placeholder('details')
    },
    './Settings.js': {MynSettings: placeholder('settings')},
    './Editor.js': {MynEditor: placeholder('editor')},
    './Player.js': {MynPlayer: placeholder('player')}
  }
);
const {MynLibrary, MynLibSeries, MynLibTable, MynDetails} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'LibraryView.js'), {
    './RendererRuntime.js': {library: runtimeLibrary, libraryViewLog: logger, playerLog: logger},
    'react-virtuoso': {TableVirtuoso: placeholder('virtual-table')},
    './SharedComponents.js': {MynOverflowTextMarquee: placeholder('marquee')},
    './EditorFields.js': Object.fromEntries(['MynEditSeenWidget', 'MynEditWatchlaterWidget',
      'MynEditRatingWidget', 'MynEditPositionWidget', 'MynShowPositionWidget']
      .map(name => [name, placeholder(name)]))
  }
);

const suite = createSuite(
  'Top-level Mynda React coordinator',
  'component',
  'Exercises application state and renders the real root component while replacing its large child panes.'
);

function makeLibrary() {
  const alien = videoFixture({id: 'alien', title: 'Alien', new: true, tags: ['space']});
  const arrival = videoFixture({id: 'arrival', title: 'Arrival', new: false, tags: ['language']});
  const show = videoFixture({id: 'show', title: 'The Expanse', kind: 'show', new: false});
  return libraryFixture({
    settings: {
      watchfolders: [],
      themes: {appearances: [], layouts: []},
      preferences: {
        include_user_rating_in_avg: false,
        include_new_vids_in_playlists: false,
        override_dialogs: {}
      },
      used: {kinds: ['movie', 'show'], genres: [], tags: []}
    },
    playlists: [
      {id: 'movies', name: 'Movies', filter_function: "video.kind === 'movie'", view: 'flat', tab: true, columns: ['title']},
      {id: 'shows', name: 'Shows', filter_function: "video.kind === 'show'", view: 'series', tab: true, columns: ['title']}
    ],
    recently_watched: ['arrival'],
    media: [alien, arrival, show]
  });
}

function instanceFor(library = makeLibrary()) {
  runtimeLibrary.media = library.media;
  runtimeLibrary.playlists = library.playlists;
  runtimeLibrary.settings = library.settings;
  runtimeLibrary.recently_watched = library.recently_watched;
  runtimeLibrary.replaceCalls.length = 0;
  const instance = new Mynda({library: runtimeLibrary});
  instance.setState = function synchronousSetState(update, callback) {
    const previousState = this.state;
    const patch = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = Object.assign({}, this.state, patch);
    this.componentDidUpdate(this.props, previousState);
    if (callback) callback();
  };
  return instance;
}

function findElement(tree, predicate) {
  for (const element of React.Children.toArray(tree)) {
    if (!React.isValidElement(element)) continue;
    if (predicate(element)) return element;
    const found = findElement(element.props.children, predicate);
    if (found) return found;
  }
  return null;
}

function paneProps(instance, name) {
  return findElement(instance.render(), element => element.type.displayName === name).props;
}

function stateful(component) {
  component.setState = (update, callback) => {
    component.state = {...component.state,
      ...(typeof update === 'function' ? update(component.state, component.props) : update)};
    if (callback) callback();
  };
  return component;
}

function updateProps(component, props) {
  const previous = component.props;
  component.props = props;
  if (component.componentDidUpdate) component.componentDidUpdate(previous);
}

function withOpenPlaylist(data, operation, playlistID = 'movies') {
  const previousDocument = global.document, searchField = {value: ''};
  let asynchronous = false;
  global.document = {getElementById: id => id === 'search-input' ? searchField :
    {getElementsByTagName: () => [{click() {}}]}};
  try {
    const instance = instanceFor(data);
    instance.componentDidMount();
    instance.setPlaylist(playlistID);
    const result = operation(instance, searchField);
    asynchronous = Boolean(result && typeof result.then === 'function');
    return asynchronous ? result.finally(() => { global.document = previousDocument; }) : result;
  } finally { if (!asynchronous) global.document = previousDocument; }
}

function commitPreferences(changes, address = 'settings.preferences') {
  // LibraryClient publishes a new immutable settings snapshot before notifying
  // Mynda. Do not mutate the old state: that would hide a stale-state bug.
  runtimeLibrary.settings = deepFreeze({...runtimeLibrary.settings,
    preferences: {...runtimeLibrary.settings.preferences, ...changes}});
  savedPing.saved([address]);
}

suite.test('normalizes column labels and rating scales for display and sorting', () => {
  const instance = instanceFor();
  assert.strictEqual(instance.displayColumnName('ratings_user'), 'Rating');
  assert.strictEqual(instance.displayColumnName('lastseen'), 'Last Seen');
  assert.strictEqual(instance.displayColumnName('runtime', true), 'Duration');
  assert.strictEqual(instance.calcAvgRatings({imdb: 8, rt: 100, user: 5}), '90%');
  assert.strictEqual(instance.calcAvgRatings({imdb: '', rt: '', user: ''}), '');
  assert.strictEqual(instance.calcAvgRatings({imdb: '', rt: ''}, 'sort'), -1);
  instance.state.settings.preferences.include_user_rating_in_avg = true;
  assert.strictEqual(instance.calcAvgRatings({imdb: 8, rt: 100, user: 5}), '93%');
});

suite.test('filters playlists and applies the include-new-videos preference', () => {
  const instance = instanceFor();
  assert.deepStrictEqual(instance.playlistFilter('movies').map(video => video.id), ['arrival']);
  instance.state.settings.preferences.include_new_vids_in_playlists = true;
  assert.deepStrictEqual(instance.playlistFilter('movies').map(video => video.id), ['alien', 'arrival']);
  assert.deepStrictEqual(instance.playlistFilter('shows').map(video => video.id), ['show']);
  assert.strictEqual(instance.state.playlistLength.movies, 2);
});

for (const address of ['settings.preferences.include_new_vids_in_playlists', 'settings.preferences', 'settings']) {
  suite.test(`refreshes the open playlist and counts on ${address} changes`, () => {
    const data = makeLibrary();
    data.settings.preferences.include_new_vids_in_playlists = true;
    data.playlists.push({id: 'new', name: 'New', filter_function: 'video.new', view: 'flat', columns: ['title']});
    withOpenPlaylist(data, (instance, searchField) => {
      assert.deepStrictEqual(instance.state.filteredVideos.map(video => video.id), ['alien', 'arrival']);
      // A settings refresh must preserve the current query and temporary view.
      searchField.value = 'Alien';
      instance.setPlaylist('movies');
      instance.changePlaylistView('series');
      commitPreferences({include_new_vids_in_playlists: false}, address);
      assert.deepStrictEqual(instance.state.playlistVideos.map(video => video.id), ['arrival']);
      assert.deepStrictEqual(instance.state.filteredVideos, []);
      assert.deepStrictEqual(instance.state.playlistLength, {movies: 1, shows: 1, new: 1});
      assert.strictEqual(instance.state.currentPlaylistID, 'movies');
      assert.strictEqual(instance.state.view, 'series');
      assert.strictEqual(searchField.value, 'Alien');
      commitPreferences({include_new_vids_in_playlists: true}, address);
      assert.deepStrictEqual(instance.state.filteredVideos.map(video => video.id), ['alien']);
      assert.strictEqual(instance.state.playlistLength.movies, 2);
      searchField.value = '';
      instance.setPlaylist('new');
      commitPreferences({include_new_vids_in_playlists: false}, address);
      assert.deepStrictEqual(instance.state.filteredVideos.map(video => video.id), ['alien'], 'New remains available');
    });
  });
}

suite.test('waits for the new settings to enter React state before filtering', () => {
  const data = makeLibrary();
  data.settings.preferences.include_new_vids_in_playlists = true;
  withOpenPlaylist(data, instance => {
    const applyState = instance.setState.bind(instance), queued = [];
    instance.setState = (update, callback) => queued.push({update, callback});
    commitPreferences({include_new_vids_in_playlists: false});
    assert.strictEqual(instance.state.filteredVideos.length, 2, 'The old snapshot remains until React commits');
    while (queued.length) {
      const {update, callback} = queued.shift();
      applyState(update, callback);
    }
    assert.deepStrictEqual(instance.state.filteredVideos.map(video => video.id), ['arrival']);
  });
});

suite.test('rapid preference commits leave the playlist on the latest value', () => {
  const data = makeLibrary();
  data.settings.preferences.include_new_vids_in_playlists = true;
  withOpenPlaylist(data, instance => {
    const applyState = instance.setState.bind(instance), queued = [];
    instance.setState = (update, callback) => queued.push({update, callback});
    commitPreferences({include_new_vids_in_playlists: false});
    commitPreferences({include_new_vids_in_playlists: true});
    while (queued.length) {
      const {update, callback} = queued.shift();
      applyState(update, callback);
    }
    assert.strictEqual(instance.state.settings.preferences.include_new_vids_in_playlists, true);
    assert.deepStrictEqual(instance.state.filteredVideos.map(video => video.id), ['alien', 'arrival']);
    assert.strictEqual(instance.state.playlistLength.movies, 2);
  });
});

suite.test('including user ratings updates displayed averages and their active sort immediately', () => {
  const data = makeLibrary();
  data.settings.preferences.include_new_vids_in_playlists = true;
  data.media[0].ratings = {imdb: 9, user: 1};
  data.media[1].ratings = {imdb: 5, user: 5};
  data.playlists[0].columns = ['title', 'ratings_avg'];
  data.playlists[0].flatDefaultSort = 'ratings_avg';
  withOpenPlaylist(data, instance => {
    const view = new MynLibrary(paneProps(instance, 'library'));
    const table = stateful(new MynLibTable(findElement(view.render(), element => element.type === MynLibTable).props));
    table.componentDidMount();
    const updateRatingPreference = value => {
      commitPreferences({include_user_rating_in_avg: value});
      view.props = paneProps(instance, 'library');
      updateProps(table, findElement(view.render(), element => element.type === MynLibTable).props);
    };
    const renderedRatings = () => table.state.sortedRows.map((row, index) =>
      ReactDOMServer.renderToStaticMarkup(React.createElement('table', null,
        React.createElement('tbody', null, React.createElement('tr', null, table.renderCells(index, row))))));
    assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID), ['alien', 'arrival']);
    assert(renderedRatings()[0].includes('90%'));
    updateRatingPreference(true);
    assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID), ['arrival', 'alien']);
    assert(renderedRatings()[0].includes('75%'));
    assert(renderedRatings()[1].includes('55%'));
    assert.strictEqual(table.state.sortKey, 'ratings_avg');
    assert.strictEqual(table.state.sortAscending, false);
    updateRatingPreference(false);
    assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID), ['alien', 'arrival']);
    table.reset('title');
    updateRatingPreference(true);
    assert.strictEqual(table.state.sortKey, 'title', 'A display preference must preserve an unrelated sort');
    assert.strictEqual(table.state.sortAscending, true);
    assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID), ['alien', 'arrival']);
    assert(renderedRatings()[0].includes('55%'));
  });
});

suite.test('plot-summary visibility updates the open details without changing the selected video', () => {
  withOpenPlaylist(makeLibrary(), instance => {
    instance.state.detailVideo = instance.state.filteredVideos[0];
    const selected = instance.state.detailVideo, videos = instance.state.filteredVideos;
    const details = new MynDetails(paneProps(instance, 'details'));
    for (const visibility of ['show', 'hide', 'show']) {
      commitPreferences({hide_description: visibility});
      updateProps(details, paneProps(instance, 'details'));
      const description = findElement(details.render(), element => element.props.id === 'detail-description');
      assert.strictEqual(description.props.className, `detail ${visibility}`);
      assert.strictEqual(details.props.video, selected);
      assert.strictEqual(instance.state.filteredVideos, videos, 'Presentation-only changes need not refilter the playlist');
    }
  });
});

suite.test('New-video visibility updates an expanded series without collapsing it', () => {
  const data = makeLibrary();
  data.settings.preferences.include_new_vids_in_playlists = true;
  data.media = [false, true].map((isNew, index) => videoFixture({id: `episode-${index}`,
    kind: 'show', series: 'Example', season: 1, episode: index + 1, new: isNew}));
  withOpenPlaylist(data, instance => {
    const view = new MynLibrary(paneProps(instance, 'library'));
    const series = stateful(new MynLibSeries(findElement(view.render(), element => element.type === MynLibSeries).props));
    series.componentDidMount();
    series.toggleExpansion('Example');
    for (const includeNew of [false, true]) {
      commitPreferences({include_new_vids_in_playlists: includeNew});
      view.props = paneProps(instance, 'library');
      updateProps(series, findElement(view.render(), element => element.type === MynLibSeries).props);
      const table = findElement(series.render(), element => element.type === MynLibTable);
      assert.deepStrictEqual(table.props.movies.map(video => video.id), includeNew ? ['episode-0', 'episode-1'] : ['episode-0']);
      assert.strictEqual(table.props.visible, true);
      assert.deepStrictEqual(table.props.columns, ['episode', 'title']);
    }
  }, 'shows');
});

suite.test('live column edits retain episode numbers and expansion in series view', () => {
  const data = makeLibrary();
  data.media = [videoFixture({id: 'episode', kind: 'show', series: 'Example', season: 1, episode: 1, new: false})];
  withOpenPlaylist(data, instance => {
    const view = new MynLibrary(paneProps(instance, 'library'));
    const series = stateful(new MynLibSeries(findElement(view.render(), element => element.type === MynLibSeries).props));
    series.componentDidMount();
    series.toggleExpansion('Example');
    assert.deepStrictEqual(series.state.columns, ['episode', 'title']);
    runtimeLibrary.playlists = data.playlists.map(playlist => playlist.id === 'shows' ?
      {...playlist, columns: ['title', 'year']} : playlist);
    savedPing.saved(['playlists']);
    view.props = paneProps(instance, 'library');
    updateProps(series, findElement(view.render(), element => element.type === MynLibSeries).props);
    const table = findElement(series.render(), element => element.type === MynLibTable);
    assert.deepStrictEqual(table.props.columns, ['episode', 'title', 'year']);
    assert.strictEqual(table.props.visible, true);
  }, 'shows');
});

suite.test('flat column edits update the open table while defaults apply only to new playlists', () => {
  withOpenPlaylist(makeLibrary(), instance => {
    const view = new MynLibrary(paneProps(instance, 'library'));
    const table = stateful(new MynLibTable(findElement(view.render(), element => element.type === MynLibTable).props));
    table.componentDidMount();
    table.reset('title'); // User-selected descending title order.
    commitPreferences({defaultcolumns: {used: ['year'], unused: ['title']}});
    assert.deepStrictEqual(instance.state.columns, ['title'], 'Default columns must not rewrite an existing playlist');
    runtimeLibrary.playlists = runtimeLibrary.playlists.map(playlist => playlist.id === 'movies' ?
      {...playlist, columns: ['title', 'year']} : playlist);
    savedPing.saved(['playlists']);
    view.props = paneProps(instance, 'library');
    updateProps(table, findElement(view.render(), element => element.type === MynLibTable).props);
    assert.deepStrictEqual(React.Children.toArray(table.renderHeader().props.children)
      .map(cell => cell.props.className), ['title', 'year']);
    const cells = ReactDOMServer.renderToStaticMarkup(React.createElement('table', null,
      React.createElement('tbody', null, React.createElement('tr', null, table.renderCells(0, table.state.sortedRows[0])))));
    assert(cells.includes('class="year centered mono"'));
    assert.strictEqual(table.state.sortKey, 'title');
    assert.strictEqual(table.state.sortAscending, false);
  });
});

suite.test('returns no videos and logs a bad playlist expression instead of crashing', () => {
  const library = makeLibrary();
  library.playlists.push({id: 'broken', name: 'Broken', filter_function: 'video..title', view: 'flat'});
  const instance = instanceFor(library);
  logEntries.length = 0;
  assert.deepStrictEqual(instance.playlistFilter('broken'), []);
  assert(logEntries.some(entry => entry.level === 'error' && entry.message.includes('playlist filter')));
});

suite.test('searches multiple words across titles, genres, cast, and tags', () => {
  const instance = instanceFor();
  instance.state.playlistVideos = instance.state.videos;
  assert.deepStrictEqual(instance.searchFilter('Alien space').map(video => video.id), ['alien']);
  assert.deepStrictEqual(instance.searchFilter('Ridley Horror').map(video => video.id), ['alien', 'arrival', 'show']);
  assert.deepStrictEqual(instance.searchFilter('language').map(video => video.id), ['arrival']);
  assert.deepStrictEqual(instance.searchFilter('unfindable'), []);
});

suite.test('displays recently watched updates only after backend commit notifications', () => {
  const instance = instanceFor();
  const before = Array.from({length: 10}, (unused, index) => `video-${index}`);
  instance.state.recentlyWatched = before;
  instance.componentDidMount();
  assert.strictEqual(instance.state.recentlyWatched, before);
  assert.strictEqual(runtimeLibrary.replaceCalls.length, 0);
  runtimeLibrary.recently_watched = ['video-5', 'video-0'];
  savedPing.saved(['recently_watched']);
  assert.deepStrictEqual(instance.state.recentlyWatched, ['video-5', 'video-0']);
});

suite.test('starts scans through the named bridge and rejects invalid temporary playlist views', () => {
  const instance = instanceFor();
  ipcRenderer.sent.length = 0;
  instance.scanWatchfolders();
  assert.deepStrictEqual(ipcRenderer.sent, [{channel: 'scan-watchfolders', args: []}]);
  instance.state.view = 'flat';
  instance.changePlaylistView('grid');
  assert.strictEqual(instance.state.view, 'flat');
  instance.changePlaylistView('series');
  assert.strictEqual(instance.state.view, 'series');
});

suite.test('renders all major application panes beneath the grid root', () => {
  const instance = instanceFor();
  const html = ReactDOMServer.renderToStaticMarkup(instance.render());
  assert(html.includes('id="grid-container"'));
  ['navigation', 'library', 'details', 'notify', 'settings', 'editor', 'player'].forEach(name => {
    assert(html.includes(`data-mynda-component="${name}"`), `Missing ${name} pane`);
  });
});

// Keep the save debounce deterministic: these cases exercise the real root
// coordinator and save notifications without sleeping or running Electron.
function withBatchRefresh(operation) {
  const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
  let nextID = 0;
  const pending = new Map();
  global.setTimeout = (callback, delay) => {
    assert.strictEqual(delay, 500);
    pending.set(++nextID, callback);
    return nextID;
  };
  global.clearTimeout = id => pending.delete(id);
  try {
    const data = makeLibrary();
    data.settings.preferences.include_new_vids_in_playlists = true;
    withOpenPlaylist(data, instance => {
      instance.state.playlistRowManifest = data.media.map(video => ({
        vidID: video.id, rowID: video.id, tableID: 'movies'
      }));
      instance.showDetails(['alien', 'arrival'], 'alien');
      operation(instance, {
        pending,
        save(description, address = 'media') {
          runtimeLibrary.media = runtimeLibrary.media.map(video => ({...video, description}));
          savedPing.saved([address]);
        },
        flush() {
          const callbacks = [...pending.values()];
          pending.clear();
          callbacks.forEach(callback => callback());
        }
      });
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

suite.test('a delayed batch save cannot replace a newly selected single-video editor', () => {
  withBatchRefresh((instance, clock) => {
    clock.save('Saved batch');
    instance.handleSelectedRows('alien', 'alien', 'movies', true);
    assert.strictEqual(instance.state.detailVideo.title, 'Alien');
    clock.flush();
    assert.strictEqual(instance.state.detailVideo.id, 'alien');
    assert.strictEqual(paneProps(instance, 'editor').video.title, 'Alien');
    assert.strictEqual(instance.state.batchVids, null);
  });
});

suite.test('batch saves debounce to one refresh using the latest committed data', () => {
  withBatchRefresh((instance, clock) => {
    clock.save('First');
    clock.save('Latest', 'media.0.description');
    assert.strictEqual(clock.pending.size, 1);
    // Visible selection can disappear as tables rebuild; the open batch is
    // still authoritative and must refresh all its original members.
    instance.state.selectedRows = {};
    clock.flush();
    assert.strictEqual(instance.state.detailVideo.description, 'Latest');
    assert.deepStrictEqual(instance.state.batchVids.map(video => video.id), ['alien', 'arrival']);
  });
});

suite.test('a delayed batch save cannot restore an older batch selection', () => {
  withBatchRefresh((instance, clock) => {
    clock.save('Saved batch');
    instance.showDetails(['arrival', 'show'], 'arrival');
    clock.flush();
    assert.deepStrictEqual(instance.state.batchVids.map(video => video.id), ['arrival', 'show']);
  });
});

suite.test('switching playlists cancels the old batch refresh', () => {
  withBatchRefresh((instance, clock) => {
    clock.save('Saved batch');
    instance.setPlaylist('shows');
    clock.flush();
    assert.strictEqual(instance.state.detailVideo, null);
    assert.strictEqual(clock.pending.size, 0);
  });
});

suite.test('unmount cancels the pending batch refresh', () => {
  withBatchRefresh((instance, clock) => {
    clock.save('Saved batch');
    assert.strictEqual(clock.pending.size, 1);
    instance.componentWillUnmount();
    assert.strictEqual(clock.pending.size, 0);
  });
});

suite.test('a real twenty-video commit refreshes the open view once and updates every playlist count', async () => {
  const LibraryClient = require('../src/library/LibraryClient');
  const {makeDelta} = require('../src/library/LibraryProtocol');
  const data = makeLibrary();
  data.playlists.push({id:'new',name:'New',filter_function:'video.new',view:'flat',columns:['title']});
  data.media = Array.from({length:20}, (_,i) => videoFixture({id:`batch-${i}`,title:`Video ${i}`,kind:'movie',new:true}));
  await withOpenPlaylist(data, async instance => {
    const client = new LibraryClient({initialData:data,log:logger,api:{
      snapshot:async()=>({session:'test',revision:0,paths:{},data}),
      onCommitted(){},onCloseCanceled(){},onPrepareClose(){}}});
    await client.ready;
    const recordNotifications=[];
    client.subscribe(address=>recordNotifications.push(address));
    client.onSavedBatch = addresses => {
      runtimeLibrary.media = client.media;
      savedPing.saved(addresses);
    };
    let refreshes=0,details=0,counts=0;
    const setPlaylist=instance.setPlaylist.bind(instance),setCounts=instance.setPlaylistLengths.bind(instance);
    instance.setPlaylist=(...args)=>{refreshes++;return setPlaylist(...args);};
    instance.setPlaylistLengths=(...args)=>{counts++;return setCounts(...args);};
    instance.refreshDetails=()=>{details++;};
    const revision=instance.state.mediaRevision;
    const before=client.getSaveObject(),after={...before,media:before.media.map((v,i)=>({...v,new:false,kind:i<12?'movie':'show'}))};
    const addresses=after.media.map(v=>`media.${v.id}`);
    const message={session:'test',revision:1,addresses,delta:makeDelta(before,after)};
    await client.receive(message);
    assert.strictEqual(refreshes,1);assert.strictEqual(details,1);assert.strictEqual(counts,1);
    assert.strictEqual(instance.state.mediaRevision,revision+1);
    assert.strictEqual(instance.state.filteredVideos.length,12);
    assert.deepStrictEqual(instance.state.playlistLength,{movies:12,shows:8,new:0});
    assert.deepStrictEqual(recordNotifications,addresses);
    await client.receive(message);
    assert.strictEqual(refreshes,1,'The duplicate commit reply must not refresh twice');
  });
});

suite.test('mixed media, playlist and preference changes refresh once from a coherent snapshot', () => {
  const data=makeLibrary();
  data.settings.preferences.include_new_vids_in_playlists=true;
  withOpenPlaylist(data,(instance,searchField)=>{
    searchField.value='Alien';instance.setPlaylist('movies');
    let refreshes=0,details=0;
    const setPlaylist=instance.setPlaylist.bind(instance);
    instance.setPlaylist=(...args)=>{refreshes++;return setPlaylist(...args);};
    instance.refreshDetails=()=>{details++;};
    runtimeLibrary.media=runtimeLibrary.media.map(v=>v.id==='alien'?{...v,new:false}:v);
    runtimeLibrary.settings={...runtimeLibrary.settings,preferences:{...runtimeLibrary.settings.preferences,
      include_new_vids_in_playlists:false}};
    runtimeLibrary.playlists=runtimeLibrary.playlists.map(p=>({...p,view:'series'}));
    savedPing.saved(['media.alien','media.arrival','playlists','settings.preferences']);
    assert.strictEqual(refreshes,1);assert.strictEqual(details,1);
    assert.deepStrictEqual(instance.state.filteredVideos.map(v=>v.id),['alien']);
    assert.deepStrictEqual(instance.state.playlistLength,{movies:2,shows:1});
    assert.strictEqual(instance.state.view,'series');assert.strictEqual(searchField.value,'Alien');
  });
});

suite.test('closed counts follow single edits, removals and playlist filter edits without opening them', () => {
  const data=makeLibrary();
  data.playlists.push({id:'new',name:'New',filter_function:'video.new',view:'flat',columns:['title']});
  withOpenPlaylist(data,instance=>{
    const priorCounts=instance.state.playlistLength;
    runtimeLibrary.media=runtimeLibrary.media.map(v=>v.id==='alien'?{...v,new:false,kind:'show'}:v);
    savedPing.saved(['media.alien']);
    assert.deepStrictEqual(instance.state.playlistLength,{movies:1,shows:2,new:0});
    assert.deepStrictEqual(priorCounts,{movies:1,shows:1,new:1},'Earlier count snapshots must not be mutated');
    runtimeLibrary.media=runtimeLibrary.media.filter(v=>v.id!=='show');
    savedPing.saved(['media']);
    assert.deepStrictEqual(instance.state.playlistLength,{movies:1,shows:1,new:0});
    runtimeLibrary.playlists=runtimeLibrary.playlists.filter(p=>p.id!=='new').map(p=>p.id==='shows'?
      {...p,filter_function:'false'}:p);
    savedPing.saved(['playlists']);
    assert.deepStrictEqual(instance.state.playlistLength,{movies:1,shows:0});
    assert.strictEqual(instance.state.currentPlaylistID,'movies');
  });
});

suite.test('queued React updates publish current closed counts and keep the current search and selection', () => {
  const data=makeLibrary();
  withOpenPlaylist(data,(instance,searchField)=>{
    instance.changePlaylistView('series');searchField.value='Alien';
    const selectedRows={movies:{arrival:true}};instance.state.selectedRows=selectedRows;
    const applyState=instance.setState.bind(instance),queued=[];
    instance.setState=(update,callback)=>queued.push({update,callback});
    runtimeLibrary.media=runtimeLibrary.media.map(v=>v.id==='alien'?{...v,new:false}:v);
    savedPing.saved(['media.alien','media.arrival']);
    while(queued.length){const {update,callback}=queued.shift();applyState(update,callback);}
    assert.deepStrictEqual(instance.state.playlistLength,{movies:2,shows:1});
    assert.deepStrictEqual(instance.state.filteredVideos.map(v=>v.id),['alien']);
    assert.strictEqual(instance.state.view,'series');assert.strictEqual(instance.state.selectedRows,selectedRows);
  });
});

suite.test('count-only refresh publishes one state update even with many closed playlists', () => {
  const data=makeLibrary();
  data.playlists.push(...Array.from({length:30},(_,i)=>({id:`custom-${i}`,name:`Custom ${i}`,
    filter_function:"video.kind === 'movie'",view:'flat',columns:['title']})));
  withOpenPlaylist(data,instance=>{
    instance.state.playlistLength={};
    let updates=0;const setState=instance.setState.bind(instance);
    instance.setState=(...args)=>{updates++;return setState(...args);};
    instance.setPlaylistLengths();
    assert.strictEqual(updates,1);assert.strictEqual(Object.keys(instance.state.playlistLength).length,32);
    assert.strictEqual(instance.state.playlistLength['custom-29'],1);
  });
});

runSuite(suite);
