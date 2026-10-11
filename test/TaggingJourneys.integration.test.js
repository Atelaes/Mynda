// Validate the Electron journeys' raw HTTP fixtures against the real engine.
// This runs without a display; it does not stand in for native UI execution.
const fs=require('fs'),path=require('path'),axios=require('axios');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const fixtures=require('./electron/TaggingFixtures');
const {createNetwork,redact}=require('./electron/TaggingNetwork');
const {confirmLive}=require('./electron/LiveTaggingConsent');
const checks=require('./electron/TaggingAssertions');
const Evidence=require('../src/tagging/TaggingEvidence');
const {buildTaggingReport}=require('../src/tagging/TaggingReport');
const {createAutoTagRunner}=require('../src/tagging/AutoTagRunner');
const suite=createSuite('Tagging journey catalog and live-test safeguards','integration',
  'Real request/cache/matching/application code, downloaded PNG bytes, fixture integrity, consent, budgets and secret redaction.');
const quiet={debug(){},info(){},warn(){},error(){}};
// These helpers are loaded by the native runner; requiring the portable ones
// here also catches entry-point syntax/import failures before opening Electron.
require('./electron/TaggingJourney');
require('./electron/run-tagging');
for(const scenario of ['movies','episode-parents','episode-numbering','selected','failures']) {
  suite.test(`${scenario}: raw catalog fixtures produce the explicitly expected identities`,()=>withTemporaryDirectory('tagging-contract',async directory=>{
    fs.mkdirSync(path.join(directory,'Library','Artwork'),{recursive:true});
    const imageBytes=fs.readFileSync(path.join(__dirname,'..','images','qmark.png'));
    const network=createNetwork({axios,imageBytes});
    // Observe real streams so a failed request's asynchronous close finishes
    // before the disposable directory is removed (no filesystem substitution).
    const originalCreateWriteStream=fs.createWriteStream, writes=[];
    fs.createWriteStream=function(...args) {
      const stream=originalCreateWriteStream.apply(this,args);
      writes.push(new Promise(resolve=>stream.once('close',resolve)));
      return stream;
    };
    try {
      const api=loadFreshWithMocks(path.join(__dirname,'../src/tagging/OmdbHelper.js'),{
        electron:{app:{getPath:()=>directory}},'../../omdb':{key:'fixture-only'},
        [path.join(__dirname,'../src/platform/Logger.js')]:{child:()=>quiet}
      });
      const videos=fixtures.videos(scenario,path.join(directory,'media'));
      const saved=new Map(videos.map(video=>[video.id,fixtures.copy(video)]));
      const run=createAutoTagRunner({state:{running:false},catalog:api,log:quiet,
        getCandidates:()=>videos,getLibraryVideos:()=>videos,
        save:async batch=>{for(const video of batch)saved.set(video.id,fixtures.copy(video));},
        notifyStatus(){},chooseSeries:async()=>fixtures.parents.mirror,
        preferences:{remove_autotagged_from_new:scenario!=='selected'},whenIdle:async()=>{}});
      const selected=scenario==='selected';
      await run(selected?{videos:videos.slice(0,2),scope:'selected',seriesBatch:{series:'Mirror Bay'}}:{});
      checks.verify(scenario,videos.map(video=>saved.get(video.id)));
      network.assertHealthy();assert(network.requests.length>0);
      for(const video of saved.values())if(video.artwork)assert.deepStrictEqual(fs.readFileSync(video.artwork),imageBytes);
    } finally {
      network.restore();fs.createWriteStream=originalCreateWriteStream;await Promise.all(writes);
    }
  }));
}
suite.test('manual movie and episode proposals apply real metadata and authorized images without saving the library',()=>
  withTemporaryDirectory('manual-tagging-contract',async directory=>{
    fs.mkdirSync(path.join(directory,'Library','Artwork'),{recursive:true});
    const network=createNetwork({axios,imageBytes:fs.readFileSync(path.join(__dirname,'..','images','qmark.png'))});
    try {
      const app={getPath:()=>directory};
      const catalog=loadFreshWithMocks(path.join(__dirname,'../src/tagging/OmdbHelper.js'),{
        electron:{app},'../../omdb':{key:'fixture-only'},
        [path.join(__dirname,'../src/platform/Logger.js')]:{child:()=>quiet}
      });
      const library={media:fixtures.videos('manual',path.join(directory,'media'))};
      const originals=fixtures.copy(library.media);
      const editor=require('../src/main/EditorService').createEditorService({library,catalog,app,dialog:{}});
      const results=[];
      for(const [index,draft] of originals.entries()) {
        const proposal=await editor.search(draft,'window-1');
        assert.strictEqual(proposal.status,'candidate');
        assert.deepStrictEqual(library.media,originals,'Search must leave authoritative records untouched');
        const result=await editor.select({draft,choice:{myndaProposalID:proposal.proposalID}},'window-1');
        assert.strictEqual(result.status,'matched');
        assert(editor.authorizeArtwork(result.video.artwork,'window-1'));
        assert(!editor.authorizeArtwork(result.video.artwork,'other-window'));
        assert.deepStrictEqual(library.media,originals,'Selection supplies a draft, not a commit');
        checks.matched(result.video,index===0?'tt19000002':'tt19000221');
        results.push(result.video);
      }
      checks.verify('manual',results);network.assertHealthy();
    } finally {network.restore();}
  }));
suite.test('a typed IMDb ID becomes completed match evidence only after selection, and survives serialization and refresh',()=>
  withTemporaryDirectory('explicit-id-tagging-contract',async directory=>{
    fs.mkdirSync(path.join(directory,'Library','Artwork'),{recursive:true});
    const network=createNetwork({axios,imageBytes:fs.readFileSync(path.join(__dirname,'..','images','qmark.png'))});
    try {
      const app={getPath:()=>directory};
      const catalog=loadFreshWithMocks(path.join(__dirname,'../src/tagging/OmdbHelper.js'),{
        electron:{app},'../../omdb':{key:'fixture-only'},
        [path.join(__dirname,'../src/platform/Logger.js')]:{child:()=>quiet}
      });
      const library={media:fixtures.videos('manual',path.join(directory,'media'))};
      const originals=fixtures.copy(library.media);
      const editor=require('../src/main/EditorService').createEditorService({library,catalog,app,dialog:{}});
      for(const [index,imdbID] of ['tt19000002','tt19000221'].entries()) {
        const draft=Evidence.markUserEdit({...originals[index],imdbID},{imdbID});
        assert.strictEqual(buildTaggingReport(draft),null,'Typing an ID is not a successful lookup');
        const proposal=await editor.search(draft,'window-1');
        assert.strictEqual(proposal.status,'candidate');
        const result=await editor.select({draft,choice:{myndaProposalID:proposal.proposalID}},'window-1');
        assert.strictEqual(result.status,'matched');
        assert.strictEqual(result.video.taggingEvidence.kind,'explicit-id','Entry provenance must not erase the completed lookup kind');
        checks.matched(result.video,imdbID);
        const saved=fixtures.copy({...result.video,autotag_tried:false});
        assert.strictEqual(buildTaggingReport(saved).status,'matched','The saved match must have a report');
        assert.strictEqual(saved.taggingEvidence.identities.record.origin,'user');
        assert.deepStrictEqual(library.media,originals,'Search and selection must leave the library unchanged');
        const refreshed=await catalog.tag(saved);
        assert.strictEqual(refreshed.status,'matched');
        assert.strictEqual(buildTaggingReport(refreshed.video).status,'matched');
        assert.strictEqual(refreshed.evidence.kind,'explicit-id');
        assert.deepStrictEqual(refreshed.evidence.original,saved.taggingEvidence.original);
        assert.strictEqual(refreshed.evidence.identities.record.origin,'user');
      }
      network.assertHealthy();
    } finally {network.restore();}
  }));
suite.test('live consent is required in noninteractive runs; a declined prompt is not approval',async()=>{
  await assert.rejects(confirmLive({interactive:false,yes:false}),/explicit --yes/);
  assert.strictEqual(await confirmLive({interactive:true,yes:false,ask:async()=>''}),false);
  assert.strictEqual(await confirmLive({interactive:true,yes:false,ask:async()=>'no'}),false);
  assert.strictEqual(await confirmLive({interactive:true,yes:false,ask:async()=>'yes'}),true);
  assert.strictEqual(await confirmLive({interactive:false,yes:true}),true);
});
suite.test('live HTTP and renderer requests share a hard budget and unknown hosts are blocked',async()=>{
  let requests=0;
  const client=axios.create({adapter:async config=>{requests++;return {status:200,headers:{},config,
    data:JSON.stringify({...fixtures.records[0],Poster:'https://m.media-amazon.com/example.png'})};}});
  const network=createNetwork({axios:client,imageBytes:Buffer.alloc(0),live:true,limit:2});
  try {
    await client.get('https://www.omdbapi.com/?apikey=secret&i=tt19000001');
    network.begin('https://m.media-amazon.com/example.png','renderer');
    await assert.rejects(client.get('https://www.omdbapi.com/?apikey=secret&i=tt19000002'),/limit/);
    assert.strictEqual(requests,1,'Budget exhaustion must happen before the real adapter');
    assert.throws(()=>network.begin('https://example.invalid/unknown'),'Unexpected host');
    assert.strictEqual(network.requests.length,2);
    assert(!JSON.stringify(network.requests).includes('secret'));
  } finally {network.restore();}
});
suite.test('provider failures are distinguished from application assertions without leaking credentials',async()=>{
  const key='fixture-secret-value';
  const client=axios.create({adapter:async()=>{throw new Error('failure at https://www.omdbapi.com/?apikey='+key);}});
  const network=createNetwork({axios:client,imageBytes:Buffer.alloc(0),live:true,secret:key});
  try {
    await assert.rejects(client.get('https://www.omdbapi.com/?apikey='+key),error=>
      error.code==='MYNDA_TEST_PROVIDER' && !error.message.includes(key));
    assert.strictEqual(network.issues[0].category,'provider');
    assert(!JSON.stringify(network.issues).includes(key));
    assert(!redact('key='+key+' /?apikey='+encodeURIComponent(key),key).includes(key));
  } finally {network.restore();}
});
suite.test('retained request diagnostics redact credentials in poster URLs as well as API calls',()=>
  withTemporaryDirectory('tagging-ledger',async directory=>{
    const key='fixture-poster-secret',file=path.join(directory,'requests.json');
    const client=axios.create({adapter:async config=>({status:200,headers:{},config,
      data:JSON.stringify({...fixtures.records[0],Poster:'https://img.omdbapi.com/image?apikey='+key})})});
    const network=createNetwork({axios:client,live:true,secret:key,file});
    try {
      await client.get('https://www.omdbapi.com/?apikey='+key+'&i=tt19000001');
      network.begin('https://img.omdbapi.com/image?apikey='+key,'renderer');
      const bytes=fs.readFileSync(file,'utf8');
      assert(!bytes.includes(key));assert.strictEqual(JSON.parse(bytes).requests.length,2);
      network.assertHealthy();
    } finally {network.restore();}
  }));
suite.test('restart validation cannot silently make fresh catalog requests',async()=>{
  const client=axios.create({adapter:async()=>{throw Error('Must not reach transport');}});
  const network=createNetwork({axios:client,imageBytes:Buffer.alloc(0),restart:true});
  try {await assert.rejects(client.get('https://www.omdbapi.com/?i=tt19000001'),/Restart/);}
  finally {network.restore();}
});
runSuite(suite);
