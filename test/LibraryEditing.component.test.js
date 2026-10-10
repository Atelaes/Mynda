const path = require('path');
const React = require('react');
const _ = require('lodash');
const {EventEmitter} = require('events');
const hashObject = require('object-hash');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {videoFixture, libraryFixture} = require('./helpers/Fixtures');
const {videoEdit} = require('../src/renderer/LibraryEdits');
require('@babel/register')({presets: [require.resolve('@babel/preset-react')], extensions: ['.js'], ignore: [/node_modules/], cache: false});
const suite = createSuite('Library editing and committed renderer state', 'component',
  'Exercises actual editor, player, details and settings handlers against delayed commits, frozen snapshots and storage failures.');
const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const ipc = new EventEmitter();
ipc.send = () => {};
const alerts = [];
global.alert = text => alerts.push(text);
const statuses = [];
let pending = [];
const closeHooks = new Set();
const library = {...libraryFixture(),
  onBeforeClose(callback) { closeHooks.add(callback); return () => closeHooks.delete(callback); },
  patchMediaBatch(edits, callback, options) { pending.push({kind: 'media', edits, callback, options}); },
  patchMedia(id, changes, expected, callback, options) {
    pending.push({kind: 'media', edits: [{id, changes, expected}], callback, options});
  },
  transaction(operations, callback, options) { pending.push({kind: 'settings', operations, callback, options}); },
  patchWatchfolder(folder, changes, expected, callback) {
    pending.push({kind: 'folder', folder, changes, expected, callback});
  }
};
const runtime = {library, editorLog: quiet, artworkLog: quiet, playerLog: quiet,
  libraryViewLog: quiet, settingsLog: quiet, sendLocalStatusUpdate: value => statuses.push(value)};
const {MynEditor} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Editor.js'), {
  electron: {ipcRenderer: ipc}, '../tagging/OmdbHelper.js': {}, './RendererRuntime.js': runtime,
  './SharedComponents.js': {MynOpenablePane: React.Component}, './EditorFields.js': {}
});
const {MynSettings, MynSettingsFolders} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Settings.js'), {
  electron: {ipcRenderer: ipc, shell: {}}, './RendererRuntime.js': runtime,
  './SharedComponents.js': {MynOpenablePane: React.Component}, './EditorFields.js': {}
});
const {MynDetails, MynLibTableRow} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/LibraryView.js'), {
  electron: {ipcRenderer: ipc, shell: {}}, './RendererRuntime.js': runtime,
  'react-virtuoso': {TableVirtuoso() {}}, './SharedComponents.js': {}, './EditorFields.js': {}
});
global.window = {mynda: {editor: {prepareArtwork: async value => value}}};
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function video(letter, overrides = {}) { return videoFixture({id: letter.repeat(64), ...overrides}); }
function stateful(instance) {
  instance.setState = (update, callback) => {
    Object.assign(instance.state, typeof update === 'function' ? update(instance.state) : update);
    if (callback) callback();
  };
  return instance;
}
function reset(videos = [video('a')]) {
  pending = []; alerts.length = 0; statuses.length = 0; closeHooks.clear();
  library.media = freeze(_.cloneDeep(videos));
  library.settings = freeze(_.cloneDeep(libraryFixture().settings));
  library.playlists = freeze([]);
}
function editor(v = library.media[0], extra = {}) {
  const instance = stateful(new MynEditor({video: v, settings: library.settings, ...extra}));
  instance._isMounted = true;
  instance.componentDidUpdate({video: null});
  return instance;
}
function complete(request, error) {
  if (!error && request.kind === 'media') {
    const next = _.cloneDeep(library.media);
    for (const edit of request.edits) {
      const v = next.find(value => value.id === edit.id);
      for (const [key, value] of Object.entries(edit.changes)) {
        if (value === undefined) _.unset(v, key); else _.set(v, key, _.cloneDeep(value));
      }
    }
    library.media = freeze(next);
  }
  if (!error && request.kind === 'settings') {
    for (const op of request.operations) {
      const [head, ...tail] = op.address.split('.');
      let value = _.cloneDeep(library[head]);
      if (!tail.length) value = _.cloneDeep(op.entry); else _.set(value, tail, _.cloneDeep(op.entry));
      library[head] = freeze(value);
    }
  }
  request.callback(error || null, {revision: 1});
}
suite.test('field diffs keep user ratings separate from catalog ratings and carry original identity', () => {
  const original = video('a');
  const patch = videoEdit(original, {...original, ratings: {...original.ratings, user: 4}, title: 'Edited'});
  assert.deepStrictEqual(patch.changes, {title: 'Edited', 'ratings.user': 4});
  assert.deepStrictEqual(patch.expected, {title: original.title, 'ratings.user': ''});
  assert.strictEqual(patch.baseline.imdbID, original.imdbID);
  assert.notStrictEqual(patch.baseline, original);
});
suite.test('a background refresh preserves an ordinary editor draft and its original baseline', () => {
  reset(); const instance = editor(); const oldProps = instance.props;
  instance.handleChange('title', 'My correction');
  const original = instance.state.originalVideo;
  instance.props = {...oldProps, video: {...oldProps.video, title: 'Autotag result', position: 22}};
  instance.componentDidUpdate(oldProps);
  assert.strictEqual(instance.state.video.title, 'My correction');
  assert.strictEqual(instance.state.originalVideo, original);
  assert.strictEqual(original.title, 'Alien');
  instance.revertChanges();
  assert.strictEqual(instance.state.video.title, 'Autotag result');
  assert.strictEqual(instance.state.originalVideo.position, 22);
});
suite.test('a single edit remains dirty until its own commit and includes used lists in the same transaction', async () => {
  reset(); const instance = editor(); instance.handleChange('title', 'My correction');
  const before = instance.state.saveHash;
  const result = instance.saveChanges();
  assert.strictEqual(pending.length, 1);
  const request = pending.shift();
  assert.strictEqual(request.edits[0].id, library.media[0].id);
  assert.strictEqual(request.edits[0].changes.title, 'My correction');
  assert.strictEqual(request.edits[0].changes.metadata, undefined);
  assert.strictEqual(request.edits[0].changes.filename, undefined);
  assert.strictEqual(request.options.updateUsedLists, true);
  assert.strictEqual(request.options.priority, 'user');
  assert.strictEqual(instance.state.saveHash, before);
  assert(instance.state.changed.has('title'));
  assert.strictEqual(library.media[0].title, 'Alien');
  complete(request);
  assert.strictEqual(await result, true);
  assert.strictEqual(instance.state.changed.size, 0);
  assert.strictEqual(instance.state.saveHash, hashObject(instance.state.video));
});
suite.test('storage failure preserves the draft, shows a reason and does not mark it saved', async () => {
  reset(); const instance = editor(); instance.handleChange('description', 'Unsaved');
  const before = instance.state.saveHash;
  const result = instance.saveChanges();
  complete(pending.shift(), Object.assign(new Error('Disk is full'), {code: 'ENOSPC'}));
  assert.strictEqual(await result, false);
  assert.strictEqual(instance.state.video.description, 'Unsaved');
  assert.strictEqual(instance.state.saveHash, before);
  assert(instance.state.changed.has('description'));
  assert(alerts[0].includes('Disk is full'));
  assert.strictEqual(library.media[0].description, video('a').description);
});
suite.test('Next waits for this editor commit and remains on the draft if it fails', async () => {
  reset(); let navigated = 0;
  const instance = editor(undefined, {goToNext() {navigated++;}, detailRowBoundaryFlag: ''});
  instance.handleChange('title', 'Draft');
  const failed = instance.goToNext();
  assert.strictEqual(navigated, 0);
  complete(pending.shift(), Object.assign(new Error('Changed elsewhere'), {code: 'LIBRARY_CONFLICT'}));
  await failed; assert.strictEqual(navigated, 0);
  const succeeded = instance.goToNext();
  complete(pending.shift()); await succeeded;
  assert.strictEqual(navigated, 1);
});
suite.test('batch edits never modify their supplied records and commit all patches together', async () => {
  reset([video('a', {title: 'First', tags: ['common', 'first']}), video('b', {title: 'Second', tags: ['common', 'second']})]);
  const batch = library.media;
  const summary = videoFixture({id: 'batch', title: '', tags: ['common'], new: true});
  const instance = editor(summary, {batch});
  instance.handleChange('tags', ['common', 'added']);
  instance.handleChange('seen', true);
  const saved = instance.saveChanges();
  const request = pending.shift();
  assert.strictEqual(pending.length, 0);
  assert.strictEqual(request.edits.length, 2);
  assert.deepStrictEqual(batch[0].tags, ['common', 'first']);
  assert.deepStrictEqual(request.edits[0].changes.tags, ['common', 'first', 'added']);
  assert.deepStrictEqual(request.edits[1].changes.tags, ['common', 'second', 'added']);
  assert.strictEqual(request.edits[0].changes.title, undefined);
  assert.strictEqual(request.edits[1].changes.seen, true);
  complete(request); assert.strictEqual(await saved, true);
  assert.strictEqual(statuses[statuses.length - 1].action, '');
});
suite.test('same-summary batch selection changes capture the correct new original records', () => {
  reset([video('a'), video('b')]);
  const summary = videoFixture({id: 'batch', title: ''});
  const instance = editor(summary, {batch: [library.media[0]]});
  const old = instance.props;
  instance.props = {...old, batch: [library.media[1]]};
  instance.componentDidUpdate(old);
  assert.strictEqual(instance.state.originalBatch[0].id, library.media[1].id);
});


suite.test('details and inline controls submit changed fields, never an entire old record', () => {
  reset(); const original = library.media[0];
  const details = new MynDetails({video: original});
  details.saveVideo('watchlater', true);
  assert.deepStrictEqual(pending.shift().edits[0].changes, {watchlater: true});
  const row = new MynLibTableRow({settings: {preferences: {override_dialogs: {'MynLibTable-confirm-inlineEdit': true}}}});
  row.saveEdited(original, {ratings: {...original.ratings, user: 5}});
  assert.deepStrictEqual(pending.shift().edits[0].changes, {'ratings.user': 5});
  assert.strictEqual(ipc.listenerCount('save-video-confirm'), 0);
});
suite.test('settings debounce retains edits to two different controls and commits atomically', () => {
  reset(); const settings = stateful(new MynSettings({settings: library.settings}));
  settings.save({'settings.preferences.exclude_samples_from_library': false});
  settings.save({'settings.preferences.exclude_trailers_from_library': false});
  settings.flushSettings();
  const request = pending.shift();
  assert.strictEqual(request.operations.length, 2);
  assert(request.operations.every(op => op.expected === true));
  complete(request);
  assert.strictEqual(library.settings.preferences.exclude_samples_from_library, false);
  assert.strictEqual(library.settings.preferences.exclude_trailers_from_library, false);
});
suite.test('a subsequent settings change while a commit is pending is based on its confirmed predecessor', () => {
  reset(); const settings = stateful(new MynSettings({settings: library.settings}));
  settings.save({'settings.preferences.exclude_samples_from_library': false}); settings.flushSettings();
  const first = pending.shift();
  settings.save({'settings.preferences.exclude_samples_from_library': true}); settings.flushSettings();
  assert.strictEqual(pending.length, 0);
  complete(first);
  assert.strictEqual(pending.length, 1);
  const second = pending.shift();
  assert.strictEqual(second.operations[0].expected, false);
  complete(second);
  assert.strictEqual(library.settings.preferences.exclude_samples_from_library, true);
});
suite.test('failed settings do not join an unrelated later successful save', () => {
  reset(); const settings = stateful(new MynSettings({settings: library.settings}));
  settings.save({'settings.preferences.exclude_samples_from_library': false}); settings.flushSettings();
  complete(pending.shift(), Object.assign(new Error('Full'), {code: 'ENOSPC'}));
  settings.save({'settings.preferences.exclude_trailers_from_library': false}); settings.flushSettings();
  const next = pending.shift();
  assert.deepStrictEqual(next.operations.map(op => op.address), ['settings.preferences.exclude_trailers_from_library']);
  complete(next);
  assert.strictEqual(library.settings.preferences.exclude_samples_from_library, true);
});
suite.test('watchfolder kind uses its path identity instead of an array position', () => {
  reset(); const folders = stateful(new MynSettingsFolders({folders: [{path: '/Shows', kind: 'movie'}], kinds: []}));
  folders.componentDidMount();
  folders.editKind({target: {value: 'show'}}, 0);
  const request = pending.shift();
  assert.strictEqual(request.folder, '/Shows');
  assert.deepStrictEqual(request.changes, {kind: 'show'});
  assert.deepStrictEqual(request.expected, {kind: 'movie'});
});
suite.test('app close flushes settings debounce and waits for its own commit before allowing quit', async () => {
  reset(); const settings = stateful(new MynSettings({settings: library.settings}));
  settings.save({'settings.preferences.exclude_samples_from_library': false});
  let finished = false;
  const closing = [...closeHooks][0]().then(() => { finished = true; });
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(finished, false);
  complete(pending.shift()); await closing;
  assert.strictEqual(finished, true);
  settings.componentWillUnmount();
  assert.strictEqual(closeHooks.size, 0);
});
suite.test('app close receives a settings write failure instead of discarding the pending draft', async () => {
  reset(); const settings = stateful(new MynSettings({settings: library.settings}));
  settings.save({'settings.preferences.exclude_samples_from_library': false});
  const closing = [...closeHooks][0]();
  complete(pending.shift(), Object.assign(new Error('Full'), {code: 'ENOSPC'}));
  await assert.rejects(closing, error => error.code === 'ENOSPC');
  assert.strictEqual(library.settings.preferences.exclude_samples_from_library, true);
});
suite.test('a late save confirmation cannot erase the draft of a different selected video', async () => {
  reset([video('a'), video('b')]);
  const instance = editor(); instance.handleChange('title', 'First draft');
  const saving = instance.saveChanges(); const request = pending.shift();
  const previous = instance.props;
  instance.props = {...previous, video: library.media[1]};
  instance.componentDidUpdate(previous);
  complete(request); await saving;
  assert.strictEqual(instance.state.video.id, library.media[1].id);
  assert.strictEqual(instance.state.video.title, 'Alien');
  assert.strictEqual(instance.state.savePending, false);
});
suite.test('normalizing editor controls does not submit scanner-owned fields or rounded playback positions', async () => {
  const legacy = video('a', {position: 12.34, metadata: null});
  reset([legacy]); const instance = editor(); instance.handleChange('title', 'Edited');
  const saving = instance.saveChanges(); const request = pending.shift();
  assert.strictEqual(request.edits[0].changes.metadata, undefined);
  assert.strictEqual(request.edits[0].changes.position, undefined);
  complete(request); await saving;
  assert.strictEqual(library.media[0].position, 12.34);
  assert.strictEqual(library.media[0].metadata, null);
});
suite.test('actual frozen LibraryClient records remain untouched by editor and list widgets', async () => {
  const LibraryClient = require('../src/library/LibraryClient');
  const data = libraryFixture({media: [video('c')]});
  const transport = new EventEmitter();
  transport.invoke = async channel => {
    assert.strictEqual(channel, 'library:snapshot');
    return {session: 'component-test', revision: 0, data, paths: {}};
  };
  const client = new LibraryClient({api: {snapshot: () => transport.invoke('library:snapshot'),
    onCommitted: callback => { transport.on('library:committed', callback); return () => transport.removeListener('library:committed', callback); },
    onPrepareClose: () => () => {}, onCloseCanceled: () => () => {}}, log: quiet, initialData: libraryFixture()});
  await client.ready;
  assert(Object.isFrozen(client.media[0]));
  assert(Object.isFrozen(client.settings.used.kinds));
  const {MynEditor: ActualClientEditor} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Editor.js'), {
    electron: {ipcRenderer: ipc}, '../tagging/OmdbHelper.js': {},
    './RendererRuntime.js': {...runtime, library: client},
    './SharedComponents.js': {MynOpenablePane: React.Component}, './EditorFields.js': {}
  });
  const instance = stateful(new ActualClientEditor({video: client.media[0], settings: client.settings}));
  instance._isMounted = true; instance.componentDidUpdate({video: null});
  instance.handleChange('tags', ['private draft']);
  assert.deepStrictEqual(client.media[0].tags, ['Science Fiction']);
  const {MynEditListWidget, MynEditAddToList} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/EditorFields.js'), {
    electron: {ipcRenderer: ipc}, './RendererRuntime.js': {...runtime, library: client},
    './SharedComponents.js': {}
  });
  const changed = [];
  const list = stateful(new MynEditListWidget({object: client.media[0], property: 'tags', update: (field, value) => changed.push(value)}));
  list.componentDidMount(); list.deleteItem(0, true);
  assert.deepStrictEqual(changed.pop(), []);
  assert.deepStrictEqual(client.media[0].tags, ['Science Fiction']);
  const add = stateful(new MynEditAddToList({object: client.media[0], property: 'tags', validator: /.+/,
    update: (field, value) => changed.push(value)}));
  add.componentDidMount();
  const previousDocument = global.document;
  global.document = {getElementById: () => ({value: 'Added'})};
  try { add.addItem({preventDefault() {}}); }
  finally { global.document = previousDocument; }
  assert.deepStrictEqual(changed.pop(), ['Science Fiction', 'Added']);
  assert.deepStrictEqual(client.media[0].tags, ['Science Fiction']);
});
suite.test('closing waits for an explicit editor save even while artwork copy precedes library IPC', async () => {
  reset([video('a', {artwork: '/tmp/editor-picked.png'})]);
  let finishCopy;
  window.mynda.editor.prepareArtwork = source => new Promise(resolve => { finishCopy = () => resolve('/tmp/mynda-managed.png'); });
  const {MynEditor: ArtworkEditor} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Editor.js'), {
    electron: {ipcRenderer: ipc, app: {getPath: () => '/tmp/mynda-component-fixture'}},
    '../tagging/OmdbHelper.js': {}, './RendererRuntime.js': runtime,
    './SharedComponents.js': {MynOpenablePane: React.Component}, './EditorFields.js': {}
  });
  const instance = stateful(new ArtworkEditor({video: library.media[0], settings: library.settings}));
  instance._isMounted = true; instance.componentDidUpdate({video: null});
  instance.handleChange('title', 'Draft with artwork');
  const saving = instance.saveChanges();
  assert.strictEqual(pending.length, 0);
  let closed = false;
  const closing = [...closeHooks][0]().then(() => { closed = true; });
  await Promise.resolve(); assert.strictEqual(closed, false);
  finishCopy(null); await Promise.resolve();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(closed, false);
  complete(pending.shift()); await saving; await closing;
  assert.strictEqual(closed, true);
  window.mynda.editor.prepareArtwork = async value => value;
});
suite.test('closing with an unsaved editor draft never implicitly saves it', async () => {
  reset(); const instance = editor(); instance.handleChange('title', 'Do not save yet');
  await [...closeHooks][0]();
  assert.strictEqual(pending.length, 0);
  assert.strictEqual(library.media[0].title, 'Alien');
});

runSuite(suite);
