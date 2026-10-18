const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,loadSearch,notFound} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const Identity = require('../src/tagging/CatalogIdentity');
const SeriesIdentity = require('../src/tagging/SeriesIdentity');
const EpisodeMatch = require('../src/tagging/EpisodeMatch');
const Policy = require('../src/tagging/MatchPolicy');
const SeriesSearch = require('../src/tagging/SeriesSearch');
const suite = createSuite('TVDB matching regressions','integration',
  'Exercises observed run-02 failure shapes with deterministic provider-native fixtures, including rejection cases.');
const parent = (id,title,year,aliases=[]) => ({...series('',title,year),catalogRef:{provider:'tvdb',id:`series:${id}`},catalogAliases:aliases});
const key = Identity.recordKey;
const ep = (parent,id,title,number,extra={}) => ({...episode(title,1,number,key(parent)),imdbID:'',
  catalogRef:{provider:'tvdb',id:`episode:${id}`},catalogSeriesRef:parent.catalogRef,...extra});
const input = (seriesName,number,title,extra={}) => show({id:`e${number}`,series:seriesName,season:'1',episode:String(number),
  title:title || `${seriesName} S01E${String(number).padStart(2,'0')}`,filename:`/Shows/${seriesName}/s01e${number}.mkv`,...extra});
const rows = Search => ({Response:'True',Search,totalResults:String(Search.length)});
function catalog(parents,episodes,{completeness='complete'}={}) {
  return query => {
    if (query.s) return rows(parents);
    const p = parents.find(row=>key(row)===query.i);
    if (p && query.Season && query.Episode === undefined) return {Response:'True',Season:query.Season,
      catalogSeriesRef:p.catalogRef,catalogCompleteness:completeness,
      Episodes:episodes.filter(row=>row.seriesID===key(p) && row.Season===query.Season)};
    if (p && query.Episode !== undefined) return episodes.find(row=>row.seriesID===key(p) && row.Season===query.Season && row.Episode===query.Episode) || notFound;
    return p || episodes.find(row=>key(row)===query.i) || notFound;
  };
}

suite.test('numeric and region-qualified series remain peers of exact display titles', () => {
  const seven = [parent(1,'Seven Days','2019'),parent(2,'7 Days','1998')];
  assert.strictEqual(SeriesIdentity.matchingSeriesResults('Seven Days',null,seven).candidates.length,2);
  const euphoria = [parent(3,'Euphoria','2011'),parent(4,'Euphoria (US)','2019'),parent(5,'Euphoria (2012)','2012')];
  assert.strictEqual(SeriesIdentity.matchingSeriesResults('Euphoria',null,euphoria).candidates.length,3);
  assert.deepStrictEqual(SeriesIdentity.matchingSeriesResults('Euphoria', '2019',euphoria).candidates,[euphoria[1]]);
  assert.deepStrictEqual(SeriesIdentity.matchingSeriesResults('Euphoria (US)',null,euphoria).candidates,[euphoria[1]]);
});
suite.test('a real episode title selects 7 Days instead of the exact-title 2019 series',async () => {
  const wrong = parent(363275,'Seven Days','2019'), right = parent(74540,'7 Days','1998');
  const fixture = loadSearch(catalog([wrong,right],[ep(wrong,11,'Episode 3',3),ep(right,10,'The Gettysburg Virus',3)]));
  const result = await fixture.api.tag(input('Seven Days',3,'The Gettysburg Virus'));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.deepStrictEqual(result.video.catalogSeriesRef,right.catalogRef);
});
suite.test('numbered-only Euphoria cannot silently select the unqualified anime',async () => {
  const wrong = parent(466268,'Euphoria','2011'), right = parent(360261,'Euphoria (US)','2019');
  const fixture = loadSearch(catalog([wrong,right],[ep(wrong,10,'Anime Chapter',3,{Runtime:'N/A'}),ep(right,11,'Made You Look',3)]));
  const result = await fixture.api.tag(input('Euphoria',3));
  assert.strictEqual(result.status,'ambiguous');
  assert.strictEqual(result.choices.length,2);
  assert.strictEqual(fixture.downloads.length,0);
});
suite.test('series search checks later pages before claiming uniqueness',async () => {
  const first = parent(1,'Test Series','2000'), second = parent(2,'Test Series (US)','2010');
  const lookup = catalog([first,second],[ep(first,1,'Other',1),ep(second,2,'Arrival',1)]);
  const fixture = loadSearch(query => query.s ?
    {Response:'True',Search:query.page==='2' ? [second] : [first],totalResults:'11',catalogHasMore:query.page!=='2'} : lookup(query));
  const result = await fixture.api.tag(input('Test Series',1,'Arrival'));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.deepStrictEqual(result.video.catalogSeriesRef,second.catalogRef);
  assert(fixture.requests.some(query=>query.page==='2'));
});
suite.test('a bounded incomplete series search cannot authorize a unique match',async () => {
  const p = parent(1,'Test Series','2000');
  const fixture = loadSearch(query => query.s ? {Response:'True',Search:[p],totalResults:'100',catalogHasMore:true} : notFound);
  const result = await fixture.api.tag(input('Test Series',1));
  assert.strictEqual(result.status,'ambiguous');
  assert.strictEqual(fixture.requests.filter(query=>query.s).length,3);
});
suite.test('a filename acronym and matching dated folder retain the specific series context', () => {
  const video = input('Ghost in the Shell',1,'Section-9',{
    filename:'/Shows/Ghost in the Shell/b. STAND Alone COMPLEX (2002-06)/1a. 1st Gig/Ghost in the Shell (S.A.C) - S01 E01 - Section-9.mkv'});
  assert.deepStrictEqual(SeriesIdentity.seriesSearchPartsForVideo(video),{
    title:'Ghost in the Shell: STAND Alone COMPLEX',year:'2002',yearSource:'qualified series folder'});
  assert.strictEqual(SeriesIdentity.seriesSearchPartsForVideo({...video,series:'Edited Show'}).title,'Edited Show');
  assert.strictEqual(SeriesIdentity.seriesSearchPartsForVideo({...video,filename:video.filename.replace('S.A.C','X.Y.Z')}).title,'Ghost in the Shell');
});
suite.test('provider series aliases participate in primary discovery',async () => {
  const p = parent(1,'Canonical Show','2000',['Alternate Show']);
  const fixture = loadSearch(catalog([p],[ep(p,1,'Arrival',1)]));
  assert.strictEqual((await fixture.api.tag(input('Alternate Show',1,'Arrival'))).status,'matched');
});
suite.test('an explicit regional series works without IMDb while conflicting year or cross-reference still rejects', () => {
  const p = parent(73244,'The Office','2005');
  assert.strictEqual(SeriesSearch.regionRejection({title:'The Office (US)'},p),null);
  assert(SeriesSearch.regionRejection({title:'The Office (US)'},{...p,Year:'2001'}));
  assert(SeriesSearch.regionRejection({title:'The Office (US)'},{...p,imdbID:'tt0290978'}));
});
suite.test('serial part placement agrees without discarding story or part identity', () => {
  const local = 'An Unearthly Child Pt 4 The Firemaker';
  assert(EpisodeMatch.episodeTitlesMatch(local,'An Unearthly Child: The Firemaker (4)','Doctor Who'));
  assert(EpisodeMatch.episodeTitlesMatch(local,'The Firemaker','Doctor Who'));
  assert(!EpisodeMatch.episodeTitlesMatch(local,'An Unearthly Child: The Firemaker (3)','Doctor Who'));
  assert(!EpisodeMatch.episodeTitlesMatch(local,'Different Story: The Firemaker (4)','Doctor Who'));
  assert.strictEqual(EpisodeMatch.assessEpisodeTitle(local,'An Unearthly Child: The Firemaker (3)','Doctor Who').state,'contradiction');
});
suite.test('Doctor Who serial titles pass through the complete tagging workflow',async () => {
  const p = parent(76107,'Doctor Who','1963');
  const fixture = loadSearch(catalog([p],[ep(p,183208,'An Unearthly Child: The Firemaker (4)',4)]));
  const result = await fixture.api.tag(input('Doctor Who',4,'An Unearthly Child Pt 4 The Firemaker'));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.strictEqual(result.evidence.original.title,'An Unearthly Child Pt 4 The Firemaker');
});
for (const pair of require('./fixtures/TvdbRun02SerialTitles.json').cases) {
  suite.test(`recorded serial title: ${pair.local}`, () => {
    const local = EpisodeMatch.usefulEpisodeTitle(pair.local,pair.series);
    assert(EpisodeMatch.episodeTitlesMatch(local,pair.catalog,pair.series),JSON.stringify(pair));
    assert.strictEqual(EpisodeMatch.assessEpisodeTitle(pair.local,pair.catalog,pair.series).state,'compatible');
    const differentPart = pair.catalog.replace(/\((\d+)\)$/,(_,number)=>`(${Number(number)+1})`);
    if (differentPart !== pair.catalog) assert(!EpisodeMatch.episodeTitlesMatch(local,differentPart,pair.series));
  });
}
suite.test('a unique full-season title recovers an episode outside the nearby window',async () => {
  const p = parent(76321,'Freaks and Geeks','1999');
  const records = [ep(p,1,'Other Story',4),ep(p,2,'Kim Kelly Is My Friend',16)];
  const fixture = loadSearch(catalog([p],records));
  const result = await fixture.api.tag(input('Freaks and Geeks',4,'Kim Kelly Is My Friend'));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.strictEqual(result.video.episode,'4');
  assert.strictEqual(result.evidence.matched.episode,'16');
  assert(result.evidence.correctionChecks.some(check=>check.kind==='season-title' && check.outcome==='selected'));
  assert.strictEqual(fixture.requests.filter(q=>q.i===key(p) && q.Season && q.Episode===undefined).length,1);
});
for (const scenario of ['duplicate','partial','different-parent']) suite.test(`full-season correction rejects ${scenario} evidence`,async () => {
  const p = parent(1,'Test Series','2000'), target = ep(p,2,'Arrival',16);
  const records = [ep(p,1,'Other Story',4),target,...(scenario==='duplicate' ? [ep(p,3,'Arrival',18)] : [])];
  const lookup = catalog([p],records,{completeness:scenario==='partial' ? 'partial' : 'complete'});
  const fixture = loadSearch(query=>scenario==='different-parent' && query.i===key(target) ?
    {...target,catalogSeriesRef:{provider:'tvdb',id:'series:99'},seriesID:'tvdb:series:99'} : lookup(query));
  assert.notStrictEqual((await fixture.api.tag(input('Test Series',4,'Arrival'))).status,'matched');
});
suite.test('a missing zero blocks numbered-only siblings regardless of batch order, while named files remain usable',async () => {
  const p = parent(70533,'Twin Peaks','1990');
  const records = [ep(p,1,'Northwest Passage',1,{Runtime:'94 min'}),ep(p,2,'Traces to Nowhere',2),ep(p,3,'Zen',3),
    ep(p,4,'Other Story',4),ep(p,5,'Return',1,{Season:'2'})];
  const videos = [input('Twin Peaks',0,'Pilot (U.S. Version)',{metadata:{duration:94*60}}),
    input('Twin Peaks',1),input('Twin Peaks',2),input('Twin Peaks',1,'Return',{id:'named',season:'2'})];
  for (const selected of [videos,[...videos].reverse()]) {
    const run = await runAutoTag(selected,catalog([p],records));
    assert.strictEqual(run.result.statistics.Success,1,JSON.stringify([...run.saved.values()]));
    assert.strictEqual(run.saved.get('e2').taggingDecision.reason.code,'unverified-episode-order');
    assert.deepStrictEqual(run.saved.get('named').catalogRef,records[4].catalogRef);
    const retry = await loadSearch(catalog([p],records)).api.tag(run.saved.get('e2'));
    assert.strictEqual(retry.status,'unmatched');
    assert.strictEqual(retry.reason.code,'unverified-episode-order');
    const batchRetry = await runAutoTag([run.saved.get('e2')],catalog([p],records));
    assert.strictEqual(batchRetry.saved.get('e2').taggingDecision.reason.code,'unverified-episode-order');
  }
});
suite.test('a real catalog episode zero does not block a correctly numbered season',async () => {
  const p = parent(1,'Test Series','2000');
  const run = await runAutoTag([input('Test Series',0,'Pilot'),input('Test Series',1)],
    catalog([p],[ep(p,1,'Pilot',0),ep(p,2,'Arrival',1)]));
  assert.strictEqual(run.result.statistics.Success,2);
});
const movie = (Title,Year,Runtime='90 min',extra={}) => ({Response:'True',Type:'movie',Title,Year,Runtime,Poster:'N/A',
  imdbID:'',catalogRef:{provider:'tvdb',id:'movie:1'},Ratings:[],...extra});
const film = (title,year='2000',duration=90) => show({kind:'movie',series:'',season:'',episode:'',title,year,
  filename:`/Movies/${title}.mkv`,metadata:{duration:duration*60}});
suite.test('a search alias survives fetching details and final acceptance',async () => {
  const full = movie('Appleseed α','2000'), summary = {...full,catalogAliases:['Appleseed Alpha']};
  const fixture = loadSearch(query=>query.s ? rows([summary]) : query.i ? full : notFound);
  const result = await fixture.api.tag(film('Appleseed Alpha'));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.strictEqual(result.video.title,'Appleseed α');
  assert.strictEqual(result.evidence.movieAssessment.providerAlias,'Appleseed Alpha');
});
suite.test('an expanded title still needs a provider alias, and aliases cannot override years', () => {
  const candidate = {title:'Harry Potter and the Sorcerers Stone',year:'2001'};
  const record = movie("Harry Potter and the Philosopher's Stone",'2001','150 min');
  const video = film(candidate.title,'2001',150);
  assert(!Policy.evaluateMovie(record,candidate,video,{}).confident);
  assert(Policy.evaluateMovie({...record,catalogAliases:[candidate.title]},candidate,video,{}).confident);
  assert(!Policy.evaluateMovie({...record,Year:'2020',catalogAliases:[candidate.title]},candidate,video,{}).confident);
});
suite.test('dropping a franchise subtitle cannot select the first film',async () => {
  const title = 'Star Wars - 5 - Empire Strikes Back - Despecialized Edition 2.0', record = movie('Star Wars','1977','121 min');
  const fixture = loadSearch(query=>query.s==='Star Wars' ? rows([record]) : query.i ? record : notFound);
  assert.notStrictEqual((await fixture.api.tag(film(title,'',126.4))).status,'matched');
});
suite.test('a descriptive bonus filename cannot inherit the containing movie identity',async () => {
  const record = movie('Shame','2018','24 min');
  const fixture = loadSearch(query=>query.s==='Shame' ? rows([record]) : query.i ? record : notFound);
  assert.notStrictEqual((await fixture.api.tag({...film('In Search of Humanity','',18.6),
    filename:'/Movies/Shame/In Search of Humanity.avi'})).status,'matched');
});
suite.test('a different production year stays manual even when runtimes are similar', () => {
  const result = Policy.evaluateMovie(movie('Peter Pan','1962','112 min'),{title:'Peter Pan',year:'1960'},film('Peter Pan','1960',100.873),
    {allowDistantYear:true,maxYearDifference:3});
  assert.strictEqual(result.confident,false);
  assert.strictEqual(result.policyReason,'unverified-release-year');
});
suite.test('a two-letter movie title without runtime evidence cannot auto-select an unrelated production',async () => {
  const record = movie('It','1990','N/A'), fixture = loadSearch(query=>query.s ? rows([record]) : record);
  assert.notStrictEqual((await fixture.api.tag(film('It','1990',179.7))).status,'matched');
});
suite.test('double-length files still cannot be tagged as just the first half',async () => {
  const p = parent(1,'Seinfeld','1989');
  const fixture = loadSearch(catalog([p],[ep(p,1,'The Boyfriend (1)',17,{Runtime:'25 min'})]));
  const result = await fixture.api.tag(input('Seinfeld',17,'The Boyfriend',{metadata:{duration:46.55*60}}));
  assert.strictEqual(result.status,'unmatched');
  assert.strictEqual(result.reason.code,'episode-coverage-mismatch');
});
runSuite(suite);
