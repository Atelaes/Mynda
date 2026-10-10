const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {buildRenderer} = require('../scripts/build-renderer');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const root = path.resolve(__dirname, '..');
const suite = createSuite('Browser renderer build and update safety', 'integration',
  'Fresh JSX compilation without Node, rejected privileged imports, and release build ordering.');

suite.test('same-timestamp source updates replace the runnable browser bundle without a runtime compiler', async () => {
  await withTemporaryDirectory('renderer-update', async directory => {
    const entryPoint = path.join(directory, 'entry.js');
    const outfile = path.join(directory, 'renderer.js');
    const timestamp = new Date('2020-01-01T00:00:00Z');
    const write = tag => {
      fs.writeFileSync(entryPoint, `const React = require(${JSON.stringify(require.resolve('react'))});\n` +
        `const element = <${tag}>Updated report</${tag}>; globalThis.fixtureResult = element.type;\n`);
      fs.utimesSync(entryPoint, timestamp, timestamp);
    };
    const launch = async () => {
      await buildRenderer({entryPoint, outfile});
      const context = vm.createContext({}, {codeGeneration: {strings: false, wasm: false}});
      vm.runInContext(fs.readFileSync(outfile, 'utf8'), context);
      assert.strictEqual(typeof context.require, 'undefined');
      assert.strictEqual(typeof context.process, 'undefined');
      return context.fixtureResult;
    };
    write('p');
    assert.strictEqual(await launch(), 'p');
    write('strong');
    assert.strictEqual(await launch(), 'strong');
    write('article');
    assert.strictEqual(await launch(), 'article');
  });
});

suite.test('privileged renderer imports fail compilation instead of becoming browser shims', async () => {
  await withTemporaryDirectory('renderer-boundary', async directory => {
    const entryPoint = path.join(directory, 'entry.js');
    const outfile = path.join(directory, 'renderer.js');
    for (const request of ['electron', 'fs', 'node:fs', 'child_process', 'path']) {
      fs.writeFileSync(entryPoint, `globalThis.test = require(${JSON.stringify(request)});`);
      await assert.rejects(buildRenderer({entryPoint, outfile}), /isolated renderer cannot import/);
    }
    assert.strictEqual(fs.existsSync(outfile), false);
  });
});

suite.test('a failed rebuild leaves the last complete bundle intact', async () => {
  await withTemporaryDirectory('renderer-failed-build', async directory => {
    const entryPoint = path.join(directory, 'entry.js');
    const outfile = path.join(directory, 'renderer.js');
    fs.writeFileSync(entryPoint, 'globalThis.fixtureResult = 1;');
    await buildRenderer({entryPoint, outfile});
    const complete = fs.readFileSync(outfile);
    fs.writeFileSync(entryPoint, 'const unfinished = ;');
    await assert.rejects(buildRenderer({entryPoint, outfile}));
    assert(fs.readFileSync(outfile).equals(complete));
  });
});

suite.test('the production packaging hook awaits the bundle before media verification', async () => {
  const calls = [];
  const hook = loadFreshWithMocks(require.resolve('../scripts/before-build'), {
    './build-renderer.js': {buildRenderer: async options => { calls.push(options.mode); }},
    './verify-media-tools.js': async context => { calls.push(context.fixture); return true; }
  });
  assert.strictEqual(await hook({fixture: 'media'}), true);
  assert.deepStrictEqual(calls, ['production', 'media']);
});

suite.test('the page permits only external local scripts and no renderer network requests', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.strictEqual(scriptTags.length, 1);
  assert.match(scriptTags[0][1], /src="generated\/renderer\.js"/);
  assert.strictEqual(scriptTags[0][2].trim(), '');
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(policy, /(?:^|; )script-src 'self'(?:;|$)/);
  assert.match(policy, /(?:^|; )connect-src 'none'(?:;|$)/);
  assert(!policy.includes('unsafe-eval'));
});

runSuite(suite);
