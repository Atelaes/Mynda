const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {createMetadataServerClient}=require('../src/tagging/MetadataServerClient');
const {capacityWait,waitForCapacity}=require('../src/tagging/CapacityWait');
const {createCatalogClient,createRequestSession}=require('../src/tagging/CatalogClient');
const {createRequestBudget}=require('../src/tagging/RequestBudget');
const {createTaggingEngine}=require('../src/tagging/TaggingEngine');
const {createTagApplier}=require('../src/tagging/TagApplier');
const {createAutoTagRunner}=require('../src/tagging/AutoTagRunner');
const {createEditorService}=require('../src/main/EditorService');
const suite=createSuite('Capacity waits across metadata, tagging and editor','integration',
  'Checks explicit wait contracts, retry pacing, cancellation, saved progress and unchanged matching through the real client and engine.');
const log={debug(){},info(){},warn(){},error(){}};
const server={url:'http://127.0.0.1:8787',token:'synthetic-access-token-0123456789abcdef'};
const requestId='12345678-1234-4123-8123-123456789abc';
const ticket='22222222-2222-4222-8222-222222222222';
function pause(overrides={}) {
  const error={code:'CAPACITY_WAIT',retryable:true,reason:'fairness',retryAfterSeconds:1,ticket,...overrides};
  return {status:429,headers:{'retry-after':String(error.retryAfterSeconds)},data:{requestId,error}};
}
function record(id='tt1234567') {
  return {ref:{provider:'fixture',id},externalIds:{imdb:id},kind:'movie',title:'A Fixture Film',year:null,artwork:[],
    released:null,runtimeMinutes:90,genres:[],plot:null,contentRating:null,directors:[],actors:[],countries:[],languages:[],
    boxOffice:null,ratings:[],votes:[],series:null,seriesExternalIds:{},season:null,episode:null,totalSeasons:null,episodeOrder:null,
    provenance:{provider:'fixture',fetchedAt:'2026-10-15T00:00:00Z'}};
}
const success=id=>({status:200,data:{requestId,data:record(id)}});
const video=(id='one',imdbID='tt1234567')=>({id,imdbID,kind:'movie',title:'Original',ratings:{user:4},new:true,autotag_tried:false});
function fixture(responder,wait=async()=>{}) {
  const calls=[];
  const transport=createMetadataServerClient({server,axios:async request=>{
    calls.push(request);return responder(request,calls.length);
  },wait});
  const client=createCatalogClient({transport,log});
  const engine=createTaggingEngine({client,log,withEpisodeDuration:async value=>value,
    applier:createTagApplier({log,downloadArtworkWithSeriesFallback:async()=>''})});
  return {client,engine,calls};
}
function batch(f,options={}) {
  const state={},saved=[],statuses=[];
  const videos=options.videos || [video(),video('two','tt1234568')];
  const run=createAutoTagRunner({state,catalog:options.catalog || f.engine,log,getCandidates:()=>videos,
    getLibraryVideos:()=>videos,preferences:{},chooseSeries:async()=>null,whenIdle:async()=>{},
    notifyStatus:status=>{statuses.push(status);if(options.onStatus)options.onStatus(status,state,saved);},
    save:async rows=>{if(options.save)await options.save(rows);saved.push(...JSON.parse(JSON.stringify(rows)));}});
  return {run,state,saved,statuses,videos};
}

suite.test('retries the same lookup with the ticket and workload, without spending candidate budget on polls',async()=>{
  const delays=[],statuses=[];
  const f=fixture((request,count)=>count<=120 ? pause() : success(),async ms=>delays.push(ms));
  const budget=createRequestBudget(1),session=createRequestSession();
  const response=await f.client.requestCatalog({id:'tt1234567'},
    {requestBudget:budget,requestSession:session,requestControl:{workload:'batch',onCapacityWait:status=>statuses.push(status)}});
  assert.strictEqual(response.data.imdbID,'tt1234567');
  assert.strictEqual(f.calls.length,121);
  assert(delays.every(ms=>ms===1000));
  assert.strictEqual(budget.used,1);
  assert.strictEqual(session.requests,1);
  assert.strictEqual(f.calls[0].headers['X-Metadata-Ticket'],undefined);
  assert(f.calls.slice(1).every(call=>call.headers['X-Metadata-Ticket']===ticket && call.headers['X-Metadata-Workload']==='batch'));
  assert(f.calls.every(call=>JSON.stringify(call.data)===JSON.stringify(f.calls[0].data)));
  assert.strictEqual(statuses[statuses.length-1].waiting,false);
  await f.client.requestCatalog({id:'tt1234567'},{requestBudget:budget,requestSession:session});
  assert.strictEqual(f.calls.length,121,'the completed result remains reusable');
});
suite.test('clears an expired ticket when the server switches to a budget pause',async()=>{
  const replies=[pause(),pause({reason:'budget',retryAfterSeconds:3600,ticket:undefined}),success()];
  const delays=[];
  const f=fixture(()=>replies.shift(),async ms=>delays.push(ms));
  await f.client.requestCatalog({id:'tt1234567'});
  assert.deepStrictEqual(delays,[1000,3600000]);
  assert.strictEqual(f.calls[2].headers['X-Metadata-Ticket'],undefined);
});
suite.test('only valid capacity instructions can initiate an automatic wait',async()=>{
  const malformed=[pause({retryAfterSeconds:0}),pause({retryAfterSeconds:-1}),pause({retryAfterSeconds:86401}),
    pause({retryAfterSeconds:'1'}),pause({reason:'invented'}),pause({retryable:false}),pause({ticket:'private\nheader'})];
  const wrongStatus=pause();wrongStatus.status=503;malformed.push(wrongStatus);
  const mismatch=pause();mismatch.headers['retry-after']='2';malformed.push(mismatch);
  for(const response of malformed)assert.throws(()=>capacityWait(response),{code:'METADATA_INVALID_RESPONSE'});
  for(const code of ['PROVIDER_QUOTA_EXCEEDED','PROVIDER_UNAVAILABLE','CAPACITY_UNAVAILABLE']) {
    let waited=false;
    const f=fixture(()=>({status:503,data:{requestId,error:{code,retryable:true}}}),async()=>{waited=true;});
    await assert.rejects(f.client.requestCatalog({id:'tt1234567'}),{code});
    assert.strictEqual(waited,false);assert.strictEqual(f.calls.length,1);
  }
});
suite.test('long waits are cancellable immediately and cancellation evicts the pending response',async()=>{
  const controller=new AbortController();
  const f=fixture((_,count)=>count===1 ? pause({reason:'budget',retryAfterSeconds:86400}) : success(),waitForCapacity);
  const session=createRequestSession();
  await assert.rejects(f.client.requestCatalog({id:'tt1234567'},{requestSession:session,
    requestControl:{signal:controller.signal,onCapacityWait:status=>{if(status.waiting)controller.abort();}}}),{code:'METADATA_CANCELED'});
  assert.strictEqual(session.responses.size,0);
  assert.strictEqual(f.calls.length,1);
  assert.strictEqual((await f.client.requestCatalog({id:'tt1234567'},{requestSession:session})).data.Response,'True');
  await assert.rejects(waitForCapacity(86400000,controller.signal),{code:'METADATA_CANCELED'});
  const active=new AbortController();
  const runningTimer=waitForCapacity(86400000,active.signal);
  active.abort();
  await assert.rejects(runningTimer,{code:'METADATA_CANCELED'});
});
suite.test('does not send another HTTP request before the capacity delay completes',async()=>{
  let release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const f=fixture((_,count)=>count===1 ? pause() : success(),()=>new Promise(resolve=>{release=resolve;entered();}));
  const pending=f.client.requestCatalog({id:'tt1234567'});
  await waiting;
  assert.strictEqual(f.calls.length,1);
  await Promise.resolve();assert.strictEqual(f.calls.length,1);
  release();await pending;assert.strictEqual(f.calls.length,2);
});
suite.test('cancels an active HTTP operation without leaking the Axios config',async()=>{
  const controller=new AbortController();
  let cancelCalled=false,started;
  const began=new Promise(resolve=>{started=resolve;});
  const axios=()=>{started();return new Promise(()=>{});};
  axios.CancelToken={source:()=>({token:'mock-cancel-token',cancel:()=>{cancelCalled=true;}})};
  const client=createMetadataServerClient({axios,server});
  const pending=client({id:'tt1234567'},{signal:controller.signal});
  await began;controller.abort();
  await assert.rejects(pending,error=>error.code==='METADATA_CANCELED' && !JSON.stringify(error).includes(server.token));
  assert.strictEqual(cancelCalled,true);
});
suite.test('batch waiting saves completed videos, resumes the same pending video, and retains successful tagging',async()=>{
  const f=fixture((request,count)=>count===2 ? pause({reason:'budget',retryAfterSeconds:300}) : success(request.data.ref.id));
  const b=batch(f,{onStatus:(status,state,saved)=>{
    if(status.capacityWait){assert.strictEqual(saved.length,1);assert.strictEqual(saved[0].id,'one');assert.strictEqual(state.capacityWaiting,true);}
  }});
  const result=await b.run();
  assert.strictEqual(result.statistics.Success,2);
  assert.deepStrictEqual(b.saved.map(row=>row.id),['one','two']);
  assert(b.saved.every(row=>row.autotag_tried && !row.taggingDecision && row.ratings.user===4));
  for (const privateValue of [server.token,ticket,'requestControl','retryAt']) assert(!JSON.stringify(b.saved).includes(privateValue));
  assert.strictEqual(f.calls[1].data.ref.id,f.calls[2].data.ref.id);
  assert.strictEqual(b.statuses[b.statuses.length-1].action,'');
  assert.strictEqual(b.state.running,false);assert.strictEqual(b.state.capacityWaiting,false);
});
suite.test('canceling a batch wait preserves earlier saves and leaves the pending video unchanged',async()=>{
  const f=fixture((request,count)=>count===2 ? pause({reason:'budget',retryAfterSeconds:86400}) : success(request.data.ref.id),waitForCapacity);
  const b=batch(f,{onStatus:(status,state)=>{if(status.capacityWait){state.cancelRequested=true;assert(state.cancelCapacityWait());}}});
  const before=JSON.stringify(b.videos);
  const result=await b.run();
  assert.strictEqual(result.canceled,true);assert.strictEqual(result.statistics.processedVideos,1);
  assert.strictEqual(result.statistics.remainingVideos,1);
  assert.deepStrictEqual(b.saved.map(row=>row.id),['one']);
  assert.strictEqual(JSON.stringify(b.videos),before);
  assert.strictEqual(f.calls.length,2);
  assert.strictEqual(b.state.cancelCapacityWait,null);
});
suite.test('a cancellation requested before a capacity response also stops the wait without recording an error',async()=>{
  let b;
  const f=fixture(()=>{b.state.cancelRequested=true;return pause();},waitForCapacity);
  b=batch(f);
  const result=await b.run();
  assert.strictEqual(result.canceled,true);assert.strictEqual(b.saved.length,0);
  assert.strictEqual(result.statistics.processedVideos,0);
});
suite.test('a save failure at the start of a capacity pause stops the batch and preserves its storage error',async()=>{
  const f=fixture((request,count)=>count===2 ? pause() : success(request.data.ref.id));
  const b=batch(f,{save:async()=>{throw Object.assign(new Error('Disk full'),{code:'ENOSPC'});}});
  await assert.rejects(b.run(),error=>error.code==='ENOSPC' && error.autoTagFailure.stage==='save');
  assert.strictEqual(f.calls.length,2);assert.strictEqual(b.saved.length,0);assert.strictEqual(b.state.running,false);
});
suite.test('preflight requests inherit batch wait controls and can be canceled before any video changes',async()=>{
  const f=fixture(()=>pause(),waitForCapacity);
  const catalog={...f.engine,preflight:async(videos,options)=>{
    await f.client.requestCatalog({id:'tt1234567'},{requestSession:options.seriesSearchSession.catalog});
    throw new Error('Canceled preflight must not reach here');
  }};
  const b=batch(f,{catalog,onStatus:(status,state)=>{if(status.capacityWait){state.cancelRequested=true;state.cancelCapacityWait();}}});
  const result=await b.run({seriesBatch:{series:'Fixture'}});
  assert.strictEqual(result.canceled,true);assert.strictEqual(result.seriesPreflightFailure,null);
  assert.strictEqual(b.saved.length,0);assert.strictEqual(f.calls[0].headers['X-Metadata-Workload'],'batch');
});
suite.test('manual lookups expose waiting only to their owner and cancel by operation ID',async()=>{
  let started;
  const began=new Promise(resolve=>{started=resolve;});
  const f=fixture(()=>pause({reason:'budget',retryAfterSeconds:86400}),waitForCapacity);
  const original=video(),updates=[];
  const service=createEditorService({library:{media:[original]},catalog:f.engine,app:{getPath:()=>'/tmp/mynda-capacity-tests'},
    notifyLookup:(owner,status)=>{updates.push({owner,status});if(status.capacityWait)started();}});
  const pending=service.search({...original,lookupID:'lookup-one'},1);
  await began;
  assert.strictEqual(service.cancelSearch({lookupID:'lookup-one'},2).canceled,false);
  assert.strictEqual(service.cancelSearch({lookupID:'wrong'},1).canceled,false);
  assert.strictEqual(service.cancelSearch({lookupID:'lookup-one'},1).canceled,true);
  assert.deepStrictEqual(await pending,{status:'canceled'});
  assert(updates.every(item=>item.owner===1 && item.status.lookupID==='lookup-one'));
  assert.strictEqual(updates[updates.length-1].status.capacityWait,null);
  assert.strictEqual(original.title,'Original');assert.strictEqual(f.calls.length,1);
});
suite.test('closing an editor owner aborts its pending lookup and stops status delivery',async()=>{
  let started;
  const began=new Promise(resolve=>{started=resolve;});
  const f=fixture(()=>pause(),waitForCapacity),original=video();
  const updates=[];
  const service=createEditorService({library:{media:[original]},catalog:f.engine,app:{getPath:()=>'/tmp/mynda-capacity-tests'},
    notifyLookup:(owner,status)=>{updates.push(status);if(status.capacityWait)started();}});
  const pending=service.search({...original,lookupID:'closing'},3);
  await began;service.dispose(3);const count=updates.length;
  assert.deepStrictEqual(await pending,{status:'canceled'});
  assert.strictEqual(updates.length,count);
});

runSuite(suite);
