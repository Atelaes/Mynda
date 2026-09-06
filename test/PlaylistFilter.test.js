const assert = require('assert');
const {
  PLAYLIST_FILTER_REFERENCE,
  PlaylistFilterError,
  clearPlaylistFilterCache,
  compilePlaylistFilter,
  createPlaylistFilterContext,
  validatePlaylistFilter
} = require('../src/PlaylistFilter.js');

const NOW_MILLISECONDS = 1700000000000;
const NOW_SECONDS = NOW_MILLISECONDS / 1000;
const context = createPlaylistFilterContext(NOW_MILLISECONDS);

const video = {
  title: ' Alien ',
  year: '1979',
  series: '',
  kind: 'movie',
  cast: ['Sigourney Weaver', 'Tom Skerritt'],
  tags: ['Horror', 'Space'],
  seen: false,
  new: true,
  dateadded: NOW_SECONDS - (10 * 24 * 60 * 60),
  ratings: {user: '5', imdb: '8.5', rt: 93},
  metadata: {duration: 7001, width: 1920, height: 1080}
};

function evaluate(source, value = video) {
  return compilePlaylistFilter(source)(value, context);
}

function assertMatches(source, expected = true, value = video) {
  assert.strictEqual(evaluate(source, value), expected, source);
}

function assertCompileError(source, code) {
  const validation = validatePlaylistFilter(source);
  assert.strictEqual(validation.valid, false, `${source} should not validate`);
  if (code) assert.strictEqual(validation.code, code, source);
  assert.throws(
    () => compilePlaylistFilter(source),
    error => error instanceof PlaylistFilterError && (!code || error.code === code),
    source
  );
}

function assertRuntimeError(source, value, code) {
  const predicate = compilePlaylistFilter(source);
  assert.throws(
    () => predicate(value, context),
    error => error instanceof PlaylistFilterError && (!code || error.code === code),
    source
  );
}

// Existing Mynda filters and fundamental expression behavior.
assertMatches("video.kind === 'movie'");
assertMatches("video.kind == 'movie'");
assertMatches('video.new === true');
assertMatches('!video.seen');
assertMatches('true');
assertMatches('false', false);
assertMatches("video.kind === 'show'", false);
assertMatches("Number(video.year) === 1979");
assertMatches("String() === '' && Number() === 0 && Boolean() === false");
assertMatches("typeof video.dvd === 'undefined'");
assertMatches("video.unknown === undefined");
assertMatches("video.missing?.value ?? 'fallback'");
assertMatches("video.missing?.nested.value ?? 'fallback'");
assertMatches("video.missing?.values.includes('x') ?? false", false);
assertRuntimeError('video.missing.value', video, 'PROPERTY_ON_UNSET_VALUE');

// Operators, arrays, conditional expressions, and own-property checks.
assertMatches('(2 + 3 * 4) === 14');
assertMatches('2 ** 4 === 16');
assertMatches('(7 & 3) === 3 && (1 << 3) === 8');
assertMatches("'kind' in video");
assertMatches("'notThere' in video", false);
assertMatches("video.year > 2000 ? false : true");
assertMatches("[video.kind, 'show'].includes('movie')");
assertMatches("NaN !== NaN && Infinity > 1000000");
assertMatches("/* readable multiline filters are allowed */ video.kind === 'movie' // keep it");
assertMatches('1_000 === 1000 && 0x10 === 16 && 0b10 === 2 && 0o10 === 8');
assertMatches("`Title: ${video.title.trim()}` === 'Title: Alien'");
assertMatches("Object.values({kind: video.kind, count: 2}).includes('movie')");
assertMatches("Object.keys({...video.ratings, extra: 1}).includes('extra')");
assertMatches('[0, ...video.tags, 3].length === 4');
assertMatches('Math.max(...[1, 9, 3]) === 9');

// String methods can be chained but cannot execute user-supplied callbacks.
assertMatches("video.title.trim().toLowerCase().startsWith('alien')");
assertMatches("video.title.trim().endsWith('ien')");
assertMatches("video.title.includes('lie')");
assertMatches("video.title.trim().slice(0, 3) === 'Ali'");
assertMatches("video.title.trim().substring(1, 4) === 'lie'");
assertMatches("'a-b-c'.split('-').length === 3");
assertMatches("'Alien'.replace('A', 'a') === 'alien'");
assertMatches("'a_a'.replaceAll('_', '-') === 'a-a'");
assertMatches("'7'.padStart(2, '0') === '07'");
assertMatches("'ab'.repeat(2) === 'abab'");
assertMatches("'abc'.at(-1) === 'c'");

// Non-mutating array methods and safe expression-only arrow callbacks.
assertMatches("video.tags.includes('Horror')");
assertMatches("video.tags.at(-1) === 'Space'");
assertMatches("video.tags.join(' / ') === 'Horror / Space'");
assertMatches("video.tags.slice(0, 1)[0] === 'Horror'");
assertMatches("video.tags.concat(['Classic']).length === 3");
assertMatches("video.tags.some(tag => tag.toLowerCase() === 'space')");
assertMatches("video.tags.some(tag => ['hor', 'dra'].some(prefix => tag.toLowerCase().startsWith(prefix)))");
assertMatches("video.tags.every(tag => tag.length >= 5)");
assertMatches("video.cast.filter(name => name.includes('Weaver')).length === 1");
assertMatches("video.cast.find(name => name.startsWith('Tom')) === 'Tom Skerritt'");
assertMatches("video.cast.findIndex(name => name.startsWith('Tom')) === 1");
assertMatches("video.tags.map(tag => tag.toLowerCase()).includes('horror')");
assertMatches("video.tags.flatMap(tag => [tag, tag]).length === 4");
assertMatches("[[1], [2, [3]]].flat(2).length === 3");
assertMatches("video.tags.reduce((text, tag) => text + tag, '') === 'HorrorSpace'");
assertMatches("video.tags.reduceRight((text, tag) => text + tag, '') === 'SpaceHorror'");
assert.deepStrictEqual(video.tags, ['Horror', 'Space']);

// Pure namespaces and helpers.
assertMatches('Math.round(8.5) === 9');
assertMatches('Math.max(1, 9, 3) === 9');
assertMatches('Math.PI > 3.14 && Math.PI < 3.15');
assertMatches("Number.isFinite(Number(video.ratings.imdb))");
assertMatches("Number.isInteger(video.metadata.width)");
assertMatches("String.fromCharCode(65) === 'A'");
assertMatches('Array.isArray(video.tags)');
assertMatches("Object.keys(video.ratings).includes('imdb')");
assertMatches("Object.values(video.ratings).includes('8.5')");
assertMatches("Object.entries(video.ratings).some(entry => entry[0] === 'rt' && entry[1] === 93)");
assertMatches("Object.hasOwn(video, 'kind')");
assertMatches('Object.is(NaN, NaN)');
assertMatches(`Date.now() === ${NOW_MILLISECONDS}`);
assertMatches(`now() === ${NOW_SECONDS}`);
assertMatches('video.dateadded >= daysAgo(30)');
assertMatches('video.dateadded < daysAgo(5)');
assertMatches('ageInDays(video.dateadded) === 10');
assertMatches('between(Number(video.ratings.user), 1, 5)');
assertMatches('clamp(12, 0, 10) === 10');
assertMatches("defined(video.metadata) && !defined(video.nope)");
assertMatches("empty(video.series) && !empty(video.tags)");

// Compilation is cached and validation uses the same compiler.
clearPlaylistFilterCache();
const firstCompilation = compilePlaylistFilter("video.kind === 'movie'");
const secondCompilation = compilePlaylistFilter("video.kind === 'movie'");
assert.strictEqual(firstCompilation, secondCompilation);
assert.deepStrictEqual(validatePlaylistFilter("video.kind === 'movie'"), {
  valid: true,
  error: null,
  code: null
});
assert(Object.isFrozen(firstCompilation.ast));
assert(PLAYLIST_FILTER_REFERENCE.arrayMethods.includes('some'));
assert(PLAYLIST_FILTER_REFERENCE.stringMethods.includes('includes'));

// Unknown execution surfaces, mutation, constructors, and statements fail at
// compile time. Computed blocked properties are also checked again at runtime.
assertCompileError('process.exit()', 'UNKNOWN_IDENTIFIER');
assertCompileError("require('fs').readFileSync('/etc/passwd')", 'UNKNOWN_IDENTIFIER');
assertCompileError('globalThis.process', 'UNKNOWN_IDENTIFIER');
assertCompileError('window.location', 'UNKNOWN_IDENTIFIER');
assertCompileError('document.body', 'UNKNOWN_IDENTIFIER');
assertCompileError('this', 'THIS_NOT_AVAILABLE');
assertCompileError("video.constructor.constructor('return process')()", 'UNSUPPORTED_CALL');
assertCompileError("video['__' + 'proto__']", 'BLOCKED_PROPERTY');
assertCompileError('({__proto__: video})', 'BLOCKED_PROPERTY');
assertCompileError('({constructor: 1})', 'BLOCKED_PROPERTY');
assertCompileError('String.raw`not allowed`', 'UNSUPPORTED_EXPRESSION');
assertCompileError("video.tags.push('Changed')", 'UNSUPPORTED_METHOD');
assertCompileError('video.tags.sort()', 'UNSUPPORTED_METHOD');
assertCompileError("video.kind = 'show'", 'PARSE_ERROR');
assertCompileError("video.kind; process.exit()", 'MULTIPLE_EXPRESSIONS');
assertCompileError("video.title.match(/Alien/)");
assertCompileError('(x => x)(1)', 'UNSUPPORTED_CALL');

const dynamicBlockedProperty = compilePlaylistFilter('video[video.propertyName]');
assert.throws(
  () => dynamicBlockedProperty({propertyName: 'constructor'}, context),
  error => error instanceof PlaylistFilterError && error.code === 'BLOCKED_PROPERTY'
);

// Reading data never invokes an accessor or an inherited property.
let getterCalled = false;
const accessorVideo = {};
Object.defineProperty(accessorVideo, 'secret', {
  enumerable: true,
  get: () => {
    getterCalled = true;
    return true;
  }
});
assertRuntimeError('video.secret', accessorVideo, 'ACCESSOR_PROPERTY');
assert.strictEqual(getterCalled, false);
const inheritedVideo = Object.create({secret: true});
assertMatches('video.secret', false, inheritedVideo);

// Bounded work/output prevents otherwise-safe expressions becoming resource
// exhaustion attacks.
assertRuntimeError("'x'.repeat(100001)", video, 'STRING_TOO_LONG');
assertRuntimeError('video.values.map(value => value + value + value).length > 0', {
  values: Array.from({length: 10000}, (_, index) => index)
}, 'OPERATION_LIMIT');

assertCompileError('', 'EMPTY_FILTER');
assertCompileError('x' + ' '.repeat(8192), 'FILTER_TOO_LONG');

console.log('PlaylistFilter tests passed.');
