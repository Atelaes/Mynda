const path = require('path');
const {assert,createSuite,runSuite,withTemporaryDirectory} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {credentialCrypto} = require('./helpers/CredentialCrypto');
const {videoFixture} = require('./helpers/Fixtures');
const {response} = require('./electron/MetadataFixtures');
const {createCredentialStore} = require('../src/tagging/MetadataCredentials');
const {createFeatureAccess,isFeatureAccessError} = require('../src/platform/FeatureAccess');
const {createEditorService} = require('../src/main/EditorService');
const {createAutoTagRunner} = require('../src/tagging/AutoTagRunner');
const {createTaskMethods} = require('../src/main/TaskService');
const {describeFailure} = require('../src/main/AutoTagFailure');
const suite = createSuite('Restricted features and live activation state','integration',
  'Real encrypted credential lifecycle, tagging composition, editor and batch entry points; synthetic HTTP only.');
const quiet = {debug(){},info(){},warn(){},error(){}};
const config = {url:'http://127.0.0.1:8787',token:'synthetic-license-for-feature-access-tests'};
const replacement = {...config,token:'synthetic-replacement-license-for-feature-tests'};
const original = () => videoFixture({id:'a'.repeat(64),imdbID:'tt0034583',autotag_tried:false});
const codeError = code => Object.assign(new Error('Private error details must stay private'),{code});
const deny = (operation,code='ACTIVATION_REQUIRED') => assert.rejects(operation,error=>{
  assert(isFeatureAccessError(error));assert(!error.message.includes(config.token));
  assert(!error.message.includes('Private error'));return error.code === code;
});
function fixture(directory) {
  const calls = {checks:0,requests:[],downloads:0,logs:[]};
  const mode = {check:null,request:null};
  const options = {userData:directory,safeStorage:credentialCrypto(),allowServerOverride:true,
    verify:async()=>{calls.checks++;if(mode.check) throw codeError(mode.check);}};
  const store = createCredentialStore(options);
  const access = createFeatureAccess({requireActivation:()=>store.requireActivation()});
  const app = {getPath:()=>directory};
  const catalog = loadFreshWithMocks(path.join(__dirname,'../src/tagging/TaggingService'),{
    electron:{app},
    '../main/FeatureAccess':access,
    '../main/MetadataConnection':{getConfig:()=>store.getConfig(),reject:input=>store.reject(input)},
    '../platform/Logger.js':{child:()=>Object.fromEntries(Object.keys(quiet).map(level=>[level,
      (...args)=>calls.logs.push(args)]))},
    '../platform/download':{download:()=>{calls.downloads++;throw Error('Unexpected artwork');}},
    axios:async request=>{
      calls.requests.push(request);
      const result = mode.request && await mode.request(request,calls.requests.length);
      if (result) return result;
      return response({Response:'True',Type:'movie',Title:'Casablanca',Year:'1942',Poster:'N/A',
        imdbID:request.data.ref.id,Runtime:'102 min',Plot:'Fixture description',Ratings:[]},{});
    }
  });
  const library = {media:[original()],inactive_media:[]};
  const editor = createEditorService({library,app,catalog,requireFeature:access.requireFeature,
    confirmationDialogIsDisabled:()=>true,
    deriveFilenameResetChanges:()=>({changes:{title:'Filename title'},watchfolderFound:true})});
  const state = {running:false}, saved=[], statuses=[];
  const run = createAutoTagRunner({state,catalog,requireFeature:access.requireFeature,log:quiet,
    getCandidates:()=>library.media,getLibraryVideos:()=>library.media,preferences:{},
    save:async batch=>saved.push(...JSON.parse(JSON.stringify(batch))),whenIdle:async()=>{},
    notifyStatus:status=>statuses.push(status),chooseSeries:async()=>null});
  return {store,options,access,app,catalog,library,editor,run,state,saved,statuses,calls,mode};
}

suite.test('every public tagging operation is blocked before catalog discovery with no key',()=>withTemporaryDirectory('feature-missing',async directory=>{
  const f=fixture(directory),before=JSON.stringify(f.library);
  for (const operation of [
    ()=>f.catalog.search(original()),()=>f.catalog.tag(original()),()=>f.catalog.resolve(original()),
    ()=>f.catalog.applyMatch({status:'candidate'}),()=>f.catalog.preflight([original()]),
    ()=>f.catalog.resolveSeriesForBatch([original()]),()=>f.catalog.resolveSeriesStructure({},[]),
    ()=>f.editor.search(original(),1),()=>f.editor.select({draft:original(),choice:{}},1),
    ()=>f.run(),()=>f.run({videos:f.library.media,scope:'selected',seriesBatch:{series:'Example'}})
  ]) await deny(operation());
  assert.strictEqual(f.calls.checks,0);assert.deepStrictEqual(f.calls.requests,[]);
  assert.deepStrictEqual(f.calls.logs,[]);assert.strictEqual(f.calls.downloads,0);
  assert.deepStrictEqual(f.saved,[]);assert.deepStrictEqual(f.statuses,[]);assert.strictEqual(f.state.running,false);
  assert.strictEqual(JSON.stringify(f.library),before);
}));

suite.test('both batch commands check access before confirmation/start and report once per action',()=>withTemporaryDirectory('feature-start',async directory=>{
  const f=fixture(directory),started=[],failures=[];
  let settled,completed;
  const complete=()=>{if (++completed===2) settled();};
  const methods=createTaskMethods({requireFeature:f.access.requireFeature,
    startTagging:()=>{started.push('library');complete();},startSelectedTagging:()=>{started.push('selected');complete();},
    reportFailure:(error,scope)=>{failures.push({error,scope});complete();}});
  const start=async()=>{
    completed=0;
    const done=new Promise(resolve=>{settled=resolve;});
    methods['tagging.start']();methods['tagging.startSelected'](null,[original().id]);
    await done;
  };
  await start();assert.deepStrictEqual(started,[]);assert.strictEqual(failures.length,2);
  assert.deepStrictEqual(failures.map(item=>item.scope),['library','selected']);
  for (const {error} of failures) {
    const dialog=describeFailure(error).options;
    assert.strictEqual(dialog.title,'Activation required');assert.match(dialog.message,/Activate Mynda to use tagging/);
  }
  await f.store.save(config);await start();assert.deepStrictEqual(started,['library','selected']);
  await f.store.remove();await start();assert.strictEqual(started.length,2);assert.strictEqual(failures.length,4);
}));

suite.test('activation and removal take effect in the same editor, including cached result application',()=>withTemporaryDirectory('feature-live',async directory=>{
  const f=fixture(directory);
  await deny(f.editor.search(original(),1));
  await f.store.save(config);
  const found=await f.editor.search(original(),1);
  assert.strictEqual(found.status,'candidate');assert.strictEqual(f.calls.requests.length,1);
  const choice={draft:original(),choice:{myndaProposalID:found.proposalID}};
  await f.store.remove();await deny(f.editor.select(choice,1));
  assert.strictEqual(f.calls.requests.length,1);assert.strictEqual(f.calls.downloads,0);
  await f.store.save(config);
  const tagged=await f.editor.select(choice,1);
  assert.strictEqual(tagged.status,'matched');assert.strictEqual(tagged.video.title,'Casablanca');
  assert.strictEqual(f.calls.requests.length,1,'cached application should need no catalog request');
  assert.strictEqual(f.calls.checks,2,'each Activate verifies; feature checks reuse that state');
  assert.deepStrictEqual(f.library.media,[original()],'the editor still only changes its draft');
}));

suite.test('a restored key is verified before the first tagging request, once for concurrent operations',()=>withTemporaryDirectory('feature-restart',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  const restarted=createCredentialStore(f.options);
  const access=createFeatureAccess({requireActivation:()=>restarted.requireActivation()});
  assert.strictEqual((await restarted.getStatus()).verified,false);
  await Promise.all(Array.from({length:40},()=>access.requireFeature('tagging')));
  assert.strictEqual(f.calls.checks,2);assert.strictEqual((await restarted.getStatus()).verified,true);
  await Promise.all(Array.from({length:40},()=>access.requireFeature('tagging')));
  assert.strictEqual(f.calls.checks,2);
}));

suite.test('an unverified saved key cannot start tagging if verification fails, and retries without restarting',()=>withTemporaryDirectory('feature-offline',async directory=>{
  const f=fixture(directory);await f.store.save(config,{check:false});
  f.mode.check='CONNECTION_FAILED';
  await deny(f.editor.search(original(),1),'ACTIVATION_CHECK_FAILED');
  assert.strictEqual(f.calls.requests.length,0);assert.strictEqual((await f.store.getStatus()).hasCredential,true);
  f.mode.check=null;
  assert.strictEqual((await f.editor.search(original(),1)).status,'candidate');
  assert.strictEqual(f.calls.checks,2);
}));

suite.test('Check activation updates the same authority, including rejection and recovery',()=>withTemporaryDirectory('feature-recheck',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  f.mode.check='ACCESS_REJECTED';await assert.rejects(f.store.check(),{code:'ACCESS_REJECTED'});
  await deny(f.catalog.tag(original()),'ACTIVATION_REJECTED');
  assert.strictEqual(f.calls.requests.length,0);assert.strictEqual(f.calls.checks,2);
  f.mode.check=null;await f.store.check();
  assert.strictEqual((await f.catalog.tag(original())).status,'matched');assert.strictEqual(f.calls.checks,3);
}));

suite.test('failed replacement preserves activation; a valid replacement is used on the next request',()=>withTemporaryDirectory('feature-replace',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  f.mode.check='ACCESS_REJECTED';await assert.rejects(f.store.save(replacement),{code:'ACCESS_REJECTED'});
  await f.catalog.resolve(original());
  assert.strictEqual(f.calls.requests[0].headers.Authorization,'Bearer '+config.token);
  f.mode.check=null;await f.store.save(replacement);await f.catalog.resolve(original());
  assert.strictEqual(f.calls.requests[1].headers.Authorization,'Bearer '+replacement.token);
}));

suite.test('explicit metadata-service rejection updates shared activation and blocks subsequent cached work',()=>withTemporaryDirectory('feature-revoked',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  const proposal=await f.catalog.resolve(original());
  f.mode.request=async()=>({status:401,data:'untrusted response containing '+config.token});
  await deny(f.catalog.resolve(original()),'ACTIVATION_REJECTED');
  assert.strictEqual((await f.store.getStatus()).verified,false);
  await deny(f.catalog.applyMatch(proposal),'ACTIVATION_REJECTED');
  await deny(f.catalog.resolve(original()),'ACTIVATION_REJECTED');
  assert.strictEqual(f.calls.requests.length,2);assert.strictEqual(f.calls.checks,1);
  f.mode.request=null;await f.store.check();
  assert.strictEqual((await f.catalog.applyMatch(proposal)).status,'matched');
}));

suite.test('ordinary server outages remain service errors and do not invalidate activation',()=>withTemporaryDirectory('feature-server-offline',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  f.mode.request=async()=>{throw Error('Network unavailable');};
  const result=await f.catalog.resolve(original());
  assert.strictEqual(result.status,'service-error');assert.strictEqual(result.reason.code,'METADATA_UNAVAILABLE');
  assert.strictEqual((await f.store.getStatus()).verified,true);
  assert.strictEqual(f.calls.checks,1);
}));

suite.test('activation loss stops a batch once, saves completed videos and leaves the blocked video untouched',()=>withTemporaryDirectory('feature-batch-revoked',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  const second=videoFixture({id:'b'.repeat(64),imdbID:'tt0034584',autotag_tried:false});
  f.library.media.push(second,videoFixture({id:'c'.repeat(64),imdbID:'tt0034585',autotag_tried:false}));
  const before=JSON.stringify(f.library.media);
  f.mode.request=async(_request,count)=>count===2 ? {status:403,data:{}} : null;
  await deny(f.run(),'ACTIVATION_REJECTED');
  assert.strictEqual(f.calls.requests.length,2);assert.strictEqual(f.saved.length,1);
  assert.strictEqual(f.saved[0].id,original().id);assert.strictEqual(f.saved[0].autotag_tried,true);
  assert.strictEqual(f.state.running,false);assert.deepStrictEqual(f.statuses.at(-1),{action:''});
  assert.strictEqual(JSON.stringify(f.library.media),before,'no blocked video gets failure evidence or attempt flags');
}));

suite.test('a result returning after local deactivation cannot be applied',()=>withTemporaryDirectory('feature-pending',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  f.mode.request=async()=>{await f.store.remove();return null;};
  await deny(f.catalog.tag(original()));
  assert.strictEqual(f.calls.requests.length,1);assert.strictEqual(f.calls.downloads,0);
  assert(!f.calls.logs.some(args=>args[0]==='Tagging decision'&&args[1].status==='matched'));
}));

suite.test('old unauthorized responses cannot revoke a newly activated key',()=>withTemporaryDirectory('feature-stale',async directory=>{
  const f=fixture(directory);await f.store.save(config);
  await f.store.save(replacement);await f.store.reject(config);
  await f.access.requireFeature('tagging');assert.strictEqual((await f.store.getStatus()).verified,true);
  assert.strictEqual(f.calls.checks,2);
}));

suite.test('verification racing with deactivation cannot restore access',()=>withTemporaryDirectory('feature-ordered',async directory=>{
  const f=fixture(directory);await f.store.save(config,{check:false});
  const checking=f.access.requireFeature('tagging'),removing=f.store.remove();
  await checking;await removing;await deny(f.access.requireFeature('tagging'));
  assert.strictEqual((await f.store.getStatus()).hasCredential,false);
}));

suite.test('canceling while activation is being checked prevents the later lookup',async()=>{
  let release,entered;
  const checking=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const service=createEditorService({app:{getPath:()=>'/unused'},library:{media:[original()]},
    requireFeature:async()=>{entered();await gate;},catalog:{resolve:()=>assert.fail('Canceled lookup started')}});
  const pending=service.search({...original(),lookupID:'pending-activation'},1);
  await checking;
  assert.strictEqual(service.cancelSearch({lookupID:'pending-activation'},1).canceled,true);
  release();assert.deepStrictEqual(await pending,{status:'canceled'});
});

suite.test('unknown features fail closed, storage errors stay explicit, and non-tagging editor work remains available',()=>withTemporaryDirectory('feature-scope',async directory=>{
  const f=fixture(directory);
  await assert.rejects(f.access.requireFeature('not-a-feature'),/Unknown feature/);
  const unavailable=createFeatureAccess({requireActivation:async()=>{throw codeError('STORAGE_LOCKED');}});
  await assert.rejects(unavailable.requireFeature('tagging'),error=>
    error.code==='ACTIVATION_UNAVAILABLE'&&/keychain/.test(error.message));
  const result=await f.editor.resetFromFilename([original()],1);
  assert(result);assert.strictEqual(f.calls.checks,0);assert.strictEqual(f.calls.requests.length,0);
}));

runSuite(suite);
