const {EventEmitter}=require('events');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {createSmokeTerminator,rejectUnexpectedDialogs,closeAndVerify}=require('./electron/SmokeLifecycle');
const suite=createSuite('Electron smoke-test lifecycle','unit',
  'Failure teardown exits without interactive shutdown, while success requires real window closure and saved-data verification.');

suite.test('failure writes its result before exiting and never initiates normal quit',()=>{
  const calls=[];
  const finish=createSmokeTerminator({
    app:{exit:code=>calls.push(['exit',code]),quit:()=>{throw Error('Must not run graceful quit after test failure');}},
    clearDeadline:()=>calls.push(['clear']),writeResult:result=>calls.push(['result',result])
  });
  finish(false,{stage:'initial-render',error:'Library authorization failed'});
  finish(true,{stage:'complete'});
  assert.deepStrictEqual(calls,[['clear'],['result',{ok:false,stage:'initial-render',error:'Library authorization failed'}],['exit',1]]);
});

suite.test('a failed result write still terminates the disposable process with failure',()=>{
  const exits=[];
  createSmokeTerminator({app:{exit:code=>exits.push(code)},clearDeadline:()=>{},writeResult:()=>{throw Error('Pipe closed');}})(true,{stage:'complete'});
  assert.deepStrictEqual(exits,[1]);
});

suite.test('successful cleanup invokes close and waits for the closed event before checking disk',()=>{
  const window=new EventEmitter(),calls=[];
  window.close=()=>calls.push('close');window.destroy=()=>{throw Error('Must exercise graceful close');};
  closeAndVerify(window,()=>{calls.push('verify');return {gracefulClose:true};},(ok,result)=>calls.push({ok,result}));
  assert.deepStrictEqual(calls,['close']);
  window.emit('closed');
  assert.deepStrictEqual(calls,['close','verify',{ok:true,result:{gracefulClose:true}}]);
});

suite.test('a missing close-time save reports a failure even though the window closed',()=>{
  const window=new EventEmitter(),results=[];window.close=()=>{};
  closeAndVerify(window,()=>{throw Error('Deferred preference missing');},(ok,result)=>results.push({ok,result}));
  window.emit('closed');
  assert.strictEqual(results.length,1);assert.strictEqual(results[0].ok,false);
  assert.strictEqual(results[0].result.stage,'graceful-close-save');
  assert.match(results[0].result.error,/Deferred preference missing/);
});

suite.test('unexpected asynchronous native dialogs fail without opening a real modal',async()=>{
  const results=[];
  const dialog={showMessageBox:()=>{throw Error('Native dialog must not open');}};
  rejectUnexpectedDialogs(dialog,(ok,result)=>results.push({ok,result}));
  await dialog.showMessageBox({}, {title:'Pending Library Saves',message:'Renderer unavailable',detail:'Wait or cancel'});
  assert.deepStrictEqual(results,[{ok:false,result:{stage:'unexpected-dialog',
    dialog:{title:'Pending Library Saves',message:'Renderer unavailable',detail:'Wait or cancel'}}}]);
});

suite.test('synchronous and error-box dialogs are also noninteractive failures',()=>{
  const results=[],dialog={};rejectUnexpectedDialogs(dialog,(ok,result)=>results.push({ok,result}));
  dialog.showMessageBoxSync({title:'Sync dialog',message:'Unexpected'});
  dialog.showErrorBox('Error box','Unexpected startup error');
  assert.strictEqual(results.length,2);assert(results.every(result=>result.ok===false));
  assert.deepStrictEqual(results.map(result=>result.result.dialog.title),['Sync dialog','Error box']);
});

runSuite(suite);
