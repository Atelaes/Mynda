const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures');
const {createEditorService} = require('../src/main/EditorService');

const suite = createSuite('Filename reset through the main application', 'integration',
  'Uses the real main-process reset callback, editor service, saved library and show detector; only native boundaries are simulated.');

suite.test('single and batch resets derive canonical filenames, preserve user state and wait for Save', () =>
  withTemporaryDirectory('filename-reset', async directory => {
    const root = path.resolve(__dirname, '..');
    const mediaRoot = path.join(directory, 'media');
    const movie = videoFixture({id: 'a'.repeat(64), kind: 'show', seriesImdbID: 'tt1111111',
      filename: path.join(mediaRoot, 'Movie (1979).mkv'), new: false,
      ratings: {user: 3, imdb: '8.5', rt: 93, mc: 89}, seen: true, position: 300,
      subtitles: [path.join(mediaRoot, 'Movie.srt')], artwork: '/old/artwork.png'});
    const show = videoFixture({id: 'b'.repeat(64), kind: 'movie',
      filename: path.join(mediaRoot, 'Shows', 'A Series', 'Season 2', 'A Series S02E03 - Arrival.mkv')});
    const outside = videoFixture({id: 'c'.repeat(64), kind: 'other',
      filename: path.join(mediaRoot + ' 2', 'Unsorted File.mkv')});
    const data = libraryFixture({videoIdScheme: 2, media: [movie, show, outside]});
    data.settings.watchfolders = [{path: mediaRoot, kind: 'movie'},
      {path: path.join(mediaRoot, 'Shows'), kind: 'show'}];
    const primary = path.join(directory, 'Library', 'library.json');
    fs.mkdirSync(path.dirname(primary), {recursive: true});
    fs.writeFileSync(primary, JSON.stringify(data));

    const ipcMain = new EventEmitter();
    ipcMain.handle = () => {};
    const app = new EventEmitter();
    Object.assign(app, {isPackaged: true, getAppPath: () => root, getPath: () => directory,
      getVersion: () => 'test', quit() {}, whenReady: () => ({then() {}})});
    // Capture the actual service assembled by main/index.js before Electron
    // starts scanning. In particular, never replace the reset callback itself.
    let editor, library, confirmResponse = 1;
    const dialogs = [];
    const quiet = {debug() {}, info() {}, warn() {}, error() {}};
    loadFreshWithMocks(path.join(root, 'src/main/index.js'), {
      electron: {app, ipcMain, shell: {}, dialog: {showMessageBox: async options => {
        dialogs.push(options); return {response: confirmResponse};
      }}},
      [path.join(root, 'src/platform/Logger.js')]: {child: () => quiet},
      [path.join(root, 'src/media/MediaTools.js')]: {ffmpegPath: null, ffprobePath: null},
      [path.join(root, 'src/tagging/TaggingService.js')]: {},
      [path.join(root, 'src/main/EditorService.js')]: {createEditorService: options => {
        library = options.library;
        editor = createEditorService(options);
        return editor;
      }}
    });
    const before = JSON.parse(JSON.stringify(library.getSaveObject()));
    const diskBefore = fs.readFileSync(primary);
    const result = await editor.resetFromFilename([{...movie, filename: '/wrong/path.mkv', ratings: {user: 5}}]);
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.patches.length, 1);
    const {id, changes} = result.patches[0];
    assert.strictEqual(id, movie.id);
    assert.strictEqual(changes.title, 'Movie (1979)');
    assert.strictEqual(changes.kind, 'movie');
    assert.strictEqual(changes.imdbID, '');
    assert.strictEqual(changes.seriesImdbID, '');
    assert.strictEqual(changes.artwork, '');
    assert.strictEqual(changes.new, true);
    assert.strictEqual(changes.autotag_tried, false);
    assert.deepStrictEqual(changes.ratings, {user: 5, imdb: '', rt: '', mc: ''});
    for (const field of ['tags', 'subtitles', 'seen', 'position', 'metadata', 'dateadded', 'lastseen']) {
      assert.strictEqual(Object.hasOwn(changes, field), false, `${field} must survive the reset`);
    }
    const batch = await editor.resetFromFilename([movie, show, outside]);
    assert.strictEqual(batch.confirmed, true);
    assert.deepStrictEqual(batch.patches.map(patch => patch.id), [movie.id, show.id, outside.id]);
    const episode = batch.patches[1].changes;
    assert.deepStrictEqual([episode.kind, episode.series, episode.season, episode.episode, episode.title],
      ['show', 'A Series', '2', '3', 'Arrival']);
    assert.deepStrictEqual([batch.patches[2].changes.kind, batch.patches[2].changes.title], ['other', 'Unsorted File']);
    assert.match(dialogs[1].detail, /For 1 videos without a known watchfolder/);
    confirmResponse = 0;
    assert.deepStrictEqual(await editor.resetFromFilename([movie]), {confirmed: false, patches: []});
    assert.strictEqual(library.revision, 0, 'Reset must stage changes, not save them');
    assert.deepStrictEqual(library.getSaveObject(), before);
    assert.deepStrictEqual(fs.readFileSync(primary), diskBefore);
  }));

runSuite(suite);
