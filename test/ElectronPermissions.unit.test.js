const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {observePermissionDecisions, assertGeolocationDenied} = require('./electron/ExternalContentJourney');
const suite = createSuite('Electron permission smoke-test evidence', 'unit',
  'A real request must be denied by Mynda; OS denial, unavailable location and timeout cannot pass.');
const denied = {code:1, message:'User denied Geolocation'};
const decision = {contentsId:7, permission:'geolocation', allowed:false};

suite.test('observes asynchronous decisions without changing the handler arguments or answer', async () => {
  const session = {setPermissionCheckHandler(){},setPermissionRequestHandler(handler) {
    assert.strictEqual(this, session); this.handler = handler;
  }};
  const decisions = [], contents = {id:7}, details = {requestingUrl:'file:///app/index.html'};
  observePermissionDecisions(session, decisions);
  for (const allowed of [false, true]) {
    session.setPermissionRequestHandler(async (sender, permission, callback, receivedDetails) => {
      assert.strictEqual(sender, contents); assert.strictEqual(permission, 'geolocation');
      assert.strictEqual(receivedDetails, details);
      await Promise.resolve(); callback(allowed);
    });
    const answer = await new Promise(resolve => session.handler(contents, 'geolocation', resolve, details));
    assert.strictEqual(answer, allowed);
  }
  assert.deepStrictEqual(decisions, [decision, {...decision, allowed:true}]);
  session.setPermissionRequestHandler(null);
  assert.strictEqual(session.handler, null);
});

suite.test('observes synchronous permission checks without changing arguments or the decision', () => {
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(handler){
    assert.strictEqual(this,session);this.check=handler;
  }};
  const decisions=[],contents={id:7},origin='file://',details={requestingUrl:'file:///app/index.html'};
  observePermissionDecisions(session,decisions);
  for(const allowed of [false,true]) {
    session.setPermissionCheckHandler((sender,permission,receivedOrigin,receivedDetails)=>{
      assert.strictEqual(sender,contents);assert.strictEqual(permission,'geolocation');
      assert.strictEqual(receivedOrigin,origin);assert.strictEqual(receivedDetails,details);return allowed;
    });
    assert.strictEqual(session.check(contents,'geolocation',origin,details),allowed);
  }
  assert.deepStrictEqual(decisions,[decision,{...decision,allowed:true}]);
  session.setPermissionCheckHandler(null);assert.strictEqual(session.check,null);
});

suite.test('accepts permission-denied only with the tested renderer\'s actual application denial', () => {
  assert.doesNotThrow(() => assertGeolocationDenied(denied, [decision], 7));
});

suite.test('rejects an OS-only denial that never reached the application handler', () => {
  assert.throws(() => assertGeolocationDenied(denied, [], 7), /did not reach Mynda/);
});

suite.test('rejects a granted application decision even when the OS denies access', () => {
  assert.throws(() => assertGeolocationDenied(denied, [{...decision, allowed:true}], 7), /Mynda granted/);
  assert.throws(() => assertGeolocationDenied(denied, [decision, {...decision, allowed:true}], 7), /Mynda granted/);
});

suite.test('does not confuse another renderer or another permission with the location request', () => {
  for (const unrelated of [{...decision, contentsId:8}, {...decision, permission:'media'}]) {
    assert.throws(() => assertGeolocationDenied(denied, [unrelated], 7), /did not reach Mynda/);
  }
});

suite.test('rejects location-unavailable and timeout results instead of treating all errors as denial', () => {
  for (const code of [2, 3]) {
    assert.throws(() => assertGeolocationDenied({code}, [decision], 7), /Expected geolocation PERMISSION_DENIED/);
  }
});

suite.test('does not substitute a permission-status query for a real request result', () => {
  for (const state of ['granted', 'denied']) {
    assert.throws(() => assertGeolocationDenied({state}, [decision], 7), /Expected geolocation PERMISSION_DENIED/);
  }
});

runSuite(suite);
