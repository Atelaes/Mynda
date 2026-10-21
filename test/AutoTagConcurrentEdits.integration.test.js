const _ = require('lodash');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {createAutoTagRunner} = require('../src/tagging/AutoTagRunner');
const suite=createSuite('Auto-Tag concurrent edit boundaries','integration',
  'Real batch runner retains lookup baselines, exposes save conflicts and keeps slow lookups outside commit work.');
const original={id:'one',filename:'/Movies/one.mkv',kind:'movie',title:'Original',new:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function runner({videos,resolve,save,state={running:false,cancelRequested:false}}) {
  return createAutoTagRunner({state,getCandidates:()=>videos,
    getLibraryVideos:()=>videos,save,notifyStatus:()=>{},chooseSeries:async()=>null,
    preferences:{remove_autotagged_from_new:false},whenIdle:async()=>{},
    log:{info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}},
    catalog:{createSeriesSearchSession:()=>({}),seriesSearchSummary:()=>({}),resolve}});
}

suite.test('a delayed lookup retains its original baseline while a user edit completes independently',async()=>{
  const live=[_.cloneDeep(original)],started=deferred(),finishLookup=deferred();
  let received;
  const run=runner({videos:live,resolve:async input=>{
    started.resolve();await finishLookup.promise;
    return {status:'matched',video:{...input,title:'Catalog title'},evidence:{kind:'movie'}};
  },save:async(batch,options)=>{received={batch,options};return {conflicts:[{id:'one'}]};}});
  const pending=run();await started.promise;
  // No save queue is held by the runner while this network response is pending.
  live[0]={...live[0],title:'User correction',time:100};
  assert.strictEqual(received,undefined);
  finishLookup.resolve();const result=await pending;
  assert.strictEqual(received.options.baselines[0].title,'Original');
  assert.strictEqual(received.batch[0].title,'Catalog title');
  assert.strictEqual(result.statistics.Success,0);
  assert.strictEqual(result.statistics['Changed during lookup'],1);
  assert.strictEqual(live[0].title,'User correction');
});

suite.test('bounded batches await persistence before starting later lookups',async()=>{
  const saves=[],started=deferred(),finishSave=deferred(),requests=[];
  const videos=Array.from({length:45},(_,i)=>({...original,id:String(i)}));
  const run=runner({videos,resolve:async input=>{
    requests.push(input.id);return {status:'matched',video:{...input,title:'Tagged'},evidence:{kind:'movie'}};
  },save:async(batch,options)=>{
    saves.push({batch,options});
    if(saves.length===1){started.resolve();await finishSave.promise;}
  }});
  const pending=run();await started.promise;
  assert.strictEqual(requests.length,20);assert.strictEqual(saves[0].batch.length,20);
  finishSave.resolve();await pending;
  assert.deepStrictEqual(saves.map(item=>item.batch.length),[20,20,5]);
  assert(saves.every(item=>item.options.baselines.every(video=>video.title==='Original')));
});

suite.test('cancellation flushes a partial batch below the new twenty-video boundary',async()=>{
  const state={running:false,cancelRequested:false},saves=[];
  const videos=Array.from({length:30},(_,i)=>({...original,id:String(i)}));
  const run=runner({videos,state,resolve:async input=>{
    if(input.id==='6')state.cancelRequested=true;
    return {status:'matched',video:{...input,title:'Tagged'},evidence:{kind:'movie'}};
  },save:async batch=>saves.push(batch)});
  const result=await run();
  assert.strictEqual(result.canceled,true);
  assert.deepStrictEqual(saves.map(batch=>batch.map(v=>v.id)),[['0','1','2','3','4','5','6']]);
  assert.strictEqual(state.running,false);
});

runSuite(suite);
