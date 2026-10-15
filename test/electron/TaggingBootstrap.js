const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {app,dialog,session} = require('electron');
const {wait} = require('./BrowserDriver');
const {closeAndVerify,createSmokeTerminator} = require('./SmokeLifecycle');
const {createNetwork} = require('./TaggingNetwork');
const fixtures = require('./TaggingFixtures');
const checks = require('./TaggingAssertions');
const directory = process.env.MYNDA_E2E_USER_DATA;
const scenario = process.env.MYNDA_TAGGING_SCENARIO;
const phase = process.env.MYNDA_E2E_PHASE;
assert(directory && fs.existsSync(path.join(directory,'.mynda-test-library')),'Missing disposable-library marker');
assert(['exercise','restart'].includes(phase));
assert(fixtures.definitions[scenario],'Unknown scenario');
app.setPath('userData',directory);
app.commandLine.appendSwitch('disable-background-timer-throttling');
const root = app.getAppPath();
const diagnostics = path.dirname(directory);
const imageBytes = fs.readFileSync(path.join(root,'images/qmark.png'));
const live = scenario === 'live';
// The disposable app receives only the server connection in memory. Production
// code still uses its ordinary configuration loader; no provider key is staged.
const config = require(path.join(root,'src/main/MetadataConnection'));
const {validateServerConfig}=require(path.join(root,'src/tagging/MetadataServerConfig'));
const server = validateServerConfig(JSON.parse(process.env.MYNDA_TEST_METADATA_CONNECTION));
config.getConfig = async () => server;
// This journey starts activated; activation itself is exercised by the
// credential UI journey and feature-access integration tests.
config.requireActivation = async () => {};
delete process.env.MYNDA_TEST_METADATA_CONNECTION;
const network = createNetwork({axios:require('axios'),imageBytes,live,server,
  file:path.join(diagnostics,'requests.json'),restart:phase==='restart'});
let library,window,stage='startup',finished=false;
const messages=[],dialogHistory=[],pendingDialogs=[];
const status={completed:0,startupReady:false,tagging:false};
const disk={fail:false};
const deadline=setTimeout(()=>finish(false,{stage,error:'Tagging journey timed out'}),live?210000:90000);
const terminate=createSmokeTerminator({app,clearDeadline:()=>clearTimeout(deadline),writeResult:result=>{
  fs.writeSync(1,'MYNDA_ELECTRON_SMOKE_RESULT:'+network.redact(JSON.stringify(result))+'\n');
}});
async function finish(ok,details) {
  if(finished)return;finished=true;
  const result={...details,phase,scenario,...(!ok?{rendererConsole:messages.slice(-30),dialogs:dialogHistory}:{})};
  if(!ok) {
    fs.writeFileSync(path.join(diagnostics,phase+'-failure.json'),network.redact(JSON.stringify(result,null,2)));
    if(window && !window.isDestroyed()) {
      await Promise.race([window.capturePage().then(image=>fs.writeFileSync(path.join(diagnostics,phase+'-failure.png'),image.toPNG())).catch(()=>{}),
        new Promise(resolve=>setTimeout(resolve,1000))]);
    }
  }
  network.restore();terminate(ok,result);
}
const dialogs={
  expect(match,response){pendingDialogs.push({match,response});},
  prepend(match,response){pendingDialogs.unshift({match,response});},
  drained(timeout=10000){return wait(()=>pendingDialogs.length===0,'expected dialogs',timeout);}
};
dialog.showMessageBox=async(...args)=>{
  const options=args[args.length-1];dialogHistory.push(options);
  const expected=pendingDialogs.shift();
  if(!expected || !expected.match(options)) {
    void finish(false,{stage:'unexpected-dialog',dialog:options});
    return {response:options.cancelId || 0};
  }
  return {response:typeof expected.response==='function'?expected.response(options):expected.response,checkboxChecked:false};
};
dialog.showMessageBoxSync=(...args)=>{void finish(false,{stage:'unexpected-sync-dialog',dialog:args[args.length-1]});return 0;};
dialog.showErrorBox=(title,message)=>{void finish(false,{stage:'unexpected-error-dialog',title,message});};
// One narrow filesystem failure, armed only by the disk-full scenario. The
// real transaction, atomic write, rollback and failure notification still run.
const rename=fs.renameSync;
fs.renameSync=function(from,to,...args) {
  if(disk.fail && to===path.join(directory,'Library','library.json'))
    throw Object.assign(new Error('ENOSPC: simulated test disk full'),{code:'ENOSPC'});
  return rename.call(fs,from,to,...args);
};
const libraryFile=require.resolve(path.join(root,'src/library/Library.js'));
const RealLibrary=require(libraryFile);
require.cache[libraryFile].exports=class extends RealLibrary {
  constructor(...args) {
    super(...args);library=this;
    if(phase==='exercise') {
      assert.strictEqual(this.media.length,0,'Fixture must start with an empty disposable library');
      const data=fixtures.copy(this.getSaveObject());
      data.media=fixtures.seed(scenario,path.join(directory,'media'),path.join(root,'images/qmark.png'));
      data.settings.watchfolders=[{path:path.join(directory,'media'),kind:'movie'}];
      data.settings.preferences.remove_edited_from_new=false;
      data.settings.preferences.remove_autotagged_from_new=scenario!=='selected';
      data.playlists.push({...fixtures.copy(data.playlists[0]),id:'e2e',name:'Test Library',filter_function:'true',view:'flat',tab:true});
      this.applyLibraryData(data);this.save();
      fs.writeFileSync(path.join(diagnostics,'originals.json'),JSON.stringify(data.media,null,2));
    }
  }
};
app.on('ready',()=>{
  if(!live) {
    // Renderer search thumbnails also stay offline. The real image loader
    // receives actual PNG bytes through its ordinary HTTPS URL.
    session.defaultSession.protocol.handle('https',request=>{
      try {const {url}=network.begin(request.url,'renderer');
        return new Response(url.pathname==='/missing.png'?'Not found':imageBytes,
          {status:url.pathname==='/missing.png'?404:200,headers:{'Content-Type':'image/png'}});
      } catch(error) {void finish(false,{stage,error:error.message});return new Response('Blocked',{status:403});}
    });
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*']},(request,callback)=>{
      callback({cancel:true});
      try {network.begin(request.url,'renderer');}
      catch(error) {void finish(false,{stage,error:error.message});}
    });
  } else {
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,callback)=>{
      try {network.begin(request.url,'renderer');callback({});}
      catch(error){callback({cancel:true});void finish(false,{stage,error:error.message});}
    });
  }
});
app.on('browser-window-created',(_event,created)=>{
  const send=created.webContents.send.bind(created.webContents);
  let sawScan=false;
  created.webContents.send=(channel,...args)=>{
    if(channel==='status-update' && args[0]) {
      const action=args[0].action;
      if(action==='check')sawScan=true;
      if(action==='autotag')status.tagging=true;
      if(action==='') {if(sawScan)status.startupReady=true;if(status.tagging){status.completed++;status.tagging=false;}}
    }
    return send(channel,...args);
  };
  created.webContents.on('console-message',(...args)=>{
    const entry=require('./ConsoleMessage').consoleMessage(...args);
    if(['error','warning'].includes(entry.level))messages.push(network.redact(entry.message));
  });
  created.webContents.on('preload-error',(_event,_file,error)=>void finish(false,{stage:'preload',error:error.stack}));
  created.webContents.on('did-finish-load',async()=>{
    if(window || !created.webContents.getURL().includes('/src/renderer/index.html'))return;
    window=created;
    try {
      await wait(()=>status.startupReady,'initial scan',20000);
      const originals=JSON.parse(fs.readFileSync(path.join(diagnostics,'originals.json'),'utf8'));
      const result=await require('./TaggingJourney').run({window,scenario,phase,library,originals,dialogs,network,status,disk,stage:value=>{stage=value;}});
      network.assertHealthy();assert.strictEqual(pendingDialogs.length,0);
      stage='graceful-close';
      closeAndVerify(window,()=>{
        const saved=JSON.parse(fs.readFileSync(library.path,'utf8'));
        checks.verify(scenario,originals.map(video=>saved.media.find(item=>item.id===video.id)));
        return {...result,stage:'complete',gracefulClose:true};
      },finish);
    } catch(error) {void finish(false,{stage,error:error.stack || String(error),issues:network.issues});}
  });
});
process.on('uncaughtException',error=>void finish(false,{stage,error:error.stack}));
process.on('unhandledRejection',error=>void finish(false,{stage,error:error && error.stack || String(error)}));
require(path.join(root,'src/main/index.js'));
