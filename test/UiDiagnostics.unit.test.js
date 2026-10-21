const {EventEmitter}=require('events');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {createUiDiagnostics:createMain}=require('../src/main/UiDiagnostics');
const {createUiDiagnostics:createRenderer}=require('../src/renderer/UiDiagnostics');
const LibraryClient=require('../src/library/LibraryClient');
const {libraryFixture,videoFixture}=require('./helpers/Fixtures');
const {makeDelta}=require('../src/library/LibraryProtocol');
const suite=createSuite('Opt-in UI responsiveness diagnostics','unit',
  'Controlled clocks distinguish blocked timers, missing frames and delayed commits without changing UI or matching behavior.');
function fixture() {
  let time=0,next=0;const timers=new Map(),frames=new Map(),logs=[];
  const target=()=>{const t=new EventEmitter();t.addEventListener=t.on;t.removeEventListener=t.removeListener;return t;};
  const window=target(),document=target();document.visibilityState='visible';document.hasFocus=()=>true;
  Object.assign(window,{setInterval:fn=>{timers.set(++next,fn);return next;},clearInterval:id=>timers.delete(id),
    requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id)});
  const log=Object.fromEntries(['info','warn','error'].map(level=>[level,(message,data)=>logs.push({level,message,data})]));
  return {window,document,timers,frames,logs,log,now:()=>time,wall:()=>100000+time,
    advance(ms){time+=ms;},tick(ms=1000){time+=ms;for(const fn of [...timers.values()])fn();},
    frame(){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn());},
    latest(){return logs.filter(x=>x.message==='UI diagnostics renderer sample').at(-1)?.data;}};
}
function renderer(f,enabled=true,extra={}) {
  return createRenderer({...f,getState:()=>({revision:7,actualNewCount:20}),
    api:{getConfig:async()=>({enabled,session:'s'})},...extra});
}
suite.test('disabled diagnostics install no timers, frames, listeners or log output',async()=>{
  const f=fixture(),d=renderer(f,false);await d.start();d.status({action:'autotag'});d.ellipsis();d.rendered({});
  assert.strictEqual(d.receive({revision:1}),null);assert.strictEqual(d.beginDelivery(null),null);d.applied(null,1);
  assert.strictEqual(f.timers.size,0);assert.strictEqual(f.frames.size,0);assert.deepStrictEqual(f.logs,[]);
  assert.deepStrictEqual(f.document.eventNames(),[]);
});
suite.test('normal timing emits ten-second summaries, not a line per video or frame',async()=>{
  const f=fixture(),d=renderer(f);await d.start();
  for(let i=0;i<1000;i++){d.status({action:'autotag',numCurrent:i,numTotal:1000});d.rendered({revision:i});d.ellipsis();f.frame();}
  assert.strictEqual(f.logs.length,1);
  for(let i=0;i<10;i++){f.frame();f.tick();}
  assert.strictEqual(f.logs.length,2);assert.strictEqual(f.latest().renders,1000);assert.strictEqual(f.latest().ellipsisTicks,1000);
  assert.strictEqual(f.latest().lastStatus.current,999);assert.strictEqual(f.latest().frameObservedRenderSequence,1000);d.stop();
});
suite.test('a stalled renderer timer records the gap and resumes sampling',async()=>{
  const f=fixture(),d=renderer(f);await d.start();f.frame();d.ellipsis();f.tick(30000);
  const warning=f.logs.find(x=>x.message==='UI diagnostics renderer timer delayed');
  assert.strictEqual(warning.data.gapMs,30000);assert.strictEqual(f.latest().frameAgeMs,30000);
  assert.strictEqual(f.latest().ellipsisAgeMs,30000);assert.strictEqual(f.latest().visibility,'visible');d.stop();
});
suite.test('healthy timers with no frame callbacks remain distinguishable from a timer stall',async()=>{
  const f=fixture(),d=renderer(f);await d.start();f.frame();d.rendered({revision:8});
  for(let i=0;i<10;i++)f.tick();
  assert(!f.logs.some(x=>x.level==='warn'));assert.strictEqual(f.latest().frameAgeMs,10000);
  assert.strictEqual(f.latest().renderSequence,1);assert.strictEqual(f.latest().frameObservedRenderSequence,0);
  f.frame();f.document.emit('visibilitychange');assert.strictEqual(f.latest().frameObservedRenderSequence,1);d.stop();
});
suite.test('visibility and focus transitions are captured without changing the window or timer policy',async()=>{
  const f=fixture(),d=renderer(f);await d.start();f.document.visibilityState='hidden';f.document.emit('visibilitychange');
  assert.strictEqual(f.latest().visibility,'hidden');f.window.emit('blur');assert.strictEqual(f.latest().event,'blur');
  f.document.visibilityState='visible';f.window.emit('focus');assert.strictEqual(f.latest().event,'focus');
  assert.strictEqual(f.timers.size,1);assert.strictEqual(f.frames.size,1);d.stop();
});
suite.test('commit transit, queue waiting and application timings are separate and carry revision numbers',async()=>{
  const f=fixture(),d=renderer(f);await d.start();f.advance(500);
  const received=d.receive({revision:8,diagnostics:{session:'s',savedAt:100000}});
  f.advance(700);const start=d.beginDelivery(received);f.advance(40);d.applied(start,8);
  d.rendered({revision:8,stateMatchesLibrary:true,newTabCount:19});f.frame();f.window.emit('focus');
  const s=f.latest();assert.strictEqual(s.maxTransitMs,500);assert.strictEqual(s.maxQueueMs,700);assert.strictEqual(s.maxDeliveryMs,40);
  assert.strictEqual(s.lastReceived.revision,8);assert.strictEqual(s.lastApplied.revision,8);assert.strictEqual(s.lastRendered.newTabCount,19);d.stop();
});
suite.test('stop and page teardown remove every timer and listener, including pending initialization',async()=>{
  const f=fixture(),d=renderer(f);await d.start();f.window.emit('pagehide');
  assert.strictEqual(f.timers.size,0);assert.strictEqual(f.frames.size,0);assert.deepStrictEqual(f.window.eventNames(),[]);
  let resolve;const pending=renderer(f,true,{api:{getConfig:()=>new Promise(r=>{resolve=r;})}});
  const started=pending.start();pending.stop();resolve({enabled:true,session:'later'});await started;assert.strictEqual(f.timers.size,0);
});
suite.test('unavailable config and failed logging cannot break renderer startup',async()=>{
  const f=fixture(),disabled=renderer(f,true,{api:{getConfig:async()=>{throw Error('offline');}}});await disabled.start();assert.strictEqual(f.timers.size,0);
  const d=renderer(f,true,{log:{info(){throw Error('log failed');},warn(){throw Error('log failed');}}});
  await d.start();assert.doesNotThrow(()=>f.tick(30000));d.stop();
});
function main(f,enabled=true) {
  const win=new EventEmitter(),power=new EventEmitter();Object.assign(win,{isFocused:()=>true,isVisible:()=>true,isMinimized:()=>false,
    webContents:{getLastWebPreferences:()=>({backgroundThrottling:true})}});
  const d=createMain({...f,enabled,getState:()=>({tagging:true,revision:9}),timers:f.window});d.attach(win,power);return {d,win,power};
}
suite.test('backend samples and lifecycle signals survive a renderer that sends nothing',()=>{
  const f=fixture(),{d,win,power}=main(f);d.phase('series-retries',{total:400});d.activity({matches:50});
  f.tick(10000);win.emit('unresponsive');power.emit('resume');
  const samples=f.logs.filter(x=>x.message==='UI diagnostics backend sample');assert(samples.some(x=>x.data.event==='periodic'));
  assert(samples.some(x=>x.data.event==='window-unresponsive'));assert(samples.some(x=>x.data.event==='system-resume'));
  assert.strictEqual(samples.at(-1).data.phase,'series-retries');assert.strictEqual(samples.at(-1).data.work.matches,50);
  win.emit('closed');assert.strictEqual(f.timers.size,0);assert.deepStrictEqual(power.eventNames(),[]);
});
suite.test('backend records commit latency with bounded warnings and clock-stall information',()=>{
  const f=fixture(),{d}=main(f);const start=d.beginCommit();f.advance(1400);
  const data=d.endCommit(start,{revision:10,committed:true,changedAddresses:10,queueLength:0});
  assert.strictEqual(data.commitMs,1400);assert.strictEqual(data.savedAt,101400);
  for(let i=0;i<4;i++){const t=d.beginCommit();f.advance(1000);d.endCommit(t,{revision:11+i,committed:true});}
  assert.strictEqual(f.logs.filter(x=>x.message==='UI diagnostics slow library commit').length,1);
  f.tick(20000);assert(f.logs.some(x=>x.message==='UI diagnostics backend timer delayed'));d.stop();
});
suite.test('disabled backend leaves commit responses and window behavior untouched',()=>{
  const f=fixture(),{d,win}=main(f,false);d.phase('test');d.status({});
  assert.strictEqual(d.beginCommit(),null);assert.strictEqual(d.endCommit(null,{}),undefined);
  assert.strictEqual(d.config().enabled,false);assert.strictEqual(f.timers.size,0);assert.deepStrictEqual(win.eventNames(),[]);assert.deepStrictEqual(f.logs,[]);
});
suite.test('real library client delivers identical committed state with diagnostics on and off',async()=>{
  const initial=libraryFixture({media:[videoFixture({id:'v',new:true})]});
  const next={...initial,media:initial.media.map(v=>({...v,new:false}))};
  const message={session:'library',revision:1,delta:makeDelta(initial,next),addresses:['media.id=v'],
    diagnostics:{session:'s',savedAt:100000}};
  for(const enabled of [false,true]){
    const f=fixture(),d=renderer(f,enabled),notifications=[];await d.start();
    const api={snapshot:async()=>({session:'library',revision:0,data:initial,paths:{}}),
      onCommitted(){},onCloseCanceled(){},onPrepareClose(){}};
    const client=new LibraryClient({api,initialData:initial,log:f.log,onSaved:a=>notifications.push(a)});await client.ready;
    notifications.length=0;client.diagnostics=d;await client.receive(message);
    assert.deepStrictEqual(client.getSaveObject(),next);assert.deepStrictEqual(notifications,['media.id=v']);
    assert.strictEqual(client.revision,1);assert(!JSON.stringify(client.getSaveObject()).includes('diagnostics'));
    d.stop();
  }
});
runSuite(suite);
