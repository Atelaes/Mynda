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

const suite = createSuite(
  'Renderer notification and navigation components',
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

runSuite(suite);
