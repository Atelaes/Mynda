const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const {assert,createSuite,runSuite,withTemporaryDirectory} = require('./helpers/TestHarness');
const {createCredentialStore,verifyConnection,messages} = require('../src/tagging/MetadataCredentials');
const {defaultServerURL} = require('../src/tagging/MetadataServerConfig');
const {credentialCrypto} = require('./helpers/CredentialCrypto');
const token='synthetic-private-token-for-credential-tests';
const nextToken='synthetic-replacement-token-for-credential-tests';
const config={url:defaultServerURL,token};
const suite=createSuite('Encrypted metadata credential lifecycle','integration',
  'Real encrypted files and HTTP, with an injected OS key provider; no personal credentials or external requests.');

function fixture(directory, extra={}) {
  const options={userData:directory,legacyFile:path.join(directory,'old-settings.json'),
    safeStorage:credentialCrypto(),verify:async()=>{},allowServerOverride:true,...extra};
  return {options,store:createCredentialStore(options),restart:()=>createCredentialStore(options)};
}
const read=file=>fs.readFileSync(file,'utf8');
const rejected=(operation,code)=>assert.rejects(operation,error=>{
  assert(!error.message.includes(token));assert(!error.message.includes(nextToken));
  assert.strictEqual(error.message,messages[code]);return error.code===code;
});

suite.test('first launch returns public defaults without creating files or checking a provider',()=>withTemporaryDirectory('credentials',async d=>{
  const {store}=fixture(d,{verify:()=>assert.fail('unexpected HTTP')});
  const status=await store.getStatus();
  assert.strictEqual(status.url,defaultServerURL);assert.strictEqual(status.hasCredential,false);
  assert.strictEqual(status.token,undefined);assert(!fs.existsSync(store.file));
}));
suite.test('migration encrypts, verifies, removes the plaintext source and survives restart',()=>withTemporaryDirectory('migration',async d=>{
  const {options,store,restart}=fixture(d);
  fs.writeFileSync(options.legacyFile,JSON.stringify(config));
  assert.deepStrictEqual(await store.getConfig(),config);
  assert(!fs.existsSync(options.legacyFile));
  assert(!read(store.file).includes(token));assert(!read(store.file).includes(defaultServerURL));
  assert.deepStrictEqual(await restart().getConfig(),config);
  if(process.platform!=='win32') {
    assert.strictEqual(fs.statSync(store.file).mode&0o777,0o600);
    assert.strictEqual(fs.statSync(path.dirname(store.file)).mode&0o777,0o700);
  }
}));
suite.test('missing keychain and Linux basic_text never encrypt or remove the old settings',()=>withTemporaryDirectory('keychain',async d=>{
  for(const mode of ['locked','basic']) {
    const root=path.join(d,mode);fs.mkdirSync(root);
    const safeStorage={...credentialCrypto(),isAsyncEncryptionAvailable:async()=>mode!=='locked',
      getSelectedStorageBackend:()=>mode==='basic'?'basic_text':'gnome_libsecret',encryptStringAsync:()=>assert.fail('must not encrypt')};
    const {store,options}=fixture(root,{safeStorage,platform:'linux'});
    fs.writeFileSync(options.legacyFile,JSON.stringify(config));
    assert.strictEqual((await store.getStatus()).message,messages.STORAGE_LOCKED);
    assert(fs.existsSync(options.legacyFile));assert(!fs.existsSync(store.file));
    await rejected(store.save(config),'STORAGE_LOCKED');
  }
}));
suite.test('failed migration leaves the original file and cleans up the temporary encrypted file',()=>withTemporaryDirectory('migration-fail',async d=>{
  const {store,options}=fixture(d,{io:{...fs.promises,rename:async()=>{throw Error(token);}}});
  const original=JSON.stringify(config);fs.writeFileSync(options.legacyFile,original);
  assert.strictEqual((await store.getStatus()).message,messages.STORAGE_WRITE);
  assert.strictEqual(read(options.legacyFile),original);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(store.file)),[]);
}));
suite.test('existing encrypted settings take precedence and removal cannot resurrect an old token',()=>withTemporaryDirectory('precedence',async d=>{
  const {store,options,restart}=fixture(d);
  await store.save(config);
  fs.writeFileSync(options.legacyFile,JSON.stringify({...config,token:nextToken}));
  assert.deepStrictEqual(await restart().getConfig(),config);
  await store.remove();
  assert.strictEqual((await restart().getStatus()).hasCredential,false);
  await rejected(restart().getConfig(),'ACCESS_MISSING');
  assert(!read(store.file).includes(token));
}));
suite.test('corrupt or other-user encrypted settings never fall back to a plaintext token',()=>withTemporaryDirectory('corrupt',async d=>{
  const {store,options}=fixture(d);await store.save(config);
  fs.writeFileSync(options.legacyFile,JSON.stringify(config));
  const wrongKey=createCredentialStore({...options,safeStorage:credentialCrypto()});
  await rejected(wrongKey.getConfig(),'STORAGE_READ');
  fs.writeFileSync(store.file,'invalid '+token);
  const broken=createCredentialStore(options);
  await rejected(broken.getConfig(),'STORAGE_READ');assert(fs.existsSync(options.legacyFile));
}));
suite.test('OS key rotation refreshes the encrypted file, and a failed refresh preserves usable access',()=>withTemporaryDirectory('rotation',async d=>{
  const {store,options}=fixture(d);await store.save(config);
  const original=read(store.file);
  const safeStorage={...options.safeStorage, decryptStringAsync:async bytes=>({
    ...await options.safeStorage.decryptStringAsync(bytes), shouldReEncrypt:true
  })};
  const rotated=createCredentialStore({...options,safeStorage});
  assert.deepStrictEqual(await rotated.getConfig(),config);
  assert.notStrictEqual(read(store.file),original);
  assert.deepStrictEqual(await createCredentialStore(options).getConfig(),config);
  const refreshed=read(store.file);
  const failed=createCredentialStore({...options,safeStorage,io:{...fs.promises,rename:async()=>{throw Error(token);}}});
  assert.deepStrictEqual(await failed.getConfig(),config);
  assert.strictEqual((await failed.getStatus()).message,messages.STORAGE_WRITE);
  assert.strictEqual(read(store.file),refreshed);
}));
suite.test('rejected replacement and failed atomic write preserve the previous connection',()=>withTemporaryDirectory('replace-fail',async d=>{
  let failWrite=false,deny=false;
  const io={...fs.promises,rename:async(...args)=>{if(failWrite) throw Error(nextToken);return fs.promises.rename(...args);}};
  const {store}=fixture(d,{io,verify:async()=>{if(deny) throw Object.assign(new Error(messages.ACCESS_REJECTED),{code:'ACCESS_REJECTED'});}});
  await store.save(config);const original=read(store.file);
  deny=true;await rejected(store.save({...config,token:nextToken}),'ACCESS_REJECTED');
  deny=false;failWrite=true;await rejected(store.save({...config,token:nextToken}),'STORAGE_WRITE');
  assert.strictEqual(read(store.file),original);assert.deepStrictEqual(await store.getConfig(),config);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(store.file)),['metadata-credentials.json']);
}));
suite.test('migration retains a legacy file edited while encryption was pending',()=>withTemporaryDirectory('edited-legacy',async d=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});
  const crypto=credentialCrypto();let began;const started=new Promise(resolve=>{began=resolve;});
  const {store,options}=fixture(d,{safeStorage:{...crypto,encryptStringAsync:async value=>{began();await waiting;return crypto.encryptStringAsync(value);}}});
  fs.writeFileSync(options.legacyFile,JSON.stringify(config));
  const loading=store.getStatus();await started;
  const edited=JSON.stringify({...config,token:nextToken});fs.writeFileSync(options.legacyFile,edited);release();
  assert.strictEqual((await loading).message,messages.LEGACY_REMOVE);assert.strictEqual(read(options.legacyFile),edited);
}));
suite.test('save and remove serialize so a slow verification cannot restore removed access',()=>withTemporaryDirectory('ordered',async d=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const {store,restart}=fixture(d,{verify:()=>wait});
  const saving=store.save(config),removing=store.remove();release();await saving;await removing;
  assert.strictEqual((await restart().getStatus()).hasCredential,false);
}));
suite.test('setup refuses an overwrite and developer URL switching retains the encrypted token',()=>withTemporaryDirectory('cli-store',async d=>{
  const {store,restart}=fixture(d);await store.save(config,{check:false,onlyIfMissing:true});
  await rejected(store.save({...config,token:nextToken},{check:false,onlyIfMissing:true}),'ALREADY_CONFIGURED');
  await store.changeServer('http://127.0.0.1:8787');
  assert.deepStrictEqual(await restart().getConfig(),{url:'http://127.0.0.1:8787',token});
  await rejected(store.changeServer('http://example.org'),'INVALID_CREDENTIAL');
}));
suite.test('packaged settings cannot direct a token to an arbitrary origin',()=>withTemporaryDirectory('origin',async d=>{
  let calls=0;const {store}=fixture(d,{allowServerOverride:false,verify:async()=>{calls++;}});
  await rejected(store.save({url:'https://unrelated.example',token}),'INVALID_CREDENTIAL');
  await rejected(store.save({...config,unexpected:token}),'INVALID_CREDENTIAL');
  assert.strictEqual(calls,0);assert(!fs.existsSync(store.file));
}));
suite.test('credentials wait for Electron readiness before opening the keychain',()=>withTemporaryDirectory('ready',async d=>{
  let release,accessed=false;const wait=new Promise(resolve=>{release=resolve;});
  const crypto=credentialCrypto();
  const {store}=fixture(d,{ready:()=>wait,safeStorage:{...crypto,isAsyncEncryptionAvailable:async()=>{accessed=true;return true;}}});
  const save=store.save(config);await new Promise(resolve=>setImmediate(resolve));
  assert.strictEqual(accessed,false);release();await save;assert(accessed);
}));
suite.test('verification accepts authenticated capabilities and never follows redirects or echoes secrets',async()=>{
  let calls=0,targetCalls=0;
  const target=http.createServer((req,res)=>{targetCalls++;res.end('{}');});
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  let mode='ok';
  const server=http.createServer((req,res)=>{
    calls++;assert.strictEqual(req.url,'/v1/capabilities');assert.strictEqual(req.headers.authorization,'Bearer '+token);
    if(mode==='redirect') {res.writeHead(302,{Location:`http://127.0.0.1:${target.address().port}`});res.end();}
    else {res.writeHead(mode==='reject'?401:200,{'Content-Type':'application/json'});
      res.end(mode==='ok'?JSON.stringify({requestId:'fixture',data:{provider:'fixture'}}):JSON.stringify({error:{message:token},token}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const input={url:`http://127.0.0.1:${server.address().port}`,token};
    await verifyConnection(axios,input);
    mode='reject';await rejected(verifyConnection(axios,input),'ACCESS_REJECTED');
    mode='redirect';await rejected(verifyConnection(axios,input),'CONNECTION_FAILED');
    mode='bad';await rejected(verifyConnection(axios,input),'CONNECTION_FAILED');
    await rejected(verifyConnection(async()=>{throw Error(token);},input),'CONNECTION_FAILED');
    assert.strictEqual(calls,4);assert.strictEqual(targetCalls,0);
  } finally {server.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>target.close(r))]);}
});
runSuite(suite);
