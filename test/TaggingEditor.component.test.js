const path=require('path');
const React=require('react');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const {show}=require('./helpers/OmdbFixtures');
const Evidence=require('../src/tagging/TaggingEvidence');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')],extensions:['.js'],ignore:[/node_modules/],cache:false});
const suite=createSuite('Tagging editor provenance','component',
  'Exercises the real editor change and catalog-choice handlers; identity authorship survives the UI boundary.');
const quiet={debug(){},info(){},warn(){},error(){}};
let request,changed,proposal,applied=0,lookups=0;
const {MynEditor,MynEditorSearch}=loadFreshWithMocks(path.join(__dirname,'../src/renderer/Editor.js'),{
  electron:{ipcRenderer:{}},
  '../tagging/OmdbHelper.js':{
    resolve:async()=>{lookups++;return proposal;},
    applyMatch:async(candidate,options)=>{applied++;request={candidate,options};return {status:'matched',video:candidate.candidate.video};},
    tag:async(video,options)=>{
      request={video,options};return {status:'matched',video:{...video,taggingEvidence:{test:'applied'}}};
    }
  },
  './RendererRuntime.js':{editorLog:quiet,artworkLog:quiet,library:{media:[]}},
  './SharedComponents.js':{MynOpenablePane:React.Component},
  './EditorFields.js':{}
});
function editor(video) {
  const instance=new MynEditor({video});
  instance.state.video=JSON.parse(JSON.stringify(video));
  instance.state.originalVideo=JSON.parse(JSON.stringify(video));
  instance._isMounted=true;
  instance.setState=update=>Object.assign(instance.state,update);
  return instance;
}
suite.test('manual IMDb edits are recorded as user choices',()=>{
  const original=show({imdbID:'tt111',taggingEvidence:{imdbID:'tt111',kind:'episode',
    identities:{record:{value:'tt111',origin:'automatic'}}}});
  const instance=editor(original);
  instance.handleChange('imdbID','tt222');
  assert.strictEqual(Evidence.identity(instance.state.video,'imdbID').origin,'user');
  assert.strictEqual(instance.state.video.taggingEvidence.kind,undefined);
});
suite.test('automatic results keep the evidence supplied by the policy',()=>{
  const instance=editor(show());
  const evidence={imdbID:'tt333',identities:{record:{value:'tt333',origin:'automatic'}}};
  instance.handleChange({imdbID:'tt333',taggingEvidence:evidence});
  assert.strictEqual(instance.state.video.taggingEvidence,evidence);
  assert.strictEqual(Evidence.identity(instance.state.video,'imdbID').origin,'automatic');
});
suite.test('applying an accepted record clears the previous failure in the editor working copy',()=>{
  const instance=editor(show({taggingDecision:{status:'unmatched',reason:{code:'no-results'}}}));
  instance.handleChange({imdbID:'tt333',taggingDecision:null,
    taggingEvidence:{kind:'episode',imdbID:'tt333',identities:{record:{value:'tt333',origin:'user'}}}});
  assert.strictEqual(instance.state.video.taggingDecision,null);
});
suite.test('an explicit record choice keeps the file input and marks the selection as user supplied',async()=>{
  const original=show();
  const instance=new MynEditorSearch({video:original,handleChange:video=>{changed=video;}});
  instance.clearSearch=()=>{};
  await instance.retrieveResult({imdbID:'tt444',Title:'Chosen Record'});
  assert.strictEqual(request.video.filename,original.filename);
  assert.strictEqual(request.video.title,original.title);
  assert.strictEqual(request.video.imdbID,'tt444');
  assert.strictEqual(request.options.imdbIDSource,'user');
  assert.strictEqual(changed.taggingEvidence.test,'applied');
});
suite.test('a series choice is passed as a parent, with explicit user provenance',async()=>{
  const original=show();
  const instance=new MynEditorSearch({video:original,handleChange:()=>{}});
  instance.clearSearch=()=>{};
  await instance.retrieveResult({myndaChoiceType:'series',imdbID:'tt555'});
  assert.strictEqual(request.video,original);
  assert.deepStrictEqual(request.options,{seriesImdbID:'tt555',seriesSelectionSource:'user'});
});
suite.test('previewing a candidate performs no application; confirming reuses the proposal',async()=>{
  const original=show();
  proposal={status:'candidate',context:{originalInput:Evidence.snapshot(original)},
    candidate:{video:original,record:{Title:'Arrival',imdbID:'tt666',Type:'episode',Poster:'N/A'}}};
  const instance=new MynEditorSearch({video:original,handleChange:()=>{}});
  instance.setState=update=>Object.assign(instance.state,update);
  let row;
  instance.chooseResult=movie=>{row=movie;};
  await instance.handleSearch({preventDefault(){}});
  assert.strictEqual(lookups,1);
  assert.strictEqual(applied,0);
  instance.state.results[0].props.onClick();
  assert.strictEqual(row.myndaInputID,original.id);
  assert.strictEqual(typeof row.myndaProposalID,'string');
  assert.strictEqual(row.myndaCandidate,undefined,'Promises and caches must never travel through Electron IPC');
  await instance.retrieveResult(JSON.parse(JSON.stringify(row)));
  assert.strictEqual(applied,1);
  assert.strictEqual(lookups,1);
  assert.strictEqual(request.candidate,proposal);
  assert.strictEqual(request.options.recordSelectionSource,'user');
});
suite.test('a late confirmation cannot apply a choice to another video',async()=>{
  const instance=new MynEditorSearch({video:show({id:'current'}),handleChange:()=>{throw Error('stale apply');}});
  const before=applied;
  await instance.retrieveResult({imdbID:'tt666',myndaInputID:'previous'});
  assert.strictEqual(applied,before);
});
runSuite(suite);
