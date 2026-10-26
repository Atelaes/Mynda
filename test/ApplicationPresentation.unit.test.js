const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {installApplicationPresentation} = require('../src/main/ApplicationPresentation');
const config = require('../package.json');
const suite = createSuite('Mynda display names and stable application identity', 'unit',
  'Capitalizes visible labels while retaining the existing app/profile and secure-storage identity.');
suite.test('macOS uses Mynda for its application menu and About/Hide/Quit labels', () => {
  let menu, about;
  const app = {getName: () => 'mynda', setAboutPanelOptions: value => {about = value;},
    setName: () => {throw new Error('Do not rename the storage identity');}, setPath: () => {throw new Error('Do not move profiles');}};
  installApplicationPresentation({app, platform: 'darwin', Menu: {
    buildFromTemplate: template => template, setApplicationMenu: template => {menu = template;}
  }});
  assert.strictEqual(menu[0].label, 'Mynda');
  for (const role of ['about', 'hide', 'quit']) assert(menu[0].submenu.find(item => item.role === role).label.includes('Mynda'));
  assert.deepStrictEqual(menu.slice(1).map(item => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
  assert.deepStrictEqual(about, {applicationName: 'Mynda'});
  assert.strictEqual(app.getName(), 'mynda');
});
suite.test('Windows/Linux retain their standard menu structure', () => {
  for (const platform of ['linux', 'win32']) installApplicationPresentation({platform,
    app: {setAboutPanelOptions: options => assert.strictEqual(options.applicationName, 'Mynda')},
    Menu: {setApplicationMenu: () => {throw new Error('Unexpected menu replacement');}}
  });
});
suite.test('bundle display name and page title are capitalized without changing package/bundle identity', () => {
  assert.strictEqual(config.name, 'mynda');
  assert.strictEqual(config.productName, undefined);
  assert.strictEqual(config.build.productName, 'Mynda');
  assert.strictEqual(config.build.appId, 'com.torvor.mynda');
  assert.strictEqual(config.build.mac.extendInfo.CFBundleDisplayName, 'Mynda');
  assert.strictEqual(config.build.mac.extendInfo.CFBundleName, undefined);
  assert(fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8').includes('<title>Mynda</title>'));
});
runSuite(suite);
