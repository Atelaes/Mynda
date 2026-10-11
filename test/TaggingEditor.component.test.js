const path=require('path');
const React=require('react');
const vm=require('vm');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const {show}=require('./helpers/OmdbFixtures');
const Evidence=require('../src/tagging/TaggingEvidence');
const {createEditorService}=require('../src/main/EditorService');
const {browserDriver}=require('./electron/BrowserDriver');
const {waitForChosenMetadata}=require('./electron/TaggingJourney');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')],extensions:['.js'],ignore:[/node_modules/],cache:false});
const suite=createSuite('Tagging editor provenance','component',
  'Exercises the real editor change and catalog-choice handlers; identity authorship survives the UI boundary.');
const quiet={debug(){},info(){},warn(){},error(){}};
let request,changed,proposal,applied=0,lookups=0;
const backendLibrary = {media: []};
const service = createEditorService({library: backendLibrary, app: {getPath: () => '/tmp/mynda-editor-component'},
  catalog: {
    resolve:async()=>{lookups++;return proposal;},
    applyMatch:async(candidate,options)=>{applied++;request={candidate,options};return {status:'matched',video:candidate.candidate.video};},
    tag:async(video,options)=>{
      request={video,options};return {status:'matched',video:{...video,taggingEvidence:{test:'applied'}}};
    }
  }
});
global.window = {mynda: {editor: {search: draft => service.search(draft, 1),
  select: input => service.select(input, 1)}}};
global.alert = () => {};
const {MynEditor,MynEditorSearch}=loadFreshWithMocks(path.join(__dirname,'../src/renderer/Editor.js'),{
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
  backendLibrary.media = [original];
  const instance=new MynEditorSearch({video:original,handleChange:video=>{changed=video;}});
  instance.clearSearch=()=>{};
  proposal = {status:'ambiguous', choices:[{imdbID:'tt444',Title:'Chosen Record'}]};
  const result = await service.search(original, 1);
  await instance.retrieveResult(result.choices[0]);
  assert.strictEqual(request.video.filename,original.filename);
  assert.strictEqual(request.video.title,original.title);
  assert.strictEqual(request.video.imdbID,'tt444');
  assert.strictEqual(request.options.imdbIDSource,'user');
  assert.strictEqual(changed.taggingEvidence.test,'applied');
});
suite.test('a series choice is passed as a parent, with explicit user provenance',async()=>{
  const original=show();
  backendLibrary.media = [original];
  const instance=new MynEditorSearch({video:original,handleChange:()=>{}});
  instance.clearSearch=()=>{};
  proposal = {status:'ambiguous', choices:[{myndaChoiceType:'series',imdbID:'tt555'}]};
  const result = await service.search(original, 1);
  await instance.retrieveResult(result.choices[0]);
  assert.deepStrictEqual(request.video,original);
  assert.deepStrictEqual(request.options,{seriesImdbID:'tt555',seriesSelectionSource:'user'});
});
suite.test('previewing a candidate performs no application; confirming reuses the proposal',async()=>{
  const original=show();
  backendLibrary.media = [original];
  lookups = 0; applied = 0;
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
  assert.strictEqual(request.candidate.context,proposal.context);
  assert.deepStrictEqual(request.candidate.candidate.record,proposal.candidate.record);
  assert.strictEqual(request.options.recordSelectionSource,'user');
});
suite.test('a late confirmation cannot apply a choice to another video',async()=>{
  const instance=new MynEditorSearch({video:show({id:'current'}),handleChange:()=>{throw Error('stale apply');}});
  const before=applied;
  await instance.retrieveResult({imdbID:'tt666',myndaInputID:'previous'});
  assert.strictEqual(applied,before);
});
suite.test('a metadata response preserves draft edits and user ratings made while it was loading', async () => {
  const original = show({ratings: {user: 3}, tags: ['before']});
  const priorSelect = window.mynda.editor.select;
  let finish, changes;
  window.mynda.editor.select = () => new Promise(resolve => { finish = resolve; });
  try {
    const instance = new MynEditorSearch({video: original, handleChange: value => { changes = value; }});
    instance.clearSearch = () => {};
    const loading = instance.retrieveResult({myndaProposalID: 'test-choice'});
    instance.props = {...instance.props, video: {...original, tags: ['my latest tag'], ratings: {user: 5}}};
    finish({status: 'matched', video: {...original, title: 'Catalog title', tags: ['catalog genre'], ratings: {user: 3, imdb: 8}}});
    await loading;
    assert.strictEqual(changes.title, 'Catalog title');
    assert.strictEqual(changes.tags, undefined);
    assert.deepStrictEqual(changes.ratings, {user: 5, imdb: 8});
  } finally { window.mynda.editor.select = priorSelect; }
});
suite.test('the manual journey waits for applied metadata when the entered IMDb ID already matches',async()=>{
  const original=show({imdbID:'',description:'Original description',artwork:'',autotag_tried:false});
  const instance=editor(original),imdbID='tt1234567';
  instance.handleChange('imdbID',imdbID);
  const search=new MynEditorSearch({video:instance.state.video,handleChange:instance.handleChange});
  search.clearSearch=()=>{};
  const priorSelect=window.mynda.editor.select;
  let complete;
  window.mynda.editor.select=()=>new Promise(resolve=>{complete=resolve;});
  try {
    const selecting=search.retrieveResult({myndaProposalID:'held-choice'});
    const fields={'.edit-field-imdbID':'imdbID','#edit-field-description':'description','#edit-field-artwork':'artwork'};
    // Supply a read-only form surface from the real editor draft. This tests
    // the journey's completion check, not native rendering or DOM events.
    const context=vm.createContext({document:{querySelector:selector=>{
      assert(fields[selector],'Unknown form selector: '+selector);
      return {value:instance.state.video[fields[selector]]};
    }}});
    const ui=browserDriver({webContents:{executeJavaScript:async source=>structuredClone(await vm.runInContext(source,context))}});
    let firstRead;
    const observed=new Promise(resolve=>{firstRead=resolve;});
    const inspect=ui.inspect;
    ui.inspect=async(...args)=>{const result=await inspect(...args);firstRead(result);return result;};
    const waiting=waitForChosenMetadata(ui,imdbID,original.description,1000);
    assert.strictEqual(await observed,false,'The typed ID must not allow the journey to Save before metadata arrives');
    const draft=instance.state.video;
    const evidence=Evidence.forMatch(draft,{imdbID,Title:'Selected title'},
      {kind:'explicit-id',requestedID:imdbID},{recordSelectionSource:'user'});
    complete({status:'matched',video:{...draft,title:'Selected title',description:'Downloaded catalog description',
      artwork:'/managed-artwork/selected.png',taggingEvidence:evidence,taggingDecision:null}});
    await selecting;
    await waiting;
    const saved=JSON.parse(JSON.stringify({...instance.state.video,autotag_tried:false}));
    assert.strictEqual(require('../src/tagging/TaggingReport').buildTaggingReport(saved).status,'matched');
    assert.strictEqual(saved.taggingEvidence.identities.record.origin,'user');
  } finally {window.mynda.editor.select=priorSelect;}
});
suite.test('a changed identity while metadata loads requires a fresh search', async () => {
  const original = show();
  const priorSelect = window.mynda.editor.select;
  let finish, changes;
  window.mynda.editor.select = () => new Promise(resolve => { finish = resolve; });
  try {
    const instance = new MynEditorSearch({video: original, handleChange: value => { changes = value; }});
    instance.clearSearch = () => {};
    const loading = instance.retrieveResult({myndaProposalID: 'test-choice'});
    instance.props = {...instance.props, video: {...original, episode: 9}};
    finish({status: 'matched', video: {...original, imdbID: 'tt123'}});
    await loading;
    assert.strictEqual(changes, undefined);
  } finally { window.mynda.editor.select = priorSelect; }
});
runSuite(suite);
