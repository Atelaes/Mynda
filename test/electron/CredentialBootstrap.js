// Disposable test bootstrap only. It never ships in Mynda.
const {app,BrowserWindow,ipcMain,safeStorage} = require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=app.getAppPath();
const userData=process.env.MYNDA_CREDENTIAL_TEST_DATA;
app.setPath('userData',userData);app.disableHardwareAcceleration();
const token='synthetic-native-ui-token-for-tests-only';
const phase=process.env.MYNDA_CREDENTIAL_TEST_PHASE;
let window;
const deadline=setTimeout(()=>finish({ok:false,error:'Credential test timed out.'}),25000);
function finish(result) {
  clearTimeout(deadline);
  process.stdout.write('MYNDA_CREDENTIAL_TEST_RESULT:'+JSON.stringify(result)+'\n',()=>app.exit(result.ok?0:1));
}
process.on('uncaughtException',error=>finish({ok:false,error:error.message.replaceAll(token,'[test token]')}));
process.on('unhandledRejection',error=>finish({ok:false,error:String(error).replaceAll(token,'[test token]')}));
async function waitFor(predicate) {
  for(let i=0;i<160;i++) {
    if(await window.webContents.executeJavaScript(predicate)) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('UI condition not reached: '+predicate);
}
app.whenReady().then(async()=>{
  const config=require(path.join(root,'src/tagging/MetadataServerConfig'));
  // Synthetic server origin is injected only into this disposable test copy.
  config.defaultServerURL=process.env.MYNDA_CREDENTIAL_TEST_ORIGIN;
  const {createCredentialStore}=require(path.join(root,'src/tagging/MetadataCredentials'));
  const {verifyConnection}=require(path.join(root,'src/tagging/MetadataCredentials'));
  const supported=process.platform!=='linux'||['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend());
  let crypto=safeStorage, storage='operating-system';
  if(!supported || !await safeStorage.isAsyncEncryptionAvailable()) {
    const unavailable=createCredentialStore({userData:path.join(userData,'unavailable'),safeStorage,verify:async()=>{}});
    await assert.rejects(unavailable.save({url:config.defaultServerURL,token}),{code:'STORAGE_LOCKED'});
    crypto=require(path.join(root,'CredentialCrypto')).credentialCrypto(Buffer.alloc(32,17));
    storage='test-only AES provider; native unavailable path verified';
  }
  const store=createCredentialStore({userData,safeStorage:crypto,verify:connection=>verifyConnection(require('axios'),connection)});
  if(process.env.MYNDA_CREDENTIAL_TEST_STORAGE_ONLY==='1') {
    if(phase==='save') {
      await store.save({url:config.defaultServerURL,token});
      assert(!fs.readFileSync(store.file,'utf8').includes(token));
    } else if(phase==='restart') {
      assert.strictEqual((await store.getConfig()).token,token);
      const {createMetadataServerClient}=require(path.join(root,'src/tagging/MetadataServerClient'));
      const request=createMetadataServerClient({axios:require('axios'),server:()=>store.getConfig()});
      assert.strictEqual((await request({id:'tt0034583'})).data.Response,'False');
      await store.check();await store.remove();
    } else assert.strictEqual((await store.getStatus()).hasCredential,false);
    return finish({ok:true,phase,storage,asar:__dirname.includes('.asar')});
  }
  const {createFeatureAccess}=require(path.join(root,'src/platform/FeatureAccess'));
  const access=createFeatureAccess({requireActivation:()=>store.requireActivation()});
  const {createMetadataServerClient}=require(path.join(root,'src/tagging/MetadataServerClient'));
  const request=createMetadataServerClient({axios:require('axios'),server:()=>store.getConfig(),
    onUnauthorized:input=>store.reject(input)});
  const methods={
    'metadata.getStatus':()=>store.getStatus(), 'metadata.save':(_event,input)=>store.save(input),
    'metadata.check':()=>store.check(), 'metadata.remove':()=>store.remove(),
    'editor.search':access.protect('tagging',()=>request({id:'tt0034583'})),
  };
  const {installRendererBridge}=require(path.join(root,'src/main/RendererBridge'));
  installRendererBridge({ipcMain,methods,isTrustedSender:event=>window&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame});
  window=new BrowserWindow({show:false,width:780,height:560,webPreferences:{
    nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,preload:path.join(root,'src/preload/generated/preload.js')
  }});
  await window.loadFile(path.join(root,'credential-ui.html'));
  // Headless Linux may report a one-pixel virtual screen. Give this isolated
  // form a real viewport so the UI exercises desktop sizing.
  window.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width:780,height:560},
    viewPosition:{x:0,y:0},viewSize:{width:780,height:560},deviceScaleFactor:1,scale:1});
  await waitFor("!!document.querySelector('#license-key') && !document.querySelector('#license-key').disabled");
  if(phase==='save') {
    const blocked=await window.webContents.executeJavaScript("window.mynda.editor.search({}).catch(e=>({code:e.code,message:e.message}))");
    assert.strictEqual(blocked.code,'ACTIVATION_REQUIRED');assert.match(blocked.message,/Activate Mynda to use tagging/);
    assert.strictEqual((await store.getStatus()).hasCredential,false);
    await window.webContents.executeJavaScript(`{
      const input=document.querySelector('#license-key');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(token)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }`);
    await waitFor("!document.querySelector('button[type=submit]').disabled");
    await window.webContents.executeJavaScript("document.querySelector('button[type=submit]').click()");
    await waitFor("document.querySelector('.license-status-badge').textContent === 'Activated'");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#license-key').value"),'');
    assert(!fs.readFileSync(store.file,'utf8').includes(token));
    assert.strictEqual((await store.getConfig()).token,token);
    // Same process and same feature gate: activating in the UI immediately
    // permits the operation through real preload/IPC, without reopening Mynda.
    assert.strictEqual((await window.webContents.executeJavaScript("window.mynda.editor.search({})")).data.Response,'False');
  } else if(phase==='restart') {
    await waitFor("document.querySelector('.license-status-badge').textContent === 'Activated'");
    // A new process reads credentials outside the archive and completes an
    // actual catalog request, using the same transport as Search/Auto-Tag.
    const result=await window.webContents.executeJavaScript("window.mynda.editor.search({})");
    assert.strictEqual(result.data.Response,'False');
    await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='Check activation').click()");
    await waitFor("document.querySelector('.license-status-badge').textContent === 'Activated'");
    await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='Deactivate this computer').click()");
    await waitFor("document.querySelector('.license-status-badge').textContent === 'Not activated'");
    assert.strictEqual(await window.webContents.executeJavaScript("window.mynda.editor.search({}).catch(e=>e.code)"),'ACTIVATION_REQUIRED');
  } else {
    assert.strictEqual((await store.getStatus()).hasCredential,false);
    await assert.rejects(store.getConfig(),{code:'ACCESS_MISSING'});
    assert.strictEqual(await window.webContents.executeJavaScript("window.mynda.editor.search({}).catch(e=>e.code)"),'ACTIVATION_REQUIRED');
  }
  assert.strictEqual(await window.webContents.executeJavaScript("typeof window.mynda.metadata.getConfig"),'undefined');
  assert.strictEqual(await window.webContents.executeJavaScript("!!document.querySelector('.license-developer-options')"),false);
  finish({ok:true,phase,storage,asar:__dirname.includes('.asar')});
});
