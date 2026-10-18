const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,loadSearch,notFound} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const StructureFixture = require('./helpers/SeriesStructureFixture');
const Identity = require('../src/tagging/CatalogIdentity');
const Search = require('../src/tagging/SeriesSearch');
const {buildTaggingReport} = require('../src/tagging/TaggingReport');
const suite = createSuite('Bounded series discovery and recovery','integration',
  'Discovery limits never prove uniqueness; complete-title, named-episode and collection evidence must independently support recovery.');
const parent = (id,title='Test Series',year='2000') => ({...series('',title,year),catalogRef:{provider:'tvdb',id:`series:${id}`}});
const key = Identity.recordKey;
const input = (title,extra={}) => show({title:title || 'Test Series S01E01',filename:'/Shows/Test Series/Season 1/1.mkv',...extra});
const record = (p,title='A Distinctive Opening',extra={}) => ({...episode(title,1,1,key(p)),imdbID:'',
  catalogRef:{provider:'tvdb',id:`episode:${p.catalogRef.id.split(':')[1]}1`},catalogSeriesRef:p.catalogRef,...extra});
const rows = (Search,totalResults='100',catalogHasMore=true) => ({Response:'True',Search,totalResults,catalogHasMore});
function fixture(parents,records,{proof,search,metadata}={}) {
  return q => {
    if(q.s) return search ? search(q) : rows(parents);
    if(q.t) return proof || notFound;
    const p = parents.find(p=>key(p) === q.i);
    if(p && q.Season && !q.Episode) return {Response:'True',Season:q.Season,catalogSeriesRef:p.catalogRef,
      catalogCompleteness:'complete',Episodes:records.filter(r=>r.seriesID===key(p)&&r.Season===q.Season)};
    if(p && q.Episode) return records.find(r=>r.seriesID===key(p)&&r.Season===q.Season&&r.Episode===q.Episode) || notFound;
    return p ? metadata || p : records.find(r=>key(r)===q.i) || notFound;
  };
}
const p=parent(1), named=record(p);

suite.test('total results wins over a stale next-link flag, including the terminal second page',async()=>{
  for(const total of [10,13,19,20]) {
    const f=loadSearch(fixture([p],[named],{search:()=>rows([p],String(total),true)}));
    const result=await f.api.tag(input(named.Title));
    assert.strictEqual(result.status,'matched',JSON.stringify(result));
    assert.strictEqual(f.requests.filter(q=>q.s).length,Math.ceil(total/10));
    assert(!f.requests.some(q=>q.t));
  }
});
suite.test('fallback discovery uses the same terminal-page rule',async()=>{
  const f=loadSearch(fixture([p],[named],{search:q=>q.s==='Test Series' ? rows([p],'10',true) : notFound}));
  const result=await f.api.tag(input(named.Title,{series:'Test.Series Complete'}));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert(!f.requests.some(q=>q.page==='2'));
});
suite.test('a named episode verifies a parent after three broad search pages',async()=>{
  const f=loadSearch(fixture([p],[named]));
  const result=await f.api.tag(input(named.Title));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.deepStrictEqual(result.video.catalogSeriesRef,p.catalogRef);
  assert.strictEqual(result.evidence.parentEvidence.basis,'verified-episode-title');
  assert.strictEqual(result.evidence.parentEvidence.search.complete,false);
  assert.strictEqual(f.requests.filter(q=>q.s).length,3);
});
suite.test('a numbered-only file remains unresolved when the title endpoint gives no completeness evidence',async()=>{
  for(const proof of [undefined,p]) {
    const f=loadSearch(fixture([p],[named],{proof})),result=await f.api.tag(input());
    assert.strictEqual(result.status,'ambiguous');
    assert.strictEqual(result.reason.code,'series-search-incomplete');
    assert.strictEqual(result.choices.length,1);
    assert.strictEqual(result.evidence.seriesSearch.pages,3);
    assert(!f.requests.some(q=>q.Episode));
    assert.strictEqual(f.downloads.length,0);
  }
});
suite.test('unknown continuation preserves uncertainty and records the actual page count',async()=>{
  const f=loadSearch(fixture([p],[named],{search:()=>rows([p],null,null)}));
  const result=await f.api.tag(input());
  assert.strictEqual(result.reason.code,'series-search-incomplete');
  assert.deepStrictEqual(result.evidence.seriesSearch,{complete:false,query:'Test Series',pages:1,reason:'unknown-pagination'});
  assert.strictEqual(Search.hasMore({catalogHasMore:true},1),true);
  assert.strictEqual(Search.hasMore({catalogHasMore:false},1),false);
});
suite.test('complete-title evidence can verify a numbered-only file without claiming a year',async()=>{
  const proof={...p,catalogTitleSearch:{query:'Test Series',complete:true,items:[p]}};
  const f=loadSearch(fixture([p],[named],{proof})),result=await f.api.tag(input());
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.strictEqual(result.evidence.parentEvidence.basis,'complete-title-search');
  assert.strictEqual(result.evidence.parentEvidence.search.complete,true);
});
suite.test('a qualified peer in the complete-title response is not erased by one exact display name',async()=>{
  const other=parent(2,'Test Series (US)','2010');
  const proof={...p,catalogTitleSearch:{query:'Test Series',complete:true,items:[p,other]}};
  const f=loadSearch(fixture([p,other],[named,record(other)],{proof,search:()=>rows([p])}));
  const result=await f.api.tag(input());
  assert.strictEqual(result.status,'ambiguous');
  assert.strictEqual(result.reason.code,'ambiguous-series');
  assert.deepStrictEqual(new Set(result.choices.map(key)),new Set([key(p),key(other)]));
  assert.strictEqual(f.downloads.length,0);
});
suite.test('a complete-title peer can still be selected by independent episode title',async()=>{
  const other=parent(2,'Test Series (US)','2010'),r=record(other,'The Right Opening');
  const proof={...p,catalogTitleSearch:{query:'Test Series',complete:true,items:[p,other]}};
  const f=loadSearch(fixture([p,other],[named,r],{proof,search:()=>rows([p])}));
  const result=await f.api.tag(input(r.Title));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.deepStrictEqual(result.video.catalogSeriesRef,other.catalogRef);
});
suite.test('two candidates with the same episode title stay ambiguous',async()=>{
  const other=parent(2),f=loadSearch(fixture([p,other],[named,record(other,named.Title)]));
  const result=await f.api.tag(input(named.Title));
  assert.strictEqual(result.reason.code,'series-search-incomplete');
  assert.strictEqual(result.choices.length,2);
});
suite.test('Pilot alone cannot identify a series whose candidate set remains incomplete',async()=>{
  const f=loadSearch(fixture([p],[record(p,'Pilot')]));
  const result=await f.api.tag(input('Pilot'));
  assert.strictEqual(result.reason.code,'series-search-incomplete');
  assert(!f.requests.some(q=>q.Episode));
});
suite.test('an explicit premiere year is confirmed against full parent metadata',async()=>{
  const f=loadSearch(fixture([p],[named]));
  const result=await f.api.tag(input(undefined,{series:'Test Series (2000)'}));
  assert.strictEqual(result.status,'matched',JSON.stringify(result));
  assert.strictEqual(result.evidence.parentEvidence.basis,'series-title-and-year');
  assert(f.requests.some(q=>q.i===key(p)&&!q.Season));
});
suite.test('a conflicting full parent year cannot validate the summary year',async()=>{
  const f=loadSearch(fixture([p],[named],{metadata:{...p,Year:'2010'}}));
  assert.strictEqual((await f.api.tag(input(undefined,{series:'Test Series (2000)'}))).reason.code,'series-search-incomplete');
});
suite.test('runtime contradictions still block a named match after bounded discovery',async()=>{
  const f=loadSearch(fixture([p],[named]));
  const result=await f.api.tag(input(named.Title,{metadata:{duration:300}}));
  assert.notStrictEqual(result.status,'matched');
  assert.strictEqual(f.downloads.length,0);
});
suite.test('provider failures remain retryable and cannot stand in for missing competitors',async()=>{
  const other=parent(2),base=fixture([p,other],[named,record(other)]);
  const f=loadSearch(q=>q.i===key(other)&&q.Episode ? Error('offline test unavailable') : base(q));
  const result=await f.api.tag(input(named.Title));
  assert.strictEqual(result.status,'service-error');
  assert.strictEqual(f.downloads.length,0);
});

const {A,B,videosFor,winner,assertNoMatch,assertRequestsReused}=StructureFixture;
function bounded(counts,options) {
  const catalog=StructureFixture.fixture(counts,options);
  return q=>q.s?rows(catalog.parents):catalog.responder(q);
}
suite.test('two fully represented seasons recover a lone bounded candidate regardless of batch order, with cached responses reused',async()=>{
  const videos=videosFor({1:3,2:4});
  for(const order of [videos,[...videos].reverse(),[...videos.slice(3),...videos.slice(0,3)]]) {
    const run=await runAutoTag(order,bounded({[A]:{1:3,2:4}}));
    assert.strictEqual(run.result.statistics.Success,7,JSON.stringify(run.result));
    assert.deepStrictEqual(winner(run),[A]);
    const evidence=run.saved.get('s1e1').taggingEvidence.parentEvidence.support.structure;
    assert.strictEqual(evidence.profile.searchIncomplete,true);
    assert.deepStrictEqual(evidence.verifiedFullSeasons,[1,2]);
    assertRequestsReused(run);
  }
});
suite.test('one season, holes, duplicates or separate collections cannot manufacture two full seasons',async()=>{
  const full=videosFor({1:3,2:4});
  const variations=[videosFor({1:3}),full.filter(v=>v.id!=='s2e2'),
    full.filter(v=>v.id!=='s2e2').flatMap(v=>[v,{...v,id:v.id+'copy'}]),
    full.map(v=>v.season==='2'?{...v,filename:v.filename.replace('/Shows/','/Elsewhere/')}:v)];
  for(const videos of variations) assertNoMatch(await runAutoTag(videos,bounded({[A]:{1:3,2:4}})));
});
suite.test('partial, unknown, sparse or malformed catalog seasons cannot supply a complete count',async()=>{
  for(const transform of [data=>({...data,catalogCompleteness:'partial'}),data=>({...data,catalogCompleteness:'unknown'}),
    data=>({...data,Episodes:data.Episodes.slice(1)}),data=>({...data,Episodes:[...data.Episodes,{Episode:'2',imdbID:'tt9999999'}]})]) {
    assertNoMatch(await runAutoTag(videosFor({1:3,2:4}),bounded({[A]:{1:3,2:4}},
      {list:(q,data)=>q.Season==='2'?transform(data):data})));
  }
});
suite.test('known matching competitors and contradictory season bounds still block structural recovery',async()=>{
  for(const counts of [{[A]:{1:3,2:4},[B]:{1:3,2:4}}, {[A]:{1:3,2:3}}])
    assertNoMatch(await runAutoTag(videosFor({1:3,2:4}),bounded(counts)));
});
suite.test('the report describes one unresolved candidate without pretending there were multiple matches',async()=>{
  const result=await loadSearch(fixture([p],[named])).api.tag(input());
  const report=buildTaggingReport({taggingDecision:result});
  assert(JSON.stringify(report).includes('only one plausible candidate'));
});
runSuite(suite);
