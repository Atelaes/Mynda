'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const Migration=require('../scripts/lib/ProfileMigration');
const {defaultPaths,parseArguments}=require('../scripts/migrate-profile');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('./helpers/TestHarness');
const suite=createSuite('Offline profile and artwork migration','integration',
  'Verifies complete backups, portable artwork, credential reset, case-only installation and recovery on disposable profiles.');
const read=name=>JSON.parse(fs.readFileSync(name,'utf8'));
const write=(name,value)=>{fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,JSON.stringify(value)+'\n');};
function fixture(root) {
  const source=path.join(root,'mynda'),destination=path.join(root,'Mynda'),output=path.join(root,'private backup');
  const artwork=path.join(source,'Library','Artwork');fs.mkdirSync(artwork,{recursive:true});
  fs.writeFileSync(path.join(artwork,'poster #%.jpg'),'image bytes');
  const library={id:'private-library',settings:{watchfolders:[]},media:[{id:'active',title:'Private title',artwork:path.join(artwork,'poster #%.jpg'),ratings:{user:5}}],
    inactive_media:[{id:'inactive',artwork:path.join(artwork,'poster #%.jpg')}],playlists:[],recently_watched:['active']};
  write(path.join(source,'Library','library.json'),library);
  write(path.join(source,'Library','Backups','library-2026-01-01T00-00-00-000Z.json'),library);
  write(path.join(source,'connection','metadata-credentials.json'),{version:1,encrypted:'private-encrypted-value'});
  fs.mkdirSync(path.join(source,'logs'));fs.writeFileSync(path.join(source,'logs','mynda-info.log'),'private log\n');
  fs.writeFileSync(path.join(source,'Local State'),'browser settings');
  fs.mkdirSync(path.join(source,'empty directory'));
  return {source,destination,output,appClosed:true,library};
}
function prepared(options) {return path.join(options.output,Migration.filenames.prepared);}
function backup(options) {return path.join(options.output,Migration.filenames.backup);}

suite.test('prepares exact private backup and relative active/inactive/snapshot references without changing source',()=>
  withTemporaryDirectory('profile-prepare',async root=>{
    const f=fixture(root),before=await Migration.inventory(f.source);
    const result=await Migration.prepareMigration(f);
    assert.strictEqual(result.status,'ready');assert.strictEqual(result.active,1);assert.strictEqual(result.inactive,1);
    assert.strictEqual(result.convertedReferences,4);assert.strictEqual(result.missingArtwork,0);
    await Migration.verify(f.source,before);await Migration.verify(backup(f),before);
    const library=read(path.join(prepared(f),'Library','library.json'));
    assert.strictEqual(library.media[0].artwork,'poster #%.jpg');assert.strictEqual(library.inactive_media[0].artwork,'poster #%.jpg');
    assert.deepStrictEqual({...library.media[0],artwork:f.library.media[0].artwork},f.library.media[0]);
    assert.deepStrictEqual(read(path.join(prepared(f),'connection','metadata-credentials.json')),{version:1,removed:true});
    assert.deepStrictEqual(read(path.join(backup(f),'connection','metadata-credentials.json')),{version:1,encrypted:'private-encrypted-value'});
    if(process.platform!=='win32') {
      assert.strictEqual(fs.statSync(f.output).mode&0o777,0o700);
      assert.strictEqual(fs.statSync(path.join(backup(f),'connection','metadata-credentials.json')).mode&0o777,0o600);
      assert.strictEqual(fs.statSync(path.join(f.output,'migration.json')).mode&0o777,0o600);
    }
    assert.strictEqual((await Migration.prepareMigration(f)).status,'ready');
  }));

suite.test('converts named working libraries without replacing the active library or changing other data',()=>
  withTemporaryDirectory('profile-working-libraries',async root=>{
    const f=fixture(root),working=JSON.parse(JSON.stringify(f.library));
    working.id='real-working-library';working.media[0].title='Different working title';
    working.inactive_media.push({...working.inactive_media[0],id:'inactive-second'});
    write(path.join(f.source,'Library','library-real.json'),working);
    write(path.join(f.source,'Library','library-before-autotag.json'),working);
    const unrelated={artwork:working.media[0].artwork};
    write(path.join(f.source,'Library','other-settings.json'),unrelated);
    const result=await Migration.prepareMigration(f);
    assert.strictEqual(result.libraries,4);
    assert.strictEqual(result.convertedReferences,10);
    for(const name of ['library-real.json','library-before-autotag.json']) {
      const converted=read(path.join(prepared(f),'Library',name));
      assert.strictEqual(converted.id,'real-working-library');
      for(const group of ['media','inactive_media']) for(let i=0;i<converted[group].length;i++) {
        assert.strictEqual(converted[group][i].artwork,'poster #%.jpg');
        converted[group][i].artwork=working[group][i].artwork;
      }
      assert.deepStrictEqual(converted,working);
      assert.deepStrictEqual(read(path.join(backup(f),'Library',name)),working);
    }
    assert.strictEqual(read(path.join(prepared(f),'Library','library.json')).id,f.library.id);
    assert.deepStrictEqual(read(path.join(prepared(f),'Library','other-settings.json')),unrelated);
    assert.deepStrictEqual(read(path.join(f.source,'Library','library-real.json')),working);
  }));

suite.test('installs a case-only folder rename, retains original, and reruns without replacing live data',()=>
  withTemporaryDirectory('profile-install',async root=>{
    const f=fixture(root),before=await Migration.inventory(f.source);
    await Migration.prepareMigration(f);const result=await Migration.installMigration(f);
    assert.strictEqual(result.status,'installed');assert(fs.readdirSync(root).includes('Mynda'));assert(!fs.readdirSync(root).includes('mynda'));
    await Migration.verify(result.originalRetained,before);await Migration.verify(backup(f),before);
    assert.strictEqual(read(path.join(f.destination,'Library','library.json')).media[0].artwork,'poster #%.jpg');
    fs.writeFileSync(path.join(f.destination,'new-live-file'),'new data');
    assert.strictEqual((await Migration.installMigration(f)).status,'already-installed');
    assert.strictEqual(fs.readFileSync(path.join(f.destination,'new-live-file'),'utf8'),'new data');
  }));

suite.test('imports external artwork without basename collisions and preserves missing references',()=>
  withTemporaryDirectory('profile-external',async root=>{
    const f=fixture(root);
    const external=[];
    for(const [directory,bytes] of [['one','first'],['two','second']]) {
      const filename=path.join(root,directory,'poster.jpg');fs.mkdirSync(path.dirname(filename));fs.writeFileSync(filename,bytes);external.push(filename);
    }
    f.library.media[0].artwork=external[0];f.library.inactive_media[0].artwork=external[1];
    f.library.inactive_media.push({id:'missing',artwork:path.join(root,'missing.jpg')});
    write(path.join(f.source,'Library','library.json'),f.library);
    const result=await Migration.prepareMigration(f),library=read(path.join(prepared(f),'Library','library.json'));
    assert.strictEqual(result.importedFiles,2);assert.strictEqual(result.missingArtwork,1);
    assert.notStrictEqual(library.media[0].artwork,library.inactive_media[0].artwork);
    assert.strictEqual(fs.readFileSync(path.join(prepared(f),'Library','Artwork',library.media[0].artwork),'utf8'),'first');
    assert.strictEqual(fs.readFileSync(path.join(prepared(f),'Library','Artwork',library.inactive_media[0].artwork),'utf8'),'second');
    assert.strictEqual(library.inactive_media[1].artwork,f.library.inactive_media[1].artwork);
  }));

suite.test('preserves damaged historical snapshots and backs up symlinks without following them',()=>
  withTemporaryDirectory('profile-history',async root=>{
    const f=fixture(root);const damaged=path.join('Library','Recovery','library-damaged.json');
    fs.mkdirSync(path.dirname(path.join(f.source,damaged)),{recursive:true});fs.writeFileSync(path.join(f.source,damaged),'broken JSON');
    if(process.platform!=='win32') fs.symlinkSync('/outside/profile',path.join(f.source,'stale-link'));
    const result=await Migration.prepareMigration(f);
    assert.strictEqual(result.skippedSnapshots,1);
    assert.strictEqual(fs.readFileSync(path.join(prepared(f),damaged),'utf8'),'broken JSON');
    if(process.platform!=='win32') assert.strictEqual(fs.readlinkSync(path.join(backup(f),'stale-link')),'/outside/profile');
  }));

suite.test('requires a closed app and refuses a distinct destination or nested backup',()=>
  withTemporaryDirectory('profile-guards',async root=>{
    const f=fixture(root);
    await assert.rejects(()=>Migration.prepareMigration({...f,appClosed:false}),e=>e.code==='PROFILE_APP_OPEN');
    const other=path.join(root,'other-profile');fs.mkdirSync(other);
    await assert.rejects(()=>Migration.prepareMigration({...f,destination:other}),e=>e.code==='PROFILE_DESTINATION_EXISTS');
    await assert.rejects(()=>Migration.prepareMigration({...f,output:path.join(f.source,'backup')}),e=>e.code==='PROFILE_OUTPUT');
    if(process.platform!=='win32') {
      const alias=path.join(root,'profile-alias');fs.symlinkSync(f.source,alias);
      await assert.rejects(()=>Migration.prepareMigration({...f,output:path.join(alias,'backup')}),e=>e.code==='PROFILE_OUTPUT');
    }
  }));

suite.test('refuses source, backup and prepared modifications before any directory move',async()=>{
  for(const type of ['source','backup','prepared']) await withTemporaryDirectory('profile-changed-'+type,async root=>{
    const f=fixture(root);await Migration.prepareMigration(f);
    const target=type==='source'?f.source:type==='backup'?backup(f):prepared(f);
    fs.appendFileSync(path.join(target,'logs','mynda-info.log'),'changed');
    await assert.rejects(()=>Migration.installMigration(f),e=>e.code===`PROFILE_${type.toUpperCase()}_CHANGED`);
    assert(fs.readdirSync(root).includes('mynda'));
  });
});

suite.test('failed final rename rolls back the exact original and a retry installs successfully',()=>
  withTemporaryDirectory('profile-rollback',async root=>{
    const f=fixture(root),before=await Migration.inventory(f.source);await Migration.prepareMigration(f);
    let failed=false;
    await assert.rejects(()=>Migration.installMigration({...f,rename:async(from,to)=>{
      if(!failed && path.basename(from).startsWith('.Mynda-migration-')) {failed=true;throw Object.assign(new Error('Simulated rename failure'),{code:'EACCES'});}
      return fs.promises.rename(from,to);
    }}),e=>e.code==='EACCES');
    await Migration.verify(f.source,before);
    assert.strictEqual(read(path.join(f.output,'migration.json')).status,'ready');
    assert.strictEqual((await Migration.installMigration(f)).status,'installed');
  }));

suite.test('recovers an interruption after moving the original but before installing its replacement',()=>
  withTemporaryDirectory('profile-interrupted',async root=>{
    const f=fixture(root);await Migration.prepareMigration(f);
    const state=read(path.join(f.output,'migration.json'));
    fs.renameSync(f.source,state.originalRetained);state.status='installing';write(path.join(f.output,'migration.json'),state);
    assert.strictEqual((await Migration.installMigration(f)).status,'installed');
    assert.strictEqual(read(path.join(f.destination,'Library','library.json')).media[0].artwork,'poster #%.jpg');
  }));

suite.test('refuses linked credential directories and leaves their external files untouched',()=>
  withTemporaryDirectory('profile-links',async root=>{
    if(process.platform==='win32') return;
    const f=fixture(root),external=path.join(root,'outside-connection');
    fs.renameSync(path.join(f.source,'connection'),external);fs.symlinkSync(external,path.join(f.source,'connection'));
    const before=fs.readFileSync(path.join(external,'metadata-credentials.json'));
    await assert.rejects(()=>Migration.prepareMigration(f),e=>e.code==='PROFILE_CONNECTION_LINK');
    assert.deepStrictEqual(fs.readFileSync(path.join(external,'metadata-credentials.json')),before);
    assert.strictEqual(fs.readlinkSync(path.join(backup(f),'connection')),external);
  }));

suite.test('materializes absolute and relative managed image symlinks into portable regular files',()=>
  withTemporaryDirectory('profile-art-links',async root=>{
    if(process.platform==='win32') return;
    const f=fixture(root),art=path.join(f.source,'Library','Artwork');
    const external=path.join(root,'external.jpg');fs.writeFileSync(external,'outside bytes');
    fs.symlinkSync(path.join(art,'poster #%.jpg'),path.join(art,'managed-link.jpg'));
    fs.symlinkSync(external,path.join(art,'external-link.jpg'));
    f.library.media[0].artwork=path.join(art,'managed-link.jpg');
    f.library.inactive_media[0].artwork='external-link.jpg';
    write(path.join(f.source,'Library','library.json'),f.library);
    const result=await Migration.prepareMigration(f);assert.strictEqual(result.importedFiles,2);assert.strictEqual(result.missingArtwork,0);
    const library=read(path.join(prepared(f),'Library','library.json'));
    for(const video of [library.media[0],library.inactive_media[0]]) {
      assert(video.artwork.startsWith('imported-'));
      assert(fs.lstatSync(path.join(prepared(f),'Library','Artwork',video.artwork)).isFile());
    }
    assert.strictEqual(fs.readFileSync(path.join(prepared(f),'Library','Artwork',library.inactive_media[0].artwork),'utf8'),'outside bytes');
  }));

suite.test('refuses a symlink masquerading as an imported-image destination',()=>
  withTemporaryDirectory('profile-art-collision',async root=>{
    if(process.platform==='win32') return;
    const f=fixture(root),external=path.join(root,'external.jpg');fs.writeFileSync(external,'image');
    const hash=require('crypto').createHash('sha256').update('image').digest('hex');
    fs.symlinkSync(external,path.join(f.source,'Library','Artwork',`imported-${hash}.jpg`));
    f.library.media[0].artwork=external;write(path.join(f.source,'Library','library.json'),f.library);
    await assert.rejects(()=>Migration.prepareMigration(f),e=>e.code==='PROFILE_ARTWORK_COLLISION');
    assert.strictEqual(fs.readFileSync(external,'utf8'),'image');
  }));

suite.test('rejects altered journal directory locations before touching any profile',()=>
  withTemporaryDirectory('profile-journal',async root=>{
    const f=fixture(root);await Migration.prepareMigration(f);
    const file=path.join(f.output,'migration.json'),state=read(file);state.originalRetained=path.join(root,'unrelated');write(file,state);
    await assert.rejects(()=>Migration.installMigration(f),e=>e.code==='PROFILE_STATE_INVALID');
    assert(fs.readdirSync(root).includes('mynda'));
  }));

suite.test('CLI prints counts and paths without private titles, logs or credential contents',()=>
  withTemporaryDirectory('profile-cli',async root=>{
    const f=fixture(root),script=path.join(__dirname,'..','scripts','migrate-profile.js');
    const args=[script,'--source',f.source,'--destination',f.destination,'--output',f.output,'--app-closed'];
    const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000});
    assert.strictEqual(result.status,0,result.stderr);const summary=JSON.parse(result.stdout);
    assert.strictEqual(summary.status,'ready');
    for(const value of ['Private title','private-encrypted-value','private log','poster #%.jpg']) assert(!result.stdout.includes(value));
    const install=spawnSync(process.execPath,[...args,'--install'],{encoding:'utf8',timeout:10000});
    assert.strictEqual(install.status,0,install.stderr);assert.strictEqual(JSON.parse(install.stdout).status,'installed');
    assert.strictEqual(spawnSync(process.execPath,[script,'--output',f.output],{encoding:'utf8'}).status,1);
  }));

suite.test('default names follow productName on all platforms and incomplete CLI options fail',()=>{
  assert.deepStrictEqual(defaultPaths('darwin',{},'/Users/test'),{source:'/Users/test/Library/Application Support/mynda',destination:'/Users/test/Library/Application Support/Mynda'});
  assert.strictEqual(defaultPaths('linux',{XDG_CONFIG_HOME:'/config'},'/home/test').destination,'/config/Mynda');
  assert.strictEqual(defaultPaths('win32',{APPDATA:'C:\\Roaming'},'C:\\Users\\test').destination,'C:\\Roaming\\Mynda');
  assert.throws(()=>parseArguments(['--output']));assert.throws(()=>parseArguments(['--what']));
});
runSuite(suite);
