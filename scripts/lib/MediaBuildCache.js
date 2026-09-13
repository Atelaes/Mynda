const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const RETRYABLE = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(12).toString('hex');

function createCache(options = {}) {
  const io = options.fs || fs.promises;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = options.log || (message => console.error(message));
  const attempts = options.attempts || 8;
  const isAlive = options.isAlive || (pid => {
    try { process.kill(pid, 0); return true; }
    catch(error) { if (error.code === 'ESRCH') return false; return true; }
  });

  async function retry(operation, label) {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch(error) {
        if (!RETRYABLE.has(error.code) || attempt + 1 >= attempts) throw error;
        if (attempt === 0) log(`Windows has not released ${label}; retrying briefly...`);
        await sleep(Math.min(250 * (attempt + 1), 1000));
      }
    }
  }

  async function exists(filename) {
    try { await io.lstat(filename); return true; }
    catch(error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async function readJSON(filename) {
    try { return JSON.parse(await io.readFile(filename, 'utf8')); }
    catch(error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return {invalid: true};
      throw error;
    }
  }

  async function writeJSON(filename, value) {
    await io.mkdir(path.dirname(filename), {recursive: true});
    const temporary = `${filename}.tmp.${token()}`;
    await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
    await retry(() => io.rename(temporary, filename), filename);
  }

  async function removeTree(directory) {
    const absolute = path.resolve(directory);
    if (absolute === path.parse(absolute).root) throw new Error('Refusing to remove a filesystem root.');
    if (!await exists(absolute)) return;
    const stat = await io.lstat(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of await io.readdir(absolute)) await removeTree(path.join(absolute, name));
      await retry(() => io.rmdir(absolute), absolute);
    } else {
      await retry(() => io.unlink(absolute), absolute);
    }
  }

  async function snapshot(directory, ignoreBuildInfo = false) {
    const files = [];
    const root = await io.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Expected a media output directory: ${directory}`);
    async function walk(relative) {
      const current = path.join(directory, relative);
      for (const name of (await io.readdir(current)).sort()) {
        const child = path.join(relative, name);
        if (ignoreBuildInfo && child === 'build-info.json') continue;
        const filename = path.join(directory, child);
        const stat = await io.lstat(filename);
        if (stat.isSymbolicLink()) throw new Error(`Unexpected link in media build output: ${filename}`);
        if (stat.isDirectory()) await walk(child);
        else if (stat.isFile()) {
          files.push({path: child.split(path.sep).join('/'), size: stat.size,
            sha256: digest(await retry(() => io.readFile(filename), filename))});
        } else throw new Error(`Unexpected media build output: ${filename}`);
      }
    }
    await walk('');
    return files;
  }

  const payload = (root, kind) => path.join(root, kind === 'bundle' ? 'bundle' : 'install');
  const sameFiles = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function cacheStatus(root, key, kind = 'component') {
    const record = await readJSON(path.join(root, 'complete.json'));
    if (!record) return 'incomplete';
    if (record.schema !== SCHEMA || record.key !== key || record.kind !== kind) return 'damaged';
    try {
      const files = await snapshot(payload(root, kind), kind === 'bundle');
      return files.length && sameFiles(files, record.files) ? 'ready' : 'damaged';
    } catch(error) {
      if (error.code === 'ENOENT') return 'damaged';
      throw error;
    }
  }

  async function seal(root, key, kind = 'component', required = []) {
    const files = await snapshot(payload(root, kind), kind === 'bundle');
    if (!files.length) throw new Error(`Cannot checkpoint empty media output: ${root}`);
    for (const pattern of required) {
      const expression = new RegExp('^' + pattern.split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      if (!files.some(file => expression.test(file.path) && file.size > 0)) {
        throw new Error(`Cannot checkpoint ${root}: required output is missing or empty: ${pattern}`);
      }
    }
    await writeJSON(path.join(root, 'complete.json'), {schema: SCHEMA, key, kind, files});
  }

  async function copyTree(source, destination) {
    const files = await snapshot(source);
    await retry(() => io.mkdir(destination, {recursive: true}), destination);
    for (const file of files) {
      const target = path.join(destination, ...file.path.split('/'));
      await retry(() => io.mkdir(path.dirname(target), {recursive: true}), path.dirname(target));
      await retry(() => io.copyFile(path.join(source, ...file.path.split('/')), target), target);
    }
    if (!sameFiles(files, await snapshot(destination))) {
      throw new Error(`Copied media output did not match its cached source: ${destination}`);
    }
    return files;
  }

  async function matches(directory, files) {
    if (!await exists(directory)) return false;
    return sameFiles(await snapshot(directory), files);
  }

  async function publish(source, destination, journalDirectory) {
    source = path.resolve(source);
    destination = path.resolve(destination);
    if (source === destination || source.startsWith(destination + path.sep) ||
        destination.startsWith(source + path.sep)) throw new Error('Media cache and publication paths must be separate.');
    const parent = path.dirname(destination);
    const name = path.basename(destination);
    const journalFile = path.join(journalDirectory, digest(destination.toLowerCase()) + '.json');
    const previous = await readJSON(journalFile);
    await io.mkdir(parent, {recursive: true});

    // Recover an interrupted replacement before starting a different bundle.
    if (previous) {
      if (previous.schema !== SCHEMA || previous.destination !== destination ||
          path.dirname(previous.backup || '') !== parent ||
          !path.basename(previous.backup || '').startsWith(`.${name}.old.`)) {
        throw new Error(`Invalid media publication journal; files were preserved: ${journalFile}`);
      }
      if (await exists(previous.backup)) {
        if (!await exists(destination)) {
          await retry(() => io.rename(previous.backup, destination), 'the previous media bundle');
        } else if (await matches(destination, previous.files)) {
          try { await removeTree(previous.backup); }
          catch(error) { log(`The new bundle is usable; the old backup is still locked: ${previous.backup}`); }
        } else {
          throw new Error(`An interrupted media replacement needs attention. Both copies were preserved:\n${destination}\n${previous.backup}`);
        }
      }
      // Retain a journal whose locked backup still needs cleanup. Do not lose
      // its recovery path by starting another replacement on top of it.
      if (await exists(previous.backup)) {
        const currentFiles = await snapshot(source);
        if (await matches(destination, currentFiles)) return;
        throw new Error(`Close programs using the previous bundle and retry. Cached builds are intact:\n${previous.backup}`);
      }
      await retry(() => io.unlink(journalFile), journalFile);
    }

    const files = await snapshot(source);
    if (!files.length) throw new Error('Cannot publish an empty media bundle.');
    if (await matches(destination, files)) {
      log('The installed media bundle already matches the verified cache.');
      return;
    }
    const pending = path.join(parent, `.${name}.new.${digest(JSON.stringify(files)).slice(0, 20)}`);
    const backup = path.join(parent, `.${name}.old.${token()}`);
    try {
      if (!await matches(pending, files)) {
        await removeTree(pending);
        await copyTree(source, pending);
      }
      await writeJSON(journalFile, {schema: SCHEMA, destination, pending, backup, files});
      if (await exists(destination)) {
        await retry(() => io.rename(destination, backup), 'the installed media bundle');
      }
      await retry(() => io.rename(pending, destination), 'the new media bundle');
    } catch(error) {
      if (await exists(backup) && !await exists(destination)) {
        try { await retry(() => io.rename(backup, destination), 'the previous media bundle'); }
        catch(restoreError) {
          error.message += `\nThe previous bundle is preserved here for recovery: ${backup}\n${restoreError.message}`;
        }
      }
      error.message += `\nMedia compilation results are preserved: ${source}\n` +
        'Close Mynda/MPV and any program holding the destination open (including folder sync), then rerun npm run media:prepare. No completed components need recompilation.';
      throw error;
    }
    if (await exists(backup)) {
      try { await removeTree(backup); }
      catch(error) {
        log(`Prepared the new bundle; the old backup is still locked and was retained: ${backup}`);
        return;
      }
    }
    await retry(() => io.unlink(journalFile), journalFile);
  }

  async function acquireLock(root, ownerPid = process.ppid) {
    await io.mkdir(root, {recursive: true});
    const filename = path.join(root, 'prepare.lock');
    const value = {schema: SCHEMA, pid: ownerPid, token: token()};
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await io.writeFile(filename, JSON.stringify(value), {flag: 'wx'});
        return value.token;
      } catch(error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await readJSON(filename);
        if (!previous || previous.invalid || !Number.isInteger(previous.pid)) {
          await sleep(250);
          continue;
        }
        if (isAlive(previous.pid)) throw new Error('Another Windows media preparation is still running. Let it finish before starting another.');
        await retry(() => io.unlink(filename), filename);
      }
    }
    throw new Error(`Could not acquire the media build lock: ${filename}`);
  }

  async function releaseLock(root, expectedToken) {
    const filename = path.join(root, 'prepare.lock');
    const record = await readJSON(filename);
    if (record && record.token === expectedToken) await retry(() => io.unlink(filename), filename);
  }

  const move = (source, destination) => retry(() => io.rename(source, destination), destination);
  return {snapshot, cacheStatus, seal, removeTree, copyTree, publish, acquireLock, releaseLock, move};
}

async function main(argv) {
  const [command, ...args] = argv;
  const cache = createCache();
  if (command === 'status') console.log(await cache.cacheStatus(args[0], args[1], args[2]));
  else if (command === 'seal') await cache.seal(args[0], args[1], args[2], args.slice(3));
  else if (command === 'remove') await cache.removeTree(args[0]);
  else if (command === 'copy') await cache.copyTree(args[0], args[1]);
  else if (command === 'move') await cache.move(args[0], args[1]);
  else if (command === 'publish') await cache.publish(args[0], args[1], args[2]);
  else if (command === 'lock') console.log(await cache.acquireLock(args[0]));
  else if (command === 'unlock') await cache.releaseLock(args[0], args[1]);
  else throw new Error(`Unknown media build cache operation: ${command}`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

module.exports = {createCache, digest};
