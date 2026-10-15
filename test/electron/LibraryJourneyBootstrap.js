// Test-only application entry. Every mutation uses a marked temporary userData
// directory; none of these controls or dependency fixtures ship in Mynda.
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const {app,dialog,session}=require('electron');
const {EventEmitter}=require('events');
const {createSmokeTerminator,rejectUnexpectedDialogs,closeAndVerify}=require('./SmokeLifecycle');
const {videos,ids,assertSaved}=require('./LibraryJourneyFixtures');
const userData=process.env.MYNDA_E2E_USER_DATA;
const phase=process.env.MYNDA_E2E_PHASE;
assert(userData && fs.existsSync(path.join(userData,'.mynda-test-library')),'Missing isolated library marker');
assert(['exercise','restart'].includes(phase),'Unknown test phase');
app.setPath('userData',userData);
app.commandLine.appendSwitch('disable-background-timer-throttling');
const root=app.getAppPath();
let stage='startup',windowFound=false,library,background='';
const messages=[];
const finish=createSmokeTerminator({app,clearDeadline:()=>clearTimeout(deadline),
  writeResult:result=>fs.writeSync(1,'MYNDA_ELECTRON_SMOKE_RESULT:'+JSON.stringify({...result,phase,rendererConsole:messages.slice(-12)})+'\n')});
const deadline=setTimeout(()=>finish(false,{stage,error:'Library journey timed out'}),90000);
rejectUnexpectedDialogs(dialog,finish);
const unexpectedDialog=dialog.showMessageBox;
dialog.showMessageBox=(...args)=>{
  const options=args[args.length-1];
  if(phase==='exercise' && options.title==='Auto-Tag' && options.message==='Auto-tag 1 video?' &&
      JSON.stringify(options.buttons)===JSON.stringify(['Cancel','Auto-Tag'])) {
    return Promise.resolve({response:1});
  }
  return unexpectedDialog(...args);
};

// Capture the real store without exporting test controls from production code.
const libraryFile=require.resolve(path.join(root,'src/library/Library.js'));
const RealLibrary=require(libraryFile);
require.cache[libraryFile].exports=class extends RealLibrary {
  constructor(...args) {
    super(...args);library=this;
    if(phase==='exercise') {
      assert.strictEqual(this.media.length,0,'Exercise phase requires a fresh fixture');
      const mediaDirectory=path.join(userData,'media');
      fs.mkdirSync(mediaDirectory,{recursive:true});
      const fixtures=videos(mediaDirectory);
      fixtures.forEach((video,index)=>fs.writeFileSync(video.filename,'Mynda save journey fixture '+index));
      const data=JSON.parse(JSON.stringify(this.getSaveObject()));
      data.media=fixtures;
      data.settings.watchfolders=[{path:mediaDirectory,kind:'movie'}];
      data.settings.preferences.remove_autotagged_from_new=false;
      this.applyLibraryData(data);this.save();
    }
  }
};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const startupReady=deferred(),scanStarted=deferred(),scanRelease=deferred(),tagStarted=deferred(),tagRelease=deferred();
let scanArmed=false,tagRequests=0;

// Replace only the external player process. Playback coordination, event
// handling, library commits, and renderer notifications remain production code.
const mediaTools=require(path.join(root,'src/media/MediaTools.js'));
mediaTools.mpvPath=process.execPath;
const processTools=require(path.join(root,'src/media/MpvProcess.js'));
const playback={player:null,loads:[],resumes:[],stops:[]};
class FixturePlayer extends EventEmitter {
  constructor() {super();playback.player=this;}
  async load(filename) {playback.loads.push(filename);}
  async goToPosition(position) {playback.resumes.push(position);}
  async addSubtitles() {}
  async play() {}
}
const mpvModule=require.resolve('node-mpv');
require(mpvModule);
require.cache[mpvModule].exports=FixturePlayer;
processTools.startMpvPlayer=async()=>{};
processTools.stopMpvPlayer=player=>{if(player) playback.stops.push(player);};
const metadata=require(path.join(root,'src/media/MediaMetadata.js'));
metadata.retrieveMetadata=async options=>{
  assert(scanArmed && phase==='exercise','Unexpected media probe');
  scanStarted.resolve();await scanRelease.promise;
  return {...options.previous,width:3840,checked:true,video_stream_checked:true};
};
const catalog=require(path.join(root,'src/tagging/TaggingService.js'));
catalog.resolve=async video=>{
  assert(phase==='exercise' && video.id===ids[0] && ++tagRequests===1,'Unexpected catalog lookup');
  tagStarted.resolve();await tagRelease.promise;
  return {status:'matched',video:{...video,title:'Catalog Alpha',imdbID:'tt1234567'},evidence:{kind:'movie'}};
};
async function armScan() {
  scanArmed=true;
  await library.patchMedia(ids[0],{'metadata.checked':false});
}

app.on('ready',()=>{
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
});
app.on('browser-window-created',(_event,window)=>{
  let sawScan=false;
  const send=window.webContents.send.bind(window.webContents);
  window.webContents.send=(channel,...args)=>{
    if(channel==='status-update' && args[0]) {
      background=args[0].action || '';
      if(args[0].action==='check') sawScan=true;
      if(sawScan && args[0].action==='') startupReady.resolve();
    }
    return send(channel,...args);
  };
  window.webContents.on('console-message',(...args)=>{
    const entry = require('./ConsoleMessage').consoleMessage(...args);
    if(['warning','error'].includes(entry.level)) messages.push(entry.message);
  });
  window.webContents.on('preload-error',(_event,_file,error)=>finish(false,{stage:'preload',error:error.stack}));
  window.webContents.on('did-finish-load',async()=>{
    if(windowFound || !window.webContents.getURL().includes('/src/renderer/index.html')) return;
    windowFound=true;stage='library-actions';
    try {
      const result=await require('./LibraryJourneyRenderer').run({window,phase,library,playback,
        startupReady:startupReady.promise,armScan,scanStarted:scanStarted.promise,releaseScan:scanRelease.resolve,
        tagStarted:tagStarted.promise,releaseTag:tagRelease.resolve,background:()=>background,stage:value=>{stage=value;}});
      stage='graceful-close';
      closeAndVerify(window,()=>{
        const saved=JSON.parse(fs.readFileSync(path.join(userData,'Library/library.json'),'utf8'));
        assertSaved(saved);
        assert(playback.player && playback.stops.includes(playback.player), 'Closing must stop the backend player');
        assert.strictEqual(playback.player.listenerCount('timeposition'),0,'Closing must detach playback events');
        if(phase==='exercise') assert.strictEqual(tagRequests,1);
        return {stage:'complete',...result,gracefulClose:true};
      },finish);
    } catch(error) {finish(false,{stage,error:error.stack || String(error)});}
  });
});
process.on('uncaughtException',error=>finish(false,{stage,error:error.stack}));
process.on('unhandledRejection',error=>finish(false,{stage,error:error && error.stack || String(error)}));
require(path.join(root,'src/main/index.js'));
