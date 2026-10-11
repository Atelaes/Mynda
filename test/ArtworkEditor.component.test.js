const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
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
for (const action of ['remove','switch video','unmount']) {
  suite.test(`a pending drop cannot overwrite artwork after ${action}`,async()=>{
    const d=deferred(), f=fixture(()=>d.promise), pending=f.drop([file]);
    if(action==='remove') f.editor.handleRemove();
    else if(action==='switch video') {
      const previous=f.editor.props;f.editor.props={...previous,movie:{id:'b',artwork:'/other.png'}};
      f.editor.componentDidUpdate(previous);
    } else f.editor.componentWillUnmount();
    d.resolve('/late.png');await pending;
    assert.deepStrictEqual(f.updates,action==='remove'?[{artwork:''}]:[]);
    f.editor.componentWillUnmount();
  });
}
suite.test('the latest drop wins when replies arrive out of order',async()=>{
  const first=deferred(),second=deferred();let count=0;
  const f=fixture(()=>++count===1?first.promise:second.promise);
  const one=f.drop([file]),two=f.drop([file]);second.resolve('/second.png');await two;
  first.resolve('/first.png');await one;assert.deepStrictEqual(f.updates,[{artwork:'/second.png'}]);f.editor.componentWillUnmount();
});
suite.test('the remove button clears saved artwork and the path stays behind a closed disclosure', () => {
  const f = fixture();
  const html = ReactDOMServer.renderToStaticMarkup(f.editor.render());
  assert(html.includes('aria-label="Remove artwork"'));
  assert(html.includes('artwork-remove-icon'));
  assert(html.includes('<summary>File info</summary>'));
  assert(!/<details[^>]*\bopen(?:=|>)/.test(html));
  assert(html.includes('/original.png'));
  f.editor.handleRemove();
  assert.deepStrictEqual(f.updates, [{artwork: ''}]);
  assert.strictEqual(f.editor.props.movie.artwork, '/original.png', 'Clearing must not mutate the saved record');
  f.editor.componentWillUnmount();
});
suite.test('empty artwork disables removal, but a mixed batch exposes explicit removal', () => {
  const f = fixture();
  f.editor.props = {...f.editor.props, movie: {id: 'a', artwork: ''}};
  const findButton = () => React.Children.toArray(f.editor.render().props.children)[0]
    .props.children.props.children[0];
  assert.strictEqual(findButton().props.disabled, true);
  let removed = false;
  f.editor.props = {...f.editor.props, movie: {id: 'batch', artwork: ''}, hasArtwork: true,
    removeArtwork() { removed = true; }};
  assert.strictEqual(findButton().props.disabled, false);
  f.editor.handleRemove(); assert.strictEqual(removed, true);
  f.editor.componentWillUnmount();
});
for (const operation of ['downloadArtwork', 'chooseArtwork']) {
  suite.test(`removal invalidates an outstanding ${operation} response`, async () => {
    const d = deferred(), f = fixture();
    window.mynda.editor[operation] = () => d.promise;
    const pending = operation === 'downloadArtwork' ? f.editor.download('https://example.test/poster.png') :
      f.editor.handleBrowse({preventDefault() {}});
    f.editor.handleRemove();
    d.resolve(operation === 'downloadArtwork' ? {success: true, message: '/late.png'} : '/late.png');
    await pending;
    assert.deepStrictEqual(f.updates, [{artwork: ''}]);
    f.editor.componentWillUnmount();
  });
}
runSuite(suite);
