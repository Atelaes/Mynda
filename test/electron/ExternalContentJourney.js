// Real Electron controls and IPC. The caller records shell.openExternal so the
// test never launches the user's browser or accesses an external website.
const assert = require('assert');
const path = require('path');

async function inspectExternalContent({app, BrowserWindow, window, opened}) {
  const contents = window.webContents;
  const originalURL = contents.getURL();
  const linkModule = path.join(app.getAppPath(), 'src/renderer/ExternalLink.js');
  const reportModule = path.join(app.getAppPath(), 'src/renderer/AutotagReport.js');
  const before = opened.length;
  await contents.executeJavaScript(`(async () => {
    const React = require('react'), ReactDOM = require('react-dom');
    const {ImdbLink} = require(${JSON.stringify(linkModule)});
    const {LinkedReportText} = require(${JSON.stringify(reportModule)});
    const fixture = document.createElement('div'); document.body.appendChild(fixture);
    ReactDOM.render(React.createElement('div', null,
      React.createElement(ImdbLink, {imdbID:'tt1234567'}, 'IMDb'),
      React.createElement(LinkedReportText, {text:'Report tt7654321'})), fixture);
    const links = fixture.querySelectorAll('a');
    if (links.length !== 2) throw new Error('Expected two real IMDb links');
    links[0].click();
    links[1].dispatchEvent(new MouseEvent('auxclick', {button:1,bubbles:true,cancelable:true}));
    const ipc = require('electron').ipcRenderer;
    for (const url of ['file:///tmp/blocked', 'javascript:alert(1)', 'https://evil.invalid/',
      'https://www.imdb.com.evil.invalid/title/tt1234567/']) {
      const result = await ipc.invoke('external:open', url);
      if (result.ok !== false) throw new Error('Unsafe URL passed the main-process check');
    }
    ReactDOM.unmountComponentAtNode(fixture); fixture.remove();
    return true;
  })()`);
  // Both click IPC requests precede the awaited rejection requests above.
  assert.deepStrictEqual(opened.slice(before), [
    'https://www.imdb.com/title/tt1234567/', 'https://www.imdb.com/title/tt7654321/'
  ]);

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

  const restrictions = await contents.executeJavaScript(`(async () => {
    const permission = await navigator.permissions.query({name:'geolocation'});
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
    return {permission:permission.state, embeddedFrameBlocked};
  })()`);
  assert.strictEqual(restrictions.permission, 'denied');
  assert.strictEqual(restrictions.embeddedFrameBlocked, true);
  return {browserLinks:true, blockedNavigation:true, blockedPopup:true, deniedPermissions:true, blockedFrame:true};
}

module.exports = {inspectExternalContent};
