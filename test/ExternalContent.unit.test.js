const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {pathToFileURL} = require('url');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {OPEN_EXTERNAL_CHANNEL, imdbTitleURL, approvedExternalURL} = require('../src/platform/ExternalLinks');
const {installExternalContentPolicy, isApplicationPage} = require('../src/main/ExternalContent');

const suite = createSuite('External content and browser permissions', 'unit',
  'Approved destinations, trusted IPC callers, blocked navigation/popups/embeds and denied browser permissions.');
const rendererPath = path.resolve(__dirname, '../src/renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
const titleURL = 'https://www.imdb.com/title/tt1234567/';

function fixture() {
  const handlers = new Map(), opened = [], warnings = [];
  const session = {checkInstalls: 0, requestInstalls: 0,
    setPermissionCheckHandler(fn) { this.check = fn; this.checkInstalls++; },
    setPermissionRequestHandler(fn) { this.request = fn; this.requestInstalls++; }};
  function window() {
    const contents = new EventEmitter();
    Object.assign(contents, {session, mainFrame: {url: rendererURL}, getURL: () => rendererURL,
      isDestroyed: () => false, setWindowOpenHandler(fn) { this.openWindow = fn; }});
    return {webContents: contents};
  }
  const shell = {openExternal: async url => { opened.push(url); }};
  const policy = installExternalContentPolicy({rendererPath, shell,
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    log: {warn: (...args) => warnings.push(args)}});
  const main = window(); policy.protectWindow(main);
  const event = () => ({sender: main.webContents, senderFrame: main.webContents.mainFrame});
  return {policy, main, session, shell, opened, warnings, window, event,
    request: (url = titleURL, caller = event()) => handlers.get(OPEN_EXTERNAL_CHANNEL)(caller, url)};
}

suite.test('constructs a canonical HTTPS title URL from a valid IMDb ID', () => {
  assert.strictEqual(imdbTitleURL('tt1234567'), titleURL);
  for (const value of [null, undefined, 123, {}, '', 'TT123', 'tt', 'tt12/other', 'tt12?x=1', 'tt12#x', 'tt12\n']) {
    assert.strictEqual(imdbTitleURL(value), null);
  }
  assert.strictEqual(imdbTitleURL('tt' + '1'.repeat(100)), null);
});
suite.test('normalizes approved IMDb host variants without preserving arbitrary URL text', () => {
  for (const value of [titleURL, 'https://imdb.com/title/tt1234567', 'HTTPS://WWW.IMDB.COM:443/title/tt1234567/']) {
    assert.strictEqual(approvedExternalURL(value), titleURL);
  }
});
suite.test('rejects executable protocols, files, credentials, lookalike hosts and redirect parameters', () => {
  const refused = [null, {}, ['https://www.imdb.com/title/tt1234567/'], '',
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///tmp/movie',
    'smb://server/share', 'mailto:test@example.com', 'https://example.com/',
    'http://www.imdb.com/title/tt1234567/', '//www.imdb.com/title/tt1234567/',
    'https://www.imdb.com.evil.invalid/title/tt1234567/', 'https://www.imdb.com@evil.invalid/title/tt1234567/',
    'https://user:password@www.imdb.com/title/tt1234567/', 'https://www.imdb.com:444/title/tt1234567/',
    'https://www.imdb.com./title/tt1234567/', 'https://www.imdb.com/title/tt1234567/?redirect=https://evil.invalid',
    'https://www.imdb.com/title/tt1234567/#script', 'https://www.imdb.com/redirect',
    'https://www.imdb.com/title/%74%741234567/', 'https://www.imdb.com/title/tt1234567/extra',
    titleURL + '\n', ' ' + titleURL, 'https:\\www.imdb.com\\title\\tt1234567', 'x'.repeat(4096)];
  for (const value of refused) assert.strictEqual(approvedExternalURL(value), null, String(value));
});
suite.test('opens an approved link only through the registered application main frame', async () => {
  const f = fixture();
  assert.deepStrictEqual(await f.request('https://imdb.com/title/tt1234567'), {ok: true});
  assert.deepStrictEqual(f.opened, [titleURL]);
});
suite.test('checks IPC destinations again even when the renderer bypasses its link component', async () => {
  const f = fixture();
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://evil.invalid/', null, {}]) {
    assert.strictEqual((await f.request(value)).ok, false);
  }
  assert.deepStrictEqual(f.opened, []);
});
suite.test('rejects unregistered windows, subframes, absent frames and missing callers', async () => {
  const f = fixture(), other = f.window().webContents;
  for (const caller of [undefined, {}, {sender: other, senderFrame: other.mainFrame},
    {sender: f.main.webContents}, {sender: f.main.webContents, senderFrame: {url: rendererURL}}]) {
    // Passing undefined directly would use the fixture's authorized default.
    const result = await f.request(titleURL, caller || null);
    assert.strictEqual(result.ok, false);
  }
  assert.deepStrictEqual(f.opened, []);
});
suite.test('rejects a registered window after either its document or calling frame changes', async () => {
  for (const field of ['document', 'frame']) {
    const f = fixture();
    if (field === 'document') f.main.webContents.getURL = () => 'https://evil.invalid/';
    else f.main.webContents.mainFrame.url = 'https://evil.invalid/';
    assert.strictEqual((await f.request()).ok, false);
    assert.deepStrictEqual(f.opened, []);
  }
});
suite.test('rejects destroyed windows and detached frames without throwing', async () => {
  const f = fixture();
  f.main.webContents.isDestroyed = () => true;
  assert.strictEqual((await f.request()).ok, false);
  f.main.webContents.isDestroyed = () => false;
  f.main.webContents.emit('destroyed');
  assert.strictEqual((await f.request()).ok, false);
  const g = fixture();
  Object.defineProperty(g.main.webContents.mainFrame, 'url', {get() { throw Error('Frame gone'); }});
  assert.strictEqual((await g.request()).ok, false);
});
suite.test('requires the exact application file, allowing only its same-document fragment', () => {
  assert(isApplicationPage(rendererURL, rendererPath));
  assert(isApplicationPage(rendererURL + '#section', rendererPath));
  for (const value of [rendererURL + '.evil', rendererURL + '?other=true',
    'https://example.com/src/renderer/index.html', 'file:///tmp/index.html', 'about:blank', 'bad']) {
    assert.strictEqual(isApplicationPage(value, rendererPath), false);
  }
});
suite.test('recognizes a canonical filesystem alias without trusting unrelated paths', async () => {
  await withTemporaryDirectory('external-link-path', directory => {
    const actual = path.join(directory, 'actual'); fs.mkdirSync(actual);
    const file = path.join(actual, 'index.html'); fs.writeFileSync(file, 'fixture');
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert(isApplicationPage(pathToFileURL(path.join(alias, 'index.html')).href, file));
    assert(!isApplicationPage(pathToFileURL(path.join(alias, 'other.html')).href, file));
  });
});
suite.test('blocks navigation, redirects and webview attachment without opening a browser', () => {
  const f = fixture();
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false;
    f.main.webContents.emit(name, {preventDefault() { prevented = true; }}, titleURL);
    assert(prevented, name);
  }
  assert.deepStrictEqual(f.opened, []);
});
suite.test('denies both modern and Electron 12 legacy popups even for an approved URL', () => {
  const f = fixture();
  for (const url of [titleURL, 'about:blank', 'https://evil.invalid/']) {
    assert.deepStrictEqual(f.main.webContents.openWindow({url}), {action: 'deny'});
    let prevented = false;
    f.main.webContents.emit('new-window', {preventDefault() { prevented = true; }}, url);
    assert(prevented);
  }
  assert.deepStrictEqual(f.opened, []);
});
suite.test('denies permission checks and requests, including unknown future permissions', () => {
  const f = fixture();
  for (const permission of ['media', 'display-capture', 'geolocation', 'notifications', 'midi',
    'clipboard-read', 'fullscreen', 'openExternal', 'future-permission']) {
    assert.strictEqual(f.session.check(f.main.webContents, permission, rendererURL, {}), false);
    let granted;
    f.session.request(f.main.webContents, permission, value => { granted = value; }, {});
    assert.strictEqual(granted, false);
  }
});
suite.test('protects replacement windows without duplicating shared session or window handlers', async () => {
  const f = fixture(); f.policy.protectWindow(f.main);
  const next = f.window(); f.policy.protectWindow(next);
  assert.strictEqual(f.main.webContents.listenerCount('will-navigate'), 1);
  assert.strictEqual(f.session.checkInstalls, 1);
  assert.strictEqual(f.session.requestInstalls, 1);
  assert.strictEqual((await f.request(titleURL, {sender: next.webContents, senderFrame: next.webContents.mainFrame})).ok, true);
});
suite.test('reports browser launch failure without falling back to a Mynda window', async () => {
  const f = fixture(); f.shell.openExternal = async () => { throw Error('Browser unavailable'); };
  const result = await f.request();
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /default browser/);
  assert(f.warnings.length);
  assert.deepStrictEqual(f.opened, []);
});

runSuite(suite);
