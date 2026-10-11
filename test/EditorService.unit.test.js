const fs = require('fs');
const os = require('os');
const path = require('path');
const {serialize, deserialize} = require('v8');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {createEditorService} = require('../src/main/EditorService');
const Evidence = require('../src/tagging/TaggingEvidence');
const suite = createSuite('Isolated editor backend', 'unit',
  'Backend-owned catalog evidence, canonical file identities, bounded artwork writes and staged edits.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-editor-service-'));
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVdMAAAAASUVORK5CYII=', 'base64');
const original = () => ({id: 'library-video', filename: '/media/Series S01E01.mkv', kind: 'show',
  title: 'Arrival', series: 'A Series', season: 1, episode: 1, tags: ['original'],
  metadata: {duration: 42 * 60}, ratings: {user: 3}, artwork: ''});
function setup(overrides = {}) {
  const source = original();
  const library = {media: [source], inactive_media: []};
  const calls = [];
  const proposal = {status: 'candidate', candidate: {video: {...source, season: 2},
    record: {imdbID: 'tt123', Title: 'Arrival', Type: 'episode'}, evidence: {kind: 'episode'}},
    context: {originalInput: Evidence.snapshot(source), cache: new Map([['pending', Promise.resolve('cached')]])}};
  const service = createEditorService({library, app: {getPath: () => root},
    catalog: {resolve: async video => { calls.push(['resolve', video]); return proposal; },
      applyMatch: async (candidate, options) => { calls.push(['apply', candidate, options]); return {status: 'matched', video: candidate.candidate.video}; },
      tag: async (video, options) => { calls.push(['tag', video, options]); return {status: 'matched', video}; }},
    dialog: {showMessageBox: async options => { calls.push(['confirm', options]); return {response: 1}; },
      showOpenDialog: async options => { calls.push(['choose', options]); return {canceled: true, filePaths: []}; }},
    downloadFile: async (url, destination) => { calls.push(['download', url, destination]); await fs.promises.writeFile(destination, image); return {success: true, message: destination}; },
    deriveFilenameResetChanges: video => { calls.push(['reset', video]); return {id: video.id, watchfolderFound: true, changes: {title: 'Detected', ratings: {...video.ratings, imdb: ''}}}; },
    ...overrides});
  return {service, library, source, proposal, calls};
}

suite.test('preview keeps promises and policy evidence in the backend and never applies a match', async () => {
  const {service, source, proposal, calls} = setup();
  const result = await service.search(source, 10);
  assert.strictEqual(result.status, 'candidate');
  assert.strictEqual(typeof result.proposalID, 'string');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)).candidate.record, proposal.candidate.record);
  assert.strictEqual(result.context.cache, undefined);
  assert.deepStrictEqual(calls.map(call => call[0]), ['resolve']);
});
suite.test('selection reuses the exact proposal context, preserves numbering and takes latest unrelated drafts', async () => {
  const {service, source, proposal, calls, library} = setup();
  const result = await service.search(source, 10);
  const matched = await service.select({draft: {...source, tags: ['unsaved'], ratings: {user: 5}},
    choice: {myndaProposalID: result.proposalID, imdbID: 'tt999'}}, 10);
  assert.strictEqual(matched.video.season, 2);
  assert.deepStrictEqual(matched.video.tags, ['unsaved']);
  assert.strictEqual(matched.video.ratings.user, 5);
  const application = calls.find(call => call[0] === 'apply');
  assert.strictEqual(application[1].context, proposal.context);
  assert.strictEqual(application[1].candidate.record.imdbID, 'tt123', 'renderer cannot replace the chosen record');
  assert.deepStrictEqual(application[2], {recordSelectionSource: 'user'});
  assert.deepStrictEqual(library.media[0], original(), 'selection must not save');
});
suite.test('tokens cannot be fabricated, reused, or transferred to another window', async () => {
  const {service, source} = setup();
  await assert.rejects(service.select({draft: source, choice: {myndaProposalID: 'invented'}}, 10));
  const result = await service.search(source, 10);
  const request = {draft: source, choice: {myndaProposalID: result.proposalID}};
  await assert.rejects(service.select(request, 11));
  await service.select(request, 10);
  await assert.rejects(service.select(request, 10));
});
suite.test('identity edits and removed videos invalidate pending choices', async () => {
  const {service, source, library} = setup();
  const result = await service.search(source, 10);
  await assert.rejects(service.select({draft: {...source, episode: 2}, choice: {myndaProposalID: result.proposalID}}, 10));
  library.media = [];
  await assert.rejects(service.select({draft: source, choice: {myndaProposalID: result.proposalID}}, 10));
});
suite.test('old and closed-window proposals expire', async () => {
  let clock = 0;
  const {service, source} = setup({now: () => clock});
  const first = await service.search(source, 10);
  clock = 31 * 60 * 1000;
  await assert.rejects(service.select({draft: source, choice: {myndaProposalID: first.proposalID}}, 10));
  const second = await service.search(source, 10);
  service.dispose(10);
  await assert.rejects(service.select({draft: source, choice: {myndaProposalID: second.proposalID}}, 10));
});
suite.test('forged paths, technical metadata and evidence never replace canonical library input', async () => {
  const {service, source, calls} = setup();
  await service.search({...source, filename: '/secrets/private', metadata: {duration: 999}, imdbID: 'tt333',
    taggingEvidence: {imdbID: 'tt333', fake: true}}, 10);
  const input = calls[0][1];
  assert.strictEqual(input.filename, source.filename);
  assert.deepStrictEqual(input.metadata, source.metadata);
  assert.strictEqual(input.taggingEvidence.fake, undefined);
  assert.strictEqual(Evidence.identity(input, 'imdbID').origin, 'user');
});
suite.test('ambiguous parent choices use the stored row and mark selection as user supplied', async () => {
  const calls = [];
  const {service, source} = setup({catalog: {
    resolve: async () => ({status: 'ambiguous', choices: [{imdbID: 'tt222', myndaChoiceType: 'series'}]}),
    tag: async (video, options) => { calls.push({video, options}); return {status: 'matched', video}; }
  }});
  const result = await service.search(source, 10);
  await service.select({draft: source, choice: {...result.choices[0], imdbID: 'tt999', myndaChoiceType: 'record'}}, 10);
  assert.deepStrictEqual(calls[0].options, {seriesImdbID: 'tt222', seriesSelectionSource: 'user'});
});
suite.test('malformed drafts fail before starting catalog work', async () => {
  const {service, source, calls} = setup();
  for (const draft of [null, [], {...source, id: 'missing'}, {...source, title: {}},
    {...source, tags: [42]}, {...source, ratings: {user: {}}}]) await assert.rejects(service.search(draft, 10));
  assert.strictEqual(calls.length, 0);
});
suite.test('legacy null library slots do not break video or existing-file lookups', async () => {
  const {service, source, library} = setup({dialog: {showMessageBox: async () => { throw new Error('An existing file should not ask again'); }}});
  const local = path.join(root, 'known-artwork.png'); fs.writeFileSync(local, image);
  const subtitle = path.join(root, 'known-subtitle.srt'); fs.writeFileSync(subtitle, 'captions');
  source.artwork = local; source.subtitles = [subtitle];
  library.media = [null, source]; library.inactive_media = [null];
  assert.strictEqual((await service.search(source, 10)).status, 'candidate');
  assert.strictEqual(await service.inspectArtwork(local, 10), fs.realpathSync(local));
  assert.deepStrictEqual((await service.validateSubtitles([subtitle], 10)).accepted, [subtitle]);
});
suite.test('local artwork uses content signatures and backend-generated destinations', async () => {
  const {service} = setup();
  const source = path.join(root, 'picked-file.txt');
  fs.writeFileSync(source, image);
  const accepted = await service.inspectArtwork(source);
  assert.strictEqual(accepted, fs.realpathSync(source));
  const managed = await service.prepareArtwork(accepted);
  assert.strictEqual(path.dirname(managed), fs.realpathSync(path.join(root, 'Library', 'Artwork')));
  assert.strictEqual(path.extname(managed), '.png');
  assert.deepStrictEqual(fs.readFileSync(managed), image);
  assert.strictEqual(await service.prepareArtwork(managed), managed);
  await assert.rejects(service.prepareArtwork('../../anything.png'));
  const fake = path.join(root, 'fake.png'); fs.writeFileSync(fake, '<html>not an image</html>');
  await assert.rejects(service.prepareArtwork(fake));
  await assert.rejects(service.prepareArtwork(root));
});
suite.test('symlinked artwork is copied rather than keeping an unmanaged target', async () => {
  const {service} = setup();
  const source = path.join(root, 'outside.png'); fs.writeFileSync(source, image);
  fs.mkdirSync(path.join(root, 'Library', 'Artwork'), {recursive: true});
  const link = path.join(root, 'Library', 'Artwork', 'linked.png');
  try { fs.symlinkSync(source, link); }
  catch (error) { if (error.code === 'EPERM' && process.platform === 'win32') return; throw error; }
  const accepted = await service.inspectArtwork(link, 10);
  const managed = await service.prepareArtwork(accepted, 10);
  assert.notStrictEqual(managed, source); assert.notStrictEqual(managed, link);
  assert.deepStrictEqual(fs.readFileSync(managed), image);
});
suite.test('artwork paths and grants remain stable through an aliased user-data directory', async () => {
  const target = path.join(root, 'alias-target');
  const alias = path.join(root, 'alias-user-data');
  fs.mkdirSync(target);
  // Directory junctions do not need Windows symlink privileges. On macOS and
  // Linux this recreates the /var -> /private/var alias used by macOS temp paths.
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const local = path.join(alias, 'chosen.png'); fs.writeFileSync(local, image);
  const {service, calls} = setup({app: {getPath: () => alias}, dialog: {
    showMessageBox: async () => ({response: 1}),
    showOpenDialog: async () => ({canceled: false, filePaths: [local]})
  }});
  const chosen = await service.chooseArtwork(10);
  assert.strictEqual(chosen, fs.realpathSync(local));
  assert.notStrictEqual(chosen, local, 'the fixture must exercise a real path alias');
  assert.strictEqual(service.authorizeArtwork(chosen, 10), true);
  assert.strictEqual(service.authorizeArtwork(chosen, 11), false);
  const inspected = await service.inspectArtwork(local, 10);
  assert.strictEqual(inspected, chosen);
  const managed = await service.prepareArtwork(inspected, 10);
  assert.strictEqual(managed, fs.realpathSync(managed));
  assert.strictEqual(path.dirname(managed), fs.realpathSync(path.join(alias, 'Library', 'Artwork')));
  assert.deepStrictEqual(fs.readFileSync(managed), image);
  assert.strictEqual(service.authorizeArtwork(managed, 10), true);
  assert.strictEqual(await service.prepareArtwork(managed, 10), managed);
  const downloaded = await service.downloadArtwork('https://artwork.example/alias.png', 10);
  assert.strictEqual(downloaded.success, true);
  assert.strictEqual(downloaded.message, fs.realpathSync(downloaded.message));
  assert.strictEqual(path.dirname(downloaded.message), fs.realpathSync(path.join(alias, 'temp')));
  assert.strictEqual(calls.filter(call => call[0] === 'download').length, 1);
  assert.strictEqual(service.authorizeArtwork(downloaded.message, 10), true);
  const savedDownload = await service.prepareArtwork(downloaded.message, 10);
  assert.strictEqual(await service.prepareArtwork(savedDownload, 10), savedDownload);
  fs.writeFileSync(managed, 'changed since approval');
  assert.strictEqual(service.authorizeArtwork(managed, 10), false);
  await assert.rejects(service.prepareArtwork(managed, 10));
  service.dispose(10);
  assert.strictEqual(service.authorizeArtwork(savedDownload, 10), false);
});
suite.test('downloads accept HTTP images only and ignore any caller-supplied destination', async () => {
  const {service, calls} = setup();
  for (const url of ['file:///private/a.png','javascript:alert(1)','https://user:password@host/a.png']) {
    await assert.rejects(service.downloadArtwork(url));
  }
  const result = await service.downloadArtwork('https://artwork.example/poster.png', '/tmp/attacker-path');
  assert(result.success);
  assert.strictEqual(path.dirname(result.message), fs.realpathSync(path.join(root, 'temp')));
  assert.strictEqual(path.extname(result.message), '.png');
  assert.strictEqual(calls.filter(call => call[0] === 'download').length, 1);
});
suite.test('a downloaded non-image is removed and cannot enter the renderer', async () => {
  let destination;
  const {service} = setup({downloadFile: async (url, file) => {
    destination = file; fs.writeFileSync(file, '<svg><script>bad()</script></svg>'); return {success: true};
  }});
  const result = await service.downloadArtwork('https://example.test/not-image.png');
  assert.strictEqual(result.success, false); assert.strictEqual(fs.existsSync(destination), false);
});
suite.test('unconfirmed file paths never acquire capabilities or permit artwork copies', async () => {
  const {service} = setup({dialog: {showMessageBox: async () => ({response: 0})}});
  const local = path.join(root, 'unapproved.png'); fs.writeFileSync(local, image);
  await assert.rejects(service.prepareArtwork(local, 10));
  assert.strictEqual(await service.inspectArtwork(local, 10), null);
  assert.strictEqual(service.authorizeArtwork(local, 10), false);
  const subtitle = path.join(root, 'unapproved.srt'); fs.writeFileSync(subtitle, 'captions');
  assert.deepStrictEqual((await service.validateSubtitles([subtitle], 10)).accepted, []);
  assert.strictEqual(service.authorizeSubtitle(subtitle, 10), false);
});
suite.test('file grants are owned by the requesting window and revoked at teardown', async () => {
  const {service} = setup();
  const local = path.join(root, 'approved.png'); fs.writeFileSync(local, image);
  const chosen = await service.inspectArtwork(local, 10);
  const managed = await service.prepareArtwork(chosen, 10);
  assert.strictEqual(service.authorizeArtwork(managed, 10), true);
  assert.strictEqual(service.authorizeArtwork(managed, 11), false);
  await assert.rejects(service.prepareArtwork(chosen, 11));
  service.dispose(10);
  assert.strictEqual(service.authorizeArtwork(managed, 10), false);
});
suite.test('a modified or replaced file cannot reuse a previous grant', async () => {
  const {service} = setup();
  const local = path.join(root, 'changing.png'); fs.writeFileSync(local, image);
  const accepted = await service.inspectArtwork(local, 10);
  assert.strictEqual(service.authorizeArtwork(accepted, 10), true);
  fs.writeFileSync(local, 'this is no longer an image');
  assert.strictEqual(service.authorizeArtwork(accepted, 10), false);
  await assert.rejects(service.prepareArtwork(accepted, 10));
  const subtitle = path.join(root, 'changing.srt'); fs.writeFileSync(subtitle, 'approved captions');
  await service.validateSubtitles([subtitle], 10);
  fs.unlinkSync(subtitle); fs.writeFileSync(subtitle, 'replacement captions');
  assert.strictEqual(service.authorizeSubtitle(subtitle, 10), false);
});
suite.test('a search finishing after window teardown cannot recreate a proposal', async () => {
  let finish;
  const {service, source} = setup({catalog: {resolve: () => new Promise(resolve => { finish = resolve; })}});
  const searching = service.search(source, 10);
  service.dispose(10);
  finish({status: 'candidate', candidate: {record: {imdbID: 'tt123', Poster: 'N/A'}}});
  await assert.rejects(searching, /window has closed/);
});
suite.test('real tagging-engine decisions crossing the bridge retain evidence and only cloneable data', async () => {
  const fixtures = require('./helpers/OmdbFixtures');
  const input = fixtures.show({filename: '/media/Example S01E01.mkv'});
  const record = fixtures.episode(input.title);
  const {api} = fixtures.loadSearch(fixtures.catalog([record]));
  const {service, library} = setup({catalog: api, library: {media: [input], inactive_media: []}});
  const preview = await service.search(input, 10);
  assert.strictEqual(preview.status, 'candidate');
  assert.deepStrictEqual(deserialize(serialize(preview)), preview);
  const matched = await service.select({draft: input, choice: {myndaProposalID: preview.proposalID}}, 10);
  assert.strictEqual(matched.status, 'matched');
  assert.strictEqual(matched.video.imdbID, record.imdbID);
  assert(matched.video.taggingEvidence.original);
  assert.strictEqual(matched.video.taggingDecision, null);
  assert.deepStrictEqual(deserialize(serialize(matched)), matched);
  assert.strictEqual(input.imdbID, '', 'the backend returns a draft instead of mutating the source');
});
suite.test('canceling an unrecognized artwork URL prevents any request or write', async () => {
  const {service, calls} = setup({dialog: {showMessageBox: async () => ({response: 0})}});
  const result = await service.downloadArtwork('http://127.0.0.1/private-image.png', 10);
  assert.strictEqual(result.success, false);
  assert.strictEqual(calls.length, 0);
});
suite.test('backend catalog artwork URLs are usable without another native confirmation', async () => {
  const {service, source, proposal, calls} = setup({dialog: {showMessageBox: async () => { throw new Error('Unexpected confirmation'); }}});
  proposal.candidate.record.Poster = 'https://artwork.example/catalog.png';
  await service.search(source, 10);
  const result = await service.downloadArtwork(proposal.candidate.record.Poster, 10);
  assert(result.success);
  assert.strictEqual(service.authorizeArtwork(result.message, 10), true);
  assert.strictEqual(calls.filter(call => call[0] === 'download').length, 1);
});
suite.test('oversized local images are rejected before entering managed artwork', async () => {
  const {service} = setup();
  const local = path.join(root, 'oversized.png');
  fs.writeFileSync(local, image); fs.truncateSync(local, 20 * 1024 * 1024 + 1);
  await assert.rejects(service.inspectArtwork(local, 10), /20 MB/);
  assert.strictEqual(service.authorizeArtwork(local, 10), false);
});
suite.test('subtitle validation filters missing paths, directories, wrong types and duplicates', async () => {
  const {service} = setup();
  const subtitle = path.join(root, 'captions.srt'); fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello');
  const result = await service.validateSubtitles([subtitle, subtitle, root, path.join(root, 'missing.srt'), path.join(root, 'outside.png')]);
  assert.deepStrictEqual(result.accepted, [subtitle]); assert.strictEqual(result.rejected.length, 3);
});
suite.test('filename reset preserves pending user rating and stages only canonical filename patches', async () => {
  const {service, source, library, calls} = setup();
  const result = await service.resetFromFilename([{...source, filename: '/wrong/file', ratings: {user: 5}}]);
  assert(result.confirmed); assert.strictEqual(result.patches[0].changes.ratings.user, 5);
  assert.strictEqual(calls.find(call => call[0] === 'reset')[1].filename, source.filename);
  assert.deepStrictEqual(library.media[0], original());
});
suite.test('cancelled reset and active autotag cannot stage or commit changes', async () => {
  const cancelled = setup({dialog: {showMessageBox: async () => ({response: 0})}});
  assert.deepStrictEqual(await cancelled.service.resetFromFilename([cancelled.source]), {confirmed: false, patches: []});
  const busy = setup({isAutoTagRunning: () => true});
  const result = await busy.service.resetFromFilename([busy.source]);
  assert.strictEqual(result.confirmed, false); assert.match(result.error, /Auto-Tag/);
  assert.strictEqual(busy.calls.length, 0);
});
suite.test('dialog operations accept only the documented confirmation kinds', async () => {
  const {service, calls} = setup();
  await assert.rejects(service.confirm({kind: '__proto__'}));
  await assert.rejects(service.confirm({kind: 'remove-list-item', item: {}}));
  await service.confirm({kind: 'revert', checkbox: true});
  assert.strictEqual(calls[0][1].defaultId, 1);
  assert.deepStrictEqual(await service.chooseSubtitles(), []);
  assert.strictEqual(await service.chooseArtwork(), null);
});

process.on('exit', () => fs.rmSync(root, {recursive: true, force: true}));
runSuite(suite);
