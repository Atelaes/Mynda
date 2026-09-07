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
  return props => React.createElement('div', {'data-mynda-component': name}, props.children);
}

class Boundary extends React.Component {
  render() { return this.props.children; }
}

const runtimeLibrary = libraryFixture();
runtimeLibrary.replaceCalls = [];
runtimeLibrary.replace = function replace(address, value) {
  this.replaceCalls.push({address, value});
};

global.savedPing = {};
const {Mynda} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'Mynda.js'),
  {
    'electron': {ipcRenderer},
    './RendererRuntime.js': {
      library: runtimeLibrary,
      frontendLog: logger,
      libraryViewLog: logger,
      playerLog: logger
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
    const patch = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = Object.assign({}, this.state, patch);
    if (callback) callback();
  };
  return instance;
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

suite.test('keeps only ten recent videos, moves repeats to the front, and saves once', () => {
  const instance = instanceFor();
  instance.state.recentlyWatched = Array.from({length: 10}, (unused, index) => `video-${index}`);
  instance.logPlayed('video-5');
  assert.strictEqual(instance.state.recentlyWatched[0], 'video-5');
  assert.strictEqual(instance.state.recentlyWatched.length, 10);
  assert.strictEqual(instance.state.recentlyWatched.filter(id => id === 'video-5').length, 1);
  assert.deepStrictEqual(runtimeLibrary.replaceCalls, [{
    address: 'recently_watched',
    value: instance.state.recentlyWatched
  }]);
});

suite.test('sends scans over IPC and rejects invalid temporary playlist views', () => {
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
