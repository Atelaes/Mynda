const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {validateRendererCommit} = require('../src/library/LibraryRendererPolicy');
const Operations = require('../src/library/LibraryOperations');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures');

const suite = createSuite('Renderer library edit boundary', 'unit',
  'Rejects unauthorized file references, scanner state changes, watchfolder bypasses and malformed renderer commands.');
const video = videoFixture({id: 'video-one', filename: '/media/one.mkv', dvd: false,
  subtitles: ['/media/one.srt'], artwork: '/managed/current.png'});
const data = libraryFixture({media: [video]});
data.settings.watchfolders = [{path: '/media', kind: 'movie', videos: []}];
function request(operations) {
  return {requestId: 'renderer:1', operations: operations.map(op => Operations.prepareOperation(data, op))};
}
const patch = changes => request([{opType: 'patch-media', patches: [{id: video.id, changes}]}]);
function validate(value, authorization = {}) {
  return validateRendererCommit(value, {library: data, ...authorization});
}
function rejected(value, authorization) {
  assert.throws(() => validate(value, authorization), error => error.code === 'INVALID_LIBRARY_OPERATION');
}

suite.test('permits ordinary metadata, preferences, playlists and watchfolder kind edits', () => {
  validate(patch({title: 'Updated', 'ratings.user': 4, seen: true}));
  validate(request([{opType: 'replace', address: 'settings.preferences.remove_edited_from_new', entry: true}]));
  validate(request([{opType: 'add', address: 'playlists.push', entry: {id: 'new-list', name: 'A list'}}]));
  validate(request([{opType: 'patch-watchfolder', path: '/media', changes: {kind: 'show'}}]));
});
suite.test('retains and removes existing artwork and subtitle references without another chooser', () => {
  validate(patch({subtitles: video.subtitles.slice(), artwork: video.artwork}));
  validate(patch({subtitles: [], artwork: ''}));
  validate(patch({subtitles: undefined, artwork: undefined}));
});
suite.test('requires a grant before adding any new local file reference', () => {
  rejected(patch({subtitles: ['/private/secret']}));
  rejected(patch({artwork: '/private/secret.png'}));
  validate(patch({subtitles: ['/chosen/sub.srt'], artwork: '/managed/new.png'}), {
    authorizeSubtitle: (value, source) => value === '/chosen/sub.srt' && source.id === video.id,
    authorizeArtwork: (value, source) => value === '/managed/new.png' && source.id === video.id
  });
});
suite.test('a grant for one path never authorizes another path or a Promise result', () => {
  rejected(patch({subtitles: ['/private/secret.srt']}), {authorizeSubtitle: value => value === '/chosen/sub.srt'});
  rejected(patch({artwork: '/managed/other.png'}), {authorizeArtwork: value => value === '/managed/new.png'});
  rejected(patch({subtitles: ['/chosen/sub.srt']}), {authorizeSubtitle: () => Promise.resolve(true)});
});
suite.test('blocks nested asset edits that could bypass whole-list validation', () => {
  rejected(patch({'subtitles.0': '/private/secret.srt'}));
  rejected(patch({'artwork.url': '/private/secret.png'}));
});
suite.test('blocks scanner-owned fields including DVD interpretation and nested metadata', () => {
  for (const changes of [{filename: '/private/secret'}, {duplicates: ['/secret']}, {dvd: true},
    {'metadata.duration': 5}, {manual_subtitles: ['/secret']}, {detected_subtitles: ['/secret']},
    {ignored_subtitles: ['/secret']}, {subtitle_tracking_initialized: true}]) rejected(patch(changes));
});
suite.test('generic whole-video and leaf replacements obey the same file grants', () => {
  rejected(request([{opType: 'replace', address: 'media.0', entry: {...video, subtitles: ['/private/secret']}}]));
  rejected(request([{opType: 'replace', address: 'media.0.artwork', entry: '/private/secret.png'}]));
  validate(request([{opType: 'replace', address: 'media.0', entry: {...video, title: 'Ordinary edit'}}]));
});
suite.test('cannot add or replace filesystem roots through settings or an ancestor', () => {
  for (const operation of [
    {opType: 'replace', address: 'settings', entry: {...data.settings, watchfolders: [{path: '/private'}]}},
    {opType: 'replace', address: 'settings.watchfolders', entry: [{path: '/private'}]},
    {opType: 'add', address: 'settings.watchfolders.push', entry: {path: '/private', kind: 'movie'}},
    {opType: 'replace', address: 'settings.watchfolders.0.path', entry: '/private'},
    {opType: 'remove', address: 'settings.watchfolders.0'}
  ]) {
    const prepared = request([operation]);
    rejected(prepared);
    assert.throws(() => Operations.applyOperations(data, prepared.operations, {actor: 'renderer'}),
      error => error.code === 'INVALID_LIBRARY_OPERATION');
  }
});
suite.test('a watchfolder patch cannot remove its kind or alter its filesystem path', () => {
  rejected(request([{opType: 'patch-watchfolder', path: '/media', changes: {path: '/private'}}]));
  rejected(request([{opType: 'patch-watchfolder', path: '/media', changes: {kind: undefined}}]));
  rejected(request([{opType: 'patch-watchfolder', path: '/media', changes: {kind: {nested: 'show'}}}]));
});
suite.test('rejects backend scan commands and unknown active video IDs', () => {
  for (const opType of ['upsert-media', 'move-media', 'remove-watchfolder', 'something-new']) {
    rejected({requestId: 'r', operations: [{opType}]});
  }
  assert.throws(() => validate({requestId: 'r', operations: [{opType: 'record-played', id: 'unknown'}]}),
    error => error.code === 'LIBRARY_CONFLICT');
});
suite.test('requires string paths and well-formed field expectations even for guards', () => {
  const base = patch({title: 'Changed'});
  base.operations[0].patches[0].guards = [{path: ['constructor'], expected: {present: false}}];
  rejected(base);
  for (const malformed of [null, {path: 'title', expected: {present: 'yes'}},
    {path: 'constructor.secret', expected: {present: false}}, {path: 'title', remove: 'yes'}]) {
    const value = patch({title: 'Changed'});
    value.operations[0].patches[0].fields = [malformed];
    rejected(value);
  }
});
suite.test('rejects circular, prototype-bearing, overly deep or oversized input before queueing', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 35; i++) deep = {child: deep};
  for (const value of [cycle, deep, new Date(), () => {}, NaN,
    JSON.parse('{"__proto__":{"injected":true}}'), 'x'.repeat(1024 * 1024 + 1)]) {
    rejected({requestId: 'r', operations: [{opType: 'replace', address: 'settings.preferences.test', entry: value}]});
  }
  assert.strictEqual({}.injected, undefined);
});

if (require.main === module) suite.test('native references are validated and replaced as one guarded identity',()=>{
  validate(patch({catalogRef:{provider:'fixture',id:'movie:42'}}));
  validate(patch({catalogRef:null,catalogSeriesRef:null}));
  for(const changes of [{'catalogRef.id':'42'},{catalogRef:{provider:'fixture',id:'42',extra:true}},
    {catalogSeriesRef:{provider:'fixture',id:'../unsafe'}}])rejected(patch(changes));
  const before={...video,catalogRef:{provider:'fixture',id:'movie:1'}};
  const replacement={...before,catalogRef:{provider:'fixture',id:'movie:2'}};
  const op=Operations.prepareOperation({...data,media:[before]}, {opType:'patch-media',patches:[{id:before.id,baseline:before,replacement}]});
  assert.deepStrictEqual(op.patches[0].fields.map(f=>f.path),['catalogRef']);
  const result=Operations.applyOperations({...data,media:[before]},[op],{actor:'renderer'});
  assert.deepStrictEqual(result.data.media[0].catalogRef,replacement.catalogRef);
  assert.throws(()=>Operations.applyOperations({...data,media:[{...before,catalogRef:{provider:'other',id:'movie:1'}}]},[op],{actor:'renderer'}),
    error=>error.code==='LIBRARY_CONFLICT');
});
runSuite(suite);
module.exports = suite;
