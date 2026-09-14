const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');
const Cleanup = require('../scripts/finish-source-reorganization.js');

const suite = createSuite('Source reorganization cleanup safety', 'integration',
  'Uses disposable projects to verify backups, Windows line endings, interrupted cleanup, and preservation of unexpected edits.');

function fixture(directory) {
  const root = path.join(directory, 'Project With Spaces');
  const manifest = {files: []};
  for (const name of ['First.js', 'Second.js']) {
    const entry = {from: `src/${name}`, to: `src/library/${name}`, text: true};
    const before = Buffer.from(`// old ${name}\nmodule.exports = 1;\n`);
    const after = Buffer.from(`// new ${name}\nmodule.exports = 1;\n`);
    for (const [relative, bytes] of [[entry.from, before], [entry.to, after]]) {
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      fs.writeFileSync(filename, bytes);
    }
    entry.before = Cleanup.digest(before, true);
    entry.after = Cleanup.digest(after, true);
    manifest.files.push(entry);
  }
  fs.writeFileSync(path.join(root, 'src', 'Unrelated.js'), 'keep me');
  return {root, manifest};
}

suite.test('checks without writing, then backs up exact old bytes before removing them', async () => {
  await withTemporaryDirectory('reorganize', directory => {
    const {root, manifest} = fixture(directory);
    const oldBytes = fs.readFileSync(path.join(root, manifest.files[0].from));
    assert.strictEqual(Cleanup.finish(root, manifest, {check: true}).pending, 2);
    assert.deepStrictEqual(fs.readdirSync(directory), ['Project With Spaces']);
    const result = Cleanup.finish(root, manifest);
    assert.strictEqual(result.removed, 2);
    assert(fs.readFileSync(path.join(result.backup, manifest.files[0].from)).equals(oldBytes));
    assert(!fs.existsSync(path.join(root, manifest.files[0].from)));
    assert(fs.existsSync(path.join(root, manifest.files[0].to)));
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'Unrelated.js'), 'utf8'), 'keep me');
    assert.strictEqual(Cleanup.finish(root, manifest).removed, 0);
  });
});

suite.test('preserves every old file when any old file contains unexpected edits', async () => {
  await withTemporaryDirectory('reorganize-edits', directory => {
    const {root, manifest} = fixture(directory);
    fs.appendFileSync(path.join(root, manifest.files[1].from), '// user edit\n');
    assert.throws(() => Cleanup.finish(root, manifest), /No old files were removed/);
    for (const entry of manifest.files) assert(fs.existsSync(path.join(root, entry.from)));
    assert.deepStrictEqual(fs.readdirSync(directory), ['Project With Spaces']);
  });
});

suite.test('preserves every old file when a replacement is missing or changed', async () => {
  await withTemporaryDirectory('reorganize-incomplete', directory => {
    const {root, manifest} = fixture(directory);
    const destination = path.join(root, manifest.files[1].to);
    fs.unlinkSync(destination);
    assert.throws(() => Cleanup.finish(root, manifest), /replacement is missing or has changed/);
    fs.writeFileSync(destination, 'incomplete download');
    assert.throws(() => Cleanup.finish(root, manifest), /replacement is missing or has changed/);
    for (const entry of manifest.files) assert(fs.existsSync(path.join(root, entry.from)));
    fs.unlinkSync(path.join(root, manifest.files[1].from));
    assert.throws(() => Cleanup.finish(root, manifest), /replacement is missing or has changed/);
    assert(fs.existsSync(path.join(root, manifest.files[0].from)));
  });
});

suite.test('accepts Git CRLF conversion while backing up original Windows bytes', async () => {
  await withTemporaryDirectory('reorganize-crlf', directory => {
    const {root, manifest} = fixture(directory);
    for (const entry of manifest.files) {
      for (const relative of [entry.from, entry.to]) {
        const filename = path.join(root, relative);
        fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/\n/g, '\r\n'));
      }
    }
    const result = Cleanup.finish(root, manifest);
    assert(fs.readFileSync(path.join(result.backup, manifest.files[0].from), 'utf8').includes('\r\n'));
  });
});

suite.test('can finish after some old files have already been removed', async () => {
  await withTemporaryDirectory('reorganize-resume', directory => {
    const {root, manifest} = fixture(directory);
    fs.unlinkSync(path.join(root, manifest.files[0].from));
    assert.strictEqual(Cleanup.finish(root, manifest).removed, 1);
    assert(fs.existsSync(path.join(root, manifest.files[0].to)));
  });
});

suite.test('rejects paths outside the project before doing any cleanup', async () => {
  await withTemporaryDirectory('reorganize-boundary', directory => {
    const {root, manifest} = fixture(directory);
    manifest.files[1].from = '../unrelated.js';
    assert.throws(() => Cleanup.finish(root, manifest), /Invalid cleanup path/);
    assert(fs.existsSync(path.join(root, manifest.files[0].from)));
  });
});

runSuite(suite);
