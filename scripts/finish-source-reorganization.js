// Run after extracting fix77 over a fix76 project. Only the recorded old
// locations are removed, and only after every file passes preflight and backup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function digest(bytes, textFile) {
  const content = textFile ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
  return crypto.createHash('sha256').update(content).digest('hex');
}

function checkedPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid cleanup path: ${relative}`);
  }
  const parts = relative.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Cleanup will not follow a symbolic link: ${relative}`);
    }
  }
  return current;
}

function inspect(root, manifest) {
  root = path.resolve(root);
  const pending = [];
  const conflicts = [];
  const locations = manifest.files.map(entry => ({entry,
    source: checkedPath(root, entry.from), destination: checkedPath(root, entry.to)}));
  if (!locations.some(item => fs.existsSync(item.source))) return pending;
  for (const {entry, source, destination} of locations) {
    const sourceExists = fs.existsSync(source);
    if (sourceExists && (!fs.statSync(source).isFile() || digest(fs.readFileSync(source), entry.text) !== entry.before)) {
      conflicts.push(`${entry.from}: differs from the fix76 file; preserve/reconcile your edits first`);
    }
    if (!fs.existsSync(destination) || !fs.statSync(destination).isFile() ||
        digest(fs.readFileSync(destination), entry.text) !== entry.after) {
      conflicts.push(`${entry.to}: the expected fix77 replacement is missing or has changed`);
    }
    if (sourceExists) pending.push({entry, source, destination});
  }
  if (conflicts.length) {
    throw new Error(`No old files were removed. Source reorganization needs attention:\n${conflicts.join('\n')}`);
  }
  return pending;
}

function finish(root, manifest, options = {}) {
  root = path.resolve(root);
  const pending = inspect(root, manifest);
  if (options.check || !pending.length) return {pending: pending.length, removed: 0, backup: null};

  // Keep the backup beside the project, outside electron-builder's input tree.
  const backup = fs.mkdtempSync(path.join(path.dirname(root), `${path.basename(root)}-before-fix77-`));
  for (const {entry, source} of pending) {
    const saved = path.join(backup, ...entry.from.split('/'));
    fs.mkdirSync(path.dirname(saved), {recursive: true});
    fs.copyFileSync(source, saved, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(saved).equals(fs.readFileSync(source))) {
      throw new Error(`Backup verification failed for ${entry.from}; no old files were removed. Backup: ${backup}`);
    }
  }
  fs.writeFileSync(path.join(backup, 'README.txt'),
    `These are the old source/theme files removed by Mynda fix77.\nProject: ${root}\n` +
    'Keep this backup until you have tested and committed the reorganization.\n' +
    'It contains no media library data. To undo the whole update, also restore\n' +
    'the changed files from your fix76 Git checkpoint or the original fix76 zip.\n');

  // Recheck after copying so edits made during backup are not silently removed.
  inspect(root, manifest);
  let removed = 0;
  try {
    for (const {source} of pending) {
      fs.unlinkSync(source);
      removed++;
    }
    const directories = new Set();
    for (const {source} of pending) {
      let directory = path.dirname(source);
      while (directory !== root) {
        directories.add(directory);
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
  } catch (error) {
    throw new Error(`Removed ${removed} old files before cleanup stopped: ${error.message}\n` +
      `Backup: ${backup}\nClose Mynda and pause any file sync, then run npm run source:cleanup again.`);
  }
  return {pending: pending.length, removed, backup};
}

if (require.main === module) {
  try {
    const unknown = process.argv.slice(2).filter(value => value !== '--check');
    if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}`);
    const manifest = require('./source-reorganization.json');
    const result = finish(path.resolve(__dirname, '..'), manifest, {check: process.argv.includes('--check')});
    if (process.argv.includes('--check')) console.log(`Cleanup preflight passed: ${result.pending} old files are ready.`);
    else if (result.removed) console.log(`Source reorganization complete: removed ${result.removed} old files.\nBackup: ${result.backup}`);
    else console.log('Source reorganization is already complete; no old files remain.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {digest, inspect, finish};
