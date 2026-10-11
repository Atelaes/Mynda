const path = require('path');
const {EventEmitter} = require('events');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {createBridge} = require('../src/preload/Bridge');
const {installRendererBridge,validatePayload} = require('../src/main/RendererBridge');
const suite=createSuite('Restricted renderer bridge','unit',
  'Named operations, real preload forwarding, stripped native events, caller checks and bounded plain data.');

suite.test('exposes only fixed, frozen namespaces rather than generic Node or messaging capabilities',()=>{
  const api=createBridge({invoke:()=>{},subscribe:()=>{},platform:'darwin'});
  assert(Object.isFrozen(api));
  for(const [name,value] of Object.entries(api)) {
    assert(Object.isFrozen(value),name);
    for(const forbidden of ['invoke','send','on','require','remote','ipcRenderer','fs','spawn']) assert.strictEqual(value[forbidden],undefined,name);
  }
  assert.deepStrictEqual(api.app,{platform:'darwin'});
});

suite.test('the real preload forwards named methods and never exposes native event objects',async()=>{
  const ipc=new EventEmitter(),calls=[];let api;
  ipc.invoke=async(channel,...args)=>{
    calls.push({channel,args});
    return channel==='mynda:invoke'?{ok:true,value:{status:'playing'}}:{session:'current'};
  };
  loadFreshWithMocks(path.join(__dirname,'../src/preload/index.js'),{electron:{
    ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(name,value)=>{assert.strictEqual(name,'mynda');api=value;}}
  }});
  assert.deepStrictEqual(await api.playback.play('video-id'),{status:'playing'});
  assert.deepStrictEqual(calls[0],{channel:'mynda:invoke',args:['playback.play',['video-id']]});
  assert.deepStrictEqual(await api.library.snapshot(),{session:'current'});
  assert.strictEqual(calls[1].channel,'library:snapshot');
  const received=[];
  const stop=api.events.onStatus((...args)=>received.push(args));
  ipc.emit('status-update',{sender:'privileged'}, {action:'scan'});
  assert.deepStrictEqual(received,[[{action:'scan'}]]);
  stop(); ipc.emit('status-update',{sender:'privileged'}, {action:'end'});
  assert.strictEqual(received.length,1);
  assert.throws(()=>api.events.onStatus(null),/callback/);
});

suite.test('preload preserves service failure information instead of returning a successful result',async()=>{
  let api;
  loadFreshWithMocks(path.join(__dirname,'../src/preload/index.js'),{electron:{
    ipcRenderer:{invoke:async()=>({ok:false,error:{code:'NO_FILE',message:'File unavailable'}})},
    contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}}
  }});
  await assert.rejects(api.editor.prepareArtwork('/some/file'),error=>error.code==='NO_FILE'&&error.message==='File unavailable');
});

function fixture() {
  let handler;const calls=[],sender={};
  installRendererBridge({ipcMain:{handle:(name,fn)=>{assert.strictEqual(name,'mynda:invoke');handler=fn;}},
    isTrustedSender:event=>event.sender===sender,
    methods:{'playback.play':(event,id)=>{calls.push([event.sender,id]);return {videoId:id};}}
  });
  return {calls,sender,request:(method,args,event={sender})=>handler(event,method,args)};
}
suite.test('the preload resolves a dropped File with webUtils and sends only its path through the existing approval operation',async()=>{
  const file = new File(['pixels'], 'poster.png', {type:'image/png'}), calls=[];
  let api;
  loadFreshWithMocks(path.join(__dirname,'../src/preload/index.js'),{electron:{
    webUtils:{getPathForFile(value){ assert.strictEqual(value,file); return '/images/poster.png'; }},
    ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {ok:true,value:'/approved/poster.png'};}},
    contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}}
  }});
  assert.strictEqual(file.path,undefined,'a modern File has no Electron path property');
  assert.strictEqual(await api.editor.inspectDroppedArtwork(file),'/approved/poster.png');
  assert.deepStrictEqual(calls,[['mynda:invoke','editor.inspectArtwork',['/images/poster.png']]]);
});
suite.test('pathless or invalid dropped objects never reach main-process inspection',async()=>{
  const calls=[];
  const api=createBridge({invoke:(...args)=>calls.push(args),subscribe:()=>{},platform:'linux',
    getPathForFile(file){if (!(file instanceof File)) throw new TypeError('Expected a File');return '';}});
  await assert.rejects(api.editor.inspectDroppedArtwork(new File(['pixels'],'poster.png')),/not a file on disk/);
  await assert.rejects(api.editor.inspectDroppedArtwork({path:'/private/file'}),/Expected a File/);
  assert.deepStrictEqual(calls,[]);
});
suite.test('dropped-file inspection preserves native cancellation and errors',async()=>{
  const options={subscribe:()=>{},platform:'win32',getPathForFile:()=> 'C:\\images\\poster.png'};
  const canceled=createBridge({...options,invoke:async()=>null});
  assert.strictEqual(await canceled.editor.inspectDroppedArtwork({}),null);
  const failed=createBridge({...options,invoke:async()=>{throw new Error('Image too large');}});
  await assert.rejects(failed.editor.inspectDroppedArtwork({}),/Image too large/);
});
suite.test('dispatches an approved operation with the original trusted sender',async()=>{
  const f=fixture();assert.deepStrictEqual(await f.request('playback.play',['id']),{ok:true,value:{videoId:'id'}});
  assert.deepStrictEqual(f.calls,[[f.sender,'id']]);
});
suite.test('rejects an unauthorized sender before any service work',async()=>{
  const f=fixture();const result=await f.request('playback.play',['id'],{sender:{}});
  assert.strictEqual(result.ok,false);assert.strictEqual(result.error.code,'APP_UNAUTHORIZED');assert.deepStrictEqual(f.calls,[]);
});
suite.test('rejects unknown and inherited method names, and malformed argument lists',async()=>{
  const f=fixture();
  for(const method of ['__proto__','constructor','toString','fs.readFile','playback.execute',null]) assert.strictEqual((await f.request(method,[])).ok,false);
  for(const args of [null,{},'id',new Array(5).fill('id')]) assert.strictEqual((await f.request('playback.play',args)).ok,false);
  assert.deepStrictEqual(f.calls,[]);
});
suite.test('rejects dangerous, non-plain, cyclic, non-finite and oversized request data',()=>{
  const cyclic={};cyclic.self=cyclic;
  for(const input of [cyclic,new Date(),new Map(),()=>{},Infinity,{value:NaN},JSON.parse('{"__proto__":{"x":1}}')]) {
    assert.throws(()=>validatePayload(input),/request|Unsupported|Unsafe/i);
  }
  assert.throws(()=>validatePayload(['large text'],{maxText:3}),/text/);
  assert.throws(()=>validatePayload([1,2,3],{maxNodes:2}),/large/);
  assert.throws(()=>validatePayload({a:{b:1}},{maxDepth:1}),/nested/);
  assert.doesNotThrow(()=>validatePayload([{id:'a',fields:[{path:'title',value:'Hello'}]}]));
});

runSuite(suite);
