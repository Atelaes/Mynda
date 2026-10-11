const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {consoleMessage}=require('./electron/ConsoleMessage');
const suite=createSuite('Electron console diagnostics','unit','Preserves warning/error diagnostics across the console-message API change.');
suite.test('reads the modern event fields and retains warning and error severity',()=>{
  for(const level of ['warning','error','info','debug']) {
    assert.deepStrictEqual(consoleMessage({level,message:'Details',lineNumber:42,sourceId:'renderer.js'}),
      {level,message:'Details',line:42,source:'renderer.js'});
  }
});
suite.test('reads legacy positional fields with equivalent severity',()=>{
  for(const [index,level] of ['debug','info','warning','error'].entries()) {
    assert.deepStrictEqual(consoleMessage({},index,'Details',42,'renderer.js'),
      {level,message:'Details',line:42,source:'renderer.js'});
  }
});
suite.test('bounds diagnostic output and tolerates missing optional fields',()=>{
  const entry=consoleMessage({level:'error',message:'x'.repeat(10000),sourceId:'y'.repeat(10000)});
  assert.strictEqual(entry.message.length,2000);assert.strictEqual(entry.source.length,1000);
  assert.strictEqual(consoleMessage({},1).message,'');
});
runSuite(suite);
