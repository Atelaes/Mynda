const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {videoFixture} = require('./helpers/Fixtures.js');

require('@babel/register')({
  presets: [require.resolve('@babel/preset-react')],
  extensions: ['.js'],
  ignore: [/node_modules/],
  cache: false
});

const invoked = [];
const shownFiles = [];
const logged = [];
const ipcRenderer = {
  on() {},
  send() {},
  async invoke(channel) {
    invoked.push(channel);
    return {ok: true, value: {canceled: false, filePath: '/exports/Mynda Library.json'}};
  }
};
const settingsLog = {
  debug() {},
  info(message, data) { logged.push({level: 'info', message, data}); },
  warn() {},
  error(message, data) { logged.push({level: 'error', message, data}); }
};
class OpenablePane extends React.Component {}
const EmptyComponent = props => React.createElement('span', null, props.children);
const ParagraphFolder = props => React.createElement(
  'div',
  {className: `paragraph-fold ${props.className || ''}`},
  React.createElement('div', {className: 'lede'}, props.lede),
  React.createElement('div', {className: 'paragraph'}, props.paragraph)
);

const {MynSettingsLibrary} = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'Settings.js'),
  {
    'electron': {
      ipcRenderer,
      shell: {showItemInFolder(filepath) { shownFiles.push(filepath); }}
    },
    'react-beautiful-dnd': {
      DragDropContext: EmptyComponent,
      Droppable: EmptyComponent,
      Draggable: EmptyComponent
    },
    './RendererRuntime.js': {
      library: {replace() {}},
      settingsLog,
      confirmationDialogIsDisabled: () => false,
      disableConfirmationDialog() {}
    },
    './SharedComponents.js': {
      MynOpenablePane: OpenablePane,
      MynOverflowTextMarquee: EmptyComponent,
      MynTooltip: EmptyComponent,
      MynParagraphFolder: ParagraphFolder
    },
    './EditorFields.js': {
      MynEditText: EmptyComponent,
      MynEditInlineAddListWidget: EmptyComponent
    },
    './RendererUtils.js': {
      getObjectDiff: () => [],
      isEqualIgnoreFuncs: () => true,
      fileManagerName: () => 'Finder'
    },
    '../PlaylistFilter.js': {
      PLAYLIST_FILTER_REFERENCE: {},
      validatePlaylistFilter: () => ({valid: true})
    }
  }
);

const suite = createSuite(
  'Settings Library tab',
  'component',
  'Renders library statistics and exercises export and file-manager actions through controlled Electron boundaries.'
);

function component(videos = []) {
  const instance = new MynSettingsLibrary({videos});
  instance.setState = function synchronousSetState(update, callback) {
    const patch = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = Object.assign({}, this.state, patch);
    if (callback) callback();
  };
  return instance;
}

suite.test('renders per-kind video totals and the actual number of duplicate files', () => {
  const instance = component([
    videoFixture({
      id: 'movie-1',
      title: 'Alien',
      duplicates: ['/duplicates/Alien Copy A.mkv', '/duplicates/Alien Copy B.mkv']
    }),
    videoFixture({id: 'movie-2', title: 'Arrival'}),
    videoFixture({
      id: 'show-1',
      title: 'Pilot',
      kind: 'show',
      duplicates: ['/duplicates/Pilot.mkv']
    })
  ]);
  const html = ReactDOMServer.renderToStaticMarkup(instance.render());
  assert(html.includes('2 videos'));
  assert(html.includes('2 duplicate files'));
  assert(html.includes('1 video'));
  assert(html.includes('1 duplicate file'));
  assert(html.includes('/duplicates/Alien Copy A.mkv'));
  assert(html.includes('Show in Finder'));
});

suite.test('shows either a video object or duplicate path in the system file manager', () => {
  shownFiles.length = 0;
  const instance = component();
  let stopped = false;
  instance.showFile('/duplicates/Alien.mkv', {stopPropagation() { stopped = true; }});
  instance.showFile({filename: '/library/Alien.mkv'});
  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(shownFiles, ['/duplicates/Alien.mkv', '/library/Alien.mkv']);
});

suite.test('invokes the backend export and reports the completed destination', async () => {
  invoked.length = 0;
  logged.length = 0;
  const instance = component();
  await instance.exportLibrary();
  assert.deepStrictEqual(invoked, ['library:export']);
  assert.strictEqual(instance.state.exporting, false);
  assert.strictEqual(instance.state.exportMessage, 'Library exported successfully.');
  assert.strictEqual(instance.state.exportPath, '/exports/Mynda Library.json');
  assert(logged.some(entry => entry.level === 'info' && entry.message === 'Library export completed'));
  const html = ReactDOMServer.renderToStaticMarkup(instance.render());
  assert(html.includes('Library exported successfully.'));
  assert(html.includes('/exports/Mynda Library.json'));
});

runSuite(suite);
