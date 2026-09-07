const path = require('path');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {videoFixture} = require('./helpers/Fixtures.js');

const loggedWarnings = [];
const RendererUtils = loadFreshWithMocks(
  path.join(__dirname, '..', 'src', 'renderer', 'RendererUtils.js'),
  {
    './RendererRuntime.js': {
      frontendLog: {
        warn: (message, data) => loggedWarnings.push({message, data}),
        debug() {}, info() {}, error() {}
      }
    }
  }
);

const suite = createSuite(
  'Renderer editing and validation helpers',
  'unit',
  'Protects editor rules without creating a browser window or rendering React.'
);

suite.test('sorts titles without leading articles', () => {
  assert.strictEqual(RendererUtils.removeLeadingArticle('The Conversation'), 'Conversation');
  assert.strictEqual(RendererUtils.removeLeadingArticle('An Education'), 'Education');
  assert.strictEqual(RendererUtils.removeLeadingArticle('Alien'), 'Alien');
  assert.strictEqual(RendererUtils.removeLeadingArticle(null), null);
});

suite.test('keeps packaged renderer assets relative while encoding absolute artwork paths', () => {
  assert.strictEqual(
    RendererUtils.artworkSourceURL('', '../images/qmark.png'),
    '../images/qmark.png'
  );
  assert.strictEqual(
    RendererUtils.artworkSourceURL('https://example.com/poster.jpg', '../images/qmark.png'),
    'https://example.com/poster.jpg'
  );
  const localArtwork = path.resolve('/tmp', 'Poster With Spaces.jpg');
  const artworkURL = RendererUtils.artworkSourceURL(localArtwork, '../images/qmark.png');
  assert(artworkURL.startsWith('file:'));
  assert(artworkURL.includes('Poster%20With%20Spaces.jpg'));
});

suite.test('builds stable single-video and batch selection identities', () => {
  assert.strictEqual(RendererUtils.editorSelectionKey({id: 'video-1'}), 'single:video-1');
  assert.strictEqual(RendererUtils.editorSelectionKey({id: 'batch'}, [
    {id: 'z'}, {id: 'a'}, null
  ]), 'batch:["a","z"]');
  assert.strictEqual(RendererUtils.editorSelectionKey(null), '');
});

suite.test('represents checked, unchecked, and mixed batch New states', () => {
  assert.strictEqual(RendererUtils.batchNewState([{new: true}, {new: true}]), true);
  assert.strictEqual(RendererUtils.batchNewState([{new: false}, {}]), false);
  assert.strictEqual(RendererUtils.batchNewState([{new: true}, {new: false}]), null);
  assert.strictEqual(RendererUtils.batchNewState([]), false);
});

suite.test('accepts only canonical integer or one-decimal episode positions', () => {
  assert.strictEqual(RendererUtils.parseEditableEpisodeNumber('3.5'), 3.5);
  assert.strictEqual(RendererUtils.parseEditableEpisodeNumber(' 12 '), 12);
  assert.strictEqual(RendererUtils.parseEditableEpisodeNumber('3.50'), null);
  assert.strictEqual(RendererUtils.parseEditableEpisodeNumber('-1'), null);
  assert.strictEqual(RendererUtils.parseEditableEpisodeNumber('1e2'), null);
});

suite.test('compares ratings by their editor-visible values', () => {
  assert.strictEqual(RendererUtils.editorRatingValuesEqual(8, '8'), true);
  assert.strictEqual(RendererUtils.editorRatingValuesEqual(null, ''), true);
  assert.strictEqual(RendererUtils.editorRatingsEqual(
    {imdb: 8, user: ''},
    {imdb: '8', user: null}
  ), true);

  const videos = [
    {ratings: {imdb: '8', custom: 'A'}},
    {ratings: {imdb: 8, custom: 'B', rt: 90}}
  ];
  const state = RendererUtils.batchRatingsState(videos);
  assert.strictEqual(state.imdb, '8');
  assert.strictEqual(state.custom, '');
  assert.strictEqual(state.rt, '');
  assert.deepStrictEqual(videos[0].ratings, {imdb: '8', custom: 'A'});
});

suite.test('distinguishes clearing a common batch value from leaving a mixed field blank', () => {
  const changed = new Set();
  const batch = {id: 'batch'};
  const baseline = {director: 'Ridley Scott', genre: ''};

  assert.strictEqual(RendererUtils.updateEditorChangedField(
    changed, batch, baseline, 'director', ''
  ), true);
  assert.strictEqual(changed.has('director'), true);

  assert.strictEqual(RendererUtils.updateEditorChangedField(
    changed, batch, baseline, 'genre', ''
  ), false);
  assert.strictEqual(changed.has('genre'), false);

  RendererUtils.updateEditorChangedField(changed, batch, baseline, 'director', 'Ridley Scott');
  assert.strictEqual(changed.has('director'), false);
});

suite.test('recognizes a complete valid video without changing it', () => {
  const item = videoFixture();
  const before = JSON.parse(JSON.stringify(item));
  assert.strictEqual(RendererUtils.validateVideo(item), true);
  assert.deepStrictEqual(item, before);
});

suite.test('repairs malformed universal fields and removes series IDs from movies', () => {
  loggedWarnings.length = 0;
  const malformed = videoFixture({
    id: '',
    year: 'not a year',
    episode: '3.50',
    cast: 'not an array',
    ratings: null,
    metadata: null,
    seen: 'yes',
    seriesImdbID: 'tt-wrong-for-a-movie'
  });
  assert.strictEqual(RendererUtils.validateVideo(malformed), false);
  assert.strictEqual(typeof malformed.id, 'string');
  assert.notStrictEqual(malformed.id, '');
  assert.strictEqual(malformed.year, '');
  assert.strictEqual(malformed.episode, '');
  assert.deepStrictEqual(malformed.cast, []);
  assert.deepStrictEqual(Object.keys(malformed.ratings).sort(), ['imdb', 'mc', 'rt', 'user']);
  assert.strictEqual(malformed.metadata.duration, 0);
  assert.strictEqual(malformed.seen, false);
  assert.strictEqual(malformed.seriesImdbID, '');
  assert.strictEqual(loggedWarnings.length, 1);
});

suite.test('validates URLs and locates the nearest matching DOM ancestor', () => {
  assert.strictEqual(RendererUtils.isValidURL('https://www.omdbapi.com/'), true);
  assert.strictEqual(RendererUtils.isValidURL('not a url'), false);

  const matching = {classList: {contains: value => value === 'target'}, parentElement: null};
  const child = {classList: {contains: () => false}, parentElement: matching};
  assert.strictEqual(RendererUtils.findNearestOfClass(child, 'target'), matching);
});

suite.test('reports object/array differences and ignores function identity', () => {
  assert.deepStrictEqual(
    new Set(RendererUtils.getObjectDiff({a: 1, b: 2}, {a: 1, c: 3})),
    new Set(['b', 'c'])
  );
  assert.deepStrictEqual(RendererUtils.getArrayDiff(
    [{id: 1}, {id: 2}],
    [{id: 2}, {id: 3}]
  ), [{id: 1}, {id: 3}]);
  assert.strictEqual(RendererUtils.isEqualIgnoreFuncs(
    {value: 1, callback() { return 1; }},
    {value: 1, callback() { return 2; }}
  ), true);
});

runSuite(suite);
