const fs = require('fs');
const path = require('path');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');

const quietLogger = {child: () => ({debug() {}, info() {}, warn() {}, error() {}})};
const suite = createSuite(
  'Small configuration-file storage',
  'integration',
  'Combines ReadWrite with real files in a disposable Electron user-data directory.'
);

function loadReadWrite(directory, renderer = false) {
  const app = {getPath: name => {
    assert.strictEqual(name, 'userData');
    return directory;
  }};
  return loadFreshWithMocks(
    path.join(__dirname, '..', 'src', 'platform', 'ReadWrite.js'),
    {
      'electron': renderer ? {remote: {app}} : {app},
      './Logger.js': quietLogger
    }
  );
}

suite.test('creates a missing file from defaults in the main process', () => withTemporaryDirectory(
  'readwrite-defaults',
  directory => {
    const ReadWrite = loadReadWrite(directory);
    const defaults = {theme: 'dark', volume: 75};
    const store = new ReadWrite({configName: 'preferences', extension: 'json', defaults});
    assert.deepStrictEqual(store.data, defaults);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'preferences.json'), 'utf8')),
      defaults
    );
  }
));

suite.test('loads existing data through Electron remote in the renderer', () => withTemporaryDirectory(
  'readwrite-renderer',
  directory => {
    fs.writeFileSync(path.join(directory, 'preferences.json'), JSON.stringify({theme: 'light'}));
    const ReadWrite = loadReadWrite(directory, true);
    const store = new ReadWrite({
      configName: 'preferences', extension: 'json', defaults: {theme: 'dark'}
    });
    assert.strictEqual(store.get('theme'), 'light');
  }
));

suite.test('persists values set after construction', () => withTemporaryDirectory(
  'readwrite-set',
  directory => {
    const ReadWrite = loadReadWrite(directory);
    const store = new ReadWrite({configName: 'state', extension: 'json', defaults: {count: 0}});
    store.set('count', 3);
    assert.strictEqual(store.get('count'), 3);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')).count,
      3
    );
  }
));

suite.test('replaces malformed JSON with explicit defaults', () => withTemporaryDirectory(
  'readwrite-malformed',
  directory => {
    const filePath = path.join(directory, 'state.json');
    fs.writeFileSync(filePath, '{not valid json');
    const ReadWrite = loadReadWrite(directory);
    const store = new ReadWrite({configName: 'state', extension: 'json', defaults: {safe: true}});
    assert.deepStrictEqual(store.data, {safe: true});
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {safe: true});
  }
));

runSuite(suite);
