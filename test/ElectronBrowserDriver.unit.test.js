const vm=require('vm');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {browserDriver}=require('./electron/BrowserDriver');
const suite=createSuite('Electron browser-driver diagnostics','unit',
  'Renderer result transfer and actionable exceptions across the test execution boundary; no native UI simulation.');

function driver() {
  const context=vm.createContext({document:{querySelector:()=>null}});
  return browserDriver({webContents:{executeJavaScript:async source=>{
    // Model Electron's loss of renderer exception details, but evaluate the
    // driver's actual generated JavaScript in a separate context.
    try { return structuredClone(await vm.runInContext(source,context)); }
    catch (_) { throw new Error('Script failed to execute'); }
  }}});
}

suite.test('preserves ordinary, asynchronous and undefined return values',async()=>{
  const ui=driver();
  assert.deepStrictEqual(await ui.inspect((value)=>({value,enabled:true}),'a "quoted" value'),
    {value:'a "quoted" value',enabled:true});
  assert.strictEqual(await ui.inspect(async value=>value+1,41),42);
  assert.strictEqual(await ui.inspect(()=>undefined),undefined);
  assert.strictEqual(await ui.exists('#absent'),false);
});
suite.test('a missing control names both the failed action and its selector',async()=>{
  const ui=driver();
  for(const action of ['click','type']) {
    await assert.rejects(ui[action]('#absent','value'),error=>{
      assert(error.message.includes(`Renderer action failed (${action} #absent)`));
      assert(error.message.includes('Missing UI control: #absent'));
      assert(error.stack.includes('Renderer stack:'));
      return true;
    });
  }
});
suite.test('synchronous and asynchronous renderer failures preserve their original details',async()=>{
  const ui=driver();
  for(const fail of [()=>{throw new TypeError('Broken synchronous action');},
    async()=>{await Promise.resolve();throw new TypeError('Broken asynchronous action');}]) {
    await assert.rejects(ui.inspect(fail),error=>{
      assert.match(error.message,/TypeError: Broken (synchronous|asynchronous) action/);
      assert.match(error.stack,/Renderer stack:/);
      return true;
    });
  }
  await assert.rejects(ui.inspect(()=>{throw 'Non-Error failure';}),/Non-Error failure/);
});
suite.test('an execution transport failure retains the attempted action',async()=>{
  const ui=browserDriver({webContents:{executeJavaScript:async()=>{throw new Error('Window closed');}}});
  await assert.rejects(ui.click('#save'),/Renderer action failed \(click #save\): Window closed/);
});
runSuite(suite);
