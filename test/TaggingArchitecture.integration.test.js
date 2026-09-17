const fs = require('fs');
const path = require('path');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,loadSearch,catalog,notFound} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const {createTaggingEngine} = require('../src/tagging/TaggingEngine');
const {createCatalogClient,createRequestSession} = require('../src/tagging/CatalogClient');
const {createRequestBudget} = require('../src/tagging/RequestBudget');
const Evidence = require('../src/tagging/TaggingEvidence');
const Policy = require('../src/tagging/MatchPolicy');
const Decision = require('../src/tagging/TaggingDecision');
const suite = createSuite('Tagging architectural contracts','integration',
  'Enforces acceptance ownership, budgets, durable provenance, cache boundaries and order-independent decisions using arbitrary series.');
const log = {debug(){},info(){},warn(){},error(){}};
const input = (n,title,extra={}) => show({id:`v${n}`,filename:`/Shows/Arbitrary/Season 1/${n}.mkv`,
  title:title || `S01E${n}`,episode:String(n),...extra});
const rows = items => ({Response:'True',Search:items});
function permutations(items) {
  return items.length ? items.flatMap((item,index) => permutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest])) : [[]];
}
function identities(run,videos) {
  return videos.map(video=>[video.id,run.saved.get(video.id)?.imdbID || null]).sort();
}

suite.test('all terminal outcomes have one status, reason and original evidence',async()=>{
  const cases = [
    ['matched',catalog([episode('Arrival')]),input(1,'Arrival')],
    ['ambiguous',q=>q.s?rows([series(),series('tt9000001')]):notFound,input(1)],
    ['unmatched',()=>notFound,input(1)],
    ['service-error',()=>Error('offline'),input(1)]
  ];
  for (const [status,responder,video] of cases) {
    const before=JSON.stringify(video), fixture=loadSearch(responder);
    const result=await fixture.api.tag(video);
    assert.strictEqual(result.status,status,JSON.stringify(result));
    assert(Decision.STATUSES.includes(result.status));
    assert(result.reason.code && result.reason.message);
    assert.deepStrictEqual(result.evidence.original,Evidence.snapshot(video));
    assert.strictEqual(result.retryable,status==='service-error');
    assert.strictEqual(result.success,undefined,'Only the editor adapter speaks success/data');
    assert.strictEqual(JSON.stringify(video),before);
    assert(fixture.logs.some(row=>row.message==='Tagging decision'&&row.data.status===status));
  }
});

suite.test('final acceptance recomputes title evidence and prevents writes after a proposal changes',async()=>{
  const fixture=loadSearch(catalog([episode('Arrival',1,1,undefined,{Poster:'https://example.invalid/a.jpg'})]));
  const proposal=await fixture.api.resolve(input(1,'Arrival'));
  assert.strictEqual(proposal.status,'candidate');
  assert.strictEqual(fixture.downloads.length,0);
  proposal.candidate.record={...proposal.candidate.record,Title:'Unrelated Content'};
  proposal.candidate.evidence.titleAssessment={state:'compatible'};
  const result=await fixture.api.applyMatch(proposal);
  assert.strictEqual(result.status,'unmatched');
  assert.strictEqual(fixture.downloads.length,0);
  assert.strictEqual(result.evidence.titleAssessment.state,'contradiction');
});

suite.test('the application boundary cannot apply fabricated approval or malformed identities',async()=>{
  let writes=0;
  const engine=createTaggingEngine({log,client:{},withEpisodeDuration:async v=>v,
    applier:{apply:async()=>{writes++;throw Error('Must not be called');}}});
  await engine.applyMatch({status:'matched'});
  const result=await engine.applyMatch({status:'candidate',context:{requestTrace:[]},
    candidate:{video:input(1),record:null,evidence:{kind:'explicit-id',requestedID:'tt1'}}});
  assert.strictEqual(result.status,'service-error');
  assert.strictEqual(result.reason.code,'malformed-catalog-record');
  assert.strictEqual(writes,0);
});

suite.test('movie discovery cannot turn a rejected canonical expansion into final approval',()=>{
  const video=show({kind:'movie',title:'The Road Home',year:'1999',metadata:{duration:90*60}});
  const record={Response:'True',Type:'movie',Title:'The Long Road Home',Year:'1999',imdbID:'tt0160481',Runtime:'90 min',imdbVotes:'100000'};
  const result=Policy.decide({video,record,evidence:{kind:'movie',candidate:{title:video.title,year:video.year},
    validationOptions:{allowCanonicalTitle:true},evaluation:{confident:true}}});
  assert.strictEqual(result.status,'unmatched');
});

suite.test('an automatic refresh retains original titles, numbering corrections and authorship',async()=>{
  const fixture=loadSearch(catalog([episode('Arrival',1,1),episode('Other Story',1,2)]));
  const original=input(2,'Arrival');
  const first=await fixture.api.tag(original);
  assert.strictEqual(first.status,'matched');
  assert.strictEqual(first.evidence.identities.record.origin,'automatic');
  let refreshed=first;
  for (let i=0;i<3;i++) refreshed=await fixture.api.tag(refreshed.video);
  assert.strictEqual(refreshed.status,'matched');
  for (const field of ['original','requested','matched','parentEvidence','identities']) {
    assert.deepStrictEqual(refreshed.evidence[field],first.evidence[field],field);
  }
  assert.strictEqual(refreshed.evidence.kind,'episode');
  assert.strictEqual(refreshed.evidence.lookup.kind,'explicit-id');
  assert(!refreshed.evidence.lookup.lookup,'Refresh must not recursively grow its history');
});

suite.test('legacy stored IDs are labeled unknown rather than invented user approvals',async()=>{
  const target=episode('Arrival'), fixture=loadSearch(catalog([target]));
  const result=await fixture.api.tag(input(1,'Old Title',{imdbID:target.imdbID}));
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.evidence.identities.record.origin,'legacy');
  const pasted=await fixture.api.tag(input(1,'Arrival',{imdbID:series().imdbID}));
  assert.strictEqual(pasted.status,'matched');
  assert.strictEqual(pasted.evidence.identities.series.origin,'legacy');
});

suite.test('explicit user selections and subsequent refreshes retain user provenance',async()=>{
  const target=episode('Arrival'),fixture=loadSearch(catalog([target]));
  let result=await fixture.api.tag(input(1,'Other',{imdbID:target.imdbID}),{imdbIDSource:'user'});
  assert.strictEqual(result.evidence.identities.record.origin,'user');
  result=await fixture.api.tag(result.video);
  assert.strictEqual(result.evidence.identities.record.origin,'user');
  const selected=await fixture.api.tag(input(1,'Arrival'),{seriesImdbID:series().imdbID,seriesSelectionSource:'user'});
  assert.strictEqual(selected.evidence.identities.series.origin,'user');
  assert.strictEqual(selected.evidence.identities.record.origin,'automatic');
});

suite.test('an accepted selection explicitly clears an older failure when applied as an editor patch',async()=>{
  const target=episode('Arrival'),fixture=loadSearch(catalog([target]));
  const original=input(1,'Other',{imdbID:target.imdbID,
    taggingDecision:{status:'unmatched',reason:{code:'no-results'},evidence:{original:{title:'Other'}}}});
  const result=await fixture.api.tag(original,{imdbIDSource:'user'});
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.video.taggingDecision,null);
  const patched={...original,...result.video};
  assert.strictEqual(patched.taggingDecision,null);
  assert.strictEqual(patched.taggingEvidence.identities.record.origin,'user');
  assert.strictEqual(original.taggingDecision.status,'unmatched');
});

suite.test('editing an ID discards stale approval details and records the new user choice',()=>{
  const video=input(1,'Arrival',{imdbID:'tt222',taggingEvidence:{imdbID:'tt111',kind:'episode',
    requested:{season:'1',episode:'99'},identities:{record:{value:'tt111',origin:'automatic'}}}});
  const edited=Evidence.markUserEdit(video,{imdbID:'tt222'});
  assert.strictEqual(edited.taggingEvidence.identities.record.origin,'user');
  assert.strictEqual(edited.taggingEvidence.requested,undefined);
  assert.strictEqual(edited.taggingEvidence.imdbID,'tt222');
  const applied=Evidence.markUserEdit(edited,{imdbID:'tt222',taggingEvidence:edited.taggingEvidence});
  assert.strictEqual(applied,edited);
});

suite.test('stored automatic parents retain their confidence and provenance under the current numbering policy',async()=>{
  const parent=series(),fixture=loadSearch(catalog([episode('Opening')],parent));
  const video=input(1,undefined,{seriesImdbID:parent.imdbID,taggingEvidence:{imdbID:'ttold',seriesID:parent.imdbID,
    identities:{series:{value:parent.imdbID,origin:'automatic'}},
    parentEvidence:{basis:'verified-episode-title',confident:true,needsOrderEvidence:true,origin:'automatic'}}});
  const result=await fixture.api.tag(video);
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.evidence.orderAssessment.basis,'confident-series-numbering');
  assert.strictEqual(result.evidence.parentEvidence.origin,'automatic');
});

suite.test('negative episode decisions retain the examined title and its assessment',async()=>{
  const fixture=loadSearch(catalog([episode('Different Subject')]));
  const result=await fixture.api.tag(input(1,'Arrival'));
  assert.strictEqual(result.status,'unmatched');
  assert.strictEqual(result.evidence.original.title,'Arrival');
  assert.strictEqual(result.evidence.catalogTitle,'Different Subject');
  assert.strictEqual(result.evidence.titleAssessment.state,'contradiction');
  assert(result.evidence.requests.some(row=>row.stage==='nearby episode title probe'));
});

suite.test('global HTTP budgets stop nested probes and leave files retryable',async()=>{
  const fixture=loadSearch(catalog([episode('Wrong Story')]));
  const result=await fixture.api.tag(input(1,'Arrival'),{requestBudgetLimit:3});
  assert.strictEqual(result.status,'service-error');
  assert.strictEqual(result.reason.code,'request-budget-exhausted');
  assert.strictEqual(fixture.requests.length,3);
  assert.strictEqual(result.evidence.requestBudget.used,3);
  const run=await runAutoTag([input(1,'Arrival')],catalog([episode('Wrong Story')]),{batchOptions:{requestBudgetLimit:1}});
  assert.strictEqual(run.saved.size,1);
  const saved=run.saved.get('v1');
  assert.strictEqual(saved.autotag_tried,false);
  assert.strictEqual(saved.taggingDecision.reason.code,'request-budget-exhausted');
  assert.strictEqual(saved.imdbID,'');
  assert.strictEqual(run.requests.length,1);
  assert.strictEqual(run.result.statistics.Error,1);
});

suite.test('concurrent requests cannot exceed the budget; cached responses remain free',async()=>{
  let calls=0;
  const client=createCatalogClient({log,omdb:{key:'secret-not-for-logs'},axios:async()=>{
    calls++;return {status:200,data:series()};
  }});
  const context={requestSession:createRequestSession(),requestBudget:createRequestBudget(2),requestTrace:[]};
  const replies=await Promise.allSettled([1,2,3,4].map(n=>client.pollOMDB(client.createURLParts({id:`tt${n}`}),context)));
  assert.strictEqual(replies.filter(row=>row.status==='fulfilled').length,2);
  assert.strictEqual(calls,2);
  assert.strictEqual(context.requestSession.requests,2);
  await client.pollOMDB(client.createURLParts({id:'tt1'}),context);
  assert.strictEqual(calls,2);
  assert.strictEqual(context.requestBudget.used,2);
  assert(!JSON.stringify(context.requestTrace).includes('secret-not-for-logs'));
  await client.pollOMDB(client.createURLParts({id:'tt3'}),{...context,requestBudget:createRequestBudget(1)});
  assert.strictEqual(calls,3,'Budget errors must not poison the response cache');
});

suite.test('preflight uses one budget across representatives and retains its requests on failure',async()=>{
  const fixture=loadSearch(catalog([episode('Wrong Story')]));
  const result=await fixture.api.preflight([input(1,'Arrival'),input(2,'Return')],{requestBudgetLimit:2});
  assert.strictEqual(result.status,'service-error');
  assert.strictEqual(result.reason.code,'request-budget-exhausted');
  assert.strictEqual(fixture.requests.length,2);
  assert.strictEqual(result.evidence.requestBudget.used,2);
  assert(result.evidence.requests.length>=2);
});

suite.test('missing-season inference preserves the empty original season',async()=>{
  const fixture=loadSearch(catalog([episode('Arrival')],{...series(),totalSeasons:'1'}));
  const result=await fixture.api.tag(input(1,'Arrival',{season:''}));
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.video.season,'1');
  assert.strictEqual(result.evidence.original.season,'');
});

suite.test('parent metadata reuse is limited to a run and cannot hide later provider changes',async()=>{
  let count='1';
  const fixture=loadSearch(q=>catalog([episode('Arrival')],{...series(),totalSeasons:count})(q));
  const video=input(1,'Arrival',{season:''}), session=fixture.api.createSeriesSearchSession();
  assert.strictEqual((await fixture.api.tag(video,{seriesSearchSession:session})).status,'matched');
  count='2';
  assert.strictEqual((await fixture.api.tag(video,{seriesSearchSession:session})).status,'matched');
  assert.strictEqual((await fixture.api.tag(video)).status,'unmatched');
});

suite.test('selected-batch preflight carries its representative evidence into every match',async()=>{
  const videos=[input(1,'Arrival'),input(2,'Return')];
  const run=await runAutoTag(videos,catalog([episode('Arrival'),episode('Return',1,2)]),{
    batchOptions:{scope:'selected',seriesBatch:{series:'Test Series'}}});
  assert.strictEqual(run.result.statistics.Success,2);
  for(const video of run.saved.values()) {
    assert.strictEqual(video.taggingEvidence.parentEvidence.origin,'automatic');
    assert.strictEqual(video.taggingEvidence.parentEvidence.support.original.id,'v1');
  }
});

suite.test('selected-batch ambiguity cancellation and service failure save nothing',async()=>{
  const videos=[input(1)],settings={batchOptions:{scope:'selected',seriesBatch:{series:'Test Series'}}};
  const canceled=await runAutoTag(videos,q=>q.s?rows([series(),series('tt9000001')]):notFound,settings);
  assert(canceled.result.seriesSelectionCanceled);
  assert.strictEqual(canceled.saved.size,0);
  const failed=await runAutoTag(videos,()=>Error('offline'),settings);
  assert.strictEqual(failed.result.seriesPreflightFailure.status,'service-error');
  assert.strictEqual(failed.saved.size,0);
  assert.strictEqual(failed.state.running,false);
});

for(const name of ['Silver Observatory','Orchard Signal']) {
  suite.test(`${name}: every permutation preserves mixed-numbering and missing-record decisions`,async()=>{
    const parent=series(undefined,name);
    const videos=[input(1,undefined,{series:name}),input(2,'Arrival',{series:name}),
      input(4,'Return',{series:name}),input(20,undefined,{series:name})];
    const records=[episode('Opening'),episode('Arrival',1,3),episode('Return',1,5)];
    const expected=[['v1',null],['v2',records[1].imdbID],['v4',records[2].imdbID],['v20',null]].sort();
    for(const order of permutations(videos)) assert.deepStrictEqual(identities(await runAutoTag(order,catalog(records,parent)),videos),expected);
  });
}

suite.test('conflicting same-name parents are exposed regardless of which named file is first',async()=>{
  const parent=series(), other=series('tt9000001');
  const records=[episode('Opening'),episode('Arrival',1,2),episode('Return',1,3,other.imdbID,{imdbID:'tt9000003'})];
  const responder=q=>q.s?rows([parent,other]):records.find(r=>r.seriesID===q.i&&r.Season===q.Season&&r.Episode===q.Episode);
  const videos=[input(1),input(2,'Arrival'),input(3,'Return')];
  for(const order of permutations(videos)) {
    const run=await runAutoTag(order,responder);
    assert.deepStrictEqual(identities(run,videos),[['v1',null],['v2',records[1].imdbID],['v3',records[2].imdbID]]);
  }
});

suite.test('a learned season offset cannot outrank a direct exact title in any processing order',async()=>{
  const records=[episode('Wrong',1,1),episode('Arrival',2,1),episode('Return',1,2),episode('Return',2,2)];
  const videos=[input(1,'Arrival'),input(2,'Return')];
  for(const order of permutations(videos)) {
    const run=await runAutoTag(order,catalog(records));
    assert.deepStrictEqual(identities(run,videos),[['v1',records[1].imdbID],['v2',records[2].imdbID]]);
  }
});

suite.test('named parent witnesses and order anchors remain inspectable in the saved evidence',async()=>{
  const records=[episode('Opening'),episode('Arrival',1,2),episode('Return',1,3)];
  const run=await runAutoTag([input(1),input(2,'Arrival'),input(3,'Return')],q=>
    q.s?rows([series(),series('tt9000001')]):catalog(records)(q));
  const evidence=run.saved.get('v1').taggingEvidence;
  assert.strictEqual(evidence.orderAssessment.support.length,2);
  assert.deepStrictEqual(evidence.orderAssessment.support.map(a=>a.originalTitle).sort(),['Arrival','Return']);
  assert(evidence.parentEvidence.support.every(a=>a.filename&&a.id));
});

suite.test('refreshing previously generated titles cannot manufacture original sibling evidence',async()=>{
  const records=[episode('Opening'),episode('Arrival',1,2),episode('Return',1,3)];
  const first=await runAutoTag([input(2),input(3)],catalog(records));
  const videos=[input(1),first.saved.get('v2'),first.saved.get('v3')];
  const lookup=catalog(records);
  for(const order of permutations(videos)) {
    const run=await runAutoTag(order,q=>q.s?rows([series(),series('tt9000001')]):lookup(q));
    assert.strictEqual(run.result.statistics.Success,2);
    assert(!run.saved.get('v1').imdbID);
  }
});

suite.test('a parent assigned to an unmatched selected file retains its automatic source',async()=>{
  const videos=[input(1,'Arrival'),input(2,'Return',{season:'extras'})];
  const run=await runAutoTag(videos,catalog([episode('Arrival')]),{
    batchOptions:{scope:'selected',seriesBatch:{series:'Test Series'}}});
  const unmatched=run.saved.get('v2');
  assert.strictEqual(unmatched.seriesImdbID,series().imdbID);
  assert.strictEqual(unmatched.taggingEvidence.identities.series.origin,'automatic');
  assert.strictEqual(unmatched.taggingDecision.status,'unmatched');
});

suite.test('explicitly confirming a numbered record records user evidence rather than inventing sibling support',async()=>{
  const fixture=loadSearch(catalog([episode('Opening')]));
  const proposal=await fixture.api.resolve(input(1),{seriesImdbID:series().imdbID,seriesSelectionSource:'siblings'});
  const automatic=await fixture.api.applyMatch(proposal);
  assert.strictEqual(automatic.status,'matched');
  assert.strictEqual(automatic.evidence.identities.record.origin,'automatic');
  const confirmed=await fixture.api.applyMatch(proposal,{recordSelectionSource:'user'});
  assert.strictEqual(confirmed.status,'matched');
  assert.strictEqual(confirmed.evidence.identities.record.origin,'user');
  assert.strictEqual(confirmed.evidence.orderAssessment.basis,'user-confirmed-record');
});

suite.test('a proposal keeps its input stable if the caller edits the source object',async()=>{
  const fixture=loadSearch(catalog([episode('Arrival')]));
  const video=input(1,'Arrival'),proposal=await fixture.api.resolve(video);
  video.episode='99';video.title='Changed';
  const result=await fixture.api.applyMatch(proposal);
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.video.episode,'1');
  assert.strictEqual(result.evidence.original.title,'Arrival');
});

suite.test('a malformed provider record is retryable and cannot poison a run cache',async()=>{
  const target=episode('Arrival');let broken=true;
  const fixture=loadSearch(()=>broken?{...target,Title:undefined}:target);
  const session=fixture.api.createSeriesSearchSession(), video=input(1,'Arrival',{imdbID:target.imdbID});
  const failed=await fixture.api.tag(video,{seriesSearchSession:session});
  assert.strictEqual(failed.status,'service-error');
  broken=false;
  const retried=await fixture.api.tag(video,{seriesSearchSession:session});
  assert.strictEqual(retried.status,'matched');
  assert.strictEqual(fixture.requests.filter(q=>q.i===target.imdbID).length,2);
});

suite.test('module dependencies enforce pure policy, a single application owner and no import cycles',()=>{
  const babel=require('@babel/core'),root=path.join(__dirname,'../src/tagging');
  const files=fs.readdirSync(root).filter(name=>name.endsWith('.js'));
  const imports=new Map(), applies=[],matched=[];
  const walk=(node,visit)=>{if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node)){
    if(Array.isArray(value))value.forEach(child=>walk(child,visit));else if(value&&typeof value==='object')walk(value,visit);
  }};
  for(const file of files) {
    const ast=babel.parseSync(fs.readFileSync(path.join(root,file),'utf8'),{babelrc:false,configFile:false});
    const deps=[];
    walk(ast,node=>{
      if(node.type!=='CallExpression')return;
      if(node.callee.name==='require'&&typeof node.arguments[0]?.value==='string')deps.push(node.arguments[0].value);
      if(node.callee.type==='MemberExpression'&&node.callee.object.name==='applier'&&node.callee.property.name==='apply')applies.push(file);
      if(node.callee.type==='MemberExpression'&&node.callee.property.name==='decision'&&node.arguments[0]?.value==='matched')matched.push(file);
    });imports.set(file,deps);
  }
  assert.deepStrictEqual(applies,['TaggingEngine.js']);
  assert.deepStrictEqual(matched,['MatchPolicy.js']);
  const visit=(file,stack=[])=>{
    assert(!stack.includes(file),`Import cycle: ${[...stack,file].join(' -> ')}`);
    for(const dep of imports.get(file)||[])if(dep.startsWith('./'))visit(path.basename(dep).replace(/\.js$/,'')+'.js',[...stack,file]);
  };
  files.forEach(file=>visit(file));
  const pure=new Set();
  const collect=file=>{if(pure.has(file))return;pure.add(file);for(const dep of imports.get(file)||[]){
    assert(!['fs','axios','electron'].includes(dep),`${file} imports ${dep}`);
    if(dep.startsWith('./'))collect(path.basename(dep).replace(/\.js$/,'')+'.js');
  }};
  collect('MatchPolicy.js');
  for(const file of ['CatalogClient.js','ArtworkService.js','TaggingEngine.js','TagApplier.js'])assert(!pure.has(file));
  for(const file of ['MovieResolver.js','SeriesResolver.js','EpisodeResolver.js']) {
    assert(!imports.get(file).some(dep=>/TagApplier|ArtworkService|electron|axios|library/.test(dep)),file);
  }
});
runSuite(suite);
