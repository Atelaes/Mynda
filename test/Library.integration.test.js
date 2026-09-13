const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures.js');
const Persistence = require('../src/LibraryPersistence.js');
const LibraryExport = require('../src/LibraryExport.js');

const suite = createSuite(
  'Library model, migration, synchronization, and recovery',
  'integration',
  'Combines the real Library class with isolated disk storage and a controlled Electron IPC boundary.'
);

const quietLogger = {
  child: () => ({debug() {}, info() {}, warn() {}, error() {}})
};

function loadLibraryClass(userData, renderer = false) {
  const ipcMain = new EventEmitter();
  const ipcRenderer = new EventEmitter();
  ipcRenderer.sent = [];
  ipcRenderer.send = function send(channel, ...args) {
    this.sent.push({channel, args});
  };
  const app = {getPath: name => {
    assert.strictEqual(name, 'userData');
    return userData;
  }};
  const electron = renderer ? {
    remote: {app},
    ipcRenderer
  } : {
    app,
    ipcMain,
    ipcRenderer
  };
  const Library = loadFreshWithMocks(
    path.join(__dirname, '..', 'src', 'Library.js'),
    {'electron': electron, './Logger.js': quietLogger}
  );
  return {Library, electron, ipcMain, ipcRenderer};
}

function operate(instance, method, ...args) {
  return new Promise((resolve, reject) => {
    instance[method](...args, error => error ? reject(new Error(error)) : resolve());
  });
}

suite.test('creates an isolated default library on first launch', () => withTemporaryDirectory(
  'library-first-launch',
  directory => {
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert.strictEqual(instance.env, 'server');
    assert.strictEqual(instance.videoIdScheme, 2);
    assert.strictEqual(instance.getIdentityIssue(), null);
    assert.deepStrictEqual(instance.media, []);
    assert.strictEqual(instance.settings.preferences.exclude_samples_from_library, true);
    assert.strictEqual(instance.settings.preferences.exclude_trailers_from_library, true);
    assert.strictEqual(fs.existsSync(instance.path), true);
    assert.deepStrictEqual(Persistence.readLibraryFile(instance.path).data.media, []);
  }
));

suite.test('migrates older libraries while preserving explicit preferences and show IDs', () => withTemporaryDirectory(
  'library-migration',
  directory => {
    const originalShow = path.join(directory, 'watch', 'Party of Five.mkv');
    const duplicateShow = path.join(directory, 'watch', 'Party of Five Copy.mkv');
    const libraryDirectory = path.join(directory, 'Library');
    const libraryPath = path.join(libraryDirectory, 'library.json');
    const oldLibrary = libraryFixture({
      settings: {
        watchfolders: [],
        themes: {appearances: [], layouts: []},
        preferences: {
          remove_edited_from_new: true,
          exclude_samples_from_library: false,
          override_dialogs: {obsolete_dialog: true}
        },
        used: {kinds: ['movie', 'show'], genres: [], tags: []}
      },
      playlists: [{id: 'old', name: 'Old', view: 'retired-view'}],
      media: [
        videoFixture({
          id: 'movie',
          collections: ['Retired'],
          seriesImdbID: 'tt-wrong',
          duplicates: 'not-an-array'
        }),
        videoFixture({
          id: 'show',
          kind: 'show',
          series: 'Party of Five',
          seriesImdbID: 'tt0108894',
          filename: originalShow,
          duplicates: [originalShow, duplicateShow, duplicateShow]
        })
      ]
    });
    Persistence.writeLibraryFile(libraryPath, oldLibrary);

    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert.strictEqual(instance.settings.preferences.remove_edited_from_new, true);
    assert.strictEqual(instance.settings.preferences.exclude_samples_from_library, false);
    assert.strictEqual(instance.settings.preferences.exclude_trailers_from_library, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(instance.media[0], 'collections'), false);
    assert.strictEqual(instance.media[0].seriesImdbID, '');
    assert.deepStrictEqual(instance.media[0].duplicates, []);
    assert.strictEqual(instance.media[1].seriesImdbID, 'tt0108894');
    assert.deepStrictEqual(instance.media[1].duplicates, [duplicateShow]);
    assert.strictEqual(instance.playlists[0].view, 'flat');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(
      instance.settings.preferences.override_dialogs,
      'obsolete_dialog'
    ), false);
  }
));

suite.test('adds, replaces, removes, and batch-replaces media through the normal save path', () => withTemporaryDirectory(
  'library-operations',
  async directory => {
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    const first = videoFixture({id: '1'.repeat(64), title: 'First'});
    const second = videoFixture({id: '2'.repeat(64), title: 'Second'});
    await operate(instance, 'add', 'media.push', first);
    await operate(instance, 'add', 'media.push', second);
    assert.deepStrictEqual(instance.media.map(item => item.id), [first.id, second.id]);

    await operate(instance, 'replace', `media.id=${first.id}`, Object.assign({}, first, {title: 'Changed'}));
    assert.strictEqual(instance.media[0].title, 'Changed');

    await operate(instance, 'replaceMediaBatch', [
      Object.assign({}, instance.media[0], {seen: true}),
      Object.assign({}, instance.media[1], {watchlater: true})
    ]);
    assert.strictEqual(instance.media[0].seen, true);
    assert.strictEqual(instance.media[1].watchlater, true);

    await operate(instance, 'remove', 'media.0');
    assert.deepStrictEqual(instance.media.map(item => item.id), [second.id]);
    assert.deepStrictEqual(Persistence.readLibraryFile(instance.path).data.media.map(item => item.id), [second.id]);
  }
));

suite.test('preserves current subtitle provenance during unrelated renderer edits', () => withTemporaryDirectory(
  'library-renderer-replacement',
  directory => {
    global.savedPing = {saved() {}};
    const {Library, ipcRenderer} = loadLibraryClass(directory, true);
    const instance = new Library();
    const detected = path.join(directory, 'watch', 'Movie.en.srt');
    const ignored = path.join(directory, 'watch', 'Movie.commentary.srt');
    const duplicate = path.join(directory, 'watch', 'Movie Copy.mkv');
    const oldVideo = videoFixture({
      id: 'movie',
      subtitles: [detected],
      detected_subtitles: [detected],
      manual_subtitles: [],
      ignored_subtitles: [ignored],
      subtitle_tracking_initialized: true,
      duplicates: [duplicate]
    });
    const replacement = videoFixture({
      id: 'movie',
      title: 'New title',
      subtitles: [],
      duplicates: [path.join(directory, 'stale', 'renderer-copy.mkv')]
    });
    const prepared = instance.prepareRendererVideoReplacement(oldVideo, replacement);
    assert.deepStrictEqual(prepared.subtitles, [detected]);
    assert.deepStrictEqual(prepared.ignored_subtitles, [ignored]);
    assert.deepStrictEqual(prepared.duplicates, [duplicate]);
    assert(ipcRenderer.sent.some(entry => entry.channel === 'lib-beacon'));
    delete global.savedPing;
  }
));

suite.test('blocks normal saves after corruption and restores the newest valid backup safely', () => withTemporaryDirectory(
  'library-restore',
  directory => {
    const libraryDirectory = path.join(directory, 'Library');
    const libraryPath = path.join(libraryDirectory, 'library.json');
    const backupDirectory = path.join(libraryDirectory, 'Backups');
    fs.mkdirSync(backupDirectory, {recursive: true});
    const damagedBytes = '{broken primary';
    fs.writeFileSync(libraryPath, damagedBytes);
    const backupName = 'library-2026-09-07T01-00-00-000Z-p1-1.json';
    const recovered = libraryFixture({videoIdScheme: 2, media: [videoFixture({id: '3'.repeat(64)})]});
    Persistence.writeLibraryFile(path.join(backupDirectory, backupName), recovered);

    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert.strictEqual(instance.media[0].id, '3'.repeat(64));
    assert.strictEqual(instance.getLoadIssue().type, 'malformed');
    assert.throws(() => instance.save(), /Refusing to overwrite/);

    const result = instance.restoreLatestAutomaticBackup();
    assert.strictEqual(instance.getLoadIssue(), null);
    assert.deepStrictEqual(Persistence.readLibraryFile(libraryPath).data.media.map(item => item.id),
      ['3'.repeat(64)]);
    assert.strictEqual(fs.readFileSync(result.preservedLibraryPath, 'utf8'), damagedBytes);
  }
));

suite.test('creates an empty library only after an explicit recovery decision', () => withTemporaryDirectory(
  'library-empty-recovery',
  directory => {
    const libraryPath = path.join(directory, 'Library', 'library.json');
    fs.mkdirSync(path.dirname(libraryPath), {recursive: true});
    fs.writeFileSync(libraryPath, '{broken and no backups');

    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert(instance.getLoadIssue());
    const result = instance.createEmptyLibraryAfterLoadFailure();
    assert.strictEqual(instance.getLoadIssue(), null);
    assert.deepStrictEqual(Persistence.readLibraryFile(libraryPath).data.media, []);
    assert.strictEqual(fs.readFileSync(result.preservedLibraryPath, 'utf8'), '{broken and no backups');
  }
));

suite.test('resolves idle waiters only after the real synchronization confirmation', () =>
  withTemporaryDirectory('library-idle-waiter', async directory => {
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    const pending = {opType: 'replace', address: 'media.id=movie', entry: {id: 'movie'}};
    instance.waitConfirm = pending;

    let resolved = false;
    const waiting = instance.whenIdle().then(() => { resolved = true; });
    await Promise.resolve();
    assert.strictEqual(resolved, false);

    instance.getConfirm(pending);
    await waiting;
    assert.strictEqual(resolved, true);
    assert.strictEqual(instance.idleWaiters.length, 0);
  })
);

suite.test('exports a validated atomic library copy through the save-dialog workflow', () =>
  withTemporaryDirectory('library-manual-export', async directory => {
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    instance.media = [videoFixture({id: '4'.repeat(64)})];
    const chosenWithoutExtension = path.join(directory, 'Chosen Library Backup');
    const calls = [];
    const parentWindow = {name: 'main-window'};
    const dialog = {
      async showSaveDialog(parent, options) {
        calls.push({parent, options});
        return {canceled: false, filePath: chosenWithoutExtension};
      }
    };

    const result = await LibraryExport.exportLibraryCopy({
      dialog,
      library: instance,
      parentWindow,
      defaultDirectory: directory,
      now: new Date('2026-09-11T12:34:56.789Z')
    });

    assert.strictEqual(result.canceled, false);
    assert.strictEqual(result.filePath, `${chosenWithoutExtension}.json`);
    assert.strictEqual(calls[0].parent, parentWindow);
    assert.strictEqual(
      calls[0].options.defaultPath,
      path.join(directory, 'Mynda Library Backup 2026-09-11T12-34-56-789Z.json')
    );
    assert.deepStrictEqual(
      Persistence.readLibraryFile(result.filePath).data.media.map(video => video.id),
      ['4'.repeat(64)]
    );
  })
);

suite.test('handles export cancellation and refuses to overwrite the live library', () =>
  withTemporaryDirectory('library-manual-export-guards', async directory => {
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    const canceled = await LibraryExport.exportLibraryCopy({
      dialog: {showSaveDialog: async () => ({canceled: true})},
      library: instance,
      defaultDirectory: directory
    });
    assert.deepStrictEqual(canceled, {canceled: true, filePath: null});

    await assert.rejects(
      LibraryExport.exportLibraryCopy({
        dialog: {showSaveDialog: async () => ({canceled: false, filePath: instance.path})},
        library: instance,
        defaultDirectory: directory
      }),
      error => error && error.code === 'EXPORT_PRIMARY_LIBRARY'
    );
  })
);

suite.test('keeps legacy libraries intact and blocks saves until explicit ID conversion', () =>
  withTemporaryDirectory('library-id-conversion-guard', directory => {
    const libraryPath = path.join(directory, 'Library', 'library.json');
    Persistence.writeLibraryFile(libraryPath, libraryFixture({media:[videoFixture()]}));
    const before = fs.readFileSync(libraryPath);
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert.strictEqual(instance.getLoadIssue(), null);
    assert.strictEqual(instance.videoIdScheme, 1);
    assert.strictEqual(instance.getIdentityIssue().code, 'LIBRARY_ID_MIGRATION_REQUIRED');
    assert.throws(() => instance.save(), error => error.code === 'LIBRARY_ID_MIGRATION_REQUIRED');
    assert.strictEqual(instance.maybeCreateAutomaticBackup(), null);
    assert.deepStrictEqual(fs.readFileSync(libraryPath), before);
  }));

suite.test('rejects unsupported schemes and mixed-format IDs instead of silently promoting them', async () => {
  for (const [scheme, expected] of [[99,'UNSUPPORTED_VIDEO_ID_SCHEME'],[2,'INVALID_VIDEO_ID']]) {
    await withTemporaryDirectory('library-id-format-guard', directory => {
      const libraryPath = path.join(directory,'Library','library.json');
      Persistence.writeLibraryFile(libraryPath,libraryFixture({videoIdScheme:scheme,media:[videoFixture()]}));
      const before = fs.readFileSync(libraryPath);
      const {Library} = loadLibraryClass(directory);
      const instance = new Library();
      assert.strictEqual(instance.getIdentityIssue().code,expected);
      assert.throws(() => instance.save(),error => error.code === expected);
      assert.deepStrictEqual(fs.readFileSync(libraryPath),before);
    });
  }
});

suite.test('requires conversion of an old recovery backup before replacing a damaged primary', () =>
  withTemporaryDirectory('library-legacy-backup-guard',directory => {
    const libraryPath = path.join(directory,'Library','library.json');
    const backups = path.join(directory,'Library','Backups');
    fs.mkdirSync(backups,{recursive:true});
    fs.writeFileSync(libraryPath,'{damaged primary');
    Persistence.writeLibraryFile(path.join(backups,'library-2026-09-07T01-00-00-000Z-p1-1.json'),
      libraryFixture({media:[videoFixture()]}));
    const {Library} = loadLibraryClass(directory);
    const instance = new Library();
    assert(instance.getLoadIssue().latestBackupPath);
    assert.strictEqual(instance.getIdentityIssue().code,'LIBRARY_ID_MIGRATION_REQUIRED');
    assert.throws(() => instance.restoreLatestAutomaticBackup(),error => error.code === 'LIBRARY_ID_MIGRATION_REQUIRED');
    assert.strictEqual(fs.readFileSync(libraryPath,'utf8'),'{damaged primary');
  }));

runSuite(suite);
