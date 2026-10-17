const fs=require('fs'),path=require('path'),http=require('http');
const {spawn}=require('child_process');
const {build}=require('esbuild');
const asar=require('@electron/asar');
const {FileMatcher}=require('app-builder-lib/out/fileMatcher');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('../helpers/TestHarness');
const {buildRenderer}=require('../../scripts/build-renderer');
const root=path.resolve(__dirname,'../..'),useAsar=process.argv.includes('--asar');
const storageOnly=process.argv.includes('--storage-only');
const token='synthetic-native-ui-token-for-tests-only';
const suite=createSuite('Credential '+(storageOnly?'storage':'UI')+' and restart'+(useAsar?' in ASAR':''),'end-to-end',
  'Real isolated Electron renderer/IPC and HTTP; native encryption where available, otherwise a test-only AES provider plus unavailable-storage assertions.');
function launch(target,data,phase,origin) {
  return new Promise((resolve,reject)=>{
    const args=process.platform==='linux'?[...(!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY?['--ozone-platform=headless','--disable-gpu']:[]),...(process.getuid&&process.getuid()===0?['--no-sandbox']:[])]:[];
    const env={...process.env,MYNDA_CREDENTIAL_TEST_DATA:data,MYNDA_CREDENTIAL_TEST_PHASE:phase,MYNDA_CREDENTIAL_TEST_ORIGIN:origin};
    if(storageOnly) env.MYNDA_CREDENTIAL_TEST_STORAGE_ONLY='1';
    delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(require('electron'),[...args,target],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error('Electron credential test timed out.'));},35000);
    child.stdout.on('data',data=>{stdout=(stdout+data).slice(-65536);});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      try {
        const marker=stdout.split(/\r?\n/).find(line=>line.startsWith('MYNDA_CREDENTIAL_TEST_RESULT:'));
        assert(marker,'Electron exited '+code+'/'+signal+' during '+phase+' without reporting a completed credential test. '+stdout+' '+stderr);
        const result=JSON.parse(marker.slice('MYNDA_CREDENTIAL_TEST_RESULT:'.length));
        assert.strictEqual(code,0,JSON.stringify(result));assert.strictEqual(result.ok,true,JSON.stringify(result));
        assert.strictEqual(result.asar,useAsar);resolve(result);
      } catch(error) {reject(error);}
    });
  });
}
suite.test((storageOnly?'saves access':'activates from the UI')+', restarts with saved access, performs a lookup, removes access and verifies another restart',()=>
  withTemporaryDirectory('credential-electron',async directory=>{
    await buildRenderer({mode:'production'});
    const stage=path.join(directory,'app'),data=path.join(directory,'data');
    fs.mkdirSync(stage);fs.mkdirSync(data);
    const include=new FileMatcher(root,stage,value=>value,require('../../package.json').build.files).createFilter();
    for(const name of ['src/tagging/CatalogIdentity.js','src/tagging/MetadataCredentials.js','src/tagging/MetadataServerConfig.js','src/tagging/MetadataServerClient.js',
      'src/tagging/CapacityWait.js','src/platform/FeatureAccess.js','src/main/RendererBridge.js','src/preload/generated/preload.js']) {
      assert(include(path.join(root,name),fs.statSync(path.join(root,name))));
      fs.mkdirSync(path.dirname(path.join(stage,name)),{recursive:true});fs.copyFileSync(path.join(root,name),path.join(stage,name));
    }
    for(const name of ['metadata-server.local.json','metadata-credentials.json','.metadata-credentials-test.tmp']) {
      const fixture=path.join(directory,name);fs.writeFileSync(fixture,token);
      assert.strictEqual(include(path.join(root,name),fs.statSync(fixture)),false,name);
    }
    fs.copyFileSync(path.join(__dirname,'CredentialBootstrap.js'),path.join(stage,'CredentialBootstrap.js'));
    fs.copyFileSync(path.join(root,'test/helpers/CredentialCrypto.js'),path.join(stage,'CredentialCrypto.js'));
    fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'mynda-credential-test',version:'1.0.0',main:'CredentialBootstrap.js'}));
    await build({stdin:{contents:"const React=require('react'); const ReactDOM=require('react-dom'); const {LicenseActivation}=require('./src/renderer/LicenseActivation'); ReactDOM.render(React.createElement(LicenseActivation),document.getElementById('app'));",resolveDir:root},
      bundle:true,platform:'browser',loader:{'.js':'jsx'},outfile:path.join(stage,'credential-ui.js')});
    fs.writeFileSync(path.join(stage,'credential-ui.html'),`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'"><link rel="stylesheet" href="src/renderer/styles/main.css"></head><body><div id="settings-pane"><div id="settings-content"><div id="app"></div></div></div><script src="credential-ui.js"></script></body></html>`);
    fs.cpSync(path.join(root,'src/renderer/styles'),path.join(stage,'src/renderer/styles'),{recursive:true});
    fs.symlinkSync(path.join(root,'node_modules'),path.join(useAsar?directory:stage,'node_modules'),process.platform==='win32'?'junction':'dir');
    const target=useAsar?path.join(directory,'app.asar'):stage;
    if(useAsar) {
      await asar.createPackage(stage,target);
      assert(!asar.listPackage(target).some(name=>/metadata-(?:server\.local|credentials)\.json$/.test(name)));
    }
    let checks=0,lookups=0;
    const server=http.createServer((req,res)=>{
      req.resume();
      assert.strictEqual(req.headers.authorization,'Bearer '+token);
      res.setHeader('Content-Type','application/json');
      if(req.url==='/v1/capabilities') {checks++;res.end(JSON.stringify({requestId:'fixture',data:{provider:'fixture'}}));}
      else {lookups++;res.writeHead(404);res.end(JSON.stringify({requestId:'fixture',error:{code:'NOT_FOUND'}}));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const origin=`http://127.0.0.1:${server.address().port}`;
      for(const phase of ['save','restart','removed']) {
        const result=await launch(target,data,phase,origin);
        console.log('        '+phase+': '+result.storage);
      }
      assert.strictEqual(checks,storageOnly?2:3);assert.strictEqual(lookups,storageOnly?1:2);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }));
runSuite(suite);
