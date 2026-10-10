const path = require('path');
const fs = require('fs');
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
global.window = {mynda: {
  library: {export: () => ipcRenderer.invoke('library:export')},
  files: {
    revealVideo: async request => { shownFiles.push({kind: 'video', ...request}); },
    revealExport: async path => { shownFiles.push({kind: 'export', path}); }
  }
}};
const settingsLog = {
  debug() {},
  info(message, data) { logged.push({level: 'info', message, data}); },
  warn() {},
  error(message, data) { logged.push({level: 'error', message, data}); }
};
const EmptyComponent = props => React.createElement('span', null, props.children);
const sharedComponents = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'SharedComponents.js'),
  {
    'electron': {ipcRenderer},
    './RendererRuntime.js': {
      frontendLog: settingsLog,
      LOCAL_STATUS_UPDATE_EVENT: 'mynda-local-status-update',
      disableConfirmationDialog() {}
    }
  }
);
const {MynParagraphFolder} = sharedComponents;

const {MynSettingsLibrary, MynSettings, MynSettingsFolders, MynSettingsPlaylists, MynSettingsShare} = loadFreshWithMocks(
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
    './SharedComponents.js': sharedComponents,
    './EditorFields.js': {
      MynEditText: EmptyComponent,
      MynEditInlineAddListWidget: EmptyComponent
    },
    './RendererUtils.js': {
      getObjectDiff: () => [],
      isEqualIgnoreFuncs: () => true,
      fileManagerName: () => 'Finder'
    },
    '../library/PlaylistFilter.js': {
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

function synchronousState(instance) {
  instance.setState = function synchronousSetState(update, callback) {
    const patch = typeof update === 'function' ? update(this.state, this.props) : update;
    this.state = Object.assign({}, this.state, patch);
    if (callback) callback();
  };
  return instance;
}

function component(videos = []) {
  return synchronousState(new MynSettingsLibrary({videos}));
}

// These are render-only inputs; no files are created. Use a native absolute
// path so the expected text includes Windows' drive and backslashes there.
function fixturePath(directory, filename) {
  return path.join(path.parse(process.cwd()).root, directory, filename);
}

function matchingElements(element, predicate) {
  const matches = [];
  React.Children.forEach(element, child => {
    if (!React.isValidElement(child)) return;
    if (predicate(child)) matches.push(child);
    matches.push(...matchingElements(child.props.children, predicate));
  });
  return matches;
}

function viewingCellMarkup(className, count, formattedPercentage) {
  return `<td class="${className}"><span class="viewing-number">${count}</span> (<span class="viewing-percentage">${formattedPercentage}</span>)</td>`;
}

suite.test('renders viewing, kind, series, resolution, and global duplicate statistics', () => {
  const instance = component([
    videoFixture({
      id: 'movie-1',
      title: 'Alien',
      seen: true,
      metadata: {width: 3840, height: 1600},
      duplicates: [fixturePath('duplicates', 'Alien Copy A.mkv'), fixturePath('duplicates', 'Alien Copy B.mkv')]
    }),
    videoFixture({
      id: 'movie-2',
      title: 'Arrival',
      seen: false,
      metadata: {width: 1920, height: 800}
    }),
    videoFixture({
      id: 'show-1',
      title: 'Pilot',
      kind: 'show',
      series: 'Doctor Who',
      seriesImdbID: 'tt0056751',
      seen: true,
      metadata: {width: 1280, height: 720},
      duplicates: [fixturePath('duplicates', 'Pilot.mkv')]
    }),
    videoFixture({
      id: 'show-2',
      title: 'Episode Two',
      kind: 'show',
      series: 'Doctor Who',
      seriesImdbID: 'tt0436992',
      seen: false,
      metadata: {width: 720, height: 480}
    }),
    videoFixture({
      id: 'show-3',
      title: 'Episode Three',
      kind: 'show',
      series: 'Doctor Who (Classic)',
      seriesImdbID: 'tt0056751',
      seen: false,
      metadata: {width: 0, height: 0}
    })
  ]);
  const html = ReactDOMServer.renderToStaticMarkup(instance.render());

  const viewingIndex = html.indexOf('Viewing Status');
  const kindsIndex = html.indexOf('Media Kinds');
  const resolutionIndex = html.indexOf('Resolution');
  const duplicatesIndex = html.indexOf('Duplicates');
  assert(viewingIndex >= 0 && viewingIndex < kindsIndex);
  assert(kindsIndex < resolutionIndex && resolutionIndex < duplicatesIndex);
  assert(/<td class="status">Seen<\/td><td class="count">2 videos<\/td><td class="percentage">40%<\/td>/.test(html));
  assert(/<td class="status">Unseen<\/td><td class="count">3 videos<\/td><td class="percentage">60%<\/td>/.test(html));
  assert(html.includes('<td class="kind">movie</td><td class="count">2 videos</td><td class="series-count">0 series</td>' +
    viewingCellMarkup('seen-count', 1, '50.0%') + viewingCellMarkup('unseen-count', 1, '50.0%')));
  assert(html.includes('<td class="kind">show</td><td class="count">3 videos</td><td class="series-count">2 series</td>' +
    viewingCellMarkup('seen-count', 1, '33.3%') + viewingCellMarkup('unseen-count', 2, '66.7%')));
  assert(/<td class="resolution">4K<\/td><td class="count">1 video<\/td><td class="percentage">20%<\/td>/.test(html));
  assert(/<td class="resolution">Unknown<\/td><td class="count">1 video<\/td><td class="percentage">20%<\/td>/.test(html));
  assert(html.includes('3 duplicate files across 2 videos'));
  assert.strictEqual((html.match(/duplicates-folder/g) || []).length, 2);
  assert(html.includes(fixturePath('duplicates', 'Alien Copy A.mkv')));
  assert(html.includes('Show in Finder'));
});

suite.test('reserves a fixed monospace percentage column and keeps one decimal place', () => {
  const instance = component();
  [
    {count: 0, total: 10, percentage: '0.0%'},
    {count: 2, total: 3, percentage: '66.7%'},
    {count: 10, total: 100, percentage: '10.0%'},
    {count: 1000, total: 1000, percentage: '100.0%'}
  ].forEach(example => {
    const html = ReactDOMServer.renderToStaticMarkup(instance.renderViewingCount(example.count, example.total));
    assert.strictEqual(html, `<span class="viewing-number">${example.count}</span> (<span class="viewing-percentage">${example.percentage}</span>)`);
  });
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'main.css'), 'utf8');
  const rule = css.match(/#settings-library \.kinds-table \.viewing-percentage\s*\{([^}]+)\}/);
  assert(rule, 'The percentage span needs its own layout rule');
  assert(/display:\s*inline-block/.test(rule[1]));
  assert(/width:\s*6ch/.test(rule[1]));
  assert(/text-align:\s*right/.test(rule[1]));
});

suite.test('explains library membership and the need to rescan after filesystem changes', () => {
  const html = ReactDOMServer.renderToStaticMarkup(component().render());
  assert(html.includes('The library copy is the file included in your Mynda library.'));
  assert(html.includes('Duplicate files are extra copies on disk and are <em>not</em> included in the library.'));
  assert(html.includes('After moving, renaming, or deleting files, run another library scan to update this list.'));
});

suite.test('gives each video an independent titled folder and keeps detail clicks from closing it', () => {
  const first = videoFixture({
    id: 'movie-a', title: 'Alien', filename: fixturePath('library', 'Alien.mkv'),
    duplicates: [fixturePath('duplicates', 'Alien A.mkv'), fixturePath('duplicates', 'Alien B.mkv')]
  });
  const second = videoFixture({
    id: 'movie-b', title: 'Arrival', filename: fixturePath('library', 'Arrival.mkv'),
    duplicates: [fixturePath('duplicates', 'Arrival.mkv')]
  });
  const instance = component([first, second, videoFixture({id: 'no-copies', duplicates: []})]);
  const folders = matchingElements(instance.render(), element => element.type === MynParagraphFolder);
  assert.strictEqual(folders.length, 2);
  assert.deepStrictEqual(folders.map(folder => folder.key), ['movie-a', 'movie-b']);
  assert.deepStrictEqual(folders.map(folder => folder.props.lede), [
    'Alien — 2 duplicate files', 'Arrival — 1 duplicate file'
  ]);
  const firstDetails = ReactDOMServer.renderToStaticMarkup(folders[0].props.paragraph);
  const secondDetails = ReactDOMServer.renderToStaticMarkup(folders[1].props.paragraph);
  assert(firstDetails.includes('Library\u00a0copy:'));
  assert(firstDetails.includes('Duplicate\u00a0files:'));
  assert(firstDetails.includes(first.filename) && firstDetails.includes(first.duplicates[1]));
  assert(!firstDetails.includes('Arrival'));
  assert(secondDetails.includes('Duplicate\u00a0file:'));
  assert(secondDetails.includes(second.filename) && !secondDetails.includes('Alien'));

  const renderedFolders = folders.map(folder => synchronousState(new MynParagraphFolder(folder.props)));
  const paragraphOf = folder => matchingElements(folder.render(), element => element.props.className === 'paragraph')[0];
  assert(renderedFolders.every(folder => paragraphOf(folder).props.style.display === 'none'));
  renderedFolders[0].render().props.onClick();
  assert.strictEqual(paragraphOf(renderedFolders[0]).props.style.display, '');
  assert.strictEqual(paragraphOf(renderedFolders[1]).props.style.display, 'none');
  let stopped = false;
  folders[0].props.paragraph.props.onClick({stopPropagation() { stopped = true; }});
  assert.strictEqual(stopped, true);
  renderedFolders[1].render().props.onClick();
  assert(renderedFolders.every(folder => paragraphOf(folder).props.style.display === ''));
  renderedFolders[0].render().props.onClick();
  assert.strictEqual(paragraphOf(renderedFolders[0]).props.style.display, 'none');
  assert.strictEqual(paragraphOf(renderedFolders[1]).props.style.display, '');

  instance.props = {videos: [second, first]};
  assert.deepStrictEqual(
    matchingElements(instance.render(), element => element.type === MynParagraphFolder).map(folder => folder.key),
    ['movie-b', 'movie-a']
  );
});

suite.test('handles an empty duplicate list and an untitled video without losing its file path', () => {
  const emptyHtml = ReactDOMServer.renderToStaticMarkup(component().render());
  assert(emptyHtml.includes('<span class="no-duplicates">None</span>'));
  assert(!emptyHtml.includes('duplicates-folder'));
  const instance = component([videoFixture({
    id: 'untitled', title: '', filename: '/library/Untitled.mkv', duplicates: ['/duplicates/Untitled.mkv']
  })]);
  const folders = matchingElements(instance.render(), element => element.type === MynParagraphFolder);
  assert.strictEqual(folders[0].props.lede, '/library/Untitled.mkv — 1 duplicate file');
  assert(ReactDOMServer.renderToStaticMarkup(instance.render()).includes('1 duplicate file across 1 video'));
});

suite.test('reveals library files by ID and exports through distinct named operations', async () => {
  shownFiles.length = 0;
  const instance = component();
  let stopped = false;
  await instance.showFile({videoID: 'alien', duplicatePath: '/duplicates/Alien.mkv'}, {stopPropagation() { stopped = true; }});
  await instance.showFile({videoID: 'alien'});
  await instance.showFile('/exports/Mynda Library.json');
  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(shownFiles, [
    {kind: 'video', videoID: 'alien', duplicatePath: '/duplicates/Alien.mkv'},
    {kind: 'video', videoID: 'alien'},
    {kind: 'export', path: '/exports/Mynda Library.json'}
  ]);
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

suite.test('folder-picker cancellation preserves the current selection', async () => {
  const folders = new MynSettingsFolders({folders: [], kinds: []});
  const selected = [];
  folders.changeTargetFolder = value => selected.push(value);
  window.mynda.watchfolders = {choose: async () => null};
  await folders.folderSelect();
  assert.deepStrictEqual(selected, []);
  window.mynda.watchfolders.choose = async () => '/Chosen/Movies';
  await folders.folderSelect();
  assert.deepStrictEqual(selected, ['/Chosen/Movies']);
});

suite.test('playlist confirmation responses cannot delete another pending playlist', async () => {
  const pending = [], removed = [];
  window.mynda.dialogs = {confirmPlaylistDelete: request => new Promise(resolve => pending.push({request, resolve}))};
  const playlists = new MynSettingsPlaylists({playlists: []});
  playlists.removePlaylist = id => removed.push(id);
  const first = playlists.deletePlaylist({id: 'first', name: 'First'});
  const second = playlists.deletePlaylist({id: 'second', name: 'Second'});
  assert.deepStrictEqual(pending.map(item => item.request), [
    {id: 'first', name: 'First'}, {id: 'second', name: 'Second'}
  ]);
  pending[1].resolve({response: 0, checkboxChecked: false});
  await second;
  pending[0].resolve({response: 1, checkboxChecked: false});
  await first;
  assert.deepStrictEqual(removed, ['second']);
});

suite.test('Settings releases both watchfolder subscriptions when unmounted', () => {
  const subscribed = [], removed = [];
  window.mynda.watchfolders = {
    onAdded: callback => { subscribed.push(callback); return () => removed.push('added'); },
    onRemoved: callback => { subscribed.push(callback); return () => removed.push('removed'); }
  };
  const settings = new MynSettings({settings: {preferences: {}}});
  assert.strictEqual(subscribed.length, 0);
  settings.componentDidMount();
  assert.strictEqual(subscribed.length, 2);
  settings.componentWillUnmount();
  assert.deepStrictEqual(removed, ['added', 'removed']);
});

suite.test('Share progress uses payload-only subscription and removes it on unmount', async () => {
  let listener, removed = false;
  window.mynda.share = {
    onProgress: callback => { listener = callback; return () => { removed = true; }; },
    getState: async () => ({ok: true, value: {busy: false}})
  };
  const share = synchronousState(new MynSettingsShare({settings: {used: {kinds: []}}, videos: []}));
  share.componentDidMount();
  await Promise.resolve();
  listener({busy: true, phase: 'fulfill', cancelRequested: true});
  assert.strictEqual(share.state.busy, true);
  assert.strictEqual(share.state.busyPhase, 'fulfill');
  assert.strictEqual(share.state.cancelRequested, true);
  share.componentWillUnmount();
  assert.strictEqual(removed, true);
});

runSuite(suite);
