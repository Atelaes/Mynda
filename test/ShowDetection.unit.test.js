const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {findSeasonEpisode: detect, findEpisodeTitle} = require('../src/ShowDetection.js');

const suite = createSuite('Show detection for scans and filename resets', 'unit',
  'Uses the shared production detector for numbered episodes, extras, titles and folder grouping.');

suite.test('detects ordinary filename and season-folder numbering', () => {
  for (const filename of ['Show.S02E03.Title', 'Show 2x03 - Title', '02.03 - Title', 'Season 2 Episode 3 - Title']) {
    const result = detect({folderParts:['Show', 'Season 2']}, filename);
    assert.strictEqual(result.series, 'Show');
    assert.strictEqual(result.season, '2');
    assert.strictEqual(result.episode, '3');
    assert.strictEqual(result.title, 'Title');
  }
  assert.strictEqual(detect({folderParts:['Show','Season 2']}, 'Episode 03 - Title').season, '2');
});

suite.test('recognizes dedicated numbered extras without removing them from the library', () => {
  for (const filename of ['01.01 - The Wand', '02.01 - Graybles Allsorts', 'Show.S02E03.Featurette']) {
    const result = detect({folderParts:['Adventure Time', 'Shorts & Extras']}, filename);
    assert.strictEqual(result.season, 'extras');
    assert(result.episode);
    assert(result.title);
    assert.strictEqual(result.series, 'Adventure Time');
  }
});

suite.test('preserves numbered specials and episodes in mixed season-and-extras folders', () => {
  assert.strictEqual(detect({folderParts:['Show', 'Specials']}, 'S00E01 - Pilot').season, '0');
  assert.strictEqual(detect({folderParts:['Show', 'Season 1 + Extras']}, 'S01E02 - Episode Title').season, '1');
  assert.strictEqual(detect({folderParts:['Show', 'Season 1 + Extras']}, 'Making Of').season, 'extras');
});

suite.test('does not mistake the actual series name Extras for a bonus folder', () => {
  const result = detect({folderParts:['Extras', 'Season 1']}, 'Extras S01E01 - Ben Stiller');
  assert.strictEqual(result.series, 'Extras');
  assert.strictEqual(result.season, '1');
});

suite.test('retains the established ER, Heroes and Kung Fu scan inputs', () => {
  assert.strictEqual(findEpisodeTitle('er.s02e09.home.fs', false), 'Home FS');
  assert.strictEqual(findEpisodeTitle('Heroes S01E01 Genesis (1080p x265 Joy)', false), 'Genesis');
  const result = detect({folderParts:['Kung Fu 1972-1975 (complete original TV series in MP4 format)']},
    'KungFu S1E06 -The Soul Is The Warrior');
  assert.strictEqual(result.series, 'Kung Fu');
  assert.strictEqual(result.title, 'The Soul Is The Warrior');
});

suite.test('preserves untitled fallbacks, meaningful punctuation and multipart labels', () => {
  assert.strictEqual(findEpisodeTitle('Episode 01', false), 'Episode 01');
  assert.strictEqual(findEpisodeTitle('Show S01E01 - Pilot Pt.2', false), 'Pilot Pt.2');
  assert.strictEqual(findEpisodeTitle('Show S01E01 - 11.22.63', false), '11.22.63');
});

runSuite(suite);
