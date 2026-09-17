const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,catalog,loadSearch} = require('./helpers/OmdbFixtures');
const Match = require('../src/tagging/EpisodeMatch');
const Annotations = require('../src/tagging/EpisodeTitleAnnotations');
const recorded = require('./fixtures/fix82-title-annotations.json');
const suite=createSuite('Episode title annotations and correction boundaries','integration',
  'Recorded title pairs and real episode decisions preserve originals, parts and numbering while handling explicit catalog annotations.');
const NAME='Silver Observatory', PARENT='tt1000001';
const input=(title,n=1) => show({series:NAME,title,season:'1',episode:String(n),filename:`/Shows/${NAME}/Season 1/${n}.mkv`});

suite.test('all 30 recorded annotation-only mismatches gain exact core agreement',()=>{
  const exact=recorded.pairs.filter(p=>Match.episodeTitlesMatch(p.local,p.catalog,p.series));
  assert.strictEqual(exact.length,30);
  assert.strictEqual(exact.filter(p=>p.series==='Quantum Leap').length,11);
  for (const p of exact) {
    const comparison=Match.episodeTitleComparison(p.local,p.catalog,p.series);
    assert.strictEqual(comparison.basis,'catalog-title-annotation',p.local);
    assert.strictEqual(comparison.annotations.local.original,p.local);
    assert.strictEqual(comparison.annotations.catalog.original,p.catalog);
    assert.strictEqual(Match.assessEpisodeTitle(p.local,p.catalog,p.series).state,'compatible',p.local);
  }
  for (const p of recorded.pairs.filter(p=>!exact.includes(p))) {
    assert.strictEqual(Match.episodeTitlesMatch(p.local,p.catalog,p.series),false,p.local);
  }
});

suite.test('calendar annotations require a real separated date and cannot erase ordinary title text',()=>{
  assert.strictEqual(Annotations.parse('Home - February 29, 2000').core,'Home');
  assert.strictEqual(Annotations.parse('Home (No. 084)').core,'Home');
  assert.strictEqual(Annotations.parse('Home (Number 84)').annotations[0].value,'84');
  assert.strictEqual(Annotations.parse('Home (No. 84) - January 1, 2000').core,'Home');
  for (const title of ['February 29, 2000','Home February 29, 2000','Home - February 29, 1900',
    'Home - April 31, 2000','Home - January 0, 2000','Home - October 14','Home (U.S. Version)',
    'Home (Extended Edition)','Home (1)','Home Part II','Home No. 84','(No. 84)']) {
    assert.strictEqual(Annotations.parse(title).core,title,title);
  }
});

suite.test('conflicting explicit annotations and different parts remain contrary evidence',()=>{
  for (const [local,remote] of [
    ['Home (No. 84)','Home (No. 85)'],
    ['Home - October 14, 1964','Home - October 15, 1964'],
    ['Home Part I','Home Part II (No. 84)'],
    ['Home (1) - January 1, 2000','Home (2) - January 2, 2000']
  ]) {
    assert.strictEqual(Match.episodeTitlesMatch(local,remote,NAME),false);
    assert.strictEqual(Match.assessEpisodeTitle(local,remote,NAME).state,'contradiction');
  }
  assert(Match.episodeTitlesMatch('Home Part I','Home (1) (No. 84)',NAME));
  assert(Match.episodeTitlesMatch('Home (No. 084)','Home (Number 84)',NAME));
  assert(!Match.episodeTitlesMatch('Pilot (U.S. Version)','Pilot',NAME));
  assert(!Match.episodeTitlesMatch('Home (Extended Edition)','Home (No. 84)',NAME));
});

suite.test('repeated series prefixes and title annotations use the same strict and fuzzy interpretation',()=>{
  assert(Match.episodeTitlesMatch(`${NAME} Arrival`,'Arrival (No. 84)',NAME));
  const fuzzy=Match.assessEpisodeTitle(`${NAME} Arrivall`,'Arrival - October 14, 1964',NAME);
  assert.strictEqual(fuzzy.state,'compatible');
  assert.strictEqual(fuzzy.normalization,'repeated-series-prefix');
  assert.strictEqual(fuzzy.annotations.catalog.core,'Arrival');
  assert(!Match.episodeTitlesMatch(`${NAME} Arrivall`,'Arrival - October 14, 1964',NAME));
  assert(Match.episodeTitlesMatch('Dark Matter','Dark Matter (No. 84)','Dark'));
  assert.strictEqual(Match.assessEpisodeTitle('Dark Matter','Dark Matter (No. 84)','Dark').comparedTitle,'Dark Matter');
  assert.strictEqual(Match.assessEpisodeTitle('Loglady','Story (No. 84)',NAME).state,'contradiction');
});

suite.test('annotation evidence and original titles survive actual acceptance and saved-parent refresh',async()=>{
  const row=episode('Arrival (No. 84)'), parent=series(PARENT,NAME);
  const fixture=loadSearch(catalog([row],parent));
  const result=await fixture.api.tag(input(`${NAME} Arrival`),{seriesImdbID:PARENT});
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.evidence.original.title,`${NAME} Arrival`);
  assert.strictEqual(result.evidence.titleComparison.annotations.catalog.original,'Arrival (No. 84)');
  assert.strictEqual(result.evidence.titleAssessment.annotations.catalog.annotations[0].value,'84');
  assert.strictEqual(result.evidence.matched.episode,'1');
  const saved=JSON.parse(JSON.stringify(result.video));
  const refreshed=await fixture.api.tag(saved);
  assert.strictEqual(refreshed.status,'matched');
  assert.strictEqual(refreshed.evidence.original.title,`${NAME} Arrival`);
});

suite.test('an exact annotated core permits a unique nearby correction, while fuzzy wording does not',async()=>{
  const rows=[episode('Unrelated Subject',1,1),episode('Arrival (No. 84)',1,2)];
  const responder=catalog(rows,series(PARENT,NAME));
  const exact=await loadSearch(responder).api.tag(input(`${NAME} Arrival`),{seriesImdbID:PARENT});
  assert.strictEqual(exact.status,'matched');
  assert.strictEqual(exact.video.imdbID,rows[1].imdbID);
  assert.strictEqual(exact.evidence.requested.episode,'1');
  assert.strictEqual(exact.evidence.matched.episode,'2');
  const fuzzy=await loadSearch(responder).api.tag(input(`${NAME} Arrivall`),{seriesImdbID:PARENT});
  assert.strictEqual(fuzzy.status,'unmatched');
  assert.notStrictEqual(fuzzy.video?.imdbID,rows[1].imdbID);
});

suite.test('duplicate cores across different nearby distances cannot choose an episode number',async()=>{
  const rows=[episode('Arrival (No. 84)',1,1),episode('Unrelated Subject',1,2),
    episode('Different Story',1,3),episode('Arrival (No. 85)',1,4)];
  const responder=catalog(rows,series(PARENT,NAME));
  const result=await loadSearch(responder).api.tag(input('Arrival',2),{seriesImdbID:PARENT});
  assert.strictEqual(result.status,'unmatched');
  const explicit=await loadSearch(responder).api.tag(input('Arrival (No. 85)',2),{seriesImdbID:PARENT});
  assert.strictEqual(explicit.status,'matched');
  assert.strictEqual(explicit.video.imdbID,rows[3].imdbID);
});

suite.test('fuzzy sanity at the requested position remains available after date normalization',async()=>{
  const row=episode('Arrival - October 14, 1964');
  const result=await loadSearch(catalog([row],series(PARENT,NAME))).api.tag(input('Arrivall'),{seriesImdbID:PARENT});
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.evidence.titleAssessment.reason,'small spelling variation');
  assert.strictEqual(result.evidence.exactTitle,false);
  assert.strictEqual(result.evidence.requested.episode,result.evidence.matched.episode);
});

runSuite(suite);
