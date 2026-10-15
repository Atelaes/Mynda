const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')],extensions:['.js'],ignore:[/node_modules/],cache:false});
const {LicenseActivation} = require('../src/renderer/LicenseActivation');
const suite=createSuite('License activation settings','component','Verified activation states, offline/rejected keys, private input, ordered actions and teardown.');
const token='synthetic-renderer-token-for-tests';
const saved={hasCredential:true,verified:false,url:'https://fixture.example',defaultURL:'https://default.example',allowServerOverride:true};
const active={...saved,verified:true};
const inactive={...saved,hasCredential:false};
function component(api,status=inactive) {
  global.window={mynda:{metadata:api}};
  const view=new LicenseActivation({});view.alive=true;
  view.setState=update=>Object.assign(view.state,update);
  view.setState({status,url:status.url,action:null});return view;
}
const html=view=>renderToStaticMarkup(view.render());
const failure=(code,message='Could not verify activation.')=>Object.assign(new Error(message),{code});
suite.test('an installation without a key asks for activation and does not verify a missing key',async()=>{
  const view=component({getStatus:async()=>inactive,check:()=>assert.fail('unexpected verification')});
  await view.refresh();const rendered=html(view);
  assert(rendered.includes('license-status-badge pending'));assert(rendered.includes('Not activated'));
  assert(rendered.includes('Activate Mynda'));assert(rendered.includes('type="password"'));
  assert(rendered.includes('Activation details'));assert(rendered.includes('Developer options'));
  assert(!rendered.includes('Change license key'));assert(!rendered.includes('Metadata access'));
  assert.strictEqual(view.state.token,'');
  view.state.status={...inactive,allowServerOverride:false};
  assert(!html(view).includes('Developer options'));
});
suite.test('opening License verifies a saved key before showing Activated, even if previously checked',async()=>{
  let resolve,calls=0;
  const view=component({getStatus:async()=>active,check:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const loading=view.refresh();await new Promise(r=>setImmediate(r));
  assert(html(view).includes('Checking activation'));assert(!html(view).includes('>Activated<'));
  await view.perform('check');assert.strictEqual(calls,1);
  resolve(active);await loading;
  assert(html(view).includes('license-status-badge active'));assert(html(view).includes('>Activated<'));
  assert(html(view).includes('Change license key'));assert(!html(view).includes(token));
});
suite.test('a saved but unverified key is never labeled Activated',()=>{
  const view=component({},saved);
  assert(html(view).includes('Verification needed'));assert(!html(view).includes('>Activated<'));
});
suite.test('activation clears entry immediately and blocks duplicate submission until the saved result arrives',async()=>{
  let resolve,calls=0,received;
  const view=component({save:input=>{calls++;received={...input};return new Promise(r=>{resolve=r;});}});
  view.setState({token});const pending=view.perform('save');
  assert.strictEqual(view.state.token,'');assert(html(view).includes('Activating…'));
  await view.perform('save');assert.strictEqual(calls,1);assert.strictEqual(received.token,token);
  resolve(active);await pending;
  assert(html(view).includes('>Activated<'));assert.strictEqual(view.state.action,null);
  assert(!html(view).includes(token));
});
suite.test('a rejected replacement preserves existing activation, clears input and keeps arbitrary exceptions private',async()=>{
  for(const error of [Error(token),failure('ACCESS_REJECTED','This license key was not accepted.')]) {
    const view=component({save:async()=>{throw error;}},active);
    view.setState({token});await view.perform('save');
    assert.strictEqual(view.state.status,active);assert.strictEqual(view.state.token,'');
    assert(!view.state.error.includes(token));assert.strictEqual(view.state.action,null);
    assert(html(view).includes('>Activated<'));assert(html(view).includes('saved license key has not been changed'));
  }
});
suite.test('a failed verification is amber and retains the key rather than claiming the license is rejected',async()=>{
  for(const operation of ['refresh','check']) {
    const view=component({getStatus:async()=>active,check:async()=>{throw failure('CONNECTION_FAILED');}},active);
    if(operation==='refresh')await view.refresh();else await view.perform('check');
    const rendered=html(view);
    assert(rendered.includes('Unable to verify'));assert(rendered.includes('license-status-badge pending'));
    assert(!rendered.includes('>Activated<'));assert(!rendered.includes('license-status-badge error'));
    assert(view.state.status.hasCredential);assert.strictEqual(view.state.status.verified,false);
  }
});
suite.test('an explicitly rejected saved key is red and can be rechecked without reentering it',async()=>{
  let rejected=true;
  const view=component({check:async()=>{if(rejected)throw failure('ACCESS_REJECTED');return active;}},active);
  await view.perform('check');assert(html(view).includes('license-status-badge error'));
  assert(html(view).includes('Not activated'));assert(view.state.status.hasCredential);
  rejected=false;await view.perform('check');assert(html(view).includes('>Activated<'));
});
suite.test('checking and deactivating use the saved credential without returning it to the renderer',async()=>{
  const calls=[];
  const view=component({check:async()=>{calls.push('check');return active;},
    remove:async()=>{calls.push('remove');return inactive;}},saved);
  await view.perform('check');await view.perform('remove');
  assert.deepStrictEqual(calls,['check','remove']);assert.strictEqual(view.state.status.hasCredential,false);
  assert(html(view).includes('Not activated'));assert(!html(view).includes('Change license key'));
});
suite.test('failed deactivation keeps the current activation visible',async()=>{
  const view=component({remove:async()=>{throw failure('STORAGE_WRITE');}},active);
  await view.perform('remove');assert.strictEqual(view.state.status,active);
  assert(html(view).includes('>Activated<'));assert(view.state.error);
});
suite.test('a locked or unreadable store is presented as unavailable, not an unactivated installation',async()=>{
  const status={...inactive,message:'Unlock your system keychain.'};
  const view=component({getStatus:async()=>status});await view.refresh();
  assert(html(view).includes('Activation unavailable'));assert(html(view).includes(status.message));
  assert(!html(view).includes('Not activated'));
});
suite.test('an IPC load failure is safe and does not claim an activation result',async()=>{
  const view=component({getStatus:async()=>{throw Error(token);}});
  view.state.status=null;await view.refresh();
  assert(html(view).includes('Activation unavailable'));assert(!html(view).includes(token));
});
suite.test('closing during the initial read prevents a later automatic verification',async()=>{
  let resolve;
  const view=component({getStatus:()=>new Promise(r=>{resolve=r;}),check:()=>assert.fail('closed view verified')});
  const loading=view.refresh();view.componentWillUnmount();
  view.setState=()=>assert.fail('updated unmounted component');resolve(saved);await loading;
});
suite.test('closing the view clears input and ignores late activation and verification replies',async()=>{
  for(const action of ['save','check']) {
    let resolve;const view=component({[action]:()=>new Promise(r=>{resolve=r;})},saved);
    view.setState({token});const pending=view.perform(action);
    view.componentWillUnmount();view.setState=()=>assert.fail('updated unmounted component');
    resolve(active);await pending;assert.strictEqual(view.state.token,'');
  }
});
runSuite(suite);
