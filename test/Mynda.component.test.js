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
  global.document = {getElementById: id => id === 'search-input' ? searchField :
    {getElementsByTagName: () => [{click() {}}]}};
  try {
    const instance = instanceFor(data);
    instance.componentDidMount();
    instance.setPlaylist(playlistID);
    return operation(instance, searchField);
  } finally { global.document = previousDocument; }
}

function commitPreferences(changes, address = 'settings.preferences') {
  // LibraryClient publishes a new immutable settings snapshot before notifying
  // Mynda. Do not mutate the old state: that would hide a stale-state bug.
  runtimeLibrary.settings = deepFreeze({...runtimeLibrary.settings,
    preferences: {...runtimeLibrary.settings.preferences, ...changes}});
  savedPing.saved(address);
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
    savedPing.saved('playlists');
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
    savedPing.saved('playlists');
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
  savedPing.saved('recently_watched');
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

runSuite(suite);
