const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite, temporaryDirectory, removeDirectory} = require('./helpers/TestHarness');
const {createDesktopService} = require('../src/main/DesktopService');

const suite = createSuite('Desktop operations and user-selected filesystem scopes', 'unit',
  'Uses real files and directory identities to verify owner-scoped permissions, durable watchfolder edits and Share plan authorization.');
const quiet = {debug() {}, info() {}, warn() {}, error() {}};
function fixture() {
  const root = temporaryDirectory('desktop-service');
  const share = path.join(root, 'share'), media = path.join(root, 'media');
  fs.mkdirSync(share); fs.mkdirSync(media);
  const calls = [], sent = [];
  const events = [1, 2].map(id => ({sender: {id, isDestroyed: () => false, send: (...args) => sent.push({id, args})}}));
  const library = {path: path.join(root, 'live.json'), media: [{id: 'a'.repeat(64), title: 'Canonical Title',
    filename: path.join(media, 'Film.mkv'), duplicates: [path.join(media, 'Copy.mkv')]}],
    inactive_media: [], settings: {watchfolders: [{path: media, kind: 'movie'}]},
    add(address, folder, callback) { library.settings.watchfolders.push(folder); callback(); },
    saveCopy(file) { fs.writeFileSync(file, '{}'); }, whenIdle: async () => {}};
  const dialog = {
    showOpenDialog: async () => ({canceled: false, filePaths: [share]}),
    showSaveDialog: async () => ({canceled: false, filePath: path.join(root, 'export.json')}),
    showMessageBox: async options => { calls.push(['dialog', options]); return {response: 1, checkboxChecked: false}; }
  };
  const shareService = {
    getState: () => ({busy: false}), cancel: () => true,
    inspect: async directory => { calls.push(['inspect', directory]); return {directory}; },
    createRequest: async options => { calls.push(['create', options]); return {}; },
    planFulfillment: async options => { calls.push(['plan-fulfill', options]); return {token: 'fulfill-token'}; },
    fulfillRequest: async options => { calls.push(['fulfill', options]); return {}; },
    planImport: async options => { calls.push(['plan-import', options]); return {token: 'import-token'}; },
    importShare: async options => { calls.push(['import', options]); return {}; }
  };
  const service = createDesktopService({app: {getPath: () => root}, library, dialog,
    shell: {showItemInFolder: value => calls.push(['reveal', value])}, shareService,
    scan: reason => calls.push(['scan', reason]),
    removeWatchfolder: (folder, callback) => { calls.push(['remove', folder]); callback(); }, log: quiet});
  return {root, share, media, library, dialog, shareService, calls, sent, events, service,
    run: (name, args, event = events[0]) => service.methods[name](event, args),
    close: () => removeDirectory(root)};
}

suite.test('a native picker grants Share access only to the selecting window', async () => {
  const f = fixture();
  try {
    await f.run('share.chooseDirectory');
    assert.strictEqual((await f.run('share.inspect', {directory: f.share})).ok, true);
    assert.strictEqual(f.calls.filter(call => call[0] === 'dialog').length, 0);
    f.dialog.showMessageBox = async () => ({response: 0});
    const denied = await f.run('share.inspect', {directory: f.share}, f.events[1]);
    assert.strictEqual(denied.error.code, 'DIRECTORY_NOT_APPROVED');
    assert.strictEqual(f.calls.filter(call => call[0] === 'inspect').length, 1);
  } finally { f.close(); }
});
suite.test('pasted directories require native approval before watchfolder writes', async () => {
  const f = fixture();
  try {
    f.dialog.showMessageBox = async () => ({response: 0});
    await assert.rejects(f.run('watchfolders.add', {address: f.share, kind: 'movie'}), error => error.code === 'DIRECTORY_NOT_APPROVED');
    assert.strictEqual(f.library.settings.watchfolders.length, 1);
    assert.strictEqual(f.calls.length, 0);
  } finally { f.close(); }
});
suite.test('watchfolder addition waits for its durable commit before notifying or scanning', async () => {
  const f = fixture();
  try {
    await f.run('watchfolders.choose');
    let finish;
    f.library.add = (_address, _folder, callback) => { finish = callback; };
    const pending = f.run('watchfolders.add', {address: f.share, kind: 'MOVIE'});
    await Promise.resolve();
    assert.strictEqual(f.sent.length, 0);
    assert.strictEqual(f.calls.length, 0);
    finish(); await pending;
    assert.deepStrictEqual(f.sent[0].args, ['settings-watchfolder-added', {path: f.share, kind: 'movie', videos: []}]);
    assert.deepStrictEqual(f.calls, [['scan', 'watchfolder-added']]);
  } finally { f.close(); }
});
suite.test('a replaced approved directory cannot silently inherit the old permission', async () => {
  const f = fixture();
  try {
    await f.run('share.chooseDirectory');
    fs.renameSync(f.share, path.join(f.root, 'old-share'));
    fs.mkdirSync(f.share);
    const denied = await f.run('share.inspect', {directory: f.share});
    assert.strictEqual(denied.error.code, 'DIRECTORY_CHANGED');
    assert.strictEqual(f.calls.length, 0);
  } finally { f.close(); }
});
suite.test('Share execution requires a plan issued to the same window and operation', async () => {
  const f = fixture();
  try {
    await f.run('share.chooseDirectory');
    const planned = await f.run('share.planFulfillment', {directory: f.share, kindMappings: [], includeDvds: true});
    const token = planned.value.token;
    assert.strictEqual((await f.run('share.fulfillRequest', {token}, f.events[1])).error.code, 'SHARE_PLAN_EXPIRED');
    assert.strictEqual((await f.run('share.import', {token})).error.code, 'SHARE_PLAN_EXPIRED');
    assert.strictEqual((await f.run('share.fulfillRequest', {token})).ok, true);
    assert.strictEqual((await f.run('share.fulfillRequest', {token})).error.code, 'SHARE_PLAN_EXPIRED');
    assert.strictEqual(f.calls.filter(call => call[0] === 'fulfill').length, 1);
  } finally { f.close(); }
});
suite.test('an import plan is rejected after its destination watchfolder changes', async () => {
  const f = fixture();
  try {
    await f.run('share.chooseDirectory');
    const planned = await f.run('share.planImport', {directory: f.share,
      kindMappings: [{requestedKindId: 'movies', localKind: 'movie', watchfolder: f.media}]});
    fs.renameSync(f.media, path.join(f.root, 'old-media')); fs.mkdirSync(f.media);
    assert.strictEqual((await f.run('share.import', {token: planned.value.token})).error.code, 'SHARE_PLAN_STALE');
    assert.strictEqual(f.calls.filter(call => call[0] === 'import').length, 0);
  } finally { f.close(); }
});
suite.test('file-manager requests resolve canonical library files and reject invented duplicates', async () => {
  const f = fixture();
  try {
    const video = f.library.media[0];
    await f.run('files.revealVideo', {videoID: video.id});
    await f.run('files.revealVideo', {videoID: video.id, duplicatePath: video.duplicates[0]});
    await assert.rejects(f.run('files.revealVideo', {videoID: video.id, duplicatePath: path.join(f.root, 'secret')}), error => error.code === 'FILE_NOT_AUTHORIZED');
    await assert.rejects(f.run('files.revealVideo', {videoID: video.id, filename: '/invented'}), error => error.code === 'INVALID_APP_REQUEST');
    assert.deepStrictEqual(f.calls, [['reveal', video.filename], ['reveal', video.duplicates[0]]]);
  } finally { f.close(); }
});
suite.test('only the exporting window can reveal its completed export', async () => {
  const f = fixture();
  try {
    const exported = await f.run('library.export');
    assert.strictEqual(exported.ok, true);
    const filename = exported.value.filePath;
    await f.run('files.revealExport', filename);
    await assert.rejects(f.run('files.revealExport', filename, f.events[1]), error => error.code === 'FILE_NOT_AUTHORIZED');
    f.service.dispose(f.events[0].sender.id);
    await assert.rejects(f.run('files.revealExport', filename), error => error.code === 'FILE_NOT_AUTHORIZED');
  } finally { f.close(); }
});
suite.test('disposing a window while its chooser is open prevents a late permission grant', async () => {
  const f = fixture();
  try {
    let finish;
    f.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
    const pending = f.run('watchfolders.choose');
    f.service.dispose(f.events[0].sender.id);
    finish({canceled: false, filePaths: [f.share]});
    await assert.rejects(pending, error => error.code === 'APP_UNAUTHORIZED');
  } finally { f.close(); }
});
suite.test('video-edit confirmation uses backend identity and refuses generic dialog options', async () => {
  const f = fixture();
  try {
    await f.run('dialogs.confirmVideoEdit', {videoID: f.library.media[0].id, changes: {seen: true}, showSkipDialog: true});
    assert(f.calls[0][1].message.includes('Canonical Title'));
    await assert.rejects(f.run('dialogs.confirmPaneExit', {id: 'editor-pane', message: 'Close?', buttons: ['Danger']}), error => error.code === 'INVALID_APP_REQUEST');
  } finally { f.close(); }
});
runSuite(suite);
