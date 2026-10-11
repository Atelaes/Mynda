const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');

const filename = path.join(__dirname, '..', 'devtools', 'react-developer-tools', 'build', 'background.js');
const background = fs.readFileSync(filename, 'utf8');
const suite = createSuite('React DevTools background compatibility', 'unit',
  'Runs the bundled extension with Electron-style APIs and verifies React detection and inspection messaging.');

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
    get size() { return listeners.size; }
  };
}

function start({browserAction, tabs = []} = {}) {
  const injected = [];
  const chrome = {
    runtime: {onConnect: event(), onMessage: event()},
    tabs: {
      query(options, callback) { callback(tabs); },
      onCreated: event(), onUpdated: event(),
      executeScript(tabId, options, callback) {
        injected.push({tabId, file: options.file});
        callback();
      }
    }
  };
  if (browserAction !== undefined) chrome.browserAction = browserAction;
  vm.runInNewContext(background, {chrome, navigator: {userAgent: 'Electron'}, URL}, {filename});
  return {chrome, injected};
}

function detectReact(chrome) {
  assert.strictEqual(chrome.runtime.onMessage.size, 1, 'React detection must remain connected');
  chrome.runtime.onMessage.emit({hasDetectedReact: true, reactBuildType: 'development'}, {tab: {id: 7}});
}

function port(name, tabId) {
  return {
    name, sender: {tab: {id: tabId}},
    onMessage: event(), onDisconnect: event(), messages: [], disconnected: false,
    postMessage(message) { this.messages.push(message); },
    disconnect() { this.disconnected = true; }
  };
}

suite.test('React detection succeeds without a browser toolbar API', () => {
  const {chrome} = start();
  detectReact(chrome);
});

suite.test('Restricted-page startup and navigation succeed without a toolbar API', () => {
  const {chrome} = start({tabs: [{id: 7, url: 'chrome://extensions/'}]});
  chrome.tabs.onUpdated.emit(7, {}, {id: 7, url: 'chrome://newtab/'});
  chrome.tabs.onCreated.emit(7, {}, {id: 7});
  detectReact(chrome);
});

suite.test('An incomplete toolbar API is optional too', () => {
  for (const browserAction of [{}, {setIcon() {}}, {setPopup() {}}]) {
    detectReact(start({browserAction}).chrome);
  }
});

suite.test('A supported browser toolbar still receives its icon and popup', () => {
  const calls = [];
  const browserAction = {
    setIcon(options) { assert.strictEqual(this, browserAction); calls.push({icon: options}); },
    setPopup(options) { assert.strictEqual(this, browserAction); calls.push({popup: options}); }
  };
  detectReact(start({browserAction}).chrome);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [
    {icon: {tabId: 7, path: {
      16: 'icons/16-development.png', 32: 'icons/32-development.png',
      48: 'icons/48-development.png', 128: 'icons/128-development.png'
    }}},
    {popup: {tabId: 7, popup: 'popups/development.html'}}
  ]);
});

suite.test('React inspection messages still flow both ways and disconnect cleanly', () => {
  const {chrome, injected} = start();
  detectReact(chrome);
  const devtools = port('7', 7);
  const content = port('content-script', 7);
  chrome.runtime.onConnect.emit(devtools);
  chrome.runtime.onConnect.emit(content);
  assert.deepStrictEqual(injected, [{tabId: 7, file: '/build/contentScript.js'}]);
  const inspect = {event: 'inspectElement', payload: {id: 1}};
  const response = {event: 'inspectedElement', payload: {id: 1}};
  devtools.onMessage.emit(inspect);
  content.onMessage.emit(response);
  assert.deepStrictEqual(content.messages, [inspect]);
  assert.deepStrictEqual(devtools.messages, [response]);
  devtools.onDisconnect.emit();
  assert.strictEqual(devtools.disconnected, true);
  assert.strictEqual(content.disconnected, true);
  assert.strictEqual(devtools.onMessage.size, 0);
  assert.strictEqual(content.onMessage.size, 0);
});

runSuite(suite);
