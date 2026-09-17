const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,catalog,notFound,loadSearch,SERIES} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const Batch = require('../src/tagging/BatchEvidence');
const Numbering = require('../src/tagging/EpisodeNumbering');
const suite=createSuite('Sibling-supported numbering and correction lookups','integration',
  'General release-local evidence, independent votes, shuffled order, safe retries, shared fallbacks and policy enforcement.');
const v=(n,title=`S01E${n}`,extra={})=>show({id:`v${n}`,title,series:'Silver Observatory',seriesImdbID:SERIES,
  season:'1',episode:String(n),filename:`/Shows/Silver Observatory/Season 1/${n}.mkv`,...extra});
const parent=series(SERIES,'Silver Observatory');
const response=records=>catalog(records,parent);
const permute=xs=>xs.length?xs.flatMap((x,i)=>permute(xs.filter((_,j)=>j!==i)).map(tail=>[x,...tail])):[[]];
const offsetRecords=[episode('Arrival',2,1),episode('Return',2,2),episode('The Lost Signal',2,3),episode('Dawn',2,4)];
const anchors=[v(1,'Arrival'),v(2,'Return')];
const fuzzy=v(3,'Lost Signal');

suite.test('two exact siblings support fuzzy and unnamed season corrections in every processing order',async()=>{
  for (const order of permute([...anchors,fuzzy,v(4)])) {
    const run=await runAutoTag(order,response(offsetRecords));
    assert.strictEqual(run.result.statistics.Success,4);
    for (const n of [3,4]) {
      const saved=run.saved.get(`v${n}`);
      assert.strictEqual(saved.imdbID,offsetRecords[n-1].imdbID);
      assert.strictEqual(saved.season,'1');
      assert.strictEqual(saved.taggingEvidence.matched.season,'2');
      assert.strictEqual(saved.taggingEvidence.numberingMapping.support.length,2);
      assert.strictEqual(saved.taggingEvidence.orderAssessment.basis,'sibling-numbering');
    }
    assert.strictEqual(run.result.statistics.numberingRetries,2);
    assert.strictEqual(run.result.statistics.recoveredNumberingRetries,2);
    assert.strictEqual(run.result.statistics.processedVideos,4);
    assert.strictEqual(run.result.statistics.remainingVideos,0);
    const keys=run.requests.map(q=>JSON.stringify(q));assert.strictEqual(new Set(keys).size,keys.length);
  }
});

for (const [seasonShift,episodeShift] of [[0,1],[0,-1],[1,0],[-1,0]]) {
  suite.test(`supports observed season offset ${seasonShift}, episode offset ${episodeShift}`,async()=>{
    const local=[v(3,'Arrival'),v(4,'Return'),v(5,'Lost Signal')];
    const records=local.map((x,i)=>episode(['Arrival','Return','The Lost Signal'][i],1+seasonShift,Number(x.episode)+episodeShift));
    const run=await runAutoTag(local,response(records));
    assert.strictEqual(run.saved.get('v5').imdbID,records[2].imdbID);
    const saved=run.saved.get('v5');
    assert.strictEqual(saved.episode,'5');assert.strictEqual(saved.season,'1');
    assert.strictEqual(saved.taggingEvidence.numberingMapping.episodeOffset,episodeShift);
    assert.strictEqual(saved.taggingEvidence.numberingMapping.seasonOffset,seasonShift);
  });
}

suite.test('one exact sibling and duplicate copies of it cannot establish a mapping',async()=>{
  for (const selected of [[anchors[0],fuzzy],[anchors[0],{...anchors[0],id:'copy',filename:'/Shows/Silver Observatory/Season 1/copy.mkv'},fuzzy]]) {
    const run=await runAutoTag(selected,response(offsetRecords));
    assert(!run.saved.get('v3').imdbID);assert(!run.result.statistics.numberingRetries);
  }
});

suite.test('any conflicting exact sibling vetoes an offset regardless of order',async()=>{
  const records=[...offsetRecords,episode('Contrary',1,4)];
  for (const order of permute([...anchors,fuzzy,v(4,'Contrary')])) {
    const run=await runAutoTag(order,response(records));
    assert(!run.saved.get('v3').imdbID);
    assert(!run.result.statistics.numberingRetries);
    assert.strictEqual(run.saved.get('v4').imdbID,records[4].imdbID);
  }
});

suite.test('offset witnesses cannot cross a release directory or a local season',async()=>{
  for (const target of [v(3,'Lost Signal',{filename:'/Shows/Silver Observatory/Other release/3.mkv'}),
    v(3,'Lost Signal',{season:'0'})]) {
    const run=await runAutoTag([...anchors,target],response(offsetRecords));
    assert(!run.saved.get('v3').imdbID);assert(!run.result.statistics.numberingRetries);
  }
});

suite.test('each recovered file must still pass its own title and runtime checks',async()=>{
  for (const [target,records,code] of [
    [v(3,'Unrelated Story'),offsetRecords,'episode-mismatch'],
    [{...fuzzy,metadata:{duration:95*60}},offsetRecords,'episode-coverage-mismatch']
  ]) {
    const run=await runAutoTag([...anchors,target],response(records));
    const saved=run.saved.get('v3');assert(!saved.imdbID);
    assert.strictEqual(saved.taggingDecision.reason.code,code);
    assert(saved.taggingDecision.evidence.numberingMapping);
    assert(run.result.statistics.numberingRetries);
  }
});

async function savedWitnesses() {
  const run=await runAutoTag(anchors,response(offsetRecords));
  return [...run.saved.values()];
}

suite.test('retrying only a failed file can reuse intact saved exact-title siblings',async()=>{
  const saved=await savedWitnesses(), before=JSON.stringify(saved);
  const run=await runAutoTag([fuzzy],response(offsetRecords),{libraryVideos:saved});
  assert.strictEqual(run.saved.get('v3').imdbID,offsetRecords[2].imdbID);
  assert.strictEqual(run.saved.size,1);assert.strictEqual(run.result.statistics.totalVideos,1);
  assert.strictEqual(JSON.stringify(saved),before);
});

suite.test('independent siblings supersede an earlier unconfirmed parent for a generic mapped title',async()=>{
  const target=v(4,'S01E4',{taggingEvidence:{seriesID:SERIES,imdbID:'',
    identities:{series:{value:SERIES,origin:'automatic'}},
    parentEvidence:{basis:'catalog-candidate',origin:'automatic',confident:false}}});
  const record=episode('Episode #2.4',2,4);
  const run=await runAutoTag([target],response([record]),{libraryVideos:await savedWitnesses()});
  const saved=run.saved.get('v4');
  assert.strictEqual(saved.imdbID,record.imdbID);
  assert.strictEqual(saved.taggingEvidence.parentEvidence.confident,true);
  assert.strictEqual(saved.taggingEvidence.parentEvidence.basis,'siblings-series-selection');
});

suite.test('manual, edited, stale, generated and dependent saved matches cannot supply votes',async()=>{
  const originals=await savedWitnesses();
  const edits=[x=>{x.taggingEvidence.identities.record.origin='user';},x=>{x.title='Edited title';},
    x=>{x.episode='20';},x=>{x.taggingDecision={status:'service-error'};},
    x=>{x.taggingEvidence.original.title=`S01E${x.episode}`;},x=>{x.taggingEvidence.numberingMapping={state:'established'};}];
  for(const edit of edits) {
    const saved=JSON.parse(JSON.stringify(originals));saved.forEach(edit);
    const run=await runAutoTag([fuzzy],response(offsetRecords),{libraryVideos:saved});
    assert(!run.saved.get('v3').imdbID);assert(!run.result.statistics.numberingRetries);
  }
});

suite.test('refreshing selected records cannot revive numbering evidence after their local positions changed',async()=>{
  const saved=await savedWitnesses();saved.forEach(x=>{x.episode=String(Number(x.episode)+10);});
  const run=await runAutoTag([...saved,fuzzy],response(offsetRecords));
  assert(!run.saved.get('v3').imdbID);assert(!run.result.statistics.numberingRetries);
});

suite.test('conflicting declared parents veto saved numbering evidence',async()=>{
  const saved=await savedWitnesses();saved.push({...v(8),seriesImdbID:'tt9999999'});
  const run=await runAutoTag([fuzzy],response(offsetRecords),{libraryVideos:saved});
  assert(!run.saved.get('v3').imdbID);assert(!run.result.statistics.numberingRetries);
});

suite.test('final acceptance recomputes mapping from independent ledger evidence, not the proposal',async()=>{
  const saved=await savedWitnesses(), ledger=Batch.createEvidence([fuzzy],saved);
  const found=ledger.numberingFor(fuzzy,{status:'unmatched',reason:{code:'no-results'}});
  const fixture=loadSearch(response(offsetRecords));
  const proposal=await fixture.api.resolve(fuzzy,{seriesImdbID:SERIES,numberingEvidence:found.assessment});
  assert.strictEqual(proposal.status,'candidate');
  assert.strictEqual((await fixture.api.applyMatch(proposal)).reason.code,'unverified-episode-order');
  const conflicting=JSON.parse(JSON.stringify(found.assessment.support));conflicting[0].catalogSeason='1';
  assert.strictEqual((await fixture.api.applyMatch(proposal,{anchors:conflicting})).status,'unmatched');
  assert.strictEqual((await fixture.api.applyMatch(proposal,{anchors:found.assessment.support})).status,'matched');
});

suite.test('duplicate identities and positions cannot create a one-to-one numbering mapping',async()=>{
  const saved=await savedWitnesses(), found=Batch.createEvidence([fuzzy],saved).numberingFor(fuzzy,{status:'unmatched',reason:{code:'no-results'}});
  const a=found.assessment.support;
  for (const bad of [{...a[0],id:a[1].id},{...a[0],id:'tt999'}]) {
    assert.strictEqual(Numbering.assess(fuzzy,SERIES,[...a,bad]).state,'conflicting');
  }
  assert.strictEqual(Numbering.translated({...found.assessment,episodeOffset:-9},fuzzy),null);
});

suite.test('can represent simultaneous offsets when independent observations demonstrate both',async()=>{
  const saved=await savedWitnesses(), found=Batch.createEvidence([fuzzy],saved).numberingFor(fuzzy,{status:'unmatched',reason:{code:'no-results'}});
  const support=found.assessment.support.map(a=>({...a,catalogEpisode:String(Number(a.localEpisode)+1)}));
  const mapping=Numbering.assess(fuzzy,SERIES,support);
  assert.strictEqual(mapping.state,'established');
  assert.deepStrictEqual(Numbering.translated(mapping,fuzzy),{season:'2',episode:'4'});
});

suite.test('a sibling-corrected missing record remains unmatched and retains the attempted correction',async()=>{
  const run=await runAutoTag([...anchors,fuzzy],response(offsetRecords.slice(0,2)));
  const saved=run.saved.get('v3');assert(!saved.imdbID);
  const checks=saved.taggingDecision.evidence.correctionChecks;
  assert(checks.some(c=>c.kind==='adjacent-season'));
  assert(checks.some(c=>c.kind==='sibling-numbering' && c.outcome==='not-found'));
  assert.strictEqual(run.result.statistics.Success,2);
});

suite.test('nearby and adjacent corrections use the same season-list and exact-ID fallback',async()=>{
  for (const [season,number] of [['1','2'],['2','1']]) {
    const record=episode('Arrival',season,number);
    const fixture=loadSearch(q=>{
      if(q.i===SERIES && q.Season===season && !q.Episode)return {Response:'True',Season:season, Episodes:[{Episode:number,imdbID:record.imdbID}]};
      if(q.i===record.imdbID)return record;
      return notFound;
    });
    const result=await fixture.api.tag(v(1,'Arrival'));
    assert.strictEqual(result.status,'matched');assert.strictEqual(result.video.imdbID,record.imdbID);
    const selected=result.evidence.correctionChecks.find(c=>c.outcome==='selected');
    assert.strictEqual(selected.via,'season-list');assert.strictEqual(selected.imdbID,record.imdbID);
    assert(fixture.requests.some(q=>q.i===record.imdbID));
  }
});

suite.test('wrong-parent fallback records cannot authorize an adjacent correction',async()=>{
  const target=episode('Arrival',2,1,'tt9999999');
  const fixture=loadSearch(q=>q.i===target.imdbID?target:q.i===SERIES && q.Season==='2' && !q.Episode?
    {Response:'True',Season:'2',Episodes:[{Episode:'1',imdbID:target.imdbID}]}:notFound);
  const result=await fixture.api.tag(v(1,'Arrival'));
  assert.strictEqual(result.status,'unmatched');
  assert(result.evidence.correctionChecks.some(c=>c.outcome==='invalid-record' &&
    c.via==='season-list' && c.imdbID===target.imdbID));
});

suite.test('cancellation during numbering recovery leaves later deferred candidates untouched',async()=>{
  const saved=await savedWitnesses();
  const records=[...offsetRecords,episode('Original position three',1,3),episode('Original position four',1,4)];
  const run=await runAutoTag([v(3),v(4)],response(records),{libraryVideos:saved,
    afterRequest:(q,state)=>{if(q.Season==='2' && q.Episode==='3')state.cancelRequested=true;}});
  assert.strictEqual(run.result.canceled,true);
  assert.strictEqual(run.result.statistics.numberingRetries,1);
  assert.strictEqual(run.result.statistics.Success,1);
  assert.strictEqual(run.saved.get('v3').imdbID,offsetRecords[2].imdbID);
  assert(!run.saved.has('v4'));
  assert.strictEqual(run.result.statistics.processedVideos,1);
  assert.strictEqual(run.result.statistics.remainingVideos,1);
  assert.strictEqual(run.state.running,false);
});

suite.test('lookup limits during correction fallback remain retryable and record the interrupted probe',async()=>{
  const fixture=loadSearch(()=>notFound);
  const result=await fixture.api.tag(v(1,'Arrival'),{requestBudgetLimit:2});
  assert.strictEqual(result.status,'service-error');
  assert.strictEqual(result.reason.code,'request-budget-exhausted');
  assert.strictEqual(fixture.requests.length,2);
  assert(result.evidence.correctionChecks.some(c=>c.outcome==='service-error'));
});

suite.test('ambiguous exact correction titles are recorded as ambiguous rather than successful tags',async()=>{
  const fixture=loadSearch(response([episode('Arrival',1,1),episode('Wrong',1,2),episode('Arrival',1,3)]));
  const result=await fixture.api.tag(v(2,'Arrival'));
  assert.strictEqual(result.status,'unmatched');
  assert.strictEqual(result.evidence.correctionChecks.filter(c=>c.outcome==='ambiguous-title').length,2);
});

runSuite(suite);
