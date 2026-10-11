// Real Electron controls and IPC. The caller records shell.openExternal so the
// test never launches the user's browser or accesses an external website.
const assert = require('assert');
const path = require('path');
const {pathToFileURL} = require('url');
const {browserDriver, wait} = require('./BrowserDriver');

// Install before production registers its handler. Observe and forward its
// actual decision unchanged; an OS-level denial alone must not pass this test.
function observePermissionDecisions(session, decisions) {
  const setHandler = session.setPermissionRequestHandler.bind(session);
  session.setPermissionRequestHandler = handler => setHandler(handler === null ? null :
    (contents, permission, callback, details) => handler(contents, permission, allowed => {
      decisions.push({contentsId: contents && contents.id, permission, allowed});
      callback(allowed);
    }, details));
  const setCheckHandler = session.setPermissionCheckHandler.bind(session);
  session.setPermissionCheckHandler = handler => setCheckHandler(handler === null ? null :
    (contents, permission, origin, details) => {
      const allowed = handler(contents, permission, origin, details);
      decisions.push({contentsId:contents && contents.id, permission, allowed});
      return allowed;
    });
}

function assertGeolocationDenied(result, decisions, contentsId) {
  assert.strictEqual(result.code, 1,
    `Expected geolocation PERMISSION_DENIED, received ${JSON.stringify(result)}`);
  const requests = decisions.filter(item => item.contentsId === contentsId && item.permission === 'geolocation');
  assert(requests.length > 0, 'The location request did not reach Mynda\'s permission handler');
  assert(requests.every(item => item.allowed === false), 'Mynda granted a location request');
}

async function inspectExternalContent({app, BrowserWindow, window, opened, permissionDecisions, videoId}) {
  const contents = window.webContents;
  const originalURL = contents.getURL();
  const preferences = contents.getLastWebPreferences();
  for (const [key, value] of Object.entries({nodeIntegration:false, contextIsolation:true,
    sandbox:true, webviewTag:false, nodeIntegrationInSubFrames:false,
    nodeIntegrationInWorker:false, webSecurity:true, allowRunningInsecureContent:false})) {
    assert.strictEqual(preferences[key], value, 'Unsafe window preference: ' + key);
  }
  const ui = browserDriver(window);
  await ui.start();
  const isolation = await ui.inspect(() => {
    const bridge = window.mynda;
    return {electron:typeof window.electron, remote:typeof window.remote,
      invoke:typeof bridge.invoke, send:typeof bridge.send, on:typeof bridge.on,
      ipc:typeof bridge.ipcRenderer, frozen:Object.isFrozen(bridge),
      libraryFrozen:Object.isFrozen(bridge.library), externalFrozen:Object.isFrozen(bridge.external)};
  });
  assert.deepStrictEqual(isolation, {electron:'undefined', remote:'undefined', invoke:'undefined',
    send:'undefined', on:'undefined', ipc:'undefined', frozen:true, libraryFrozen:true, externalFrozen:true});

  // These are actual rendered report links, loaded through the normal library
  // snapshot and bundled React UI. No renderer require() or component injection.
  await ui.edit(videoId);
  await ui.click('#edit-autotag-report .folder-heading');
  const before = opened.length;
  await contents.executeJavaScript(`(async () => {
    const record = document.querySelector('#edit-autotag-report a[href="https://www.imdb.com/title/tt1234567/"]');
    const series = document.querySelector('#edit-autotag-report a[href="https://www.imdb.com/title/tt7654321/"]');
    if (!record || !series) throw new Error('Expected two real IMDb report links');
    record.click();
    series.dispatchEvent(new MouseEvent('auxclick', {button:1,bubbles:true,cancelable:true}));
    for (const url of ['file:///tmp/blocked', 'javascript:alert(1)', 'https://evil.invalid/',
      'https://www.imdb.com.evil.invalid/title/tt1234567/']) {
      const result = await window.mynda.external.open(url);
      if (result.ok !== false) throw new Error('Unsafe URL passed the main-process check');
    }
    return true;
  })()`);
  await wait(() => opened.length === before + 2, 'external browser link dispatch');
  assert.deepStrictEqual(opened.slice(before), [
    'https://www.imdb.com/title/tt1234567/', 'https://www.imdb.com/title/tt7654321/'
  ]);
  await ui.closeEditor();

  const windowsBefore = BrowserWindow.getAllWindows().length;
  await contents.executeJavaScript(`window.open('https://www.imdb.com/title/tt1234567/'); true`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(BrowserWindow.getAllWindows().length, windowsBefore, 'A page opened a Mynda child window');
  assert.strictEqual(opened.length, before + 2, 'A popup bypassed the explicit browser-link path');

  const navigation = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { contents.removeListener('will-navigate', onNavigate);
      reject(new Error('The navigation guard was not exercised')); }, 5000);
    function onNavigate(event) { clearTimeout(timer); resolve(event.defaultPrevented); }
    contents.once('will-navigate', onNavigate);
  });
  // Attach a rejection handler immediately, even if executeJavaScript fails.
  navigation.catch(() => {});
  await contents.executeJavaScript(`location.assign('https://navigation-blocked.invalid/'); true`);
  assert.strictEqual(await navigation, true, 'Navigation was not canceled');
  assert.strictEqual(contents.getURL(), originalURL);
  assert.strictEqual(opened.length, before + 2, 'Navigation unexpectedly launched the browser');

  const permissionStart = permissionDecisions.length;
  const restrictions = await contents.executeJavaScript(`(async () => {
    // Exercise an actual location request. Current Chromium can deny it in
    // the synchronous permission check before reaching the request callback.
    const permission = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Location permission request did not finish')), 5000);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timer); reject(new Error('Location access unexpectedly succeeded')); },
        error => { clearTimeout(timer); resolve({code:error.code, message:error.message}); },
        {timeout:3000, maximumAge:0});
    });
    const embeddedFrameBlocked = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const finish = value => { clearTimeout(timer); document.removeEventListener('securitypolicyviolation', onViolation);
        frame.remove(); resolve(value); };
      const onViolation = event => { if (event.effectiveDirective === 'frame-src' || event.effectiveDirective === 'child-src') finish(true); };
      const timer = setTimeout(() => { document.removeEventListener('securitypolicyviolation', onViolation);
        frame.remove(); reject(new Error('Embedded content was not blocked by CSP')); }, 5000);
      document.addEventListener('securitypolicyviolation', onViolation);
      frame.src = 'data:text/html,<p>Blocked fixture</p>'; document.body.appendChild(frame);
    });
    return {permission, embeddedFrameBlocked};
  })()`);
  assertGeolocationDenied(restrictions.permission, permissionDecisions.slice(permissionStart), contents.id);
  assert.strictEqual(restrictions.embeddedFrameBlocked, true);
  const scriptFixture = pathToFileURL(path.join(app.getAppPath(), 'src/renderer/ScriptPolicyFixture.js')).href;
  const scripts = await ui.inspect(async fixtureURL => {
    const evalBlocked = await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const clean = () => {clearTimeout(timer); script.remove();};
      const timer = setTimeout(() => {clean(); reject(new Error('Script policy fixture did not load'));}, 5000);
      script.onload = () => {clean(); resolve(window.__myndaScriptPolicyResult && window.__myndaScriptPolicyResult.evalBlocked);};
      script.onerror = () => {clean(); reject(new Error('Allowed script policy fixture could not load'));};
      script.src = fixtureURL; document.body.appendChild(script);
    });
    const inlineBlocked = await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const clean = () => {clearTimeout(timer); document.removeEventListener('securitypolicyviolation', violation); script.remove();};
      const violation = event => {
        if (event.effectiveDirective.startsWith('script-src') && event.blockedURI === 'inline') {clean(); resolve(true);}
      };
      const timer = setTimeout(() => {clean(); reject(new Error('Inline script was not blocked by CSP'));}, 5000);
      document.addEventListener('securitypolicyviolation', violation);
      script.textContent = 'window.__myndaUnsafeInlineExecuted = true'; document.body.appendChild(script);
    });
    return {evalBlocked, inlineBlocked, inlineExecuted:window.__myndaUnsafeInlineExecuted === true};
  }, scriptFixture);
  assert.deepStrictEqual(scripts, {evalBlocked:true, inlineBlocked:true, inlineExecuted:false});
  return {browserLinks:true, blockedNavigation:true, blockedPopup:true, deniedPermissions:true,
    blockedFrame:true, isolatedRenderer:true, blockedScripts:true};
}

module.exports = {inspectExternalContent, observePermissionDecisions, assertGeolocationDenied};
