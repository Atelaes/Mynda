const fs=require('fs'),path=require('path');
const {EventEmitter}=require('events');
const {pathToFileURL}=require('url');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const suite=createSuite('Main application bridge wiring','integration',
  'Loads the real main composition with a disposable library and simulated Electron boundary. Native Chromium is covered separately.');

suite.test('startup installs isolation and the complete named API, rejecting unrelated windows and unsafe library edits',()=>
  withTemporaryDirectory('main-bridge',async directory=>{
    const root=path.resolve(__dirname,'..'), handlers=new Map(),windows=[],logs=[];
    const ipcMain=new EventEmitter();ipcMain.handle=(name,fn)=>{assert(!handlers.has(name),'Duplicate handler '+name);handlers.set(name,fn);};
    const app=new EventEmitter();Object.assign(app,{isPackaged:true,getAppPath:()=>root,
      getPath:()=>directory,getVersion:()=> 'test',quit:()=>{}});
    let start;app.whenReady=()=>({then:callback=>{start=callback;}});
    class Window extends EventEmitter {
      constructor(options) {
        super();this.options=options;windows.push(this);
        const contents=new EventEmitter();this.webContents=contents;
        Object.assign(contents,{id:1,mainFrame:{url:''},getURL:()=>contents.mainFrame.url,isDestroyed:()=>false,
          send:()=>{},setWindowOpenHandler:()=>{},session:{setPermissionCheckHandler:()=>{},setPermissionRequestHandler:()=>{}}});
      }
      isDestroyed(){return false;}
      async loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;}
    }
    const quiet=Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(...args)=>logs.push([level,...args])]));
    const Logger={child:()=>quiet,initialize:()=>{},receiveRenderer:()=>{},flush:async()=>{}};
    const tools={ffmpegPath:null,ffprobePath:null,status:()=>({ffmpeg:{available:true},ffprobe:{available:true}})};
    loadFreshWithMocks(path.join(root,'src/main/index.js'),{
      electron:{app,ipcMain,BrowserWindow:Window,dialog:{showMessageBox:async()=>{throw Error('Unexpected dialog');}},shell:{}},
      [path.join(root,'src/platform/Logger.js')]:Logger,
      [path.join(root,'src/media/MediaTools.js')]:tools,
      [path.join(root,'src/tagging/OmdbHelper.js')]:{},
      './ReactDevTools.js':async()=>null
    });
    await start();
    assert.strictEqual(windows.length,1);
    const win=windows[0],prefs=win.options.webPreferences, sender=win.webContents;
    assert.strictEqual(prefs.nodeIntegration,false);assert.strictEqual(prefs.contextIsolation,true);
    assert.strictEqual(prefs.sandbox,true);
    assert.strictEqual(prefs.preload,path.join(root,'src/preload/generated/preload.js'));
    assert.deepStrictEqual([...handlers.keys()].sort(),['external:open','library:close-ready','library:commit','library:snapshot','mynda:invoke'].sort());
    assert.strictEqual(ipcMain.eventNames().length,0,'Legacy renderer IPC remained registered');
    const event={sender,senderFrame:sender.mainFrame};
    const snapshot=handlers.get('library:snapshot')(event);
    assert.deepStrictEqual(snapshot.data.media,[]);
    assert(fs.existsSync(snapshot.paths.path));
    const bridge=handlers.get('mynda:invoke');
    assert.strictEqual((await bridge(event,'playback.getState',[])).value.status,'idle');
    assert.strictEqual((await bridge(event,'share.getState',[])).value.ok,true);
    const failed=await bridge(event,'editor.select',[{draft:{id:'a'.repeat(64)},choice:{myndaProposalID:'forged'}},999]);
    assert.strictEqual(failed.ok,false);
    const stranger={...sender};
    assert.throws(()=>handlers.get('library:snapshot')({sender:stranger,senderFrame:sender.mainFrame}),/application window/);
    assert.strictEqual((await bridge({sender:stranger,senderFrame:sender.mainFrame},'share.getState',[])).error.code,'APP_UNAUTHORIZED');
    assert.throws(()=>handlers.get('library:snapshot')({sender,senderFrame:{url:sender.getURL()}}),/application window/);
    const denied=await handlers.get('library:commit')(event,{requestId:'forged',operations:[{
      opType:'replace',address:'settings',entry:{watchfolders:[{path:directory}]},check:{present:true,value:snapshot.data.settings}
    }]});
    assert.strictEqual(denied.error.code,'INVALID_LIBRARY_OPERATION');
    assert.strictEqual(handlers.get('library:snapshot')(event).revision,snapshot.revision);
    // Startup temp-directory cleanup is asynchronous; let it settle before
    // removing the fixture so it does not observe a deleted test directory.
    await new Promise(resolve=>setImmediate(resolve));
  }));
runSuite(suite);
