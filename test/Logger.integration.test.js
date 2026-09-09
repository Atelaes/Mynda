const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');

const loggerPath = path.join(__dirname, '..', 'src', 'Logger.js');
const suite = createSuite(
  'Backend logging, redaction, IPC forwarding, and rotation',
  'integration',
  'Uses real temporary log files while replacing only Electron and the terminal console.'
);

function loadLogger(electron = {}) {
  return loadFreshWithMocks(loggerPath, {'electron': electron});
}

async function withoutConsoleOutput(operation) {
  const methods = ['debug', 'log', 'warn', 'error'];
  const originals = {};
  methods.forEach(method => {
    originals[method] = console[method];
    console[method] = () => {};
  });
  try {
    return await operation();
  } finally {
    methods.forEach(method => { console[method] = originals[method]; });
  }
}

suite.test('routes levels to the correct files and redacts secrets', () => withTemporaryDirectory(
  'logger-routing',
  async directory => {
    const ipcMain = new EventEmitter();
    const Logger = loadLogger();

    await withoutConsoleOutput(async () => {
      Logger.initialize({logDirectory: directory, ipcMain});
      const log = Logger.child('Test');
      log.debug('debug stays out of files');
      log.info('ordinary information', {apiKey: 'visible-api-key'});
      log.warn('token=visible-token');
      log.error('failed safely', {authorization: 'Bearer visible-authorization'});
      ipcMain.emit('mynda-backend-log', {}, {
        timestamp: '2026-09-07T01:00:00.000Z',
        level: 'debug',
        scope: 'RendererTest',
        pid: 123,
        message: 'renderer debug remains console only'
      });
      ipcMain.emit('mynda-backend-log', {}, {
        timestamp: '2026-09-07T01:00:00.000Z',
        level: 'info',
        scope: 'RendererTest',
        pid: 123,
        message: 'renderer forwarded this',
        details: 'password=visible-password'
      });
      await Logger.flush();
    });

    const info = fs.readFileSync(path.join(directory, 'mynda-info.log'), 'utf8');
    const error = fs.readFileSync(path.join(directory, 'mynda-error.log'), 'utf8');
    assert(info.includes('ordinary information'));
    assert(info.includes('WARN [Test]'));
    assert(info.includes('failed safely'));
    assert(info.includes('[RendererTest] [renderer:123] renderer forwarded this'));
    assert(!info.includes('debug stays out of files'));
    assert(!info.includes('renderer debug remains console only'));
    assert(error.includes('failed safely'));
    assert(!error.includes('ordinary information'));
    assert(info.includes('[REDACTED]'));
    ['visible-api-key', 'visible-token', 'visible-authorization', 'visible-password'].forEach(secret => {
      assert(!info.includes(secret), `Log exposed ${secret}`);
      assert(!error.includes(secret), `Error log exposed ${secret}`);
    });

    await Logger.shutdown();
    assert.strictEqual(ipcMain.listenerCount('mynda-backend-log'), 0);
  }
));

suite.test('shows renderer DEBUG at the normal DevTools level and still forwards it', async () => {
  const originalProcessType = Object.getOwnPropertyDescriptor(process, 'type');
  const originalConsole = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error
  };
  const calls = {debug: [], log: []};
  const forwarded = [];

  try {
    Object.defineProperty(process, 'type', {
      configurable: true,
      value: 'renderer'
    });
    console.debug = (...args) => calls.debug.push(args);
    console.log = (...args) => calls.log.push(args);
    console.warn = () => {};
    console.error = () => {};

    const Logger = loadLogger({
      ipcRenderer: {
        send: (...args) => forwarded.push(args)
      }
    });
    Logger.child('RendererConsole').debug('visible debug detail', {videoID: 'video-1'});

    assert.strictEqual(calls.debug.length, 0);
    assert.strictEqual(calls.log.length, 1);
    assert.strictEqual(calls.log[0][5], 'DEBUG');
    assert(calls.log[0][7].includes('[RendererConsole] [renderer:'));
    assert(calls.log[0][7].includes('visible debug detail'));
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(forwarded[0][0], 'mynda-backend-log');
    assert.strictEqual(forwarded[0][1].level, 'debug');
  } finally {
    console.debug = originalConsole.debug;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    if (originalProcessType) {
      Object.defineProperty(process, 'type', originalProcessType);
    } else {
      delete process.type;
    }
  }
});

suite.test('rotates large logs and honors the configured backup limit', () => withTemporaryDirectory(
  'logger-rotation',
  async directory => {
    const Logger = loadLogger();
    await withoutConsoleOutput(async () => {
      Logger.initialize({logDirectory: directory, maxFileSize: 420, maxBackups: 2});
      const log = Logger.child('Rotation');
      for (let index = 0; index < 16; index++) {
        log.info(`rotation-entry-${index}`, {padding: 'x'.repeat(180)});
      }
      await Logger.flush();
      await Logger.shutdown();
    });

    const names = fs.readdirSync(directory).sort();
    assert(names.includes('mynda-info.log'));
    assert(names.includes('mynda-info.1.log'));
    assert(names.includes('mynda-info.2.log'));
    assert(!names.includes('mynda-info.3.log'));
    const retained = names
      .filter(name => /^mynda-info(?:\.\d+)?\.log$/.test(name))
      .map(name => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('');
    assert(retained.includes('rotation-entry-15'));
  }
));

runSuite(suite);
