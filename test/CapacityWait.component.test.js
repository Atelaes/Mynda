const path=require('path');
const React=require('react');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const {loadFreshWithMocks}=require('./helpers/ModuleMocks');
const {createBridge}=require('../src/preload/Bridge');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')],extensions:['.js'],ignore:[/node_modules/],cache:false});
const suite=createSuite('Capacity waiting and cancellation UI','component',
  'Checks waiting notifications, editor lifecycle, stale replies and the restricted preload methods.');
const quiet={debug(){},info(){},warn(){},error(){}};
const runtime={editorLog:quiet,artworkLog:quiet,frontendLog:quiet,library:{media:[]}};
const {MynEditorSearch}=loadFreshWithMocks(path.join(__dirname,'../src/renderer/Editor.js'),{
  './RendererRuntime.js':runtime,'./SharedComponents.js':{MynOpenablePane:React.Component},'./EditorFields.js':{}
});
const {MynNotify}=loadFreshWithMocks(path.join(__dirname,'../src/renderer/SharedComponents.js'),{'./RendererRuntime.js':runtime});
function find(tree,id) {
  for(const node of React.Children.toArray(tree)) {
    if(!React.isValidElement(node))continue;
    if(node.props.id===id)return node;
    const result=find(node.props.children,id);if(result)return result;
  }
}
function fixture() {
  let listener,resolveLookup;
  const calls=[],changes=[],alerts=[];
  const api={onLookupStatus:fn=>{listener=fn;return()=>{listener=null;}},
    cancelSearch:async input=>{calls.push(input);return {canceled:true};},
    search:()=>new Promise(resolve=>{resolveLookup=resolve;}),
    select:()=>new Promise(resolve=>{resolveLookup=resolve;})};
  global.window={mynda:{editor:api}};global.alert=message=>alerts.push(message);
  const instance=new MynEditorSearch({video:{id:'video-one',kind:'movie',title:'Original'},handleChange:change=>changes.push(change)});
  instance.setState=update=>Object.assign(instance.state,update);
  instance.componentDidMount();
  return {instance,calls,changes,alerts,api,notify:status=>listener && listener(status),
    resolve:value=>resolveLookup(value),hasListener:()=>Boolean(listener)};
}
suite.test('batch status distinguishes a brief wait, a timed pause and cancellation while retaining position',()=>{
  const notify=new MynNotify({});
  assert.strictEqual(notify.messageFor({action:'autotag',numCurrent:25,numTotal:3000,
    capacityWait:{reason:'fairness',retryAfterSeconds:1}}),'Waiting for server capacity (video 25 of 3000)');
  assert.match(notify.messageFor({action:'autotag',capacityWait:{reason:'budget',retryAfterSeconds:3600,retryAt:Date.now()+3600000}}),/paused.*Retrying at/);
  assert.strictEqual(notify.messageFor({action:'autotag',cancelRequested:true,canceledWait:true}),'Canceling auto-tagging and finishing saves');
});
suite.test('the editor displays only its current wait and Cancel ignores a late result',async()=>{
  const f=fixture(),pending=f.instance.handleSearch({preventDefault(){}});
  const lookupID=f.instance._activeLookupID;
  f.notify({lookupID:'old',videoID:'video-one',capacityWait:{reason:'budget'}});
  assert.strictEqual(f.instance.state.capacityWait,null);
  f.notify({lookupID,videoID:'another',capacityWait:{reason:'budget'}});
  assert.strictEqual(f.instance.state.capacityWait,null);
  f.notify({lookupID,videoID:'video-one',capacityWait:{reason:'fairness',retryAfterSeconds:1}});
  assert.strictEqual(f.instance.state.capacityWait.reason,'fairness');
  const cancel=find(f.instance.render(),'edit-search-cancel');
  assert(cancel);cancel.props.onClick();
  assert.deepStrictEqual(f.calls,[{lookupID}]);assert.strictEqual(f.instance.state.searching,false);
  f.resolve({status:'candidate',proposalID:'late',candidate:{record:{Title:'Late',Type:'movie',imdbID:'tt1234567'}}});
  await pending;
  assert.strictEqual(f.instance.state.results,null);assert.deepStrictEqual(f.changes,[]);assert.deepStrictEqual(f.alerts,[]);
  f.instance.componentWillUnmount();
});
suite.test('changing selection cancels its pending lookup and unmount removes the status subscription',async()=>{
  const f=fixture(),pending=f.instance.handleSearch({preventDefault(){}}),before=f.instance.props;
  f.instance.props={...before,video:{id:'video-two',kind:'movie',title:'Different'}};
  f.instance.componentDidUpdate(before);
  assert.strictEqual(f.calls.length,1);assert.strictEqual(f.instance.state.searching,false);
  f.resolve({status:'canceled'});await pending;
  assert.deepStrictEqual(f.alerts,[]);
  const next=f.instance.handleSearch({preventDefault(){}});
  f.instance.componentWillUnmount();assert.strictEqual(f.hasListener(),false);
  assert.strictEqual(f.calls.length,2);f.resolve({status:'canceled'});await next;
});
suite.test('selecting a catalog result also supports cancellation without modifying the draft',async()=>{
  const f=fixture();
  const pending=f.instance.retrieveResult({Title:'Selected',imdbID:'tt1234567',myndaInputID:'video-one'});
  assert.strictEqual(f.instance.state.searching,true);
  f.instance.cancelLookup();
  f.resolve({status:'matched',video:{...f.instance.props.video,title:'Late selected result'}});
  await pending;assert.deepStrictEqual(f.changes,[]);assert.deepStrictEqual(f.alerts,[]);
  f.instance.componentWillUnmount();
});
suite.test('preload exposes only the named cancellation call and lookup status subscription',async()=>{
  const calls=[];
  const bridge=createBridge({invoke:async(...args)=>calls.push(args),subscribe:(...args)=>{calls.push(args);return()=>{};},platform:'darwin'});
  await bridge.editor.cancelSearch({lookupID:'one'});
  const listener=()=>{};bridge.editor.onLookupStatus(listener);
  assert.deepStrictEqual(calls,[['editor.cancelSearch',{lookupID:'one'}],['editor:lookup-status',listener]]);
  assert(Object.isFrozen(bridge.editor));assert.strictEqual(bridge.editor.invoke,undefined);
});
runSuite(suite);
