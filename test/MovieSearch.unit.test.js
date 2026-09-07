const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');
const MovieSearch = require('../src/MovieSearch.js');

const suite = createSuite(
  'Movie search and auto-tag matching',
  'unit',
  'Exercises deterministic filename parsing and OMDb-result qualification without network calls.'
);

suite.test('normalizes punctuation, articles, diacritics, ampersands, and sequel numerals', () => {
  assert.strictEqual(MovieSearch.titleKey("The King's Speech"), 'thekingsspeech');
  assert.strictEqual(MovieSearch.titleKey('Amélie'), 'amelie');
  assert.strictEqual(MovieSearch.titleKey('Me & You'), MovieSearch.titleKey('Me and You'));
  assert.strictEqual(MovieSearch.titleKey('Rocky II'), MovieSearch.titleKey('Rocky 2'));
  assert.strictEqual(MovieSearch.titleKey('The Colour of Money'), MovieSearch.titleKey('The Color of Money'));
});

suite.test('recognizes only deliberate sample and sample-folder evidence', () => {
  assert.strictEqual(MovieSearch.basenameLooksLikeSampleOrGarbage('/Movies/Alien.sample.mkv'), true);
  assert.strictEqual(MovieSearch.basenameLooksLikeSampleOrGarbage('/Movies/RARBG.com.mp4'), true);
  assert.strictEqual(MovieSearch.basenameLooksLikeSampleOrGarbage('/Movies/A Sample of Life.mkv'), false);
  assert.strictEqual(MovieSearch.pathContainsSampleArea('/Movies/Alien/Samples/clip.mkv'), true);
  assert.strictEqual(MovieSearch.pathContainsSampleArea('C:\\Movies\\Alien\\Sample,Screens\\clip.mkv'), true);
  assert.strictEqual(MovieSearch.pathContainsSampleArea('/Movies/A Sample of Life/movie.mkv'), true);
});

suite.test('builds cautious spelling and catalog-title query variants', () => {
  const trailingArticle = MovieSearch.buildTitleQueryVariants('Conversation, The');
  assert(trailingArticle.some(item => item.title === 'The Conversation'));

  const sequel = MovieSearch.buildTitleQueryVariants('Rocky 2');
  assert(sequel.some(item => item.title === 'Rocky II'));

  const alias = MovieSearch.buildTitleQueryVariants('Der Untergang (Downfall)');
  assert(alias.some(item => item.title === 'Downfall'));

  const normalized = MovieSearch.buildNormalizedDiscoveryQueries("Oceans Eleven");
  assert(normalized.length <= 2);
  assert(normalized.some(item => /Ocean/.test(item.title)));
});

suite.test('extracts a clean movie title and year from a release filename', () => {
  const candidates = MovieSearch.buildSearchCandidates({
    title: 'Alien.1979.1080p.BluRay.x264',
    filename: '/Movies/Alien.1979.1080p.BluRay.x264.mkv',
    year: '',
    kind: 'movie'
  });
  assert.strictEqual(candidates[0].title, 'Alien');
  assert.strictEqual(candidates[0].year, '1979');
  assert.strictEqual(candidates[0].source, 'filename');
});

suite.test('prefers a deliberately edited title and refuses auxiliary material', () => {
  const edited = MovieSearch.buildSearchCandidates({
    title: 'The Correct Movie',
    filename: '/Movies/Wrong.Release.Name.2020.mkv',
    year: 2020,
    kind: 'movie'
  });
  assert.strictEqual(edited[0].title, 'The Correct Movie');
  assert.strictEqual(edited[0].source, 'video title');

  assert.deepStrictEqual(MovieSearch.buildSearchCandidates({
    title: 'Interview',
    filename: '/Movies/Alien/Featurettes/Interview.mkv',
    kind: 'movie'
  }), []);
  assert.deepStrictEqual(MovieSearch.buildSearchCandidates({
    title: 'Alien.sample',
    filename: '/Movies/Alien/Alien.sample.mkv',
    kind: 'movie'
  }), []);
});

suite.test('preserves split-file and episodic structural evidence', () => {
  assert.strictEqual(MovieSearch.isSplitFile('/Movies/Lawrence of Arabia CD1.mkv'), true);
  assert.strictEqual(MovieSearch.isSplitFile('/Movies/Part 1.mkv'), false);

  const split = MovieSearch.buildSearchCandidates({
    title: 'Lawrence.of.Arabia.CD1',
    filename: '/Movies/Lawrence.of.Arabia.CD1.mkv',
    kind: 'movie'
  });
  assert.strictEqual(split[0].title, 'Lawrence of Arabia');

  const episode = MovieSearch.buildSearchCandidates({
    title: 'Mystery.S01E02',
    filename: '/Movies/Mystery/Mystery.S01E02.mkv',
    kind: 'movie'
  });
  assert.deepStrictEqual(episode, []);
});

suite.test('selects one exact compatible OMDb row and preserves real ambiguity', () => {
  const candidate = {title: 'Alien', year: '1979'};
  const video = {kind: 'movie'};
  const exact = {Title: 'Alien', Year: '1979', Type: 'movie', imdbID: 'tt0078748'};
  const wrongYear = {Title: 'Alien', Year: '1992', Type: 'movie', imdbID: 'tt0103644'};
  const series = {Title: 'Alien', Year: '1979', Type: 'series', imdbID: 'tt-series'};

  const selected = MovieSearch.evaluateSearchResults([wrongYear, series, exact], candidate, video);
  assert.strictEqual(selected.confident, exact);
  assert.deepStrictEqual(selected.acceptableResults, [exact]);

  const duplicate = {Title: 'Alien', Year: '1979', Type: 'movie', imdbID: 'tt-other'};
  const ambiguous = MovieSearch.evaluateSearchResults([exact, duplicate], candidate, video);
  assert.strictEqual(ambiguous.confident, null);
  assert.strictEqual(ambiguous.acceptableResults.length, 2);
});

suite.test('keeps exact, article-only, and canonical confidence tiers separate', () => {
  const candidate = {title: 'Captain America', year: '2011'};
  const exact = {Title: 'Captain America', Year: '2011', Type: 'movie', imdbID: 'exact'};
  const article = {Title: 'The Captain America', Year: '2011', Type: 'movie', imdbID: 'article'};
  const canonical = {
    Title: 'Captain America: The First Avenger',
    Year: '2011',
    Type: 'movie',
    imdbID: 'canonical'
  };
  const result = MovieSearch.evaluateSearchResults(
    [canonical, article, exact],
    candidate,
    {kind: 'movie'},
    {allowCanonicalTitle: true}
  );
  assert.strictEqual(result.confident, exact);
  assert.deepStrictEqual(result.exactResults, [exact]);
  assert.deepStrictEqual(result.articleResults, [article]);
  assert.deepStrictEqual(result.canonicalResults, [canonical]);
});

suite.test('parses OMDb runtimes and rejects implausible feature matches', () => {
  assert.strictEqual(MovieSearch.parseRuntimeMinutes('2 h 17 min'), 137);
  assert.strictEqual(MovieSearch.parseRuntimeMinutes('117 min'), 117);
  assert.strictEqual(MovieSearch.parseRuntimeMinutes('N/A'), null);

  const video = {filename: '/Movies/Example.mkv', metadata: {duration: 120 * 60}};
  const plausible = MovieSearch.evaluateFullResultPlausibility(
    {Runtime: '125 min', Genre: 'Drama', imdbVotes: '12,000'},
    video
  );
  assert.strictEqual(plausible.plausible, true);

  const short = MovieSearch.evaluateFullResultPlausibility(
    {Runtime: '12 min', Genre: 'Short', imdbVotes: '100'},
    video
  );
  assert.strictEqual(short.plausible, false);
  assert(short.reasons.length >= 1);
});

suite.test('requires strong runtime and audience evidence for relaxed matches', () => {
  const video = {kind: 'movie', filename: '/Movies/Dune.mkv', metadata: {duration: 155 * 60}};
  const candidate = {title: 'Dune', year: ''};
  const obscure = {
    Title: 'Dune', Year: '2021', Type: 'movie', imdbID: 'obscure',
    Runtime: '155 min', imdbVotes: '12'
  };
  const established = Object.assign({}, obscure, {imdbID: 'established', imdbVotes: '900,000'});

  assert.strictEqual(MovieSearch.evaluateFullResult(
    obscure,
    candidate,
    video,
    {requireStrongEvidence: true}
  ).confident, false);
  assert.strictEqual(MovieSearch.evaluateFullResult(
    established,
    candidate,
    video,
    {requireStrongEvidence: true}
  ).confident, true);
});

runSuite(suite);
