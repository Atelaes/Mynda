const fs = require('fs');
const path = require('path');
const readline = require('readline');
const asar = require('@electron/asar');
const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
const {assert,createSuite,removeDirectory} = require('../helpers/TestHarness');
const {buildRenderer} = require('../../scripts/build-renderer');
const {copyDirectory,launchElectron} = require('./run-electron-smoke');
const {confirmLive} = require('./LiveTaggingConsent');
const {redact} = require('./TaggingNetwork');
const {verify} = require('./TaggingAssertions');
const {definitions} = require('./TaggingFixtures');
const {connection} = require('./MetadataFixtures');
const {loadMetadataServerConfig,validateServerConfig} = require('../../src/tagging/MetadataServerConfig');
const root = path.resolve(__dirname,'../..');
const testFiles = ['TaggingBootstrap.js','TaggingJourney.js','TaggingFixtures.js','TaggingAssertions.js',
  'TaggingNetwork.js','MetadataFixtures.js','BrowserDriver.js','SmokeLifecycle.js','ConsoleMessage.js'];
async function runScenario(scenario,{useAsar,server = connection,keep}) {
  const secret = server.token;
  const parent=path.join(root,'sandbox','test-results');fs.mkdirSync(parent,{recursive:true});
  const directory=fs.mkdtempSync(path.join(parent,`tagging-${scenario}-${useAsar?'asar-':''}`));
  const appDirectory=path.join(directory,'app'), userData=path.join(directory,'user-data');
  let passed=false;
  try {
    fs.mkdirSync(appDirectory);fs.mkdirSync(userData);
    fs.writeFileSync(path.join(userData,'.mynda-test-library'),'Disposable tagging journey');
    const filter=useAsar?new FileMatcher(root,appDirectory,value=>value,require('../../package.json').build.files).createFilter():null;
    for (const folder of ['src','images']) copyDirectory(path.join(root,folder),path.join(appDirectory,folder),filter);
    for (const file of testFiles) fs.copyFileSync(path.join(__dirname,file),path.join(appDirectory,file));
    fs.writeFileSync(path.join(appDirectory,'package.json'),JSON.stringify({name:'mynda-tagging-test',version:'1.0.0',main:'TaggingBootstrap.js'}));
    fs.symlinkSync(path.join(root,'node_modules'),path.join(useAsar?directory:appDirectory,'node_modules'),process.platform==='win32'?'junction':'dir');
    const target=useAsar?appDirectory+'.asar':appDirectory;
    if(useAsar)await asar.createPackage(appDirectory,target);
    const options={timeoutMs:scenario==='live'?225000:100000,diagnostics:directory,redact:value=>redact(value,secret),
      env:{MYNDA_TAGGING_SCENARIO:scenario,MYNDA_TEST_METADATA_CONNECTION:JSON.stringify(server)}};
    const executable=require('electron');
    assert(typeof executable==='string' && fs.existsSync(executable),'Install the pinned Electron runtime first');
    for(const phase of ['exercise','restart']) {
      const result=await launchElectron(executable,target,userData,phase,options);
      assert.strictEqual(result[phase==='exercise'?'taggingVerified':'restartVerified'],true);
      assert.strictEqual(result.gracefulClose,true);
      const original=JSON.parse(fs.readFileSync(path.join(directory,'originals.json'),'utf8'));
      const saved=JSON.parse(fs.readFileSync(path.join(userData,'Library','library.json'),'utf8'));
      verify(scenario,original.map(video=>saved.media.find(item=>item.id===video.id)));
    }
    passed=true;
  } finally {
    if(passed && !keep)removeDirectory(directory);
    else console.log(`        ${passed?'Retained test files':'Failure diagnostics retained'}: ${directory}`);
  }
}
async function main() {
  const args=process.argv.slice(2), live=args.includes('--live'),useAsar=args.includes('--asar');
  const caseArg=args.find(value=>value.startsWith('--case='));
  const scenario=caseArg && caseArg.slice(7);
  if(args.some(value=>!['--live','--asar','--yes','--keep'].includes(value) && !value.startsWith('--case=')))throw new Error('Unknown tagging-test argument');
  if(scenario && (!definitions[scenario] || scenario==='live'))throw new Error('Choose a deterministic --case from: '+Object.keys(definitions).filter(name=>name!=='live').join(', '));
  if(live && scenario)throw new Error('--case cannot be combined with --live');
  let server = connection;
  if(live) {
    const approved=await confirmLive({yes:args.includes('--yes'),interactive:Boolean(process.stdin.isTTY),ask:question=>new Promise(resolve=>{
      const terminal=readline.createInterface({input:process.stdin,output:process.stdout});
      terminal.question(question,answer=>{terminal.close();resolve(answer);});
    })});
    if(!approved){console.log('Live tests canceled. No API requests were made.');process.exitCode=2;return;}
    server = validateServerConfig(loadMetadataServerConfig());
  }
  await buildRenderer({mode:useAsar?'production':'development'});
  const suite=createSuite(`Electron tagging workflows${live?' with LIVE metadata server':''}${useAsar?' from ASAR':''}`,'end-to-end',
    'Real UI, matching, artwork, saves and restart in automatically created disposable libraries.');
  for(const name of live?['live']:scenario?[scenario]:Object.keys(definitions).filter(name=>name!=='live'))
    suite.test(name,()=>runScenario(name,{useAsar,server,keep:args.includes('--keep')}));
  await suite.run();
}
if(require.main===module)main().catch(error=>{console.error(redact(error.stack || error));process.exitCode=1;});
module.exports={runScenario};
