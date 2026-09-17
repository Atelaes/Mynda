const fs=require('fs'),path=require('path'),vm=require('vm');
const {EventEmitter}=require('events');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const {videoFixture}=require('./helpers/Fixtures');
const {createAutoTagRunner}=require('../src/tagging/AutoTagRunner');
const {describeFailure,createFailureReporter}=require('../src/main/AutoTagFailure');
const suite=createSuite('Auto-Tag storage failure and notification','integration',
  'Real atomic writes with injected disk errors, rollback, retry eligibility, queue progress and visible terminal errors.');

function fixture(directory,count=25) {
  const policy={code:null,point:'write',writes:0,failOn:1};
  const primary=path.join(directory,'Library','library.json');
  const descriptors=new Map();
  const fail=()=>{throw Object.assign(new Error(`${policy.code}: simulated filesystem error`),{code:policy.code,syscall:policy.point});};
  const persistence=loadFreshWithMocks(path.join(__dirname,'../src/library/LibraryPersistence.js'),{fs:{...fs,
    openSync(file,...args){const fd=fs.openSync(file,...args);descriptors.set(fd,file);return fd;},
    closeSync(fd){descriptors.delete(fd);return fs.closeSync(fd);},
    writeFileSync(file,contents,...args){
      const temporary=typeof file==='number' && path.basename(String(descriptors.get(file))).startsWith('.library.json.tmp-');
      if(temporary)policy.writes++;
      if(temporary && policy.code && policy.point==='write' && policy.writes>=policy.failOn) {
        fs.writeSync(file,Buffer.from(contents).subarray(0,31));fail();
      }
      return fs.writeFileSync(file,contents,...args);
    },
    renameSync(from,to){if(to===primary && policy.code && policy.point==='rename' && policy.writes>=policy.failOn)fail();
      return fs.renameSync(from,to);}
  }});
  const logs=[],log=Object.fromEntries(['debug','info','warn','error'].map(level=>[level,
    (message,data)=>logs.push({level,message,data})]));
  const Library=loadFreshWithMocks(path.join(__dirname,'../src/library/Library.js'),{
    electron:{app:{getPath:()=>directory},ipcMain:new EventEmitter(),ipcRenderer:{}},
    './LibraryPersistence.js':persistence,'../platform/Logger.js':{child:()=>log}
  });
  const library=new Library();
  library.media=Array.from({length:count},(_,n)=>videoFixture({id:String(n+1).padStart(64,'0'),
    title:`Original ${n+1}`,filename:`/Movies/${n+1}.mkv`,imdbID:'',new:true,autotag_tried:false}));
  library.save();library.lastAutomaticBackupDate=new Date();policy.writes=0;
  const state={running:false,cancelRequested:false,scope:'library'},requests=[],statuses=[],dialogs=[];
  const save=batch=>new Promise((resolve,reject)=>library.replaceMediaBatch(batch,error=>error?reject(error):resolve()));
  const run=createAutoTagRunner({state,getCandidates:()=>library.media.filter(v=>v.new && !v.autotag_tried),
    getLibraryVideos:()=>library.media,save,log,notifyStatus:s=>statuses.push(s),chooseSeries:async()=>null,
    preferences:{remove_autotagged_from_new:true},whenIdle:()=>library.whenIdle(),catalog:{
      createSeriesSearchSession:()=>({}),seriesSearchSummary:()=>({}),
      resolve:async video=>{requests.push(video.id);return {status:'matched',evidence:{kind:'movie'},
        video:{...video,title:`Tagged ${video.title}`,imdbID:'tt'+Number(video.id)}};}
    }});
  const report=createFailureReporter({log,getLibraryPath:()=>library.path,
    dialog:{showMessageBox:async options=>{assert.strictEqual(state.running,false);dialogs.push(options);}}});
  return {library,policy,state,requests,statuses,dialogs,logs,run,report,save,persistence};
}

suite.test('a partial disk-full write preserves earlier saves, rolls back the failed batch, and reports once',()=>
  withTemporaryDirectory('autotag-disk-full',async directory=>{
    const f=fixture(directory);const originals=JSON.parse(JSON.stringify(f.library.media));
    f.policy.code='ENOSPC';f.policy.failOn=2;
    let failure;
    try {await f.run();}catch(error){failure=error;await f.report(error);}
    assert(failure);assert.strictEqual(failure.code,'ENOSPC');
    assert.deepStrictEqual(failure.autoTagFailure,{stage:'save',videoCount:10,committed:false});
    assert.strictEqual(failure.cause.cause.code,'ENOSPC');
    assert.strictEqual(f.requests.length,20);assert.strictEqual(f.dialogs.length,1);
    assert.match(f.dialogs[0].message,/out of space/);assert(f.dialogs[0].detail.includes(f.library.path));
    assert.match(f.dialogs[0].detail,/last 10 videos were not saved/);
    assert.strictEqual(f.state.running,false);assert.strictEqual(f.statuses[f.statuses.length-1].action,'');
    const disk=f.persistence.readLibraryFile(f.library.path).data;
    assert.deepStrictEqual(disk.media,f.library.media);
    assert(disk.media.slice(0,10).every(v=>v.imdbID && v.autotag_tried && !v.new));
    assert.deepStrictEqual(disk.media.slice(10),originals.slice(10));
    assert(!fs.readdirSync(path.dirname(f.library.path)).some(name=>name.includes('.tmp-')));
    assert(!f.logs.some(entry=>entry.message==='Automatic tagging batch finished'));
    // The next run includes the unsaved batch without restarting or clearing flags.
    f.policy.code=null;f.requests.length=0;
    const retry=await f.run();
    assert.strictEqual(retry.statistics.totalVideos,15);assert.strictEqual(retry.statistics.Success,15);
    assert.strictEqual(f.requests.length,15);assert.strictEqual(f.dialogs.length,1);
  }));

suite.test('failure of the final partial batch keeps its videos and primary file unchanged',()=>
  withTemporaryDirectory('autotag-final-save',async directory=>{
    const f=fixture(directory,3),before=fs.readFileSync(f.library.path);
    const originals=JSON.stringify(f.library.media);f.policy.code='ENOSPC';f.policy.point='rename';
    await assert.rejects(f.run({videos:f.library.media,scope:'selected'}),error=>{
      assert.strictEqual(error.autoTagFailure.videoCount,3);assert.strictEqual(error.code,'ENOSPC');return true;
    });
    assert.strictEqual(f.state.running,false);assert.strictEqual(f.state.scope,'library');
    assert.strictEqual(JSON.stringify(f.library.media),originals);
    assert.deepStrictEqual(fs.readFileSync(f.library.path),before);
    assert(!fs.readdirSync(path.dirname(f.library.path)).some(name=>name.includes('.tmp-')));
  }));

suite.test('a failed queued batch does not stall later jobs or idle waiters',()=>
  withTemporaryDirectory('autotag-queue-failure',async directory=>{
    const f=fixture(directory,2),original=JSON.stringify(f.library.media),failures=[];
    const pending={opType:'replace',address:'media',entry:[]};f.library.waitConfirm=pending;
    f.policy.code='ENOSPC';
    for(const v of f.library.media)f.library.replaceMediaBatch([{...v,title:'Unsaved',autotag_tried:true}],e=>failures.push(e));
    let idle=false;const waiting=f.library.whenIdle().then(()=>{idle=true;});
    f.library.getConfirm(pending);await Promise.resolve();
    assert.strictEqual(failures.length,2);assert(failures.every(e=>e.code==='ENOSPC'));
    assert.strictEqual(f.library.Queue.length,0);assert.strictEqual(f.library.waitConfirm,null);
    assert.strictEqual(idle,true);await waiting;
    assert.strictEqual(JSON.stringify(f.library.media),original);
  }));

suite.test('a post-save synchronization failure cannot roll back a committed batch',()=>
  withTemporaryDirectory('autotag-committed-save',async directory=>{
    const f=fixture(directory,1);
    f.library.sync=()=>{throw Object.assign(new Error('IPC unavailable'),{code:'ENOSPC'});};
    let failure;try {await f.run();}catch(error){failure=error;}
    assert(failure && failure.autoTagFailure.committed);
    assert(f.library.media[0].imdbID);
    assert.deepStrictEqual(f.persistence.readLibraryFile(f.library.path).data.media,f.library.media);
    const report=describeFailure(failure,f.library.path);
    assert.match(report.options.detail,/last batch was saved/);
    assert(!report.options.detail.includes('not saved'));
  }));

suite.test('storage errors retain their OS code and have specific explanations without metadata dumps',()=>
  withTemporaryDirectory('autotag-save-causes',async directory=>{
    const f=fixture(directory,1);
    for(const [code,message] of [['EDQUOT',/quota/],['EACCES',/permission/],['EPERM',/permission/],
      ['EROFS',/read-only/],['ENOENT',/unavailable/],['ENODEV',/unavailable/],['EIO',/could not be saved/]]) {
      f.policy.code=code;
      let failure;try {await f.run();}catch(error){failure=error;}
      assert(failure);assert.strictEqual(failure.code,code);
      assert.match(describeFailure(failure,f.library.path).options.message,message);
      assert(failure.cause.message.length<250);
      assert(!failure.cause.message.includes('Original 1'));
      assert.strictEqual(f.library.media[0].autotag_tried,false);
    }
  }));

suite.test('both real IPC entry points send unexpected rejection to the same failure reporter',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
  const start=source.indexOf("ipcMain.on('autotag',"),end=source.indexOf("ipcMain.on('autotag-cancel',",start);
  assert(start>=0 && end>start);
  const handlers={},received=[],error=new Error('Unexpected runner failure');
  vm.runInNewContext(source.slice(start,end),{ipcMain:{on:(name,fn)=>{handlers[name]=fn;}},
    requestAutoTag:async()=>{throw error;},requestSelectedAutoTag:async()=>{throw error;},
    reportAutoTagFailure:async(e,scope)=>{received.push({error:e,scope});}});
  handlers.autotag();handlers['autotag-selected']({},['selected-video']);await Promise.resolve();
  assert.strictEqual(received.length,2);assert(received.every(item=>item.error===error));
  assert.deepStrictEqual(received.map(item=>item.scope),['library','selected']);
});

suite.test('failure reporting still displays a dialog when logging fails and contains dialog rejection',async()=>{
  const messages=[],fallback=[];const parent={name:'window'};
  const report=createFailureReporter({getLibraryPath:()=>'/library/library.json',getWindow:()=>parent,
    log:{error(){throw new Error('Logger disk full');}},dialog:{
      showMessageBox:async(window,options)=>{assert.strictEqual(window,parent);messages.push(options);throw new Error('Window closed');},
      showErrorBox:(title,detail)=>fallback.push({title,detail})}});
  await report(new Error('Unexpected failure'));
  assert.strictEqual(messages.length,1);assert.strictEqual(fallback.length,1);
  assert.match(messages[0].message,/unexpected error/);
  assert(!messages[0].message.includes('out of space'));
  assert.match(fallback[0].detail,/Auto-Tag stopped/);
});

runSuite(suite);
