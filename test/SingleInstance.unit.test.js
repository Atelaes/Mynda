const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {startSingleInstance} = require('../src/main/SingleInstance');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const suite = createSuite('Library single-instance startup', 'unit',
  'Keeps second app processes from loading or writing the library and focuses the original window.');

suite.test('a second process quits without loading the main application', () => {
  const calls = [];
  const result = startSingleInstance({
    app:{requestSingleInstanceLock:()=>{calls.push('lock');return false;},quit:()=>calls.push('quit')},
    start:()=>calls.push('main')
  });
  assert.strictEqual(result, false);
  assert.deepStrictEqual(calls, ['lock','quit']);
});

suite.test('the primary instance locks before importing the application and handles later launches', () => {
  const calls = [], handlers = {};
  const window = {isDestroyed:()=>false,isMinimized:()=>true,
    restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
  assert.strictEqual(startSingleInstance({
    app:{requestSingleInstanceLock:()=>{calls.push('lock');return true;},on:(name,fn)=>{handlers[name]=fn;}},
    BrowserWindow:{getAllWindows:()=>[window]}, start:()=>calls.push('main')
  }),true);
  assert.deepStrictEqual(calls,['lock','main']);
  handlers['second-instance']();
  assert.deepStrictEqual(calls,['lock','main','restore','show','focus']);
});

suite.test('the real bootstrap cannot import main before acquiring the lock', () => {
  for (const granted of [true,false]) {
    const calls=[];
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bootstrap.js'),'utf8'),{
      process:{env:{}}, require:name=>{
        if(name==='electron') return {app:{requestSingleInstanceLock:()=>{calls.push('lock');return granted;},
          quit:()=>calls.push('quit'),on:()=>{}},BrowserWindow:{getAllWindows:()=>[]}};
        if(name==='./main/SingleInstance.js') return {startSingleInstance};
        if(name==='./main/index.js') {calls.push('main');return {};}
        throw Error('Unexpected import: '+name);
      }
    });
    assert.deepStrictEqual(calls,granted?['lock','main']:['lock','quit']);
  }
});

suite.test('packaged media diagnostics stay separate from user-library startup', () => {
  const calls=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bootstrap.js'),'utf8'),{
    process:{env:{MYNDA_PACKAGED_MEDIA_SMOKE:'1'}},require:name=>calls.push(name)
  });
  assert.deepStrictEqual(calls,['./main/PackagedMediaSmoke.js']);
});

runSuite(suite);
