const path = require('path');
const {EventEmitter} = require('events');
const {assert,createSuite,runSuite,withTemporaryDirectory} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {libraryFixture} = require('./helpers/Fixtures');
const {show,series,episode,catalog,loadSearch} = require('./helpers/OmdbFixtures');
const Structure = require('./helpers/SeriesStructureFixture');
const Persistence = require('../src/library/LibraryPersistence');
const {createAutoTagRunner} = require('../src/tagging/AutoTagRunner');

const suite = createSuite('Auto-Tag cancellation and durable resume','integration',
  'Real discovery, recovery and atomic library saves; a fresh runner and catalog session resume only New, untried videos from disk.');
const clone = value => JSON.parse(JSON.stringify(value));
const quiet = {debug(){},info(){},warn(){},error(){}};
const candidates = library => library.media.filter(v=>v.new && !v.autotag_tried);
const input = (number,title) => show({title:title || `S1E${number}`,season:'1',episode:String(number),
  filename:`/Shows/Test Series/Season 1/${number}.mkv`});
const summary = media => media.map(v=>({id:v.id,title:v.title,imdbID:v.imdbID,seriesImdbID:v.seriesImdbID,
  catalogRef:v.catalogRef,catalogSeriesRef:v.catalogSeriesRef,season:v.season,episode:v.episode,
  new:v.new,autotag_tried:v.autotag_tried,reason:v.taggingDecision?.reason?.code}));

function libraryAt(directory,videos) {
  const primary = path.join(directory,'Library','library.json');
  if (videos) Persistence.writeLibraryFile(primary,libraryFixture({videoIdScheme:2,
    media:videos.map((v,index)=>({...v,id:String(index+1).padStart(64,'0'),new:true,autotag_tried:false}))}));
  const Library = loadFreshWithMocks(path.join(__dirname,'../src/library/Library.js'),{
    electron:{app:{getPath:()=>directory},ipcMain:new EventEmitter()},
    '../platform/Logger.js':{child:()=>quiet}
  });
  const library = new Library();
  library.lastAutomaticBackupDate = new Date();
  return library;
}

async function run(library,responder,hooks={}) {
  const state = {}, batches = [], context = {state,library,phase:'',resolves:0};
  const fixture = loadSearch(async query=>{
    const response = await responder(query);
    await hooks.afterRequest?.(query,context);
    return response;
  });
  const resolve = fixture.api.resolve;
  const api = {...fixture.api,resolve:async(video,settings)=>{
    context.resolves++;
    await hooks.beforeResolve?.(video,settings,context);
    return resolve(video,settings);
  }};
  const runner = createAutoTagRunner({state,catalog:api,
    getCandidates:()=>candidates(library),getLibraryVideos:()=>library.media,
    preferences:{remove_autotagged_from_new:true},whenIdle:()=>library.whenIdle(),chooseSeries:async()=>null,
    notifyStatus:status=>hooks.onStatus?.(status,context),
    diagnostics:{phase:phase=>{context.phase=phase;hooks.onPhase?.(phase,context);},activity(){}},
    log:Object.fromEntries(['debug','info','warn','error'].map(level=>[level,
      (message,data)=>hooks.onLog?.(message,data,context)])),
    save:async(batch,options)=>{
      assert.strictEqual(new Set(batch.map(v=>v.id)).size,batch.length,'No duplicate IDs within a commit');
      assert(batch.length<=20,'Resume must retain bounded twenty-video commits');
      await hooks.beforeSave?.(batch,options,context);
      const result = await library.patchMediaBatch(batch.map((replacement,index)=>({
        id:replacement.id,replacement,baseline:options.baselines[index]
      })),undefined,{priority:'background',conflict:'skip',coherent:true,source:'autotag'});
      batches.push(clone(batch));
      return result;
    }});
  const result = await runner();
  assert.strictEqual(state.running,false);
  assert.deepStrictEqual(Persistence.readLibraryFile(library.path).data.media,library.media);
  return {result,batches,...fixture};
}

function siblingScenario() {
  const parent = series(), other = series('tt9000001','Test Series','2020');
  const lookup = catalog([episode('Opening',1,1),episode('Arrival',1,2),episode('Return',1,3)]);
  return {videos:[input(1),input(2,'Arrival'),input(3,'Return')],
    responder:query=>query.s ? {Response:'True',Search:[parent,other]} : lookup(query)};
}

function structureScenario(ambiguous=false) {
  return {videos:Structure.videosFor({1:2,2:2}),responder:Structure.fixture({
    [Structure.A]:{1:2,2:2},[Structure.B]:ambiguous ? {1:2,2:2} : {1:3,2:3}
  }).responder};
}

async function compareResume(scenario,hooks,checkStopped) {
  return withTemporaryDirectory('autotag-resume',async directory=>{
    const baseline = libraryAt(path.join(directory,'baseline'),scenario.videos);
    await run(baseline,scenario.responder);
    assert(baseline.media.some(v=>v.imdbID),'The uninterrupted fixture must actually match videos');
    const interrupted = libraryAt(path.join(directory,'interrupted'),scenario.videos);
    const stopped = await run(interrupted,scenario.responder,hooks);
    assert.strictEqual(stopped.result.canceled,true);
    assert.strictEqual(stopped.result.statistics.remainingVideos,candidates(interrupted).length);
    await checkStopped?.(interrupted,stopped);
    // No runner, ledger, response cache or live library object survives restart.
    const restarted = libraryAt(path.join(directory,'interrupted'));
    const remaining = candidates(restarted).length;
    const resumed = await run(restarted,scenario.responder);
    assert.strictEqual(resumed.result.statistics.totalVideos,remaining);
    assert.strictEqual(resumed.result.canceled,false);
    assert.deepStrictEqual(summary(restarted.media),summary(baseline.media));
    assert.strictEqual(candidates(restarted).length,0);
    return {stopped,resumed};
  });
}

suite.test('canceling after named siblings leaves earlier ambiguity eligible after restart',()=>
  compareResume(siblingScenario(),{
    onLog:(message,data,{state})=>{if(message==='Automatic tagging finished for video' && data.title==='Return')state.cancelRequested=true;}
  },(library,{result})=>{
    assert.strictEqual(library.media[0].autotag_tried,false);
    assert.strictEqual(library.media[0].taggingDecision.reason.code,'ambiguous-series');
    assert(library.media.slice(1).every(v=>!v.new && v.autotag_tried));
    assert.strictEqual(result.statistics.Success,2);
    assert.strictEqual(result.statistics.processedVideos,2);
    assert.strictEqual(result.statistics.remainingVideos,1);
    assert.strictEqual(result.statistics.pendingRecoveryVideos,1);
    assert.strictEqual(result.statistics['Ambiguous series'],0);
  }));

for (const phase of ['series-recovery-planning','series-retries','deferred-verification']) {
  suite.test(`canceling before ${phase} preserves structural recovery after restart`,()=>
    compareResume(structureScenario(),{onPhase:(current,{state})=>{if(current===phase)state.cancelRequested=true;}},
      (library,{result})=>{
        assert.strictEqual(candidates(library).length,4);
        assert.strictEqual(result.statistics.processedVideos,0);
        assert.strictEqual(result.statistics.pendingRecoveryVideos,4);
      }));
}

suite.test('canceling within a structure lookup leaves every unresolved episode retryable',()=>
  compareResume(structureScenario(),{afterRequest:(query,{state,phase})=>{
    if(phase==='series-recovery-planning' && query.i===Structure.A && !query.Season)state.cancelRequested=true;
  }},library=>assert.strictEqual(candidates(library).length,4)));

suite.test('canceling partway through deferred recovery keeps its committed match and resumes the rest',()=>
  compareResume(structureScenario(),{onLog:(message,data,{state,phase})=>{
    if(phase==='deferred-verification' && message==='Automatic tagging finished for video')state.cancelRequested=true;
  }},(library,{result})=>{
    assert.strictEqual(library.media.filter(v=>!v.new).length,1);
    assert.strictEqual(candidates(library).length,3);
    assert.strictEqual(result.statistics.Success,1);
    assert.strictEqual(result.statistics.pendingRecoveryVideos,3);
  }));

suite.test('a first-pass no-result resumes with saved numbering witnesses',()=>
  compareResume({videos:[input(6),input(3,'Ink'),input(5,'Return')],
    responder:catalog([episode('Opening',1,1),episode('Ink',1,2),episode('Acceptance',1,3),
      episode('Return',1,4),episode('Journey',1,5)])},
  {onPhase:(phase,{state})=>{if(phase==='numbering-retries')state.cancelRequested=true;}},
  (library,{result})=>{
    assert.strictEqual(library.media[0].autotag_tried,false);
    assert.strictEqual(library.media[0].taggingDecision.reason.code,'no-results');
    assert.strictEqual(result.statistics.pendingRecoveryVideos,1);
    assert.strictEqual(result.statistics.Success,2);
  }));

suite.test('capacity-wait cancellation also retains earlier pending recovery on disk',()=>
  compareResume(siblingScenario(),{beforeResolve:async(video,settings,{state,resolves})=>{
    if(resolves!==3)return;
    await settings.seriesSearchSession.catalog.control.onCapacityWait({waiting:true,waitID:'fixture-wait'});
    state.cancelRequested=true;
    assert.strictEqual(state.cancelCapacityWait(),true);
  }},(library,{result})=>{
    assert.strictEqual(candidates(library).length,2);
    assert.strictEqual(result.statistics.processedVideos,1);
    assert.strictEqual(result.statistics.pendingRecoveryVideos,1);
  }));

suite.test('canceling a second run still leaves pending episodes eligible for a third run',()=>
  withTemporaryDirectory('autotag-repeated-resume',async directory=>{
    const scenario=siblingScenario();
    for (let attempt=0;attempt<2;attempt++) {
      const library=libraryAt(directory,attempt===0?scenario.videos:undefined);
      const stopped=await run(library,scenario.responder,{onPhase:(phase,{state})=>{
        if(phase==='series-retries')state.cancelRequested=true;
      }});
      assert.strictEqual(stopped.result.canceled,true);
      assert.strictEqual(candidates(library).length,1);
      assert.strictEqual(library.media[0].autotag_tried,false);
    }
    const restarted=libraryAt(directory),finished=await run(restarted,scenario.responder);
    assert.strictEqual(finished.result.statistics.totalVideos,1);
    assert.strictEqual(finished.result.statistics.Success,1);
    assert(restarted.media.every(v=>!v.new && v.autotag_tried && v.imdbID));
  }));

suite.test('fully reviewed ambiguity becomes complete without repeating forever or counting two attempts',()=>
  withTemporaryDirectory('autotag-final-rejections',async directory=>{
    const scenario=structureScenario(true),library=libraryAt(directory,scenario.videos);
    const stopped=await run(library,scenario.responder,{onPhase:(phase,{state})=>{
      if(phase==='finishing-saves')state.cancelRequested=true;
    }});
    assert.strictEqual(stopped.result.statistics.pendingRecoveryVideos,4);
    assert(library.media.every(v=>v.new && !v.autotag_tried));
    const restarted=libraryAt(directory),finished=await run(restarted,scenario.responder);
    assert.strictEqual(finished.result.statistics.processedVideos,4);
    assert.strictEqual(finished.result.statistics.remainingVideos,0);
    assert.strictEqual(finished.result.statistics['Ambiguous series'],4);
    assert.strictEqual(finished.result.statistics.pendingRecoveryVideos,undefined);
    assert(restarted.media.every(v=>v.new && v.autotag_tried && v.taggingDecision.status==='ambiguous'));
    const idle=await run(libraryAt(directory),scenario.responder);
    assert.strictEqual(idle.result.statistics.totalVideos,0);
    assert.strictEqual(idle.requests.length,0);
  }));

suite.test('a failed completion save leaves unresolved episodes retryable after restart',()=>
  withTemporaryDirectory('autotag-completion-save-failure',async directory=>{
    const scenario=structureScenario(true),library=libraryAt(directory,scenario.videos);
    await assert.rejects(run(library,scenario.responder,{beforeSave:(_batch,_options,{phase})=>{
      if(phase==='finishing-saves')throw Object.assign(Error('Simulated disk full'),{code:'ENOSPC'});
    }}),{name:'AutoTagSaveError',code:'ENOSPC'});
    const restarted=libraryAt(directory);
    assert.strictEqual(candidates(restarted).length,4);
    assert(restarted.media.every(v=>v.taggingDecision.status==='ambiguous'));
    await run(restarted,scenario.responder);
    assert.strictEqual(candidates(restarted).length,0);
  }));

suite.test('canceling between completion commits finalizes only the saved twenty-video batch',()=>
  withTemporaryDirectory('autotag-partial-completion',async directory=>{
    const counts={1:23,2:22},responder=Structure.fixture({[Structure.A]:counts,[Structure.B]:counts}).responder;
    const library=libraryAt(directory,Structure.videosFor(counts));
    const stopped=await run(library,responder,{beforeSave:(_batch,_options,{phase,state})=>{
      if(phase==='finishing-saves')state.cancelRequested=true;
    }});
    assert.strictEqual(stopped.result.canceled,true);
    assert.strictEqual(stopped.result.statistics.processedVideos,20);
    assert.strictEqual(stopped.result.statistics.remainingVideos,25);
    assert.strictEqual(stopped.result.statistics.pendingRecoveryVideos,25);
    assert.strictEqual(library.media.filter(v=>v.autotag_tried).length,20);
    const restarted=libraryAt(directory),finished=await run(restarted,responder);
    assert.strictEqual(finished.result.statistics.totalVideos,25);
    assert(restarted.media.every(v=>v.new && v.autotag_tried && !v.imdbID));
  }));

suite.test('final completion bookkeeping cannot overwrite a concurrent manual edit',()=>
  withTemporaryDirectory('autotag-completion-conflict',async directory=>{
    const scenario=structureScenario(true),library=libraryAt(directory,scenario.videos);
    let edited=false;
    const finished=await run(library,scenario.responder,{beforeSave:async(_batch,_options,{phase})=>{
      if(phase!=='finishing-saves' || edited)return;
      edited=true;
      await library.patchMediaBatch([{id:library.media[0].id,changes:{title:'My corrected title'}}]);
    }});
    assert.strictEqual(edited,true);
    const restarted=libraryAt(directory);
    assert.strictEqual(restarted.media[0].title,'My corrected title');
    assert.strictEqual(restarted.media[0].autotag_tried,false);
    assert.strictEqual(finished.result.statistics['Changed during lookup'],1);
    assert.strictEqual(finished.result.statistics['Ambiguous series'],3);
  }));

runSuite(suite);
