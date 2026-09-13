const fs = require('fs');
const path = require('path');
const {createCache} = require('../scripts/lib/MediaBuildCache.js');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');

const suite = createSuite('Resumable Windows media build storage', 'integration',
  'Uses disposable files and simulated Windows locks to verify checkpoints, retries, publication, and recovery.');
const io = fs.promises;
const cache = overrides => createCache({sleep: async () => {}, log: () => {}, attempts: 3, ...overrides});
const locked = () => Object.assign(new Error('simulated Windows file lock'), {code: 'EPERM'});
async function write(root, relative, value = relative) {
  const filename = path.join(root, relative);
  await io.mkdir(path.dirname(filename), {recursive: true});
  await io.writeFile(filename, value);
}
const read = (root, relative) => io.readFile(path.join(root, relative), 'utf8');
async function fixture(root) {
  const source = path.join(root, 'cache', 'bundle');
  const destination = path.join(root, 'synced project', 'win-x64');
  const journal = path.join(root, 'cache', 'publications');
  await write(source, 'mpv.exe', 'new player');
  await write(source, 'licenses/msys2/LICENSE', 'license');
  await write(destination, 'mpv.exe', 'old player');
  return {source, destination, journal};
}

suite.test('does not checkpoint incomplete output or confuse compiler work with installed tools', () =>
  withTemporaryDirectory('media-cache', async root => {
    const store = cache();
    await write(root, 'source/object.o');
    await write(root, 'install/bin/ffmpeg.exe');
    assert.strictEqual(await store.cacheStatus(root, 'key'), 'incomplete');
    await assert.rejects(store.seal(root, 'key', 'component', ['bin/ffprobe.exe']), /required output/);
    await write(root, 'install/bin/ffprobe.exe', '');
    await assert.rejects(store.seal(root, 'key', 'component', ['bin/ffprobe.exe']), /empty/);
    assert.strictEqual(await store.cacheStatus(root, 'key'), 'incomplete');
    assert.strictEqual(await read(root, 'source/object.o'), 'source/object.o');
  }));

suite.test('reuses only matching inputs and unchanged complete installed files', () =>
  withTemporaryDirectory('media-cache', async root => {
    const store = cache();
    await write(root, 'install/bin/library.dll', 'original');
    await store.seal(root, 'recipe-a', 'component', ['bin/*.dll']);
    assert.strictEqual(await store.cacheStatus(root, 'recipe-a'), 'ready');
    assert.strictEqual(await store.cacheStatus(root, 'recipe-b'), 'damaged');
    // Same size, different bytes must also invalidate the cache.
    await write(root, 'install/bin/library.dll', 'tampered');
    assert.strictEqual(await store.cacheStatus(root, 'recipe-a'), 'damaged');
    await io.unlink(path.join(root, 'install/bin/library.dll'));
    assert.strictEqual(await store.cacheStatus(root, 'recipe-a'), 'damaged');
  }));

suite.test('allows refreshed verification reports but detects modified bundle binaries and notices', () =>
  withTemporaryDirectory('media-cache', async root => {
    const store = cache();
    await write(root, 'bundle/mpv.exe');
    await write(root, 'bundle/THIRD_PARTY_NOTICES.md');
    await store.seal(root, 'key', 'bundle', ['mpv.exe']);
    await write(root, 'bundle/build-info.json', '{"verified":true}');
    assert.strictEqual(await store.cacheStatus(root, 'key', 'bundle'), 'ready');
    await write(root, 'bundle/THIRD_PARTY_NOTICES.md', 'changed notice');
    assert.strictEqual(await store.cacheStatus(root, 'key', 'bundle'), 'damaged');
  }));

suite.test('treats malformed completion metadata as invalid without deleting build progress', () =>
  withTemporaryDirectory('media-cache', async root => {
    const store = cache();
    await write(root, 'complete.json', '{');
    await write(root, 'source/object.o');
    assert.strictEqual(await store.cacheStatus(root, 'key'), 'damaged');
    assert.strictEqual(await read(root, 'source/object.o'), 'source/object.o');
  }));

suite.test('copies and verifies a first publication and leaves the compiled cache intact', () =>
  withTemporaryDirectory('media-cache', async root => {
    const store = cache();
    const {source, destination, journal} = await fixture(root);
    await store.removeTree(destination);
    await store.publish(source, destination, journal);
    assert.deepStrictEqual(await store.snapshot(destination), await store.snapshot(source));
    await store.publish(source, destination, journal);
    assert.deepStrictEqual(await io.readdir(journal), []);
  }));

suite.test('retries transient destination locks and replaces the old bundle after they clear', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    let blocked = 0;
    const store = cache({fs: {...io, rename: async (from, to) => {
      if (from === destination && blocked++ < 2) throw locked();
      return io.rename(from, to);
    }}});
    await store.publish(source, destination, journal);
    assert.strictEqual(blocked, 3);
    assert.deepStrictEqual(await store.snapshot(destination), await store.snapshot(source));
    assert.deepStrictEqual(await io.readdir(journal), []);
  }));

suite.test('rolls back a failed replacement and succeeds on retry using the preserved bundle', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    let blocked = true;
    const store = cache({fs: {...io, rename: async (from, to) => {
      if (blocked && to === destination && path.basename(from).includes('.new.')) throw locked();
      return io.rename(from, to);
    }}});
    await store.seal(path.dirname(source), 'key', 'bundle', ['mpv.exe']);
    await assert.rejects(store.publish(source, destination, journal), /compilation results are preserved/);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'old player');
    assert.strictEqual(await store.cacheStatus(path.dirname(source), 'key', 'bundle'), 'ready');
    blocked = false;
    await store.publish(source, destination, journal);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'new player');
    assert.deepStrictEqual(await io.readdir(journal), []);
  }));

suite.test('recovers a journal when a lock also prevented restoring the previous bundle', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    let blocked = true;
    const store = cache({fs: {...io, rename: async (from, to) => {
      if (blocked && to === destination) throw locked();
      return io.rename(from, to);
    }}});
    await assert.rejects(store.publish(source, destination, journal), /preserved here for recovery/);
    const record = JSON.parse(await read(journal, (await io.readdir(journal))[0]));
    assert.strictEqual(await read(record.backup, 'mpv.exe'), 'old player');
    assert.strictEqual(await read(source, 'mpv.exe'), 'new player');
    blocked = false;
    await store.publish(source, destination, journal);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'new player');
    assert.deepStrictEqual(await io.readdir(journal), []);
  }));

suite.test('preserves an existing bundle and source when copying into the project fails', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    let blocked = true;
    const store = cache({fs: {...io, copyFile: async (from, to) => {
      if (blocked && to.endsWith('mpv.exe')) throw locked();
      return io.copyFile(from, to);
    }}});
    await assert.rejects(store.publish(source, destination, journal), /preserved/);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'old player');
    assert.strictEqual(await read(source, 'mpv.exe'), 'new player');
    blocked = false;
    await store.publish(source, destination, journal);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'new player');
  }));

suite.test('keeps a usable new bundle when an old backup is locked and cleans it on the next run', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    let blocked = true;
    const store = cache({fs: {...io, unlink: async filename => {
      if (blocked && filename.includes('.old.')) throw locked();
      return io.unlink(filename);
    }}});
    await store.publish(source, destination, journal);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'new player');
    assert.strictEqual((await io.readdir(journal)).length, 1);
    await store.publish(source, destination, journal);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'new player');
    blocked = false;
    await store.publish(source, destination, journal);
    assert.deepStrictEqual(await io.readdir(journal), []);
  }));

suite.test('refuses conflicting recovery data instead of overwriting either retained bundle', () =>
  withTemporaryDirectory('media-cache', async root => {
    const {source, destination, journal} = await fixture(root);
    const store = cache({fs: {...io, unlink: async filename => {
      if (filename.includes('.old.')) throw locked();
      return io.unlink(filename);
    }}});
    await store.publish(source, destination, journal);
    const record = JSON.parse(await read(journal, (await io.readdir(journal))[0]));
    await write(destination, 'mpv.exe', 'externally modified');
    await assert.rejects(store.publish(source, destination, journal), /Both copies were preserved/);
    assert.strictEqual(await read(destination, 'mpv.exe'), 'externally modified');
    assert.strictEqual(await read(record.backup, 'mpv.exe'), 'old player');
  }));

suite.test('prevents a second live preparation and recovers a dead owner without accepting another unlock token', () =>
  withTemporaryDirectory('media-cache', async root => {
    let alive = true;
    const store = cache({isAlive: () => alive});
    const first = await store.acquireLock(root, 123);
    await assert.rejects(store.acquireLock(root, 456), /still running/);
    await store.releaseLock(root, 'wrong-token');
    await assert.rejects(store.acquireLock(root, 456), /still running/);
    alive = false;
    const second = await store.acquireLock(root, 456);
    assert.notStrictEqual(first, second);
    await store.releaseLock(root, first);
    assert.strictEqual(JSON.parse(await read(root, 'prepare.lock')).token, second);
    await store.releaseLock(root, second);
    assert.strictEqual(fs.existsSync(path.join(root, 'prepare.lock')), false);
  }));

runSuite(suite);
