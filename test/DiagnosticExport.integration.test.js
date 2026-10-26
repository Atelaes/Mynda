const fs = require('fs');
const path = require('path');
const {Readable} = require('stream');
const yauzl = require('yauzl');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {createDiagnosticExporter, createRedactor, collectLogs, writeArchive} = require('../src/main/DiagnosticExport');
const {createDesktopService} = require('../src/main/DesktopService');
const {installRendererBridge} = require('../src/main/RendererBridge');
const {createBridge} = require('../src/preload/Bridge');
const {videoFixture, libraryFixture} = require('./helpers/Fixtures');
const suite = createSuite('Diagnostic ZIP export', 'integration',
  'Reads real retained logs and real ZIPs; protects credentials, private files, immutable library data and user-controlled destinations.');

function unzip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, {lazyEntries: true}, (error, zip) => {
    if (error) return reject(error);
    const files = {};
    zip.on('error', reject);
    zip.on('end', () => resolve(files));
    zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('error', reject);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {files[entry.fileName] = Buffer.concat(chunks).toString('utf8'); zip.readEntry();});
    }));
    zip.readEntry();
  }));
}

function fixture(root, overrides = {}) {
  const logs = path.join(root, 'profile', 'logs');
  const home = path.join(root, 'Alice');
  const watchfolder = path.join(home, 'Videos');
  fs.mkdirSync(logs, {recursive: true});
  const app = {isPackaged: true, getVersion: () => '1.0.0-beta.1', getAppPath: () => path.join(root, 'app.asar'),
    getPath: name => ({home, userData: path.dirname(logs), documents: root})[name]};
  let data = libraryFixture({media: [videoFixture({filename: path.join(watchfolder, 'Alien.mkv'),
    taggingDecision: {status: 'matched', requestId: 'req-library-321', token: 'library-secret'},
    ratings: {imdb: '8.5', rt: 93, user: 5}})]});
  data.settings.watchfolders = [{path: watchfolder, kind: 'movie'}];
  const library = {getSaveObject: () => data, revision: 7};
  const flushes = [], dialogs = [];
  const dialog = {showSaveDialog: async (...args) => {
    dialogs.push(args); return {canceled: false, filePath: path.join(root, 'report.zip')};
  }};
  const logger = {flush: async () => flushes.push(true), getLogDirectory: () => logs};
  const exporter = createDiagnosticExporter({app, dialog, library, logger,
    getKnownSecrets: async () => ['current-secret-123'],
    getStatus: async () => ({hasCredential: true, verified: true,
      url: 'https://name:url-password@example.test/metadata?token=query-secret', token: 'never-include-this-field'}),
    ...overrides});
  return {app, logs, home, watchfolder, library, data, dialog, logger, exporter, dialogs, flushes,
    replaceData(next) {data = next;}};
}

suite.test('exports a readable ZIP with bounded technical fields, redacted logs and original request IDs', async () => {
  await withTemporaryDirectory('diagnostic-zip', async root => {
    const f = fixture(root);
    fs.writeFileSync(path.join(f.logs, 'mynda-info.log'),
      '2026-10-26T10:00:00Z INFO [Metadata] [main:1] lookup ' + JSON.stringify({
        requestId: 'req-ABC123', token: 'historical-secret', filename: path.join(f.watchfolder, 'Alien.mkv'),
        home: f.home, email: 'alice@example.test', text: 'Authorization: Bearer bearer-secret',
        url: 'https://bob:url-secret@example.test/details?api_key=url-api-secret',
        message: 'Unexpected current-secret-123'}) + '\n');
    fs.writeFileSync(path.join(f.logs, 'metadata-credentials.json'), 'PRIVATE CREDENTIAL FILE');
    fs.writeFileSync(path.join(f.logs, '.env'), 'PRIVATE ENV');
    fs.writeFileSync(path.join(f.logs, 'library.json'), 'PRIVATE LIBRARY');
    const result = await f.exporter({includeLibrary: false});
    const files = await unzip(result.filePath), all = Object.values(files).join('\n');
    assert.deepStrictEqual(Object.keys(files).sort(), ['README.txt', 'diagnostics.json', 'logs/mynda-info.log']);
    for (const secret of ['historical-secret', 'current-secret-123', 'bearer-secret', 'url-api-secret',
      'url-secret', 'url-password', 'alice@example.test', f.home, 'PRIVATE', 'never-include-this-field']) assert(!all.includes(secret), secret);
    assert(all.includes('req-ABC123'));
    assert(all.includes('[WATCHFOLDER_1]'));
    assert(all.includes('Alien.mkv'));
    const report = JSON.parse(files['diagnostics.json']);
    assert.strictEqual(report.activation.serverOrigin, 'https://example.test');
    assert.strictEqual(report.library.active, 1);
    assert.deepStrictEqual(report.librarySnapshot, {included: false});
    assert.strictEqual(f.flushes.length, 1);
    assert(!files['library-diagnostic.json']);
    assert.strictEqual(f.dialogs[0][0].title, 'Export Mynda Diagnostics');
  });
});

suite.test('optional library diagnostics preserve matching evidence without history, custom tags or personal ratings', async () => {
  await withTemporaryDirectory('diagnostic-library', async root => {
    const f = fixture(root), before = JSON.stringify(f.data);
    const files = await unzip((await f.exporter({includeLibrary: true})).filePath);
    const library = JSON.parse(files['library-diagnostic.json']);
    assert.strictEqual(library.media[0].title, 'Alien');
    assert.strictEqual(library.media[0].imdbID, 'tt0078748');
    assert.strictEqual(library.media[0].taggingDecision.requestId, 'req-library-321');
    assert.strictEqual(library.media[0].taggingDecision.token, '[REDACTED]');
    assert.strictEqual(library.media[0].ratings.user, undefined);
    for (const key of ['seen', 'lastseen', 'position', 'tags', 'artwork', 'cast']) assert.strictEqual(library.media[0][key], undefined);
    assert.strictEqual(library.settings, undefined);
    assert.strictEqual(library.recently_watched, undefined);
    assert.strictEqual(JSON.stringify(f.data), before);
    assert.strictEqual(JSON.parse(files['diagnostics.json']).librarySnapshot.included, true);
  });
});

suite.test('exports every active and inactive video beyond 8 MiB while redacting each record', async () => {
  await withTemporaryDirectory('diagnostic-full-library', async root => {
    const f = fixture(root);
    const record = (group, i) => videoFixture({id: `${group}-${i}`,
      filename: path.join(f.watchfolder, `${group}-${i}.mkv`),
      metadata: {codec: 'h264', evidence: 'synthetic metadata '.repeat(1800)},
      taggingDecision: {requestId: `req-${group}-${i}`, token: `record-secret-${group}-${i}`},
      ratings: {imdb: '8.5', user: 5}, tags: ['private-custom-tag']});
    f.data.media = Array.from({length: 300}, (_, i) => record('active', i));
    f.data.inactive_media = Array.from({length: 25}, (_, i) => record('inactive', i));
    const before = JSON.stringify(f.data);
    const result = await f.exporter({includeLibrary: true});
    const files = await unzip(result.filePath), text = files['library-diagnostic.json'];
    const snapshot = JSON.parse(text), report = JSON.parse(files['diagnostics.json']);
    assert(Buffer.byteLength(text) > 8 * 1024 * 1024, 'The fixture must exceed the old raw JSON cutoff');
    assert(result.archiveBytes < 1024 * 1024, 'Compressible metadata should produce a small ZIP');
    assert.strictEqual(result.archiveBytes, fs.statSync(result.filePath).size);
    assert.strictEqual(result.largeArchive, false);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(report.librarySnapshot, {included: true, active: 300, inactive: 25, truncated: false});
    assert.strictEqual(report.limits.libraryBytes, null);
    for (const group of ['media', 'inactive_media']) {
      assert.deepStrictEqual(snapshot[group].map(video => video.id), f.data[group].map(video => video.id));
      for (const video of snapshot[group]) {
        assert(video.filename.startsWith('[WATCHFOLDER_1]'));
        assert.strictEqual(video.taggingDecision.token, '[REDACTED]');
        assert.strictEqual(video.taggingDecision.requestId, `req-${video.id}`);
        assert.strictEqual(video.ratings.user, undefined);
        assert.strictEqual(video.tags, undefined);
      }
    }
    assert(!text.includes('record-secret-'));
    assert(!text.includes('private-custom-tag'));
    assert(!text.includes(f.home));
    assert.strictEqual(JSON.stringify(f.data), before);
  });
});

suite.test('empty and inactive-only libraries produce complete valid JSON snapshots', async () => {
  await withTemporaryDirectory('diagnostic-empty-library', async root => {
    const f = fixture(root);
    for (const inactive of [[], [videoFixture({id: 'inactive-only'})]]) {
      f.replaceData(libraryFixture({inactive_media: inactive}));
      const files = await unzip((await f.exporter({includeLibrary: true})).filePath);
      const snapshot = JSON.parse(files['library-diagnostic.json']);
      assert.deepStrictEqual(snapshot.media, []);
      assert.deepStrictEqual(snapshot.inactive_media.map(video => video.id), inactive.map(video => video.id));
      assert.deepStrictEqual(JSON.parse(files['diagnostics.json']).librarySnapshot,
        {included: true, active: 0, inactive: inactive.length, truncated: false});
    }
  });
});

suite.test('redacts quoted, escaped, Windows-path and header credentials without removing correlation IDs', () => {
  const redact = createRedactor({paths: [['C:\\Users\\Alice', '[HOME]']], secrets: ['known-secret']});
  const value = {filename: 'C:\\Users\\Alice\\Videos\\Alien.mkv', requestId: 'keep-me',
    password: 'spaces in password', nested: JSON.stringify({access_token: 'nested-secret'}),
    MYNDA_METADATA_TOKEN: 'prefixed-secret', clientSecret: 'client-secret', OMDB_API_KEY: 'omdb-secret',
    auth: 'Authorization: Basic YWxpY2U6c2VjcmV0', note: 'known-secret'};
  const clean = redact.text(JSON.stringify(value));
  for (const secret of ['Alice', 'spaces in password', 'nested-secret', 'YWxpY2U6c2VjcmV0', 'known-secret',
    'prefixed-secret', 'client-secret', 'omdb-secret']) assert(!clean.includes(secret), secret);
  assert(clean.includes('keep-me'));
  assert.doesNotThrow(() => JSON.parse(clean));
  assert.strictEqual(redact.text('C:\\USERS\\ALICE\\Videos\\Alien.mkv'), '[HOME]\\Videos\\Alien.mkv');
});

suite.test('cancellation neither reads private state nor writes a file, and allows the next export', async () => {
  await withTemporaryDirectory('diagnostic-cancel', async root => {
    const f = fixture(root, {getKnownSecrets: () => {throw new Error('Should not read credentials');}});
    f.dialog.showSaveDialog = async () => ({canceled: true});
    assert.deepStrictEqual(await f.exporter(), {canceled: true});
    assert.deepStrictEqual(await f.exporter(), {canceled: true});
    assert.strictEqual(f.flushes.length, 0);
    assert(!fs.existsSync(path.join(root, 'report.zip')));
  });
});

suite.test('a concurrent export is refused while the save dialog is pending', async () => {
  await withTemporaryDirectory('diagnostic-busy', async root => {
    const f = fixture(root); let finish;
    f.dialog.showSaveDialog = () => new Promise(resolve => {finish = resolve;});
    const first = f.exporter();
    await assert.rejects(f.exporter(), error => error.code === 'DIAGNOSTIC_EXPORT_BUSY');
    finish({canceled: true}); await first;
  });
});

suite.test('takes the newest complete log records and discloses skipped files and truncation', async () => {
  await withTemporaryDirectory('diagnostic-limit', async root => {
    const f = fixture(root, {maxLogBytes: 45});
    const old = path.join(f.logs, 'mynda-info.1.log'), recent = path.join(f.logs, 'mynda-info.log');
    fs.writeFileSync(old, 'older old old old\n'); fs.utimesSync(old, 1, 1);
    fs.writeFileSync(recent, 'older record that will be truncated off the front\nnewest requestId=req-recent\npartial-secret');
    const files = await unzip((await f.exporter({includeLibrary: true})).filePath);
    const report = JSON.parse(files['diagnostics.json']);
    assert(files['logs/mynda-info.log'].includes('req-recent'));
    assert(!files['logs/mynda-info.log'].includes('partial-secret'));
    assert(report.logs[0].truncated);
    assert(report.warnings.some(value => value.includes('mynda-info.1.log')));
    assert.strictEqual(report.librarySnapshot.truncated, false);
    assert.strictEqual(JSON.parse(files['library-diagnostic.json']).media.length, 1);
  });
});

suite.test('missing logs or unavailable activation do not prevent an unactivated user from exporting', async () => {
  await withTemporaryDirectory('diagnostic-unavailable', async root => {
    const f = fixture(root, {getStatus: async () => {throw new Error('keychain unavailable');}});
    fs.rmdirSync(f.logs);
    const files = await unzip((await f.exporter()).filePath), report = JSON.parse(files['diagnostics.json']);
    assert.strictEqual(report.activation.unavailable, true);
    assert(report.warnings.some(note => note.includes('Logs unavailable')));
  });
});

suite.test('collects a stable committed library revision even if a new commit arrives during export', async () => {
  await withTemporaryDirectory('diagnostic-revision', async root => {
    let f;
    f = fixture(root, {getStatus: async () => {f.replaceData(libraryFixture()); f.library.revision++; return {};}});
    const files = await unzip((await f.exporter({includeLibrary: true})).filePath);
    assert.strictEqual(JSON.parse(files['diagnostics.json']).library.revision, 7);
    assert.strictEqual(JSON.parse(files['library-diagnostic.json']).media.length, 1);
    assert.strictEqual(f.library.getSaveObject().media.length, 0);
  });
});

suite.test('refuses a late write after its window closes', async () => {
  await withTemporaryDirectory('diagnostic-close', async root => {
    const f = fixture(root);
    await assert.rejects(f.exporter({assertAlive: () => {throw new Error('window closed');}}), /window closed/);
    assert.strictEqual(f.flushes.length, 0);
    assert(!fs.existsSync(path.join(root, 'report.zip')));
  });
});

suite.test('disk-full errors are actionable and do not leave the exporter stuck busy', async () => {
  await withTemporaryDirectory('diagnostic-disk', async root => {
    const f = fixture(root, {writeZip: async () => {throw Object.assign(new Error(), {code: 'ENOSPC'});}});
    await assert.rejects(f.exporter(), /not enough disk space/);
    await assert.rejects(f.exporter(), /not enough disk space/);
    assert(!fs.existsSync(path.join(root, 'report.zip')));
  });
});

suite.test('a failed final rename removes its partial ZIP and preserves the existing destination', async () => {
  await withTemporaryDirectory('diagnostic-atomic', async root => {
    const destination = path.join(root, 'existing'); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'keep');
    await assert.rejects(writeArchive(destination, [{name: 'README.txt', content: 'test'}]));
    assert.deepStrictEqual(fs.readdirSync(root), ['existing']);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'keep');
  });
});

suite.test('ZIPs above the email advisory size still save fully and recommend sharing a link', async () => {
  await withTemporaryDirectory('diagnostic-zip-advisory', async root => {
    const f = fixture(root, {emailAdvisoryBytes: 10});
    fs.writeFileSync(path.join(root, 'report.zip'), 'previous export');
    const result = await f.exporter({includeLibrary: true});
    const files = await unzip(result.filePath);
    assert.strictEqual(result.largeArchive, true);
    assert(result.archiveBytes > 10);
    assert.strictEqual(result.archiveBytes, fs.statSync(result.filePath).size);
    assert(result.warnings.some(note => note.includes('file link')));
    assert.strictEqual(JSON.parse(files['library-diagnostic.json']).media.length, 1);
    assert(files['README.txt'].includes('file link'));
    assert(!fs.readdirSync(root).some(name => name.endsWith('.tmp')));
  });
});

suite.test('streaming failures remove the partial ZIP and preserve an existing report', async () => {
  await withTemporaryDirectory('diagnostic-stream-failure', async root => {
    const destination = path.join(root, 'report.zip');
    fs.writeFileSync(destination, 'previous export');
    const stream = Readable.from((async function* () {
      yield '{"media":[';
      await new Promise(resolve => setImmediate(resolve));
      throw new Error('Snapshot serialization failed');
    })());
    await assert.rejects(writeArchive(destination, [{name: 'library-diagnostic.json', stream}]), /Snapshot serialization failed/);
    assert.strictEqual(stream.destroyed, true);
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'previous export');
    assert.deepStrictEqual(fs.readdirSync(root), ['report.zip']);
  });
});

suite.test('an output failure stops the library stream and leaves no partial file', async () => {
  await withTemporaryDirectory('diagnostic-stream-output', async root => {
    const stream = Readable.from((async function* () {
      while (true) {yield 'record'; await new Promise(resolve => setImmediate(resolve));}
    })());
    await assert.rejects(writeArchive(path.join(root, 'missing', 'report.zip'),
      [{name: 'library-diagnostic.json', stream}]), error => error.code === 'ENOENT');
    assert.strictEqual(stream.destroyed, true);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});

suite.test('retained log symlinks never copy their target into a report', async () => {
  await withTemporaryDirectory('diagnostic-symlink', async root => {
    const f = fixture(root), privateFile = path.join(root, 'private'); fs.writeFileSync(privateFile, 'private-key\n');
    try {fs.symlinkSync(privateFile, path.join(f.logs, 'mynda-error.log'));}
    catch (error) {if (process.platform === 'win32' && error.code === 'EPERM') return; throw error;}
    const logs = await collectLogs(f.logs, createRedactor(), 1000);
    assert.deepStrictEqual(logs.entries, []);
    assert(logs.notes.some(note => note.includes('non-regular')));
  });
});

suite.test('named preload/IPC export requires a trusted window, rejects paths, and scopes reveal permission', async () => {
  await withTemporaryDirectory('diagnostic-bridge', async root => {
    const f = fixture(root), sent = [], events = [1, 2].map(id => ({sender: {id, isDestroyed: () => false}}));
    const desktop = createDesktopService({...f, getWindow: () => null, exportDiagnostics: f.exporter,
      shell: {showItemInFolder: filename => sent.push(filename)}, log: {info() {}, error() {}}});
    let handler;
    installRendererBridge({ipcMain: {handle: (_name, callback) => {handler = callback;}},
      isTrustedSender: event => events.includes(event), methods: desktop.methods});
    const api = createBridge({platform: 'linux', subscribe: () => {}, invoke: async (name, ...args) => {
      const result = await handler(events[0], name, args); if (!result.ok) throw result.error; return result.value;
    }});
    const response = await api.diagnostics.export({includeLibrary: false});
    assert(response.ok);
    await api.files.revealExport(response.value.filePath);
    assert.deepStrictEqual(sent, [response.value.filePath]);
    assert.strictEqual((await handler(events[1], 'files.revealExport', [response.value.filePath])).ok, false);
    assert.strictEqual((await handler({}, 'diagnostics.export', [{includeLibrary: false}])).error.code, 'APP_UNAUTHORIZED');
    for (const input of [{includeLibrary: 'yes'}, {includeLibrary: false, path: '/private'}, {}]) {
      assert.strictEqual((await handler(events[0], 'diagnostics.export', [input])).error.code, 'INVALID_APP_REQUEST');
    }
  });
});

runSuite(suite);
