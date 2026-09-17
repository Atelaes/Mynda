const {createAutoTagRunner} = require('../src/tagging/AutoTagRunner');
const _ = require('lodash');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const Recovery = require('../src/tagging/AutoTagRecovery.js');
const SeriesSearch = require('../src/tagging/SeriesSearch.js');
const suite = createSuite('Automatic series recovery and save accounting', 'integration',
  'Runs the real automatic-tagging loop with controlled searches and saves; verifies bounded retries, grouping, cancellation and counts.');
const PARENT = 'tt1000001', OTHER = 'tt1000002';
const video = (number, extra = {}) => ({id:`video-${number}`,kind:'show',series:'Example',season:'1',episode:String(number),
  title:number === 1 ? 'Example S01E1' : `Named story ${number}`,filename:`/Shows/Example/Season 1/episode-${number}.mkv`,new:true,...extra});
const accepted = (input, parent = PARENT) => ({status:'matched',reason:{code:'identity-accepted'},evidence:{kind:'episode'},video:{...input,
  title:`Named story ${input.episode}`,imdbID:`tt200000${input.episode}`,seriesImdbID:parent}});
const ambiguous = () => ({status:'ambiguous',reason:{code:'ambiguous-series'},failure:'Ambiguous series',retryable:false,
  choices:[{imdbID:PARENT},{imdbID:OTHER}]});

function established(extra = {}) {
  const r = Recovery.createRecovery();
  for (const n of [2,3]) {const v=video(n,extra);r.observe(v,accepted(v));}
  return r;
}

suite.test('catalog titles cannot manufacture independent evidence from unnamed originals', () => {
  const recovery = Recovery.createRecovery();
  for (const number of [2,3]) {
    const original = video(number,{title:`Example S01E${number}`});
    recovery.observe(original,accepted(original));
  }
  assert.strictEqual(recovery.parentFor(video(1),ambiguous()),null);
});

suite.test('one independently named episode resolves the parent without granting permission to tag other episodes', () => {
  const r=Recovery.createRecovery(), one=video(2);
  r.observe(one,accepted(one));
  assert.strictEqual(r.parentFor(video(1),ambiguous()).seriesID,PARENT);
  r.observe({...one,id:'duplicate',filename:'/Shows/Example/Season 1/duplicate.mkv'},accepted(one));
  assert.strictEqual(r.parentFor(video(1),ambiguous()).seriesID,PARENT);
  r.observe(video(3),accepted(video(3)));
  assert.strictEqual(r.parentFor(video(1),ambiguous()).seriesID,PARENT);
  assert.strictEqual(r.parentFor(video(1,{filename:'/Shows/Example/Other series/one.mkv'}),ambiguous()),null);
  assert.strictEqual(r.parentFor(video(1,{series:'Example (2020)'}),ambiguous()),null);
  assert.strictEqual(r.parentFor(video(1,{seriesImdbID:OTHER}),ambiguous()),null);
  assert.strictEqual(r.parentFor(video(1),{...ambiguous(),choices:[{imdbID:OTHER}]}),null);
});

suite.test('never resolves conflicting parents or uses generic/bonus/invalid evidence for retries', () => {
  const r=established();r.observe(video(4),accepted(video(4),OTHER));
  assert.strictEqual(r.parentFor(video(1),ambiguous()),null);
  const generic=Recovery.createRecovery();
  for(const n of [2,3]){const v=video(n);generic.observe(v,{...accepted(v),video:{...accepted(v).video,title:`Episode #1.${n}`}});}
  assert.strictEqual(generic.parentFor(video(1),ambiguous()),null);
  const valid=established();
  for(const title of ['Loglady','Pilot Loglady','Story - Surviving Clips']) {
    assert.strictEqual(valid.parentFor(video(1,{title}),ambiguous()),null);
  }
  for(const failure of ['No results','Not enough data','Episode mismatch']) {
    assert.strictEqual(valid.parentFor(video(1),{status:'unmatched',reason:{code:'episode-mismatch',message:'Actual title disagreement'},failure}),null);
  }
  assert.strictEqual(valid.parentFor(video(1),{status:'unmatched',failure:'Episode mismatch',reason:{code:'unconfirmed-series'}}).seriesID,PARENT);
});

async function runBatch(responder, options={}) {
  const saves=[],requests=[],messages=[],logs=[];
  const context={_,AutoTagRecovery:Recovery,autoTagRunning:false,autoTagCancelRequested:false,
    autoTagScope:'library',autoTagCancellationDecision:null,
    validSeriesImdbID:id=>/^tt\d+$/.test(id),
    win:{webContents:{send:(channel,message)=>messages.push({channel,message})}},
    library:{settings:{preferences:{remove_autotagged_from_new:false}},whenIdle:async()=>{}},
    autoTagLog:Object.fromEntries(['info','warn','error','debug'].map(level=>[level,(message,data)=>logs.push({level,message,data})])),
    saveBatch:async batch=>{assert.strictEqual(new Set(batch.map(v=>v.id)).size,batch.length,'Duplicate IDs within one save batch');saves.push(_.cloneDeep(batch));},
    OmdbHelper:{createSeriesSearchSession:SeriesSearch.createSession,seriesSearchSummary:SeriesSearch.sessionSummary,
      resolve:async(input,searchOptions)=>{requests.push({input:_.cloneDeep(input),options:searchOptions});return responder(input,searchOptions,context);}}
  };
  const state = {running:false, cancelRequested:false, scope:'library', cancellationDecision:null};
  Object.defineProperties(context, {
    autoTagRunning:{get:()=>state.running},
    autoTagCancelRequested:{get:()=>state.cancelRequested,set:value=>{state.cancelRequested=value;}}
  });
  const run=createAutoTagRunner({state, catalog:context.OmdbHelper, log:context.autoTagLog,
    getCandidates:()=>[], save:context.saveBatch, notifyStatus:message=>messages.push({channel:'status-update',message}),
    chooseSeries:async()=>null, preferences:context.library.settings.preferences, whenIdle:context.library.whenIdle});
  const result=await run({videos:[video(1),video(2),video(3)],...options});
  return {result,saves,requests,messages,logs,context};
}

suite.test('the real loop retries early ambiguity once, saves the final result and counts each file once', async () => {
  const r=await runBatch((v,o)=>v.episode==='1'&&!o.seriesImdbID?ambiguous():accepted(v));
  assert.strictEqual(r.requests.length,4);
  assert.strictEqual(r.requests[3].options.seriesImdbID,PARENT);
  const session = r.requests[0].options.seriesSearchSession;
  assert(session && session.queries instanceof Map);
  assert(r.requests.every(request=>request.options.seriesSearchSession===session),
    'Initial attempts and recovery retries must share fix78 discovery caching and diagnostics');
  assert.strictEqual(r.result.statistics.totalVideos,3);
  assert.strictEqual(r.result.statistics.processedVideos,3);
  assert.strictEqual(r.result.statistics.Success,3);
  assert.strictEqual(r.result.statistics['Ambiguous series'],0);
  assert.strictEqual(r.result.statistics.recoveredSeriesRetries,1);
  const final=r.saves.flat().filter(v=>v.id==='video-1').pop();
  assert.strictEqual(final.imdbID,'tt2000001');assert.strictEqual(final.new,true);
  assert.strictEqual(r.context.autoTagRunning,false);
  assert(r.logs.some(l=>l.message==='Automatic tagging series retry finished'&&l.data.id==='video-1'));
  assert.strictEqual(r.logs.filter(l=>l.message==='Automatic tagging series discovery summary').length,1);
});

suite.test('a failed retry saves its final reason without inflating success counts or looping', async () => {
  const r=await runBatch((v,o)=>v.episode==='1'?(o.seriesImdbID?
    {status:'unmatched',failure:'Episode mismatch',reason:{code:'episode-mismatch',message:'Different episode part numbers'}}:ambiguous()):accepted(v));
  assert.strictEqual(r.requests.length,4);
  assert.strictEqual(r.result.statistics.Success,2);
  assert.strictEqual(r.result.statistics['Ambiguous series'],0);
  assert.strictEqual(r.result.statistics['Episode mismatch'],1);
  assert.strictEqual(r.result.statistics.recoveredSeriesRetries,undefined);
  const saves=r.saves.flat().filter(v=>v.id==='video-1');
  assert.strictEqual(saves.length,2);
  assert.strictEqual(saves[1].taggingDecision.reason.code,'episode-mismatch');
  assert.strictEqual(saves[1].seriesImdbID,PARENT);
  assert.strictEqual(saves[1].taggingEvidence.identities.series.origin,'automatic');
  assert.strictEqual(saves[1].taggingEvidence.parentEvidence.confident,true);
  assert(!saves[1].imdbID);
});

suite.test('a service error during recovery clears the earlier permanent-attempt flag', async () => {
  const r=await runBatch((v,o)=>v.episode==='1'?(o.seriesImdbID?
    {status:'service-error',retryable:true,failure:'Error',reason:{code:'network-error'}}:ambiguous()):accepted(v));
  const saved=r.saves.flat().filter(v=>v.id==='video-1').pop();
  assert.strictEqual(saved.autotag_tried,false);
  assert.strictEqual(saved.taggingDecision.status,'service-error');
  assert.strictEqual(r.result.statistics.Success,2);
  assert.strictEqual(r.result.statistics.Error,1);
  assert.strictEqual(r.result.statistics['Ambiguous series'],0);
  assert.strictEqual(r.result.statistics.recoveredSeriesRetries,undefined);
  assert.strictEqual(r.requests.length,4);
});

suite.test('a first-pass service error saves a report while retaining tags and retry eligibility', async () => {
  const original=video(1,{imdbID:'tt777',seriesImdbID:PARENT,autotag_tried:true,
    taggingEvidence:{kind:'episode',imdbID:'tt777',original:{title:'Original story'}},metadata:{duration:1200}});
  const before=JSON.stringify(original);
  const r=await runBatch(()=>({status:'service-error',retryable:true,failure:'Error',
    reason:{code:'ECONNABORTED',message:'Lookup timed out'},evidence:{original:{...original}}}),
    {videos:[original],seriesBatch:{storedSeriesImdbID:OTHER}});
  assert.strictEqual(r.saves.flat().length,1);
  const saved=r.saves[0][0];
  assert.strictEqual(saved.taggingDecision.status,'service-error');
  assert.strictEqual(saved.autotag_tried,false);
  for (const field of ['title','imdbID','seriesImdbID','taggingEvidence','metadata','new']) assert.deepStrictEqual(saved[field],original[field],field);
  assert.strictEqual(r.result.statistics.processedVideos,1);
  assert.strictEqual(r.result.statistics.Error,1);
  assert.strictEqual(JSON.stringify(original),before);
});

suite.test('a thrown first-pass error is reported but cancellation leaves unattempted files untouched', async () => {
  const r=await runBatch((v,o,c)=>{c.autoTagCancelRequested=true;throw Error('offline');});
  assert.strictEqual(r.saves.flat().length,1);
  assert.strictEqual(r.saves[0][0].taggingDecision.status,'service-error');
  assert.strictEqual(r.saves[0][0].autotag_tried,false);
  assert.strictEqual(r.requests.length,1);
  assert.strictEqual(r.result.statistics.processedVideos,1);
  assert.strictEqual(r.result.statistics.remainingVideos,2);
});

suite.test('cooperative cancellation prevents the retry pass and preserves completed saves', async () => {
  const r=await runBatch((v,o,c)=>{if(v.episode==='3')c.autoTagCancelRequested=true;return v.episode==='1'?ambiguous():accepted(v);});
  assert.strictEqual(r.requests.length,3);
  assert.strictEqual(r.result.canceled,true);
  assert.strictEqual(r.result.statistics.Success,2);
  assert.strictEqual(r.saves.flat().length,3);
  assert.strictEqual(r.context.autoTagRunning,false);
});

runSuite(suite);
