const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {EventEmitter} = require('events');
const {
  assert, createSuite, runSuite, withTemporaryDirectory
} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures');
const Persistence = require('../src/library/LibraryPersistence');
const {buildTaggingReport} = require('../src/tagging/TaggingReport');
const {validateRendererCommit} = require('../src/library/LibraryRendererPolicy');

const suite = createSuite('Single-writer library transactions', 'integration',
  'The real library, isolated atomic files, independently scheduled Electron messages, and failures at the filesystem boundary.');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const videoID = n => String(n).padStart(64, '0');
const quietLog = {child: () => ({debug() {}, info() {}, warn() {}, error() {}})};

// Electron serializes messages at send time. References shared between the
// two fixtures would conceal precisely the stale-copy bugs being protected.
function pairedLibrary(directory, videos = [], inactiveVideos = []) {
  const primary = path.join(directory, 'Library', 'library.json');
  Persistence.writeLibraryFile(primary, libraryFixture({videoIdScheme: 2, media: videos, inactive_media: inactiveVideos}));
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = channel => handlers.delete(channel);
  const messages = [];
  const history = [];
  const renderers = [];
  const policy = {code: null, failPoint: 'write', writes: 0};
  const descriptors = new Map();
  const fail = () => { throw Object.assign(new Error('Injected library filesystem failure'), {
    code: policy.code, syscall: policy.failPoint
  }); };
  const persistence = loadFreshWithMocks(path.join(__dirname, '../src/library/LibraryPersistence.js'), {fs: {
    ...fs,
    openSync(file, ...args) {
      const fd = fs.openSync(file, ...args);
      descriptors.set(fd, file);
      return fd;
    },
    closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
    writeFileSync(file, contents, ...args) {
      const isPrimaryTemp = typeof file === 'number' &&
        path.basename(String(descriptors.get(file))).startsWith('.library.json.tmp-');
      if (isPrimaryTemp) {
        policy.writes++;
        if (policy.code && policy.failPoint === 'write') {
          fs.writeSync(file, Buffer.from(contents).subarray(0, 31));
          fail();
        }
      }
      return fs.writeFileSync(file, contents, ...args);
    },
    renameSync(from, to) {
      if (to === primary && policy.code && policy.failPoint === 'rename') fail();
      return fs.renameSync(from, to);
    }
  }});
  const app = {getPath: name => {
    assert.strictEqual(name, 'userData');
    return directory;
  }};
  const loadClass = (electron, libraryPersistence) => loadFreshWithMocks(
    path.join(__dirname, '../src/library/Library.js'), {
      electron, './LibraryPersistence.js': libraryPersistence,
      '../platform/Logger.js': quietLog
    });
  const Main = loadClass({app, ipcMain}, persistence);
  const main = new Main();
  // Begin with an already migrated on-disk fixture. Schema migration/recovery
  // has its own suite; these comparisons isolate subsequent transactions.
  Persistence.writeLibraryFile(primary, main.getSaveObject());
  main.lastAutomaticBackupDate = new Date();
  policy.writes = 0;

  function createRenderer(senderID) {
    const ipcRenderer = new EventEmitter();
    const diskCalls = [];
    const sender = new EventEmitter();
    sender.id = senderID || renderers.length + 1;
    sender.destroyed = false;
    sender.isDestroyed = () => sender.destroyed;
    sender.getURL = () => pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href;
    sender.mainFrame = {url: sender.getURL()};
    const event = () => ({sender, senderFrame: sender.mainFrame,
      reply: (channel, ...args) => sender.send(channel, ...args)});
    const enqueue = (direction, channel, args, deliver) => {
      const entry = {direction, channel, args: clone(args), sender, deliver};
      messages.push(entry);
      history.push({direction, channel, args: clone(args), senderID: sender.id});
    };
    sender.send = (channel, ...args) => {
      if (sender.destroyed) throw new Error('Renderer has closed');
      enqueue('renderer', channel, args, copy => ipcRenderer.emit(channel, {}, ...copy));
    };
    ipcRenderer.send = (channel, ...args) => enqueue('main', channel, args,
      copy => ipcMain.emit(channel, event(), ...copy));
    ipcRenderer.sendSync = (channel, ...args) => {
      history.push({direction: 'sync', channel, args: clone(args), senderID: sender.id});
      const request = event();
      ipcMain.emit(channel, request, ...clone(args));
      return clone(request.returnValue);
    };
    ipcRenderer.invoke = (channel, ...args) => new Promise((resolve, reject) => {
      enqueue('invoke', channel, args, async copy => {
        try {
          assert(handlers.has(channel), `No handler for ${channel}`);
          const response = clone(await handlers.get(channel)(event(), ...copy));
          if (ipcRenderer.holdSnapshotResponses && channel === 'library:snapshot') {
            enqueue('reply', channel, [response], reply => resolve(reply[0]));
          } else resolve(response);
        } catch (error) { reject(error); }
      });
    });
    const {createBridge} = require('../src/preload/Bridge');
    const channels = {'library.snapshot':'library:snapshot','library.commit':'library:commit',
      'library.closeReady':'library:close-ready'};
    const api = createBridge({platform:process.platform,
      invoke:(method,...args)=>ipcRenderer.invoke(channels[method],...args),
      subscribe:(channel,callback)=>{
        const listener=(_event,...args)=>callback(...args);
        ipcRenderer.on(channel,listener);
        return ()=>ipcRenderer.removeListener(channel,listener);
      }}).library;
    const Client = require('../src/library/LibraryClient');
    const renderer = new Client({api,log:quietLog.child(),initialData:require('../src/library/LibraryDefaults')});
    const result = {renderer, sender, ipcRenderer, diskCalls};
    renderers.push(result);
    return result;
  }

  function deliver(predicate = () => true) {
    const index = messages.findIndex(predicate);
    if (index < 0) return false;
    const entry = messages.splice(index, 1)[0];
    if (!entry.sender.destroyed) entry.deliver(clone(entry.args));
    return entry;
  }

  async function flush(predicate = () => true) {
    // Each pass gives scheduled commit work a chance to run; actual IPC is
    // delivered explicitly so tests can withhold or reorder either direction.
    let quiet = 0;
    for (let pass = 0; pass < 200; pass++) {
      let count = 0;
      while (deliver(predicate)) {
        if (++count > 500) throw new Error('Library IPC did not settle');
      }
      await turn();
      if (count === 0 && !messages.some(predicate)) {
        if (++quiet === 3) return;
      } else quiet = 0;
    }
    throw new Error('Library transaction work did not settle');
  }

  return {main, primary, policy, persistence, messages, history, renderers,
    handlers, createRenderer, deliver, flush, disk: () => Persistence.readLibraryFile(primary).data};
}

function operation(instance, method, ...args) {
  const result = {done: false, error: null, value: undefined};
  const pending = instance[method](...args, (error, value) => {
    result.done = true;
    result.error = error || null;
    result.value = value;
  });
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  return result;
}

function transaction(instance, operations, options = {}) {
  const result = {done: false, error: null, value: undefined};
  const pending = instance.transaction(operations, (error, value) => {
    result.done = true;
    result.error = error || null;
    result.value = value;
    if (result.onComplete) result.onComplete();
  }, options);
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  return result;
}

function patchBatch(instance, patches, options = {}) {
  const result = {done: false, error: null, value: undefined};
  const pending = instance.patchMediaBatch(patches, (error, value) => {
    result.done = true;
    result.error = error || null;
    result.value = value;
  }, options);
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  return result;
}

function assertCommitted(result) {
  assert.strictEqual(result.done, true, 'The caller must receive its own commit result');
  assert.ifError(result.error);
}

suite.test('renderer startup obtains backend state without opening, backing up, or writing the library', () =>
  withTemporaryDirectory('transaction-renderer-bootstrap', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    assert.deepStrictEqual(client.diskCalls, []);
    assert.deepStrictEqual(client.renderer.media, f.main.media);
    assert.notStrictEqual(client.renderer.media, f.main.media);
    assert.notStrictEqual(client.renderer.media[0], f.main.media[0]);
    assert.strictEqual(f.policy.writes, 0);
  }));

suite.test('overlapping backend and renderer saves both survive delayed IPC and renderer reload', () =>
  withTemporaryDirectory('transaction-overlap', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const backendSave = operation(f.main, 'replace',
      'settings.preferences.exclude_trailers_from_library', false);
    const rendererSave = operation(client.renderer, 'replace',
      'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(backendSave);
    assertCommitted(rendererSave);
    for (const data of [f.main, client.renderer, f.disk()]) {
      assert.strictEqual(data.settings.preferences.exclude_trailers_from_library, false);
      assert.strictEqual(data.settings.preferences.exclude_samples_from_library, false);
    }
    assert.deepStrictEqual(client.diskCalls, []);
    const reloaded = f.createRenderer();
    await f.flush();
    assert.deepStrictEqual(reloaded.renderer.getSaveObject(), f.disk());
  }));

for (const point of ['write', 'rename']) {
  suite.test(`ordinary save failure during ${point} retains confirmed state and never leaks into a later commit`, () =>
    withTemporaryDirectory(`transaction-failure-${point}`, async directory => {
      const f = pairedLibrary(directory);
      const client = f.createRenderer();
      await f.flush();
      const before = f.disk();
      f.policy.code = 'ENOSPC';
      f.policy.failPoint = point;
      const failed = operation(client.renderer, 'replace',
        'settings.preferences.exclude_samples_from_library', false);
      await f.flush();
      assert.strictEqual(failed.done, true);
      assert(failed.error);
      assert.strictEqual(failed.error.code, 'ENOSPC');
      for (const data of [f.main, client.renderer, f.disk()]) {
        assert.strictEqual(data.settings.preferences.exclude_samples_from_library,
          before.settings.preferences.exclude_samples_from_library);
      }
      assert(!fs.readdirSync(path.dirname(f.primary)).some(name => name.includes('.tmp-')));
      f.policy.code = null;
      const later = operation(f.main, 'replace',
        'settings.preferences.exclude_trailers_from_library', false);
      await f.flush();
      assertCommitted(later);
      assert.strictEqual(f.disk().settings.preferences.exclude_trailers_from_library, false);
      assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, true);
      assert.deepStrictEqual(client.diskCalls, []);
    }));
}

suite.test('a failed batch leaves every video unchanged, and a retry commits the whole batch', () =>
  withTemporaryDirectory('transaction-batch-rollback', async directory => {
    const f = pairedLibrary(directory, [1, 2].map(n => videoFixture({
      id: videoID(n), title: `Original ${n}`, filename: `/Movies/${n}.mkv`
    })));
    const client = f.createRenderer();
    await f.flush();
    const before = clone(f.main.media);
    const edits = client.renderer.media.map(video => ({...video, title: `Edited ${video.title}`}));
    f.policy.code = 'ENOSPC';
    const failed = operation(client.renderer, 'replaceMediaBatch', edits);
    await f.flush();
    assert.strictEqual(failed.done, true);
    assert.strictEqual(failed.error && failed.error.code, 'ENOSPC');
    for (const data of [f.main, client.renderer, f.disk()]) assert.deepStrictEqual(data.media, before);
    f.policy.code = null;
    const writes = f.policy.writes;
    const retry = operation(client.renderer, 'replaceMediaBatch', edits);
    await f.flush();
    assertCommitted(retry);
    assert.strictEqual(f.policy.writes - writes, 1, 'One atomic file commit for the entire batch');
    for (const data of [f.main, client.renderer, f.disk()]) {
      assert.deepStrictEqual(data.media.map(video => video.title), ['Edited Original 1', 'Edited Original 2']);
    }
  }));

suite.test('a renderer disconnect cannot roll back a durable backend commit or stall later saves', () =>
  withTemporaryDirectory('transaction-disconnect', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    client.sender.destroyed = true;
    client.sender.emit('destroyed');
    const first = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(first);
    const second = operation(f.main, 'replace', 'settings.preferences.exclude_trailers_from_library', false);
    await f.flush();
    assertCommitted(second);
    const reconnected = f.createRenderer();
    await f.flush();
    for (const data of [reconnected.renderer, f.disk()]) {
      assert.strictEqual(data.settings.preferences.exclude_samples_from_library, false);
      assert.strictEqual(data.settings.preferences.exclude_trailers_from_library, false);
    }
  }));

suite.test('invalid candidate data is rejected without publishing or changing the last valid file', () =>
  withTemporaryDirectory('transaction-validation', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const before = f.disk();
    const invalid = operation(f.main, 'replace', 'media', {not: 'an array'});
    await f.flush();
    assert.strictEqual(invalid.done, true);
    assert(invalid.error);
    assert.deepStrictEqual(f.disk(), before);
    assert.deepStrictEqual(f.main.getSaveObject(), before);
    assert.deepStrictEqual(client.renderer.getSaveObject(), before);
  }));

suite.test('field patches preserve a simultaneous manual title and discovered technical metadata', () =>
  withTemporaryDirectory('transaction-unrelated-video-fields', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(f.main.media[0]);
    const metadata = {...baseline.metadata, width: 3840, height: 2160};
    const user = patchBatch(client.renderer, [{id: baseline.id,
      changes: {title: 'My manual title'}, expected: {title: baseline.title}}], {priority: 'user'});
    const scan = patchBatch(f.main, [{id: baseline.id,
      changes: {metadata}, expected: {metadata: baseline.metadata}}], {priority: 'background'});
    await f.flush();
    assertCommitted(user);
    assertCommitted(scan);
    for (const data of [f.main, client.renderer, f.disk()]) {
      assert.strictEqual(data.media[0].title, 'My manual title');
      assert.strictEqual(data.media[0].metadata.width, 3840);
    }
  }));

suite.test('an outdated player position save does not replace newly edited identification metadata', () =>
  withTemporaryDirectory('transaction-player-save', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const playbackStartingVideo = clone(f.main.media[0]);
    const edit = patchBatch(client.renderer, [{id: playbackStartingVideo.id,
      changes: {title: 'Correct title', imdbID: 'tt0123456'}, baseline: playbackStartingVideo}],
    {priority: 'user', coherent: true});
    await f.flush();
    assertCommitted(edit);
    const playback = patchBatch(f.main, [{id: playbackStartingVideo.id,
      changes: {position: 125.4}, expected: {position: playbackStartingVideo.position}}]);
    await f.flush();
    assertCommitted(playback);
    for (const data of [f.main, client.renderer, f.disk()]) {
      assert.strictEqual(data.media[0].title, 'Correct title');
      assert.strictEqual(data.media[0].imdbID, 'tt0123456');
      assert.strictEqual(data.media[0].position, 125.4);
    }
  }));

suite.test('autotag identification based on an older title is skipped as a coherent result', () =>
  withTemporaryDirectory('transaction-coherent-identity', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), autotag_tried: false})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(f.main.media[0]);
    const user = patchBatch(client.renderer, [{id: baseline.id,
      changes: {title: 'My correction'}, expected: {title: baseline.title}}]);
    await f.flush();
    assertCommitted(user);
    const beforeTag = f.disk();
    const tag = patchBatch(f.main, [{id: baseline.id,
      changes: {imdbID: 'tt9999999', year: 2020, description: 'Different identification', autotag_tried: true},
      baseline}], {priority: 'background', conflict: 'skip', coherent: true});
    await f.flush();
    assertCommitted(tag);
    assert.deepStrictEqual(f.disk(), beforeTag);
    assert(tag.value && ((tag.value.skipped && tag.value.skipped.length) ||
      (tag.value.conflicts && tag.value.conflicts.length)), 'The caller needs the skipped conflict result');
  }));

suite.test('a stale editor conflict rejects the entire batch, including unrelated pending edits', () =>
  withTemporaryDirectory('transaction-batch-conflict', async directory => {
    const f = pairedLibrary(directory, [1, 2].map(n => videoFixture({id: videoID(n), title: `Original ${n}`})));
    const client = f.createRenderer();
    await f.flush();
    const old = clone(client.renderer.media);
    const competing = patchBatch(f.main, [{id: old[0].id,
      changes: {title: 'Already corrected'}, expected: {title: old[0].title}}]);
    await f.flush();
    assertCommitted(competing);
    const before = f.disk();
    const stale = patchBatch(client.renderer, old.map(video => ({id: video.id,
      changes: {title: 'Outdated editor value'}, expected: {title: video.title}})), {conflict: 'reject'});
    await f.flush();
    assert.strictEqual(stale.done, true);
    assert(stale.error, 'A competing edit must be reported rather than silently replaced');
    assert.deepStrictEqual(f.disk(), before);
    assert.deepStrictEqual(client.renderer.getSaveObject(), before);
  }));

suite.test('moving a video between active and inactive arrays commits once or not at all', () =>
  withTemporaryDirectory('transaction-move-record', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const video = clone(f.main.media[0]);
    const operations = [
      {opType: 'remove', address: `media.id=${video.id}`, expected: video},
      {opType: 'add', address: 'inactive_media.push', entry: video}
    ];
    f.policy.code = 'ENOSPC';
    const failed = transaction(f.main, operations);
    await f.flush();
    assert.strictEqual(failed.done, true);
    assert.strictEqual(failed.error && failed.error.code, 'ENOSPC');
    for (const data of [f.main, f.disk()]) {
      assert.strictEqual(data.media.length, 1);
      assert.strictEqual(data.inactive_media.length, 0);
    }
    f.policy.code = null;
    const writes = f.policy.writes;
    const success = transaction(f.main, operations);
    await f.flush();
    assertCommitted(success);
    assert.strictEqual(f.policy.writes - writes, 1);
    for (const data of [f.main, f.disk()]) {
      assert.strictEqual(data.media.length, 0);
      assert.strictEqual(data.inactive_media[0].id, video.id);
    }
  }));

suite.test('user saves pass waiting background commits and complete without waiting for global idle', () =>
  withTemporaryDirectory('transaction-user-priority', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const background = Array.from({length: 20}, (_,index) => transaction(f.main, [{
      opType: 'add', address: 'playlists.push', entry: {id: `background-${index}`, name: `Scan ${index}`, view: 'flat'}
    }], {priority: 'background'}));
    const user = transaction(client.renderer, [{opType: 'replace',
      address: 'settings.preferences.exclude_samples_from_library', entry: false}], {priority: 'user'});
    let pendingWhenUserFinished = 0;
    user.onComplete = () => { pendingWhenUserFinished = background.filter(job => !job.done).length; };
    await f.flush();
    assertCommitted(user);
    background.forEach(assertCommitted);
    assert(pendingWhenUserFinished >= 18,
      `User save waited behind ${20 - pendingWhenUserFinished} background commits`);
    assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, false);
    assert.strictEqual(f.disk().playlists.length, 20);
  }));

suite.test('the renderer repairs a missed commit with an authoritative snapshot', () =>
  withTemporaryDirectory('transaction-revision-gap', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const first = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush(message => message.direction !== 'renderer');
    assertCommitted(first);
    const discarded = f.messages.findIndex(message => message.channel === 'library:committed');
    assert(discarded >= 0, 'Backend publishes a committed revision');
    f.messages.splice(discarded, 1);
    const snapshotsBefore = f.history.filter(message => message.channel === 'library:snapshot').length;
    const second = operation(f.main, 'replace', 'settings.preferences.exclude_trailers_from_library', false);
    await f.flush();
    assertCommitted(second);
    assert(f.history.filter(message => message.channel === 'library:snapshot').length > snapshotsBefore,
      'A revision gap requires resynchronization');
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
    assert.deepStrictEqual(client.diskCalls, []);
  }));

suite.test('an older duplicate commit cannot overwrite a newer renderer revision', () =>
  withTemporaryDirectory('transaction-old-message', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const first = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(first);
    const firstCommit = clone(f.history.find(message => message.channel === 'library:committed').args);
    const second = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', true);
    await f.flush();
    assertCommitted(second);
    client.ipcRenderer.emit('library:committed', {}, ...firstCommit);
    await f.flush();
    assert.strictEqual(client.renderer.settings.preferences.exclude_samples_from_library, true);
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
  }));

suite.test('a late background result cannot resurrect a removed video', () =>
  withTemporaryDirectory('transaction-removed-video', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const baseline = clone(f.main.media[0]);
    const removed = transaction(f.main, [{opType: 'remove', address: `media.id=${baseline.id}`,
      expected: baseline}], {priority: 'user'});
    await f.flush();
    assertCommitted(removed);
    const background = patchBatch(f.main, [{id: baseline.id,
      changes: {imdbID: 'tt9999999'}, baseline}], {priority: 'background', conflict: 'skip', coherent: true});
    await f.flush();
    assertCommitted(background);
    assert.deepStrictEqual(f.disk().media, []);
    assert.deepStrictEqual(f.main.media, []);
    assert(background.value && ((background.value.skipped && background.value.skipped.length) ||
      (background.value.conflicts && background.value.conflicts.length)));
  }));

suite.test('submitted changes are isolated from later caller mutation', () =>
  withTemporaryDirectory('transaction-submission-copy', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const changes = {title: 'Submitted title', ratings: {...f.main.media[0].ratings, user: 4}};
    const save = patchBatch(f.main, [{id: videoID(1), changes}]);
    changes.title = 'Changed after submission';
    changes.ratings.user = 1;
    await f.flush();
    assertCommitted(save);
    assert.strictEqual(f.disk().media[0].title, 'Submitted title');
    assert.strictEqual(f.disk().media[0].ratings.user, 4);
  }));

suite.test('confirmed records cannot be changed in place outside a transaction', () =>
  withTemporaryDirectory('transaction-readonly-records', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const before = f.disk();
    for (const library of [f.main, client.renderer]) {
      assert(Object.isFrozen(library.media));
      assert(Object.isFrozen(library.media[0]));
      assert(Object.isFrozen(library.media[0].ratings));
      assert(Object.isFrozen(library.settings.preferences));
    }
    assert.deepStrictEqual(f.disk(), before);
  }));

suite.test('a commit from another backend session triggers a fresh snapshot instead of applying its data', () =>
  withTemporaryDirectory('transaction-session-change', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const save = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(save);
    const oldCommit = clone(f.history.find(message => message.channel === 'library:committed').args);
    oldCommit[0].session = 'a-different-backend-session';
    oldCommit[0].revision = 999;
    const snapshotsBefore = f.history.filter(message => message.channel === 'library:snapshot').length;
    client.ipcRenderer.emit('library:committed', {}, ...oldCommit);
    await f.flush();
    assert(f.history.filter(message => message.channel === 'library:snapshot').length > snapshotsBefore);
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
  }));

suite.test('repeated delivery of one commit request performs only one write', () =>
  withTemporaryDirectory('transaction-idempotent-request', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const add = operation(client.renderer, 'add', 'playlists.push', {id: 'one', name: 'One', view: 'flat'});
    await f.flush();
    assertCommitted(add);
    const request = clone(f.history.find(message => message.channel === 'library:commit').args[0]);
    const writes = f.policy.writes;
    const duplicate = client.ipcRenderer.invoke('library:commit', request);
    await f.flush();
    const response = await duplicate;
    assert(!response.error);
    assert.strictEqual(f.policy.writes, writes);
    assert.strictEqual(f.disk().playlists.length, 1);
  }));

suite.test('renderer reload in the same window cannot reuse an earlier command request ID', () =>
  withTemporaryDirectory('transaction-reload-requests', async directory => {
    const f = pairedLibrary(directory);
    const firstClient = f.createRenderer();
    await f.flush();
    const first = operation(firstClient.renderer, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(first);
    const reloaded = f.createRenderer(firstClient.sender.id);
    await f.flush();
    const second = operation(reloaded.renderer, 'replace', 'settings.preferences.exclude_trailers_from_library', false);
    await f.flush();
    assertCommitted(second);
    const requests = f.history.filter(message => message.channel === 'library:commit').map(message => message.args[0].requestId);
    assert.strictEqual(new Set(requests).size, 2);
    assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, false);
    assert.strictEqual(f.disk().settings.preferences.exclude_trailers_from_library, false);
  }));

suite.test('a revision gap arriving during an older snapshot request still catches up without another commit', () =>
  withTemporaryDirectory('transaction-stale-inflight-snapshot', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    client.ipcRenderer.holdSnapshotResponses = true;
    await f.flush(message => message.direction !== 'reply');
    assert(f.messages.some(message => message.direction === 'reply'));
    const first = operation(f.main, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    const second = operation(f.main, 'replace', 'settings.preferences.exclude_trailers_from_library', false);
    await f.flush(message => !['renderer', 'reply'].includes(message.direction));
    assertCommitted(first);
    assertCommitted(second);
    const firstCommit = f.messages.findIndex(message => message.channel === 'library:committed');
    assert(firstCommit >= 0);
    f.messages.splice(firstCommit, 1);
    assert(f.deliver(message => message.channel === 'library:committed'));
    client.ipcRenderer.holdSnapshotResponses = false;
    await f.flush();
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
  }));

suite.test('remote documents and child frames cannot read or write the library', () =>
  withTemporaryDirectory('transaction-ipc-origin', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const before = f.disk();
    const events = [
      {sender: {...client.sender, getURL: () => 'https://example.invalid/'}},
      {sender: client.sender, senderFrame: {url: client.sender.getURL()}}
    ];
    for (const event of events) {
      await assert.rejects(async () => f.handlers.get('library:snapshot')(event),
        error => error.code === 'LIBRARY_UNAUTHORIZED');
      const response = await f.handlers.get('library:commit')(event, {requestId: 'invalid-origin',
        operations: [{opType: 'replace', address: 'media', entry: []}]});
      assert.strictEqual(response.error && response.error.code, 'LIBRARY_UNAUTHORIZED');
    }
    assert.deepStrictEqual(f.disk(), before);
    assert.strictEqual(f.policy.writes, 0);
  }));

suite.test('the trusted renderer can load and save through a directory symlink or junction', () =>
  withTemporaryDirectory('transaction-ipc-trusted-path-alias', async directory => {
    const rendererDirectory = path.resolve(__dirname, '../src/renderer');
    const aliasDirectory = path.join(directory, 'Mynda renderer alias');
    fs.symlinkSync(rendererDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasFile = path.join(aliasDirectory, 'index.html');
    assert.notStrictEqual(path.resolve(aliasFile), path.join(rendererDirectory, 'index.html'));
    assert.strictEqual(fs.realpathSync(aliasFile), fs.realpathSync(path.join(rendererDirectory, 'index.html')));
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    client.sender.getURL = () => pathToFileURL(aliasFile).href;
    client.sender.mainFrame.url = client.sender.getURL();
    await f.flush();
    await client.renderer.ready;
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
    const save = operation(client.renderer, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(save);
    assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, false);
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
    assert(f.history.some(message => message.channel === 'library:snapshot'));
    assert(f.history.some(message => message.channel === 'library:commit'));
    assert.deepStrictEqual(client.diskCalls, []);
  }));

suite.test('canonical renderer path checks still reject unrelated files, their aliases, remote URLs and child frames', () =>
  withTemporaryDirectory('transaction-ipc-untrusted-path-alias', async directory => {
    const rendererDirectory = path.resolve(__dirname, '../src/renderer');
    const trustedAlias = path.join(directory, 'trusted-alias');
    fs.symlinkSync(rendererDirectory, trustedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const unrelatedDirectory = path.join(directory, 'unrelated');
    fs.mkdirSync(unrelatedDirectory);
    const unrelatedFile = path.join(unrelatedDirectory, 'index.html');
    fs.writeFileSync(unrelatedFile, '<!doctype html><title>Unrelated index.html</title>');
    const untrustedAlias = path.join(directory, 'untrusted-alias');
    let aliasFile;
    if (process.platform === 'win32') {
      // Directory junctions exercise canonical-file rejection without requiring
      // Windows administrator/developer-mode privileges for file symlinks.
      fs.symlinkSync(unrelatedDirectory, untrustedAlias, 'junction');
      aliasFile = path.join(untrustedAlias, 'index.html');
    } else {
      fs.mkdirSync(untrustedAlias);
      aliasFile = path.join(untrustedAlias, 'index.html');
      fs.symlinkSync(unrelatedFile, aliasFile, 'file');
    }
    assert.strictEqual(fs.realpathSync(aliasFile), fs.realpathSync(unrelatedFile));
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const before = f.disk();
    const urls = [pathToFileURL(unrelatedFile).href, pathToFileURL(aliasFile).href,
      'https://example.invalid/index.html', pathToFileURL(path.join(trustedAlias, 'index.html')).href];
    for (const [index, url] of urls.entries()) {
      const mainFrame = {url};
      const sender = {...client.sender, mainFrame, getURL: () => url};
      const event = {sender, senderFrame: index === urls.length - 1 ? {url} : mainFrame};
      await assert.rejects(async () => f.handlers.get('library:snapshot')(event),
        error => error.code === 'LIBRARY_UNAUTHORIZED');
      const response = await f.handlers.get('library:commit')(event, {requestId: `untrusted-alias-${index}`,
        operations: [{opType: 'replace', address: 'settings.preferences.exclude_samples_from_library', entry: false}]});
      assert.strictEqual(response.error && response.error.code, 'LIBRARY_UNAUTHORIZED');
    }
    assert.deepStrictEqual(f.disk(), before);
    assert.strictEqual(f.policy.writes, 0);
  }));

suite.test('queued array-index edits retain their selected record when an earlier removal shifts indices', () =>
  withTemporaryDirectory('transaction-stable-selectors', async directory => {
    const f = pairedLibrary(directory, [1, 2, 3].map(n => videoFixture({id: videoID(n), title: `Video ${n}`})));
    const remove = operation(f.main, 'remove', 'media.0');
    const edit = operation(f.main, 'replace', 'media.1.title', 'Edited second video');
    await f.flush();
    assertCommitted(remove);
    assertCommitted(edit);
    assert.deepStrictEqual(f.disk().media.map(video => [video.id, video.title]), [
      [videoID(2), 'Edited second video'], [videoID(3), 'Video 3']
    ]);
  }));

suite.test('manual subtitle edits retain provenance while unrelated edits preserve the latest discovered files', () =>
  withTemporaryDirectory('transaction-subtitle-provenance', async directory => {
    const detected = '/Movies/Movie.en.srt', manual = '/Movies/chosen.srt';
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), subtitles: [detected],
      detected_subtitles: [detected], manual_subtitles: [], ignored_subtitles: [], subtitle_tracking_initialized: true})]);
    const client = f.createRenderer();
    await f.flush();
    const edit = patchBatch(client.renderer, [{id: videoID(1), changes: {subtitles: [manual]}, expected: {subtitles: [detected]}}]);
    await f.flush();
    assertCommitted(edit);
    const title = patchBatch(client.renderer, [{id: videoID(1), changes: {title: 'New title'}}]);
    await f.flush();
    assertCommitted(title);
    const saved = f.disk().media[0];
    assert.deepStrictEqual(saved.subtitles, [manual]);
    assert.deepStrictEqual(saved.detected_subtitles, [detected]);
    assert.deepStrictEqual(saved.manual_subtitles, [manual]);
    assert.deepStrictEqual(saved.ignored_subtitles, [detected]);
  }));

suite.test('an editor identity change detects identification committed after its starting baseline', () =>
  withTemporaryDirectory('transaction-editor-identity-conflict', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(client.renderer.media[0]);
    const tag = patchBatch(f.main, [{id: baseline.id,
      changes: {imdbID: 'tt9999999'}, baseline}], {coherent: true, priority: 'background'});
    await f.flush();
    assertCommitted(tag);
    const before = f.disk();
    const edit = patchBatch(client.renderer, [{id: baseline.id,
      changes: {title: 'Editor draft based on previous identity'}, baseline}], {coherent: true});
    await f.flush();
    assert.strictEqual(edit.done, true);
    assert(edit.error && edit.error.code === 'LIBRARY_CONFLICT');
    assert.deepStrictEqual(f.disk(), before);
  }));

suite.test('technical metadata cannot commit after the filename it was measured from changes', () =>
  withTemporaryDirectory('transaction-read-dependency', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const baseline = clone(f.main.media[0]);
    const moved = patchBatch(f.main, [{id: baseline.id,
      changes: {filename: '/Other-copy/Movie.mkv'}, baseline}]);
    await f.flush();
    assertCommitted(moved);
    const before = f.disk();
    const metadata = patchBatch(f.main, [{id: baseline.id,
      changes: {metadata: {...baseline.metadata, width: 3840}},
      expected: {metadata: baseline.metadata, filename: baseline.filename}}], {conflict: 'skip', priority: 'background'});
    await f.flush();
    assertCommitted(metadata);
    assert(metadata.value.skipped.length > 0);
    assert.deepStrictEqual(f.disk(), before);
  }));

suite.test('used-list entries for scalar genres and array tags commit atomically with the edit', () =>
  withTemporaryDirectory('transaction-used-lists', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const save = patchBatch(client.renderer, [{id: videoID(1),
      changes: {genre: 'Mystery', tags: ['New custom tag']}}], {updateUsedLists: true});
    await f.flush();
    assertCommitted(save);
    assert(f.disk().settings.used.genres.includes('Mystery'));
    assert(f.disk().settings.used.tags.includes('New custom tag'));
    assert.strictEqual(f.policy.writes, 1);
  }));

suite.test('legacy null array entries cannot cause a failure after a successful durable commit', () =>
  withTemporaryDirectory('transaction-legacy-array-holes', async directory => {
    const f = pairedLibrary(directory, [null, videoFixture({id: videoID(1)})],
      [null, videoFixture({id: videoID(2)})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(client.renderer.media.find(video => video && video.id === videoID(1)));
    const save = patchBatch(client.renderer, [{id: videoID(1), changes: {title: 'Still editable'}, baseline}]);
    await f.flush();
    assertCommitted(save);
    assert.strictEqual(f.disk().media.find(video => video && video.id === videoID(1)).title, 'Still editable');
    assert.deepStrictEqual(f.main.getSaveObject(), f.disk());
    assert.deepStrictEqual(client.renderer.getSaveObject(), f.disk());
  }));

suite.test('generic renderer video replacements retain identity checks and scanner-owned field protections', () =>
  withTemporaryDirectory('transaction-generic-renderer-guards', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1)})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(f.main.media[0]);
    const edit = operation(client.renderer, 'replace', `media.id=${baseline.id}.title`, 'Stale title edit');
    const tag = patchBatch(f.main, [{id: baseline.id, changes: {imdbID: 'tt9999999'}, baseline}],
      {priority: 'background', coherent: true});
    // The edit captures its old baseline now, but reaches the backend after tagging.
    await f.flush(message => message.direction !== 'invoke');
    assertCommitted(tag);
    await f.flush();
    assert.strictEqual(edit.done, true);
    assert.strictEqual(edit.error && edit.error.code, 'LIBRARY_CONFLICT');
    const before = f.disk();
    for (const [field, value] of [['metadata.width', 9], ['filename', '/untrusted/replacement.mkv'],
      ['duplicates', ['/untrusted/duplicate.mkv']]]) {
      const guarded = operation(client.renderer, 'replace', `media.id=${baseline.id}.${field}`, value);
      await f.flush();
      assert.strictEqual(guarded.done, true);
      assert.strictEqual(guarded.error && guarded.error.code, 'INVALID_LIBRARY_OPERATION');
      assert.deepStrictEqual(f.disk(), before);
    }
    assert.strictEqual(client.renderer.media[0].title, baseline.title);
    assert.strictEqual(client.renderer.media[0].imdbID, 'tt9999999');
  }));

suite.test('untrusted renderer file references fail before queueing or writing, while ordinary edits still save', () =>
  withTemporaryDirectory('transaction-renderer-file-gate', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), subtitles: [], artwork: ''})]);
    f.main.validateRendererCommit = request => validateRendererCommit(request, {library: f.main});
    const client = f.createRenderer();
    await f.flush();
    const before = f.disk(), revision = f.main.revision;
    for (const changes of [{subtitles: ['/private/secret']}, {artwork: '/private/secret.png'}, {dvd: true}]) {
      const denied = patchBatch(client.renderer, [{id: videoID(1), changes}]);
      await f.flush();
      assert.strictEqual(denied.done, true);
      assert.strictEqual(denied.error && denied.error.code, 'INVALID_LIBRARY_OPERATION');
      assert.strictEqual(f.policy.writes, 0);
      assert.strictEqual(f.main.revision, revision);
      assert.deepStrictEqual(f.disk(), before);
    }
    const allowed = patchBatch(client.renderer, [{id: videoID(1), changes: {title: 'Ordinary edit'}}]);
    await f.flush();
    assertCommitted(allowed);
    assert.strictEqual(f.disk().media[0].title, 'Ordinary edit');
    assert.strictEqual(f.policy.writes, 1);
  }));

suite.test('native file grants belong to their owner and accepted file edits retain stale identity protection', () =>
  withTemporaryDirectory('transaction-renderer-owner-grants', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), subtitles: [], artwork: ''})]);
    f.main.validateRendererCommit = (request, event) => validateRendererCommit(request, {library: f.main,
      authorizeSubtitle: value => event.sender.id === 1 && value === '/chosen/subtitle.srt',
      authorizeArtwork: value => event.sender.id === 1 && value === '/managed/new.png'});
    const owner = f.createRenderer(1), other = f.createRenderer(2);
    await f.flush();
    const changes = {subtitles: ['/chosen/subtitle.srt'], artwork: '/managed/new.png'};
    const denied = patchBatch(other.renderer, [{id: videoID(1), changes}]);
    await f.flush();
    assert.strictEqual(denied.error && denied.error.code, 'INVALID_LIBRARY_OPERATION');
    assert.strictEqual(f.policy.writes, 0);
    const baseline = clone(owner.renderer.media[0]);
    const stale = patchBatch(owner.renderer, [{id: videoID(1), changes: {...changes, title: 'Old title edit'}, baseline}]);
    const newer = patchBatch(f.main, [{id: videoID(1), changes: {imdbID: 'tt9999999'}, baseline}], {priority: 'background'});
    await f.flush(message => message.direction !== 'invoke');
    assertCommitted(newer);
    await f.flush();
    assert.strictEqual(stale.error && stale.error.code, 'LIBRARY_CONFLICT');
    assert.deepStrictEqual(f.disk().media[0].subtitles, []);
    const accepted = patchBatch(owner.renderer, [{id: videoID(1), changes}]);
    await f.flush();
    assertCommitted(accepted);
    assert.deepStrictEqual(f.disk().media[0].subtitles, changes.subtitles);
    assert.strictEqual(f.disk().media[0].artwork, changes.artwork);
    assert.strictEqual(f.disk().media[0].imdbID, 'tt9999999');
  }));

suite.test('replaying a completed request does not need another file grant or perform another write', () =>
  withTemporaryDirectory('transaction-renderer-grant-replay', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), subtitles: []})]);
    let validGrant = true, validations = 0;
    f.main.validateRendererCommit = request => {
      validations++;
      validateRendererCommit(request, {library: f.main, authorizeSubtitle: () => validGrant});
    };
    const client = f.createRenderer();
    await f.flush();
    const first = patchBatch(client.renderer, [{id: videoID(1), changes: {subtitles: ['/chosen/subtitle.srt']}}]);
    await f.flush();
    assertCommitted(first);
    const request = f.history.find(entry => entry.direction === 'invoke' && entry.channel === 'library:commit').args[0];
    validGrant = false;
    const duplicate = client.ipcRenderer.invoke('library:commit', request);
    await f.flush();
    const result = await duplicate;
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(validations, 1);
    assert.strictEqual(f.policy.writes, 1);
  }));

suite.test('an autotag save conflict records a readable explanation without changing manual tags or retry eligibility', () =>
  withTemporaryDirectory('transaction-autotag-conflict-report', async directory => {
    const f = pairedLibrary(directory, [videoFixture({id: videoID(1), new: true, autotag_tried: false})]);
    const client = f.createRenderer();
    await f.flush();
    const baseline = clone(client.renderer.media[0]);
    const manual = patchBatch(client.renderer, [{id: baseline.id,
      changes: {title: 'Manually corrected', tags: ['Keep this tag']}, baseline}]);
    await f.flush();
    assertCommitted(manual);
    const beforeTag = clone(f.main.media[0]);
    const tag = patchBatch(f.main, [{id: baseline.id,
      changes: {imdbID: 'tt9999999', tags: ['Unwanted automatic tag'], autotag_tried: true, new: false}, baseline}],
    {priority: 'background', coherent: true, conflict: 'skip', source: 'autotag'});
    await f.flush();
    assertCommitted(tag);
    assert.strictEqual(tag.value.skipped.length, 1);
    for (const data of [f.main, client.renderer, f.disk()]) {
      const saved = data.media[0];
      assert.deepStrictEqual({...saved, taggingDecision: undefined}, {...beforeTag, taggingDecision: undefined});
      assert.strictEqual(saved.taggingDecision.reason.code, 'changed-during-lookup');
      assert.strictEqual(saved.taggingDecision.evidence.saveConflict.retryable, true);
      const report = buildTaggingReport(saved);
      assert.match(JSON.stringify(report), /saved changes were preserved/);
      assert.match(JSON.stringify(report), /Run Auto-Tag again/);
    }
  }));

suite.test('canceling close invalidates a held old hook without later sealing or acknowledging that close', () =>
  withTemporaryDirectory('transaction-canceled-close-hook', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    const ready = [];
    f.handlers.set('library:close-ready', (_event, request) => { ready.push(request); return {}; });
    await f.flush();
    let releaseHook;
    const hook = new Promise(resolve => { releaseHook = resolve; });
    client.renderer.onBeforeClose(() => hook);
    client.ipcRenderer.emit('library:prepare-close', {}, {token: 'old-close'});
    await f.flush();
    assert.strictEqual(client.renderer.closing, false);
    client.ipcRenderer.emit('library:close-canceled', {});
    releaseHook();
    await f.flush();
    assert.deepStrictEqual(ready, []);
    assert.strictEqual(client.renderer.closing, false);
    const save = operation(client.renderer, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(save);
  }));

suite.test('a close-ready client rejects new writes until closing is canceled', () =>
  withTemporaryDirectory('transaction-close-seal', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    const ready = [];
    f.handlers.set('library:close-ready', (_event, request) => { ready.push(request); return {}; });
    await f.flush();
    client.ipcRenderer.emit('library:prepare-close', {}, {token: 'seal-close'});
    await f.flush();
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].token, 'seal-close');
    assert.strictEqual(client.renderer.closing, true);
    const before = f.disk();
    const blocked = operation(client.renderer, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assert.strictEqual(blocked.done, true);
    assert.strictEqual(blocked.error && blocked.error.code, 'LIBRARY_CLOSING');
    assert.deepStrictEqual(f.disk(), before);
    client.ipcRenderer.emit('library:close-canceled', {});
    const accepted = operation(client.renderer, 'replace', 'settings.preferences.exclude_samples_from_library', false);
    await f.flush();
    assertCommitted(accepted);
    assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, false);
  }));

suite.test('renderer idle waits include callback-enqueued saves without waiting for unrelated background jobs', () =>
  withTemporaryDirectory('transaction-own-idle-callback-chain', async directory => {
    const f = pairedLibrary(directory);
    const client = f.createRenderer();
    await f.flush();
    const background = Array.from({length: 20}, (_, index) => transaction(f.main, [{
      opType: 'add', address: 'playlists.push', entry: {id: `pending-${index}`, name: `Scan ${index}`, view: 'flat'}
    }], {priority: 'background'}));
    let second, backgroundPendingAtIdle = 0;
    const first = client.renderer.replace('settings.preferences.exclude_samples_from_library', false, error => {
      assert.ifError(error);
      second = operation(client.renderer, 'replace', 'settings.preferences.exclude_trailers_from_library', false);
    });
    const idle = client.renderer.whenIdle().then(() => {
      assert(second && second.done, 'Idle must include the next save submitted by the first save callback');
      assertCommitted(second);
      backgroundPendingAtIdle = background.filter(job => !job.done).length;
    });
    await f.flush();
    await Promise.all([first, idle]);
    assert(backgroundPendingAtIdle > 0, 'Renderer idle must not wait for the backend background queue');
    assert.strictEqual(f.disk().settings.preferences.exclude_samples_from_library, false);
    assert.strictEqual(f.disk().settings.preferences.exclude_trailers_from_library, false);
  }));

runSuite(suite);
