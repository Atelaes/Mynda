const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,notFound,loadSearch} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const Structure = require('../src/tagging/SeriesStructure');
const suite=createSuite('Series structure and numbered episode acceptance','integration',
  'Real batch/engine tests for lower-bound counts, contradictions, incomplete catalogs, duplicates, budgets and title-first resolution.');
const {NAME,A,B,C,range,input,videosFor,fixture,winner,assertNoMatch,assertRequestsReused} = require('./helpers/SeriesStructureFixture');

suite.test('two season totals distinguish the shorter candidate from a partial longer one',async()=>{
  const catalog=fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}), videos=videosFor({1:13,2:13});
  for (const order of [videos,[...videos].reverse(),videos.filter((_,i)=>i%2).concat(videos.filter((_,i)=>!(i%2)))]) {
    const run=await runAutoTag(order,catalog.responder);
    assert.strictEqual(run.result.statistics.Success,26);
    assert.deepStrictEqual(winner(run),[A]);
    const saved=run.saved.get('s1e1'), evidence=saved.taggingEvidence;
    assert.strictEqual(evidence.parentEvidence.basis,'structure-series-selection');
    assert.strictEqual(evidence.parentEvidence.origin,'automatic');
    assert.strictEqual(evidence.parentEvidence.support.structure.comparisons[0].basis,'two-season-counts');
    assert.deepStrictEqual(evidence.parentEvidence.support.structure.comparisons[0].seasons,[1,2]);
    assert.strictEqual(evidence.orderAssessment.basis,'confident-series-numbering');
    assert.strictEqual(run.result.statistics.seriesStructureChecks,1);
    assertRequestsReused(run);
  }
});

suite.test('one matching season total cannot choose the shorter series',async()=>{
  const run=await runAutoTag(videosFor({1:13}),fixture({[A]:{1:13},[B]:{1:22}}).responder);
  assertNoMatch(run);
  assert.strictEqual(run.saved.get('s1e13').taggingDecision.status,'ambiguous');
  assert(run.saved.get('s1e13').taggingDecision.evidence.structureAssessment);
});

suite.test('one observed episode beyond an alternative season total is enough',async()=>{
  const run=await runAutoTag([input(1,22)],fixture({[A]:{1:22},[B]:{1:13}}).responder);
  assert.deepStrictEqual(winner(run),[A]);
  const comparisons=run.saved.get('s1e22').taggingEvidence.parentEvidence.support.structure.comparisons;
  assert.strictEqual(comparisons[0].basis,'exceeds-alternative');
  assert.strictEqual(comparisons[0].contradictions[0].limit,13);
});

suite.test('an observed later season can exclude an explicitly shorter series',async()=>{
  const run=await runAutoTag([input(2,1)],fixture({[A]:{1:10,2:10},[B]:{1:10}}).responder);
  assert.deepStrictEqual(winner(run),[A]);
});

suite.test('a contradiction in another season overrides two matching season counts',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13,3:15}),fixture({[A]:{1:13,2:13,3:10},[B]:{1:22,2:22,3:20}}).responder);
  assert.deepStrictEqual(winner(run),[B]);
  assert.strictEqual(run.result.statistics.Success,41);
});

suite.test('a contradiction is still checked after the two seasons that favor a candidate',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13,3:15}),fixture({[A]:{1:13,2:13,3:10},[B]:{1:22,2:22,3:12}}).responder);
  assertNoMatch(run);
});

suite.test('ties and one distinguishing season among otherwise equal totals remain ambiguous',async()=>{
  for (const counts of [{[A]:{1:13,2:13},[B]:{1:13,2:13}}, {[A]:{1:13,2:13},[B]:{1:13,2:22}}]) {
    assertNoMatch(await runAutoTag(videosFor({1:13,2:13}),fixture(counts).responder));
  }
});

suite.test('every alternative must be distinguished, including a third same-name series',async()=>{
  const counts={[A]:{1:13,2:13},[B]:{1:22,2:22},[C]:{1:13,2:22}};
  assertNoMatch(await runAutoTag(videosFor({1:13,2:13}),fixture(counts).responder));
});

suite.test('duplicate releases, extras and Loglady clips do not inflate structural counts',async()=>{
  const videos=videosFor({1:13,2:13}), duplicate=videos.map(v=>({...v,id:v.id+'copy',
    filename:v.filename.replace('/Season ', '/S')}));
  const extras=[input(1,99,{id:'loglady',title:'Pilot Loglady'}),input(2,99,{id:'extra',season:'extras'}),
    input(2,99,{id:'dvd',dvd:true}),input(2,99,{id:'fraction',episode:'13.5'})];
  const profile=Structure.profileFor([...videos,...duplicate,...extras]);
  assert.deepStrictEqual(profile.seasons.map(s=>[s.season,s.maxEpisode,s.positions.length]),[[1,13,13],[2,13,13]]);
  const run=await runAutoTag([...videos,...duplicate,...extras],fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}).responder);
  assert.strictEqual(run.result.statistics.Success,52);
  assert(!run.saved.get('loglady').imdbID);
});

suite.test('separate physical collections cannot combine their seasons to meet the two-season rule',async()=>{
  const videos=videosFor({1:13,2:13}).map(v=>({...v,filename:v.season==='2'?v.filename.replace('/Shows/','/Other/') : v.filename}));
  assertNoMatch(await runAutoTag(videos,fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}).responder));
});

suite.test('exact local counts can outweigh sparse alternatives without treating them as short seasons',async()=>{
  const catalog=fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}, {list:(q,data)=>q.i===B && data.Episodes?
    {...data,Episodes:data.Episodes.filter(row=>['1','2','10'].includes(row.Episode))}:data});
  const run=await runAutoTag(videosFor({1:13,2:13}),catalog.responder);
  assert.deepStrictEqual(winner(run),[A]);
  const assessment=run.saved.get('s1e1').taggingEvidence.parentEvidence.support.structure;
  assert.deepStrictEqual(assessment.candidates.find(c=>c.seriesID===B).contradictions,[]);
  assert.strictEqual(assessment.comparisons[0].basis,'positive-season-count');
});

suite.test('a direct high-number episode exposes a truncated contiguous catalog list',async()=>{
  const catalog=fixture({[A]:{1:22},[B]:{1:22}}, {list:(q,data)=>q.i===B && data.Episodes?
    {...data,Episodes:data.Episodes.slice(0,13)}:data});
  const run=await runAutoTag([input(1,22)],catalog.responder);
  assertNoMatch(run);
  const assessment=run.saved.get('s1e22').taggingDecision.evidence.structureAssessment.structure;
  assert.strictEqual(assessment.candidates.find(c=>c.seriesID===B).seasons[0].count,null);
  assertRequestsReused(run);
});

suite.test('an exact positive count can distinguish an alternative with unavailable lists or metadata',async()=>{
  for (const options of [{list:(q,data)=>q.i===B?notFound:data},{metadata:parent=>parent.imdbID===B?notFound:parent}]) {
    const run=await runAutoTag(videosFor({1:13}),fixture({[A]:{1:13},[B]:{1:22}},options).responder);
    assert.deepStrictEqual(winner(run),[A]);
    const assessment=run.saved.get('s1e1').taggingEvidence.parentEvidence.support.structure;
    assert.deepStrictEqual(assessment.candidates.find(c=>c.seriesID===B).contradictions,[]);
    assert.strictEqual(assessment.comparisons[0].basis,'positive-season-count');
  }
});

suite.test('conflicting catalog rows cannot manufacture a season total',()=>{
  const rows=range(13).map(n=>({Episode:String(n),imdbID:`tt400${n}`}));
  for (const Episodes of [[...rows,{Episode:'13',imdbID:'tt999'}],[...rows,{Episode:'14',imdbID:rows[0].imdbID}],
    [...rows,{Episode:'N/A',imdbID:'tt999'}]]) {
    const result=Structure.seasonEvidence({Response:'True',Season:'1',Episodes},1,A);
    assert.strictEqual(result.count,null);
    assert.strictEqual(result.status,'unknown');
  }
  const duplicated=Structure.seasonEvidence({Response:'True',Season:'1',Episodes:[...rows,...rows]},1,A);
  assert.strictEqual(duplicated.count,13);
});

suite.test('a positive named episode is used before a misleading two-season count pattern',async()=>{
  const catalog=fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}, {record:(q,r)=>r?{...r,Title:r.seriesID===B && r.Season==='1' && r.Episode==='1'?'Arrival':'Different story'}:notFound});
  const videos=videosFor({1:13,2:13});videos[0].title='Arrival';
  const run=await runAutoTag(videos,catalog.responder);
  assert.deepStrictEqual(winner(run),[B]);
  assert.strictEqual(run.result.statistics.seriesStructureChecks,undefined);
  assert(!run.requests.some(q=>q.i===A && !q.Season));
});

suite.test('conflicting accepted named parents prevent structural rescue',async()=>{
  const catalog=fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}, {record:(q,r)=>r?{...r,
    Title:r.seriesID===A && r.Season==='1' && r.Episode==='1'?'Arrival':r.seriesID===B && r.Season==='2' && r.Episode==='1'?'Departure':'Different story'}:notFound});
  const videos=videosFor({1:13,2:13});videos[0].title='Arrival';videos[13].title='Departure';
  const run=await runAutoTag(videos,catalog.responder);
  assert.strictEqual(run.result.statistics.Success,2);
  assert.strictEqual(run.result.statistics.seriesStructureChecks,undefined);
});

suite.test('counts cannot override an episode that narrows the parent choices by title',async()=>{
  const catalog=fixture({[A]:{1:22,2:22},[B]:{1:22,2:22},[C]:{1:13,2:13}}, {record:(q,r)=>r?{...r,
    Title:r.seriesID!==C && r.Season==='1' && r.Episode==='1'?'Arrival':'Different story'}:notFound});
  const videos=videosFor({1:13,2:13});videos[0].title='Arrival';
  for (const order of [videos,[...videos].reverse()]) {
    const run=await runAutoTag(order,catalog.responder);
    assertNoMatch(run);
    const assessment=run.saved.get('s2e13').taggingDecision.evidence.structureAssessment.structure;
    const shorter=assessment.candidates.find(candidate=>candidate.seriesID===C);
    assert.deepStrictEqual(shorter.exactCounts,[1,2]);
    assert.strictEqual(shorter.titleConflicts[0].videoID,'s1e1');
    assert.strictEqual(assessment.selectedID,null);
  }
});

suite.test('selected preflight retains narrowed title choices across representatives',async()=>{
  const catalog=fixture({[A]:{1:13,2:13},[B]:{1:22,2:22},[C]:{1:22,2:22}}, {record:(q,r)=>r?{...r,
    Title:r.Season==='1' && r.Episode==='1' && r.seriesID!==C?'Arrival':
      r.Season==='2' && r.Episode==='1' && r.seriesID!==A?'Departure':'Different story'}:notFound});
  const videos=videosFor({1:13,2:13});videos[0].title='Arrival';videos[13].title='Departure';
  const run=await runAutoTag(videos,catalog.responder,{batchOptions:{seriesBatch:{series:NAME},scope:'selected'}});
  assertNoMatch(run);
  assert.strictEqual(run.result.seriesSelectionCanceled,true);
  const decision=run.logs.find(log=>log.message==='Tagging decision' && log.data.status==='ambiguous');
  assert(decision.data.evidence.structure.candidates.find(candidate=>candidate.seriesID===A).titleConflicts.length);
});

suite.test('structure transport failures replace the old permanent attempt with a retryable decision',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13}),fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}},
    {metadata:()=>Error('temporarily offline')}).responder);
  assertNoMatch(run);
  for (const v of run.saved.values()) {
    assert.strictEqual(v.autotag_tried,false);
    assert.strictEqual(v.taggingDecision.status,'service-error');
    assert.strictEqual(v.taggingDecision.evidence.original.id,v.id);
  }
});

suite.test('the original request budget also limits collection structure lookups',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13}),fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}).responder,
    {batchOptions:{requestBudgetLimit:3}});
  assertNoMatch(run);
  const errors=[...run.saved.values()].filter(v=>v.taggingDecision.status==='service-error');
  assert(errors.length);
  assert(errors.every(v=>v.taggingDecision.evidence.requestBudget.used<=3));
});

suite.test('cooperative cancellation stops structural work and prevents episode recovery',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13}),fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}).responder,
    {afterRequest:(q,state)=>{if(q.i===A && !q.Season)state.cancelRequested=true;}});
  assert.strictEqual(run.result.canceled,true);
  assertNoMatch(run);
  assert.strictEqual(run.result.statistics.seriesRetries,undefined);
});

suite.test('selected same-series preflight uses the same structural comparison before asking for a choice',async()=>{
  const run=await runAutoTag(videosFor({1:13,2:13}),fixture({[A]:{1:13,2:13},[B]:{1:22,2:22}}).responder,
    {batchOptions:{seriesBatch:{series:NAME},scope:'selected'}});
  assert.strictEqual(run.result.seriesSelectionCanceled,false);
  assert.strictEqual(run.result.statistics.Success,26);
  assert.deepStrictEqual(winner(run),[A]);
  assertRequestsReused(run);
});

suite.test('a refreshed stored inferred parent no longer imposes the retired two-title requirement',async()=>{
  const catalog=fixture({[A]:{1:2}}), old=input(1,1,{seriesImdbID:A,taggingEvidence:{seriesID:A,
    identities:{series:{value:A,origin:'automatic'}},parentEvidence:{basis:'verified-episode-title',confident:true,needsOrderEvidence:true}}});
  const result=await loadSearch(catalog.responder).api.tag(old);
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.evidence.orderAssessment.basis,'confident-series-numbering');
  assert.strictEqual(result.evidence.identities.series.origin,'automatic');
});
suite.test('prefix cleanup reaches fuzzy assessment without permitting fuzzy numbering corrections',async()=>{
  const catalog=fixture({[A]:{1:2}},{record:(q,r)=>r?{...r,Title:r.Episode==='1'?'Unrelated Subject':'Fate, Hope and Charity'}:notFound});
  const result=await loadSearch(catalog.responder).api.tag(input(1,1,{title:`${NAME} Faith, Hope and Charity`}),{seriesImdbID:A});
  assert.strictEqual(result.status,'unmatched');
  assert.notStrictEqual(result.evidence.imdbID,catalog.records.find(r=>r.Episode==='2').imdbID);
});

suite.test('fuzzy episode wording alone cannot choose between two series',async()=>{
  const catalog=fixture({[A]:{1:2},[B]:{1:2}}, {record:(q,r)=>r?{...r,
    Title:r.seriesID===A?'Fate, Hope and Charity':'Unrelated Subject'}:notFound});
  const result=await loadSearch(catalog.responder).api.tag(input(1,1,{title:`${NAME} Faith, Hope and Charity`}));
  assert.strictEqual(result.status,'ambiguous');
});
runSuite(suite);
