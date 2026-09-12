const path = require('path');
const fs = require('fs');
const {EventEmitter} = require('events');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {videoFixture} = require('./helpers/Fixtures.js');
const {buildLibraryStats} = require('../src/LibraryStats.js');

require('@babel/register')({
  presets: [require.resolve('@babel/preset-react')],
  extensions: ['.js'],
  ignore: [/node_modules/],
  cache: false
});

const windowListeners = new Map();
global.window = {
  addEventListener: (name, listener) => windowListeners.set(name, listener),
  removeEventListener: (name, listener) => {
    if (windowListeners.get(name) === listener) windowListeners.delete(name);
  }
};

const ipcRenderer = new EventEmitter();
const runtimeLibrary = {media: []};
const quietLog = {debug() {}, info() {}, warn() {}, error() {}};

const {MynNotify} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'SharedComponents.js'),
  {
    'electron': {ipcRenderer},
    './RendererRuntime.js': {
      frontendLog: quietLog,
      LOCAL_STATUS_UPDATE_EVENT: 'mynda-local-status-update',
      disableConfirmationDialog() {}
    }
  }
);

const {MynNav} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'Navigation.js'),
  {
    'electron': {ipcRenderer},
    './RendererRuntime.js': {library: runtimeLibrary}
  }
);

const EmptyComponent = () => React.createElement('span');
const OverflowText = props => React.createElement('span', null, props.text);
const {MynRecentlyWatched, MynLibTable, MynLibTableRow} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'LibraryView.js'),
  {
    'electron': {ipcRenderer, shell: {showItemInFolder() {}}},
    'react-virtuoso': {TableVirtuoso: EmptyComponent},
    '../BoxOffice.js': {
      formatBoxOffice: value => String(value),
      formatCompactBoxOffice: value => String(value)
    },
    './RendererRuntime.js': {
      library: runtimeLibrary,
      libraryViewLog: quietLog,
      playerLog: quietLog,
      placeholderImage: '../images/qmark.png',
      disableConfirmationDialog() {}
    },
    './RendererUtils.js': {
      removeLeadingArticle: value => value,
      artworkSourceURL: (value, fallback = '') => value || fallback,
      fileManagerName: () => 'File Manager',
      validateVideo: value => value
    },
    './TableSelection.js': {
      selectTableRow: () => [],
      selectedVideoIDsForTable: () => []
    },
    './SharedComponents.js': {MynOverflowTextMarquee: OverflowText},
    './EditorFields.js': {
      MynEditSeenWidget: EmptyComponent,
      MynEditWatchlaterWidget: EmptyComponent,
      MynEditRatingWidget: EmptyComponent,
      MynEditPositionWidget: EmptyComponent,
      MynShowPositionWidget: EmptyComponent
    }
  }
);

const suite = createSuite(
  'Renderer notification, navigation, and playlist components',
  'component',
  'Renders real React components to HTML with Electron IPC and browser globals replaced by small test doubles.'
);

suite.test('uses clear singular, plural, duplicate, and cancellation messages', () => {
  const notify = new MynNotify({});
  assert.strictEqual(notify.messageFor({action: 'add', numTotal: 1}), 'Adding 1 video');
  assert.strictEqual(
    notify.messageFor({action: 'add', numTotal: 2, duplicateVideos: 1}),
    'Adding 2 videos — 1 duplicate skipped'
  );
  assert.strictEqual(
    notify.messageFor({action: 'add', numTotal: 0, duplicateVideos: 3}),
    'No new videos added — 3 duplicates skipped'
  );
  assert.strictEqual(
    notify.messageFor({action: 'autotag', cancelRequested: true}),
    'Finishing the current video before canceling auto-tagging'
  );
  notify.componentWillUnmount();
});

suite.test('formats scan, batch-save, metadata, and Share progress', () => {
  const notify = new MynNotify({});
  assert.strictEqual(notify.messageFor({action: 'check'}), 'Scanning watchfolders');
  assert.strictEqual(
    notify.messageFor({action: 'check', numCurrent: 2, numTotal: 5}),
    'Checking 2 of 5 new videos'
  );
  assert.strictEqual(
    notify.messageFor({action: 'batch_save', numCurrent: 1, numTotal: 1}),
    'Saving 1 of 1 video'
  );
  assert.strictEqual(
    notify.messageFor({action: 'metadata', numCurrent: 3, numTotal: 8}),
    'Checking metadata for 3 of 8 videos'
  );
  assert.strictEqual(
    notify.messageFor({action: 'share_fulfill', numCurrent: 4, numTotal: 9}),
    'Sharing 4 of 9 videos'
  );
  notify.componentWillUnmount();
});

suite.test('renders the active notification banner and unregisters its window listener', () => {
  const notify = new MynNotify({});
  assert(windowListeners.has('mynda-local-status-update'));
  notify.state = {
    on: true,
    statusMessage: 'Saving 2 of 4 videos',
    ellipsis: '..'
  };
  const html = ReactDOMServer.renderToStaticMarkup(notify.render());
  assert(html.includes('id="notify-banner"'));
  assert(html.includes('Saving 2 of 4 videos'));
  assert(html.includes('>..</div>'));
  notify.componentWillUnmount();
  assert.strictEqual(windowListeners.has('mynda-local-status-update'), false);
});

function navigationHtml() {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(MynNav, {
    playlists: [
      {id: 'all', name: 'All', tab: true, view: 'flat'},
      {id: 'new', name: 'New', tab: true, view: 'flat'}
    ],
    playlistLength: {all: 12, new: 2},
    currentPlaylistID: 'all',
    setPlaylist() {},
    showSettings() {},
    scanWatchfolders() {},
    search() {},
    toggleDetailsPane() {},
    detailsPaneShowing: true
  }));
}

suite.test('hides the New tab when no library video is new', () => {
  runtimeLibrary.media = [{id: 'old', new: false}];
  const html = navigationHtml();
  assert(html.includes('id="playlist-all"'));
  assert(html.includes('class="flat selected"'));
  assert(!html.includes('id="playlist-new"'));
  assert(html.includes('id="scan-button"'));
  assert(html.includes('id="search-input"'));
});

suite.test('shows the New tab and count when new media exists', () => {
  runtimeLibrary.media = [{id: 'new-one', new: true}, {id: 'old', new: false}];
  const html = navigationHtml();
  assert(html.includes('id="playlist-new"'));
  assert(html.includes('class="nav-message loud"'));
  assert(html.includes('(2)'));
});

function recentlyPlayedItem(id) {
  const played = [];
  const instance = new MynRecentlyWatched({
    list: [id],
    mediaRevision: 1,
    selected: 0,
    playVideo: videoID => played.push(videoID)
  });
  instance.setState = update => {
    instance.state = Object.assign({}, instance.state, update);
  };
  instance.createListItems();
  return {
    instance,
    played,
    html: ReactDOMServer.renderToStaticMarkup(instance.render())
  };
}

suite.test('shows Play Next only when a later video exists in the same series', () => {
  runtimeLibrary.media = [
    {id: 'movie', title: 'Standalone Movie', series: '', season: '', episode: '', artwork: '', position: 0},
    {id: 'singleton', title: 'Only Episode', series: 'One Episode Show', season: 1, episode: 1, artwork: '', position: 0},
    {id: 'episode-1', title: 'Episode One', series: 'Continuing Show', season: 1, episode: 1, artwork: '', position: 0},
    {id: 'episode-2', title: 'Episode Two', series: 'Continuing Show', season: 1, episode: 2, artwork: '', position: 0},
    {id: 'episode-3', title: 'Episode Three', series: 'Continuing Show', season: 1, episode: 3, artwork: '', position: 0}
  ];

  const movie = recentlyPlayedItem('movie');
  const singleton = recentlyPlayedItem('singleton');
  const middle = recentlyPlayedItem('episode-2');
  const finalEpisode = recentlyPlayedItem('episode-3');

  assert(!movie.html.includes('class="next-btn"'));
  assert(movie.html.includes('class="video no-next"'));
  assert(!singleton.html.includes('class="next-btn"'));
  assert(singleton.html.includes('class="video no-next"'));
  assert.strictEqual(middle.instance.findNextVideoInSeries('episode-2'), 'episode-3');
  assert(middle.html.includes('class="next-btn"'));
  assert(!middle.html.includes('class="video no-next"'));
  assert.strictEqual(finalEpisode.instance.findNextVideoInSeries('episode-3'), null);
  assert(!finalEpisode.html.includes('class="next-btn"'));
  assert(finalEpisode.html.includes('class="video no-next"'));
});

suite.test('keeps recently played rows the same width when Play Next is hidden', () => {
  const stylesheet = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'styles', 'main.css'),
    'utf8'
  );
  const noNextRule = stylesheet.match(
    /\.pb-element\.recent \.dropdown-item \.video\.no-next\s*\{([^}]*)\}/
  );

  assert(noNextRule, 'Expected a style rule for recently played videos without a next button');
  assert(
    /border-radius:\s*var\(--vid-height\)\s*;/.test(noNextRule[1]),
    'Expected the video row to retain its fully rounded edge'
  );
  assert(
    /padding-right:\s*var\(--vid-height\)\s*;/.test(noNextRule[1]),
    'Expected the video row to occupy the missing Play Next button width'
  );
});

function resolutionHtml(video) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement('table', null,
    React.createElement('tbody', null, React.createElement('tr', null,
      React.createElement(MynLibTableRow, {
        video, columns: ['resolution'], calcAvgRatings: () => '',
        settings: {preferences: {}}
      })
    ))
  ));
}

suite.test('renders shared resolution labels and exact dimensions in real playlist cells', () => {
  const examples = [
    [{width:640,height:480}, '480p', '640 × 480 pixels'],
    [{width:720,height:432,sample_aspect_ratio:'64:45'}, '576p', '720 × 432 pixels (display 1024 × 432)'],
    [{width:1920,height:800}, '1080p', '1920 × 800 pixels'],
    [{width:2560,height:1440}, '1440p', '2560 × 1440 pixels'],
    [{width:3840,height:1080}, '1080p', '3840 × 1080 pixels'],
    [null, 'Unknown', 'Resolution unavailable']
  ];
  for (const [metadata, label, title] of examples) {
    const html = resolutionHtml(videoFixture({metadata}));
    assert(html.includes(`class="resolution" title="${title}">${label}</td>`), html);
  }
});

suite.test('sorts by displayed resolution and keeps unknowns last in both directions', () => {
  const movies = [
    videoFixture({id:'unknown',metadata:null}),
    videoFixture({id:'hd-4by3',metadata:{width:960,height:720}}),
    videoFixture({id:'sd-wide',metadata:{width:1024,height:576}}),
    videoFixture({id:'cropped-fhd',metadata:{width:1920,height:800}}),
    videoFixture({id:'qhd',metadata:{width:2560,height:1440}})
  ];
  const table = new MynLibTable({movies,settings:{preferences:{}}});
  table.requestSort('resolution', true);
  assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID),
    ['sd-wide','hd-4by3','cropped-fhd','qhd','unknown']);
  table.requestSort('resolution');
  assert.deepStrictEqual(table.state.sortedRows.map(row => row.vidID),
    ['qhd','cropped-fhd','hd-4by3','sd-wide','unknown']);
  assert.deepStrictEqual(movies.map(video => video.id),
    ['unknown','hd-4by3','sd-wide','cropped-fhd','qhd']);
});

suite.test('keeps playlist labels and Library statistics in agreement for the same videos', () => {
  const media = [
    videoFixture({id:'sd',metadata:{width:640,height:480}}),
    videoFixture({id:'mjpeg',metadata:{width:640,height:480,codec:'mjpeg',video_stream_selected:true}}),
    videoFixture({id:'unknown',metadata:{width:2000,height:3000,codec:'mjpeg'}}),
    videoFixture({id:'qhd',metadata:{width:2560,height:1440}})
  ];
  const rows = buildLibraryStats(media).resolutions.filter(row => row.count);
  assert.deepStrictEqual(rows.map(row => [row.value,row.count]),
    [['1440p',1],['480p',2],['Unknown',1]]);
  for (const row of rows) {
    const matching = media.filter(video => resolutionHtml(video).includes(`>${row.value}</td>`));
    assert.strictEqual(matching.length, row.count);
  }
});

runSuite(suite);
