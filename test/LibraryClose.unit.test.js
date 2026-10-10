const {EventEmitter}=require('events');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {installLibraryClose}=require('../src/main/LibraryClose');
const suite=createSuite('Library shutdown coordination','unit',
  'Flushes requested renderer edits and committed work before closing, with explicit choices when confirmation fails.');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture({choices=[1],wait=Promise.resolve()}={}) {
  const app=new EventEmitter(),window=new EventEmitter(),handlers={},calls=[],messages=[],timers=new Map();
  let timerID=0;
  const event=()=>({preventDefault:()=>calls.push('prevent-close')});
  app.quit=()=>{calls.push('quit');app.emit('before-quit',event());};
  window.isDestroyed=()=>false;window.close=()=>{calls.push('close');window.emit('close',event());};
  window.webContents={isDestroyed:()=>false,send:(channel,message)=>messages.push({channel,message})};
  const library={stopBackgroundWrites:()=>calls.push('stop-background'),resumeWrites:()=>calls.push('resume'),
    whenIdle:()=>{calls.push('drain');return wait;}};
  const guard=installLibraryClose({app,library,getWindow:()=>window,
    ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},
    dialog:{showMessageBox:async options=>{calls.push('dialog');return {response:choices.shift()};}},
    setTimer:fn=>{const id=++timerID;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
  guard.attachWindow(window);
  return {app,window,calls,messages,timers,guard,
    close:()=>window.emit('close',event()),quit:()=>app.emit('before-quit',event()),
    ack:(error,sender=window.webContents,token=messages[messages.length-1].message.token)=>
      handlers['library:close-ready']({sender},{token,error}),
    timeout:()=>{const [id,fn]=[...timers][0];timers.delete(id);fn();}};
}

suite.test('window closing waits for renderer confirmation and ready backend commits, then closes once',async()=>{
  const commit=deferred(),f=fixture({wait:commit.promise});f.close();
  assert.deepStrictEqual(f.calls,['prevent-close','stop-background']);
  assert.strictEqual(f.messages[0].channel,'library:prepare-close');
  assert.strictEqual(f.ack().accepted,true);await tick();
  assert(f.calls.includes('drain'));assert(!f.calls.includes('close'));
  commit.resolve();await tick();
  assert.strictEqual(f.calls.filter(item=>item==='close').length,1);
  assert.strictEqual(f.guard.isClosing(),false);
});

suite.test('a quit request during window draining shares the same handshake and exits after commits',async()=>{
  const f=fixture();f.close();f.quit();
  assert.strictEqual(f.messages.length,1);f.ack();await tick();
  assert.strictEqual(f.calls.filter(item=>item==='quit').length,1);
  assert(!f.calls.includes('close'));
});

suite.test('a renderer save failure lets the user cancel closing and resume writes',async()=>{
  const f=fixture();f.close();f.ack({message:'ENOSPC: disk full'});await tick();
  assert(f.calls.includes('dialog'));assert(f.calls.includes('resume'));
  assert(!f.calls.includes('quit'));assert(!f.calls.includes('drain'));
  assert.strictEqual(f.guard.isClosing(),false);
  assert.strictEqual(f.messages[f.messages.length-1].channel,'library:close-canceled');
});

suite.test('an unresponsive renderer requires explicit discard rather than silently losing pending edits',async()=>{
  const f=fixture({choices:[2]});f.close();f.timeout();await tick();
  assert(f.calls.includes('dialog'));assert(f.calls.includes('quit'));
  assert(!f.calls.includes('drain'));
});

suite.test('Wait requests a fresh confirmation; cancellation remains possible on the next timeout',async()=>{
  const f=fixture({choices:[0,1]});f.close();const first=f.messages[0].message.token;
  f.timeout();await tick();assert.strictEqual(f.messages.length,2);
  assert.notStrictEqual(f.messages[1].message.token,first);
  assert.strictEqual(f.ack(undefined,f.window.webContents,first).accepted,false);
  f.timeout();await tick();assert(f.calls.includes('resume'));assert(!f.calls.includes('quit'));
});

suite.test('a different window cannot acknowledge the pending renderer saves',async()=>{
  const f=fixture();f.close();assert.strictEqual(f.ack(undefined,{}).accepted,false);
  await tick();assert(!f.calls.includes('drain'));
  f.ack();await tick();assert(f.calls.includes('close'));
});

suite.test('stopping background tagging for shutdown does not show a false storage-error dialog',async()=>{
  const {createFailureReporter}=require('../src/main/AutoTagFailure');
  const dialogs=[];
  const report=createFailureReporter({getLibraryPath:()=>'/library.json',log:{info:()=>{},error:()=>{}},
    dialog:{showMessageBox:async options=>dialogs.push(options)}});
  await report(Object.assign(new Error('Auto-Tag could not finish saving'),{
    cause:Object.assign(new Error('Closing'),{code:'LIBRARY_CLOSING'}),
    autoTagFailure:{stage:'save',committed:false,videoCount:10}}));
  assert.deepStrictEqual(dialogs,[]);
});

runSuite(suite);
