const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {notFound,loadSearch,episode} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const {NAME,A,B,C,range,input,videosFor,fixture,winner,assertNoMatch,assertRequestsReused} = require('./helpers/SeriesStructureFixture');
const {scopeFor} = require('../src/tagging/SeriesCollection');
const {createEvidence} = require('../src/tagging/BatchEvidence');
const Structure = require('../src/tagging/SeriesStructure');
const Limits = require('../src/tagging/TaggingLimits');
const recorded = require('./fixtures/fix82-series-observations.json');
const suite=createSuite('Incomplete catalog evidence and release collections','integration',
  'Recorded parent observations and real batch tests for unknown counts, season inference, candidate breadth, release suffixes and zero-based numbering.');
const noAlternateLists={list:(q,data)=>q.i===B?notFound:data};
const assessment=video => video.taggingEvidence?.parentEvidence?.support?.structure ||
  video.taggingDecision?.evidence?.structureAssessment?.structure;

suite.test('known distribution suffixes join season folders under their verified series collection',()=>{
  const root=`/Shows/${NAME}`;
  for (const suffix of ['2160p.UHD.BluRay.x265-DEPTH[rartv]',
    '2160p.UHD.BluRay.x265-SCOTLUHD[rartv]','1080p.WEB-DL[eztv.re]','1080p.WEB-DL[TGx]',
    '1080p.PCOK.WEBRip.DDP5.1.x264-AGLET[rartv]']) {
    const folder=`${NAME.replace(/ /g,'.')}.S01.${suffix}`;
    const scope=scopeFor(input(1,1,{filename:`${root}/${folder}/episode.mkv`}));
    assert.strictEqual(scope.root,root,suffix);
    assert.strictEqual(scope.directory,`${root}/${folder}`);
  }
  for (const suffix of ['1080p[Unknown Edition]','US','fan edit','2020','1080p.DDP5.1.Fan.Edit','1080p.5.1']) {
    const folder=`${NAME}.S01.${suffix}`;
    assert.strictEqual(scopeFor(input(1,1,{filename:`${root}/${folder}/episode.mkv`})).root,`${root}/${folder}`);
  }
});

suite.test('recorded Band of Brothers inputs now contribute a provisional complete first season',()=>{
  const item=recorded.inputCases.find(c=>c.series==='Band of Brothers');
  const profile=Structure.profileFor(item.members);
  assert(profile.inferredSeason);
  assert.deepStrictEqual(profile.seasons,[{season:1,positions:range(10),maxEpisode:10}]);
  assert(item.members.every(v=>v.season===''));
});

suite.test('recorded Dr Death named witnesses now resolve its other season across release labels',()=>{
  const item=recorded.inputCases.find(c=>c.series==='Dr Death');
  for (const members of [item.members,[...item.members].reverse()]) {
    const ledger=createEvidence(members);
    for (const witness of item.savedMatches) {
      const video=members.find(v=>v.id===witness.inputID);
      ledger.observe(video,{status:'matched',video:witness.tagged,evidence:{kind:'episode',original:video,
        parentEvidence:{basis:witness.parentBasis},requested:{season:video.season,episode:video.episode},
        matched:{season:witness.tagged.season,episode:witness.tagged.episode}}});
    }
    for (const video of members.filter(v=>v.season==='2')) {
      const parent=ledger.parentFor(video,{status:'ambiguous',reason:{code:'ambiguous-series'}});
      assert(parent,video.title);
      assert.strictEqual(parent.seriesID,'tt9179552');
      assert(parent.evidence.length>=1);
      assert(parent.evidence.every(a=>a.localSeason==='1'));
    }
  }
});

suite.test('recorded Stranger Things, Euphoria and Twin Peaks observations select the expected parents',()=>{
  for (const item of recorded.cases) {
    for (const members of [item.members,[...item.members].reverse()]) {
      const collection=members.filter(v=>scopeFor(v)?.root===`/Shows/${item.series}`);
      const profile=Structure.profileFor(collection);
      assert(profile,item.series);
      assert.strictEqual(Structure.assess(profile,item.observations).selectedID,item.expectedParent,item.series);
      assert.deepStrictEqual(profile.seasons.map(s=>s.maxEpisode),item.series==='Twin Peaks'?[7,22]:item.series==='Euphoria'?[8,8]:[8,9]);
      if (item.series==='Twin Peaks') {
        assert.deepStrictEqual(profile.numberingScopes.map(s=>s.positions.length),[8,22]);
        assert.strictEqual(profile.seasons.reduce((n,s)=>n+s.positions.length,0),29,'Pilot zero is order evidence; 53 extras and all 30 clips are excluded');
      }
    }
  }
});

suite.test('a later season resolves all unnamed seasons despite different release suffixes in every order',async()=>{
  const videos=videosFor({1:8,2:9}).map(v=>({...v,filename:
    `/Shows/${NAME}/${NAME}.S0${v.season}.2160p.UHD.BluRay.x265-${v.season==='1'?'DEPTH':'SCOTLUHD'}[rartv]/${v.episode}.mkv`}));
  const catalog=fixture({[A]:{1:8,2:9},[B]:{1:8}});
  for (const order of [videos,[...videos].reverse(),videos.filter((_,i)=>i%2).concat(videos.filter((_,i)=>!(i%2)))]) {
    const run=await runAutoTag(order,catalog.responder);
    assert.strictEqual(run.result.statistics.Success,17);
    assert.deepStrictEqual(winner(run),[A]);
    assert.strictEqual(run.result.statistics.seriesStructureChecks,1);
    assert.deepStrictEqual(assessment(run.saved.get('s1e1')).profile.seasons.map(s=>s.season),[1,2]);
    assertRequestsReused(run);
  }
});

suite.test('one complete season supplies positive evidence against an unknown alternative in any order',async()=>{
  const videos=videosFor({1:8}), catalog=fixture({[A]:{1:8},[B]:{1:12}},noAlternateLists);
  for (const order of [videos,[...videos].reverse()]) {
    const run=await runAutoTag(order,catalog.responder);
    assert.strictEqual(run.result.statistics.Success,8);
    const proof=assessment(run.saved.get('s1e1'));
    assert.deepStrictEqual(proof.comparisons,[{alternative:B,basis:'positive-season-count',seasons:[1],alternativeIncomplete:true}]);
    assert.deepStrictEqual(proof.candidates.find(c=>c.seriesID===B).contradictions,[]);
    assertRequestsReused(run);
  }
});

suite.test('a local maximum, an incomplete local season or a nonmatching total does not outweigh unknown counts',async()=>{
  const catalog=fixture({[A]:{1:8},[B]:{1:12}},noAlternateLists);
  for (const videos of [[input(1,8)],videosFor({1:8}).filter(v=>v.episode!=='3'),videosFor({1:7})]) {
    assertNoMatch(await runAutoTag(videos,catalog.responder));
  }
});

suite.test('one known longer season still requires a second distinguishing season even if another is unknown',async()=>{
  const catalog=fixture({[A]:{1:8,2:8},[B]:{1:12,2:12}},{list:(q,data)=>q.i===B && q.Season==='2'?notFound:data});
  assertNoMatch(await runAutoTag(videosFor({1:8,2:8}),catalog.responder));
});

suite.test('every known competitor must be distinguished and a third unknown candidate does not break a tie',async()=>{
  const catalog=fixture({[A]:{1:8},[B]:{1:8},[C]:{1:12}},{list:(q,data)=>q.i===C?notFound:data});
  assertNoMatch(await runAutoTag(videosFor({1:8}),catalog.responder));
});

suite.test('a contradiction in a later season vetoes an otherwise exact positive count',async()=>{
  const catalog=fixture({[A]:{1:8,2:5},[B]:{1:12,2:12}},noAlternateLists);
  assertNoMatch(await runAutoTag(videosFor({1:8,2:8}),catalog.responder));
});

suite.test('malformed metadata, mismatched lists and conflicting rows are not treated as harmless absence',async()=>{
  for (const options of [
    {metadata:p=>p.imdbID===B?{...p,Title:'A Different Identity'}:p},
    {list:(q,d)=>q.i===B?{...d,Season:'9'}:d},
    {list:(q,d)=>q.i===B?{...d,imdbID:C}:d},
    {list:(q,d)=>q.i===B?{...d,Episodes:[...d.Episodes,{Episode:'1',imdbID:'tt666'}]}:d}
  ]) assertNoMatch(await runAutoTag(videosFor({1:8}),fixture({[A]:{1:8},[B]:{1:12}},options).responder));
});

suite.test('a mismatched boundary response is invalid evidence rather than a missing season',async()=>{
  const catalog=fixture({[A]:{1:8},[B]:{1:8}},{
    list:(q,d)=>q.i===B?{...d,Episodes:d.Episodes.slice(0,4)}:d,
    record:(q,r)=>r && q.i===B && q.Episode==='8'?{...r,seriesID:C}:r || notFound});
  const run=await runAutoTag(videosFor({1:8}),catalog.responder);
  assertNoMatch(run);
  assert(assessment(run.saved.get('s1e1')).candidates.find(c=>c.seriesID===B).seasons[0].invalid);
});

suite.test('service failures do not become unknown alternatives or positive count evidence',async()=>{
  const run=await runAutoTag(videosFor({1:8}),fixture({[A]:{1:8},[B]:{1:12}},
    {list:(q,d)=>q.i===B?Error('connection unavailable'):d}).responder);
  assertNoMatch(run);
  assert([...run.saved.values()].every(v=>v.taggingDecision.status==='service-error' && !v.autotag_tried));
});

suite.test('a missing season participates provisionally and only single-season metadata confirms it',async()=>{
  const videos=videosFor({1:10}).map(v=>({...v,season:'',title:`${NAME} ep${v.episode}`,
    filename:`/Shows/${NAME}/ep${v.episode}.mkv`}));
  const catalog=fixture({[A]:{1:10},[B]:{1:12}},noAlternateLists);
  for (const order of [videos,[...videos].reverse()]) {
    const run=await runAutoTag(order,catalog.responder);
    assert.strictEqual(run.result.statistics.Success,10);
    assert.deepStrictEqual(winner(run),[A]);
    for (const saved of run.saved.values()) {
      assert.strictEqual(saved.season,'1');
      assert.strictEqual(saved.taggingEvidence.original.season,'');
      assert(assessment(saved).profile.inferredSeason);
    }
    assertRequestsReused(run);
    assert.strictEqual(run.requests.filter(q=>q.i===A && !q.Season).length,1);
  }
});

suite.test('missing seasons cannot silently default to season one of a multi-season or unverified parent',async()=>{
  const videos=videosFor({1:8}).map(v=>({...v,season:'',title:`${NAME} ep${v.episode}`}));
  for (const totalSeasons of ['2','N/A']) {
    const catalog=fixture({[A]:{1:8},[B]:{1:12}},{...noAlternateLists,
      metadata:p=>p.imdbID===A?{...p,totalSeasons}:p});
    const run=await runAutoTag(videos,catalog.responder);
    assertNoMatch(run);
    assert([...run.saved.values()].every(v=>v.season===''));
  }
});

suite.test('a skipped multi-season alternative cannot masquerade as a catalog gap for an inferred season',async()=>{
  const videos=videosFor({1:8}).map(v=>({...v,season:'',title:`${NAME} ep${v.episode}`}));
  const run=await runAutoTag(videos,fixture({[A]:{1:8},[B]:{1:12,2:12}}).responder);
  assertNoMatch(run);
  assert([...run.saved.values()].every(v=>v.season===''));
});

suite.test('four same-name candidates are screened without widening speculative title searches',async()=>{
  const D='tt7000001', catalog=fixture({[A]:{1:8,2:8},[B]:{1:8},[C]:{1:8},[D]:{1:8}},
    {metadata:p=>p.imdbID===D?{...p,totalSeasons:'N/A'}:p,list:(q,d)=>q.i===D?notFound:d});
  const run=await runAutoTag(videosFor({2:8}),catalog.responder);
  assert.strictEqual(run.result.statistics.Success,8);
  assert.deepStrictEqual(winner(run),[A]);
  for (const id of [A,B,C,D]) assert(run.requests.some(q=>q.i===id && !q.Season),id);
  assert.strictEqual(assessment(run.saved.get('s2e1')).candidates.length,4);
  assert.strictEqual(Limits.series.candidates,3);
  assertRequestsReused(run);
});

suite.test('above the structural limit no candidates are silently dropped and the reason is saved',async()=>{
  const counts=Object.fromEntries(range(Limits.series.structureCandidates+1).map(i=>[`tt${1000000+i}`,{1:8}]));
  const run=await runAutoTag(videosFor({1:8}),fixture(counts).responder);
  assertNoMatch(run);
  const proof=assessment(run.saved.get('s1e1'));
  assert.strictEqual(proof.basis,'structure-candidate-limit');
  assert.strictEqual(proof.candidateCount,11);
  assert.strictEqual(proof.candidateLimit,10);
});

suite.test('broader structural screening still respects the original operation request budget',async()=>{
  const counts=Object.fromEntries(range(10).map(i=>[`tt${1000000+i}`,{1:8}]));
  const run=await runAutoTag(videosFor({1:8}),fixture(counts).responder,{batchOptions:{requestBudgetLimit:15}});
  assertNoMatch(run);
  const errors=[...run.saved.values()].filter(v=>v.taggingDecision.status==='service-error');
  assert(errors.length);
  assert(errors.every(v=>v.taggingDecision.evidence.requestBudget.used<=15));
});

suite.test('resolving a parent cannot silently align a zero-based release with a one-based catalog',async()=>{
  const videos=[input(1,0,{title:'Pilot (U.S. Version)'}),...videosFor({1:7,2:8})];
  const catalog=fixture({[A]:{1:8,2:8},[B]:{1:8}});
  for (const order of [videos,[...videos].reverse()]) {
    const run=await runAutoTag(order,catalog.responder);
    assert.strictEqual(run.result.statistics.Success,8);
    assert.deepStrictEqual(winner(run),[A]);
    const first=run.saved.get('s1e1');
    assert(!first.imdbID);
    assert.strictEqual(first.seriesImdbID,A);
    assert.strictEqual(first.taggingDecision.reason.code,'unverified-episode-order');
    assert.strictEqual(first.taggingDecision.evidence.orderAssessment.numberingEvidence.basis,'different-numbering-origin');
    assert.strictEqual(run.saved.get('s2e1').season,'2');
    const retry=await loadSearch(catalog.responder).api.tag(first);
    assert.strictEqual(retry.status,'unmatched');
    assert.strictEqual(retry.reason.code,'unverified-episode-order','A saved inferred parent must retain its numbering evidence');
  }
});

suite.test('an additional episode zero does not shift a season that already has its full ordinary numbering',async()=>{
  const videos=[input(1,0,{title:'Separate pilot edition'}),...videosFor({1:8,2:8})];
  const run=await runAutoTag(videos,fixture({[A]:{1:8,2:8},[B]:{1:8}}).responder);
  assert.strictEqual(run.result.statistics.Success,16);
  assert(run.saved.get('s1e1').imdbID);
});

suite.test('different numbering origins remain local to each physical release',async()=>{
  const videos=[input(1,0,{title:'Pilot (U.S. Version)'}),...videosFor({1:7,2:8}),
    input(1,1,{id:'other-release',filename:`/Shows/${NAME}/S01/1.mkv`})];
  const run=await runAutoTag(videos,fixture({[A]:{1:8,2:8},[B]:{1:8}}).responder);
  assert.strictEqual(run.result.statistics.Success,9);
  assert(!run.saved.get('s1e1').imdbID);
  assert(run.saved.get('other-release').imdbID);
});

suite.test('an exact title can verify a nonzero position without transferring an unproven offset',async()=>{
  const videos=[input(1,0,{title:'Separate pilot edition'}),...videosFor({1:7,2:8})];
  videos.find(v=>v.id==='s1e2').title='Arrival';
  const catalog=fixture({[A]:{1:8,2:8},[B]:{1:8}},{record:(q,r)=>r?{...r,
    Title:r.Season==='1' && r.Episode==='2'?'Arrival':r.Title}:notFound});
  const run=await runAutoTag(videos,catalog.responder);
  assert(run.saved.get('s1e1').imdbID);
  assert.strictEqual(run.saved.get('s1e1').episode,'1');
  assert(!run.saved.get('s1e0').imdbID);
});

suite.test('selected-series preflight uses the same incomplete-catalog evidence',async()=>{
  const run=await runAutoTag(videosFor({1:8}),fixture({[A]:{1:8},[B]:{1:12}},noAlternateLists).responder,
    {batchOptions:{seriesBatch:{series:NAME},scope:'selected'}});
  assert.strictEqual(run.result.seriesSelectionCanceled,false);
  assert.strictEqual(run.result.statistics.Success,8);
  assert.deepStrictEqual(winner(run),[A]);
  assertRequestsReused(run);
});

runSuite(suite);
