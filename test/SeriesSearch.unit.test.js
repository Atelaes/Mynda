const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const Search = require('../src/tagging/SeriesSearch.js');
const suite = createSuite('Conservative series discovery queries', 'unit',
  'Checks complete title identity, reviewed aliases, annotations, and bounded queries without network access.');

const annotations = [
  ['The.Office.US.Complete.Series.+Extras.720p.BrRip.EN-SUB.x264-[MULVAcoded]', 'The Office US', null],
  ['MST3K - Complete 35 DVD Collection', 'MST3K', null],
  ['House MD Season 1, 2, 3, 4, 5, 6, 7 & 8 + Extras DVDRip TSV', 'House MD', null],
  ["Family Guy - season's 1-9", 'Family Guy', null],
  ['News Radio 1995-1999 (Complete TV series in MP4 format)', 'News Radio', '1995'],
  ['The Sopranos - The Complete Series (Season 1, 2, 3, 4, 5 & 6) + Extras', 'The Sopranos', null],
  ['DanMachi [Season 1 + 2 + 3 + 4 + OVA + Recaps + Movie] [BD 1080p x265]', 'DanMachi', null],
  ['AEON FLUX (1991-1995) - Complete Animated TV Series and 2005 Movie - 1080p x264', 'AEON FLUX', '1991'],
  ['Wonder Showzen Complete (640x480) [Phr0stY]', 'Wonder Showzen', null],
  ['Generation War (2013) 720p BluRay x265 HEVC SUJAIDR', 'Generation War', '2013']
];
for (const [title, expected, year] of annotations) suite.test(`query annotation: ${expected}`, () => {
  assert.deepStrictEqual(Search.cleanSeriesInput({title}), {title:expected,year});
  assert(Search.buildQueries({title}).length <= Search.MAX_QUERIES);
});

suite.test('keeps meaningful titles, region labels and an explicit year', () => {
  for (const title of ['Complete Savages','Extras','Season of Love','The Office UK','11.22.63','The Killing (US)']) {
    assert.strictEqual(Search.cleanSeriesInput({title}).title,title);
  }
  assert.strictEqual(Search.cleanSeriesInput({title:'The Office US (2005)',year:'2020'}).year,'2020');
});

suite.test('recognizes only complete reviewed aliases, including mixed case', () => {
  for (const [input, expected] of [['mst3k','Mystery Science Theater 3000'],['SATC','Sex and the City'],
    ['DanMachi','Is It Wrong to Try to Pick Up Girls in a Dungeon?'],['Generation War','Unsere Mütter, unsere Väter']]) {
    assert(Search.buildQueries({title:input}).some(q=>q.title===expected),input);
  }
  assert(!Search.buildQueries({title:'DanMachi Sword Oratoria'}).some(q=>q.title==='Is It Wrong to Try to Pick Up Girls in a Dungeon?'));
});

suite.test('tries spacing, diacritic, ligature and dotted-initial variations', () => {
  for (const [input, expected] of [['News Radio','NewsRadio'],['Æon Flux','AEon Flux'],['E.R..R','ER']]) {
    assert(Search.buildQueries({title:input}).some(q=>q.title===expected),input);
  }
  assert.strictEqual(Search.titleKey('Æon Flux'),Search.titleKey('Aeon Flux'));
});

suite.test('never accepts a partial title, a spin-off, a different type or year', () => {
  const query=Search.buildQueries({title:'Seaquest DSV',year:'1993'})[0];
  const right={Title:'seaQuest DSV',Type:'series',Year:'1993–1996',imdbID:'tt0106126'};
  assert.strictEqual(Search.candidateRejection(query,right),null);
  for (const changes of [{Title:'Seaquest'}, {Title:'Seaquest DSV Origins'}, {Type:'movie'}, {Year:'2020'}, {imdbID:'garbage'}]) {
    assert(Search.candidateRejection(query,{...right,...changes}));
  }
});

suite.test('the US Office alias cannot select a different adaptation', () => {
  const query=Search.buildQueries({title:'The Office US'}).find(q=>q.title==='The Office');
  assert.strictEqual(Search.candidateRejection(query,{Title:'The Office',Type:'series',Year:'2005–2013',imdbID:'tt0386676'}),null);
  assert(Search.candidateRejection(query,{Title:'The Office',Type:'series',Year:'2001–2003',imdbID:'tt0290978'}));
});

runSuite(suite);
