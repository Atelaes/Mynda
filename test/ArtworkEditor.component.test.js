const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')], extensions:['.js'], ignore:[/node_modules/], cache:false});
const quiet = {debug(){}, info(){}, warn(){}, error(){}};
const {MynEditArtwork} = loadFreshWithMocks(path.join(__dirname,'../src/renderer/EditorFields.js'), {
  './RendererRuntime.js':{editorLog:quiet,artworkLog:quiet}, './SharedComponents.js':{}
});
const suite = createSuite('Artwork editor file drops', 'component',
  'Modern Files without .path, native cancellation, errors and stale responses during editor changes.');
const file = Object.freeze({name:'poster.png',type:'image/png'});
function fixture(inspectDroppedArtwork = async()=>'/approved/poster.png') {
  const updates=[], calls=[];
  global.document={addEventListener(){},removeEventListener(){}};
  global.window={mynda:{editor:{inspectDroppedArtwork:async value=>{
    calls.push(value);return inspectDroppedArtwork(value);
  },inspectArtwork:async value=>{calls.push(value);return value;}}}};
  const editor=new MynEditArtwork({movie:{id:'a',artwork:'/original.png'},update:value=>updates.push(value)});
  editor.setState=update=>Object.assign(editor.state,update);
  editor.componentDidMount();
  return {editor,updates,calls,drop:files=>editor._handleDrop({preventDefault(){},dataTransfer:{files}})};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
suite.test('a single image File reaches preload intact without reading File.path',async()=>{
  const f=fixture();await f.drop([file]);
  assert.deepStrictEqual(f.calls,[file]);assert.deepStrictEqual(f.updates,[{artwork:'/approved/poster.png'}]);
  f.editor.componentWillUnmount();
});
suite.test('typed local paths still use the path inspection operation',async()=>{
  const f=fixture(()=>{throw new Error('Wrong operation');});await f.editor.handleLocalFile('/typed.png');
  assert.deepStrictEqual(f.updates,[{artwork:'/typed.png'}]);f.editor.componentWillUnmount();
});
suite.test('empty, multiple, and non-image drops do not inspect or change artwork',async()=>{
  const f=fixture();for(const files of [[],[file,file],[{name:'video.mp4',type:'video/mp4'}]]) await f.drop(files);
  assert.deepStrictEqual(f.calls,[]);assert.deepStrictEqual(f.updates,[]);f.editor.componentWillUnmount();
});
suite.test('native cancellation leaves existing artwork intact',async()=>{
  const f=fixture(async()=>null);await f.drop([file]);assert.deepStrictEqual(f.updates,[]);f.editor.componentWillUnmount();
});
suite.test('failed inspection is visible and does not change artwork',async()=>{
  const f=fixture(async()=>{throw new Error('Image is too large');});await f.drop([file]);
  assert.strictEqual(f.editor.state.message,'Image is too large');assert.deepStrictEqual(f.updates,[]);f.editor.componentWillUnmount();
});
for (const action of ['revert','switch video','unmount']) {
  suite.test(`a pending drop cannot overwrite artwork after ${action}`,async()=>{
    const d=deferred(), f=fixture(()=>d.promise), pending=f.drop([file]);
    if(action==='revert') f.editor.handleRevert();
    else if(action==='switch video') {
      const previous=f.editor.props;f.editor.props={...previous,movie:{id:'b',artwork:'/other.png'}};
      f.editor.componentDidUpdate(previous);
    } else f.editor.componentWillUnmount();
    d.resolve('/late.png');await pending;
    assert.deepStrictEqual(f.updates,action==='revert'?[{artwork:'/original.png'}]:[]);
    f.editor.componentWillUnmount();
  });
}
suite.test('the latest drop wins when replies arrive out of order',async()=>{
  const first=deferred(),second=deferred();let count=0;
  const f=fixture(()=>++count===1?first.promise:second.promise);
  const one=f.drop([file]),two=f.drop([file]);second.resolve('/second.png');await two;
  first.resolve('/first.png');await one;assert.deepStrictEqual(f.updates,[{artwork:'/second.png'}]);f.editor.componentWillUnmount();
});
runSuite(suite);
