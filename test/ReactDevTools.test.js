const assert = require('assert');
const path = require('path');
const loadReactDeveloperTools = require('../src/ReactDevTools.js');

async function run() {
  const calls = [];
  const debugEntries = [];
  const warningEntries = [];
  const extension = {
    id: 'fmkadmapgofadopljbjfkapdkoienihi',
    name: 'React Developer Tools',
    version: '4.12.3'
  };
  const log = {
    debug: (message, details) => debugEntries.push({message, details}),
    warn: (message, details) => warningEntries.push({message, details})
  };

  const loaded = await loadReactDeveloperTools({
    app: {isPackaged: false},
    session: {
      defaultSession: {
        loadExtension: async (...args) => {
          calls.push(args);
          return extension;
        }
      }
    },
    log: log
  });

  assert.strictEqual(loaded, extension);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], loadReactDeveloperTools.DEFAULT_EXTENSION_PATH);
  assert.deepStrictEqual(calls[0][1], {allowFileAccess: true});
  assert.strictEqual(path.isAbsolute(calls[0][0]), true);
  assert.strictEqual(
    calls[0][0].endsWith(path.join('devtools', 'react-developer-tools')),
    true
  );
  assert.deepStrictEqual(debugEntries, [{
    message: 'React developer tools loaded',
    details: {
      name: 'React Developer Tools',
      version: '4.12.3',
      path: loadReactDeveloperTools.DEFAULT_EXTENSION_PATH
    }
  }]);
  assert.deepStrictEqual(warningEntries, []);

  let packagedLoadAttempted = false;
  const packagedResult = await loadReactDeveloperTools({
    app: {isPackaged: true},
    session: {
      defaultSession: {
        loadExtension: async () => {
          packagedLoadAttempted = true;
        }
      }
    },
    log: log
  });
  assert.strictEqual(packagedResult, null);
  assert.strictEqual(packagedLoadAttempted, false);

  const expectedError = new Error('extension load failed');
  const failed = await loadReactDeveloperTools({
    app: {isPackaged: false},
    session: {
      defaultSession: {
        loadExtension: async () => {
          throw expectedError;
        }
      }
    },
    log: log,
    extensionPath: '/tmp/react-developer-tools-test'
  });
  assert.strictEqual(failed, null);
  assert.deepStrictEqual(warningEntries, [{
    message: 'Could not load React developer tools',
    details: {
      path: '/tmp/react-developer-tools-test',
      error: expectedError
    }
  }]);

  console.log('React developer tools loader tests passed.');
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
