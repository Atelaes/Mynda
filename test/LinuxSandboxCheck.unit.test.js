const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const check = require('../src/main/LinuxSandboxCheck');
const runner = require('./package/run-packaged-media-smoke');
const config = require('../package.json');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {EventEmitter} = require('events');

const suite = createSuite('Installed Linux sandbox evidence', 'unit',
  'Rejects disabled or inherited-only sandboxes and keeps native installed-app checks separate from developer runs.');
const status = ({seccomp = 2, filters = 1, nnp = 1, pids = '200 2'} = {}) =>
  `Name:\tmynda\nSeccomp:\t${seccomp}\nSeccomp_filters:\t${filters}\nNoNewPrivs:\t${nnp}\nNSpid:\t${pids}\n`;
const main = status({seccomp: 0, filters: 0, nnp: 0, pids: '100'});

suite.test('accepts renderer-specific kernel restrictions on a normal desktop', () => {
  const evidence = check.assertSandboxStatus(main, status());
  assert.deepStrictEqual(evidence.renderer.namespacePids, [200, 2]);
  assert.strictEqual(evidence.renderer.filters, 1);
});

suite.test('accepts extra renderer restrictions inside an already restricted environment', () => {
  const evidence = check.assertSandboxStatus(status({pids:'100 10'}), status({filters:2,pids:'200 20 2'}));
  assert.strictEqual(evidence.renderer.filters - evidence.main.filters, 1);
});

suite.test('rejects every missing sandbox layer and unreadable evidence', () => {
  for (const value of [status({seccomp:0}), status({nnp:0}), status({filters:0}),
    status({pids:'200'}), '', 'Seccomp: 2\nNoNewPrivs: 1\nNSpid: 200 2\n']) {
    assert.throws(() => check.assertSandboxStatus(main, value), /Linux sandbox check failed/);
  }
  assert.throws(() => check.assertSandboxStatus('', status()), /Linux sandbox check failed/);
});

suite.test('an inherited container filter or namespace cannot masquerade as Chromium sandboxing', () => {
  assert.throws(() => check.assertSandboxStatus(status({pids:'100 10'}), status({pids:'200 20'})),
    /no additional renderer seccomp filter.*no additional renderer PID namespace/);
});

suite.test('native probe rejects root and disabling switches before creating a window', async () => {
  const BrowserWindow = function() { throw new Error('Should not create a window'); };
  await assert.rejects(check.run({platform:'linux',uid:0,BrowserWindow}), /without sudo/);
  await assert.rejects(check.run({platform:'darwin',uid:501,BrowserWindow}), /requires Linux/);
  for (const switchName of check.DISABLING_SWITCHES) {
    await assert.rejects(check.run({platform:'linux',uid:1000,BrowserWindow,
      app:{commandLine:{hasSwitch:name=>name===switchName}}}), /Sandbox-disabling switches/);
  }
});

suite.test('probe uses its actual renderer PID, preserves evidence and always destroys the window', async () => {
  for (const fail of [false, true]) {
    let destroyed = false;
    const paths = [];
    class BrowserWindow {
      constructor(options) {
        assert.deepStrictEqual(options.webPreferences, {sandbox:true,contextIsolation:true,nodeIntegration:false});
        this.webContents = {getOSProcessId:()=>987654};
      }
      async loadURL(url) { assert(url.startsWith('data:text/html,')); }
      isDestroyed() { return destroyed; }
      destroy() { destroyed = true; }
    }
    const promise = check.run({platform:'linux',uid:1000,BrowserWindow,
      app:{commandLine:{hasSwitch:()=>false}},
      readFileSync(filename) {
        paths.push(filename);
        if (filename === '/proc/self/status') return main;
        if (fail) throw new Error('proc status unavailable');
        return status();
      }});
    if (fail) await assert.rejects(promise, /proc status unavailable/);
    else assert.strictEqual((await promise).pid, 987654);
    assert.deepStrictEqual(paths, ['/proc/self/status','/proc/987654/status']);
    assert(destroyed);
  }
});

suite.test('installed runner targets the requested executable and refuses a root sandbox bypass', () => {
  const options = runner.parseOptions(['--executable=/opt/Mynda/mynda','--require-sandbox']);
  assert.deepStrictEqual(options, {executable:path.resolve('/opt/Mynda/mynda'),requireSandbox:true});
  assert.throws(() => runner.assertSandboxTestUser(options, 'linux', 0), /without sudo/);
  assert.throws(() => runner.assertSandboxTestUser(options, 'win32', null), /requires Linux/);
  runner.assertSandboxTestUser(options, 'linux', 1000);
  assert.throws(() => runner.parseOptions(['--no-sandbox']), /Unknown/);
});

suite.test('installed runner requires a positive sandbox result and never adds a bypass flag', async () => {
  const filename = path.join(__dirname, 'package/run-packaged-media-smoke.js');
  for (const sandbox of [undefined, {ok:false}, {ok:true,value:{pid:123}}]) {
    const exports = {exports:{}};
    let captured;
    vm.runInNewContext(fs.readFileSync(filename,'utf8'), {
      module:exports, __dirname:path.dirname(filename), console, setTimeout, clearTimeout,
      process:{platform:'linux',getuid:()=>1000,env:{PATH:'/usr/bin',ELECTRON_RUN_AS_NODE:'1'}},
      require(name) {
        if (name !== 'child_process') return require(name);
        return {spawn(executable,args,options) {
          captured = {executable,args,options};
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => {
            child.stdout.emit('data', 'MYNDA_PACKAGED_MEDIA_SMOKE_RESULT:' +
              JSON.stringify({ok:true,checks:{sandbox}}) + '\n');
            child.emit('close',0,null);
          });
          return child;
        }};
      }
    }, {filename});
    const pending = exports.exports.launch('/opt/Mynda/mynda','/tmp/probe-profile',{requireSandbox:true});
    if (sandbox?.ok) await pending;
    else await assert.rejects(pending, /did not report a successful sandbox check/);
    assert(!captured.args.includes('--no-sandbox'));
    assert.strictEqual(captured.options.env.PATH, '');
    assert.strictEqual(captured.options.env.MYNDA_REQUIRE_SANDBOX, '1');
    assert.strictEqual(captured.options.env.ELECTRON_RUN_AS_NODE, undefined);
  }
});

suite.test('Ubuntu defaults to DEB and the installed check requests mandatory sandbox evidence', () => {
  assert.strictEqual(config.build.linux.target, 'deb');
  assert.strictEqual(config.build.linux.executableArgs, undefined);
  assert.match(config.scripts['test:installed'], /--executable=\/opt\/Mynda\/mynda --require-sandbox/);
  // Verify the actual UI keeps the same sandbox request as the native probe.
  const mainSource = fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
  for (const preference of [/sandbox:\s*true/, /contextIsolation:\s*true/, /nodeIntegration:\s*false/]) {
    assert.match(mainSource, preference);
  }
});

suite.test('Linux smoke test selects the matching architecture when both packages exist', async () => {
  await withTemporaryDirectory('linux-smoke-targets', root => {
    for (const directory of ['linux-unpacked', 'linux-arm64-unpacked']) {
      fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, directory, 'mynda'), 'fixture');
    }
    for (const [arch, directory] of [['x64', 'linux-unpacked'], ['arm64', 'linux-arm64-unpacked']]) {
      assert.strictEqual(runner.packagedExecutable({platform:'linux',arch,distDirectory:root}),
        path.join(root, directory, 'mynda'));
    }
    fs.unlinkSync(path.join(root, 'linux-arm64-unpacked/mynda'));
    assert.throws(() => runner.packagedExecutable({platform:'linux',arch:'arm64',distDirectory:root}),
      /Could not find.*linux-arm64/);
  });
});

runSuite(suite);
