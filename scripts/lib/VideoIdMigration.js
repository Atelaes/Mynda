const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Persistence = require('../../src/library/LibraryPersistence.js');
const Fingerprint = require('../../src/library/ContentFingerprint.js');
const Identity = require('../../src/library/VideoIdentity.js');

const FORMAT = 'mynda-video-id-migration-v2';
const filenames = {
  original: 'original-library.json', converted: 'converted-library.json',
  checkpoint: 'checkpoint.json', report: 'report.json', archive: 'archived-inactive.json'
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultOutput(input) {
  return path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-id-migration-v2`);
}

function writeJSON(filename, data) {
  Persistence.atomicWrite(filename, JSON.stringify(data, null, 2) + '\n');
}

function readJSON(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function assertOrdinaryFile(filename) {
  if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) {
    throw failure('MIGRATION_PATH', `Expected an ordinary file: ${filename}`);
  }
}

// Rewrites only simple video.id comparisons to known string literals. It
// parses expressions but never evaluates user code. More complex uses stop
// conversion for review instead of doing a global UUID replacement in JSON.
function rewriteFilter(source, mapping) {
  if (typeof source !== 'string') return source;
  const {compilePlaylistFilter} = require('../../src/library/PlaylistFilter.js');
  let ast;
  try { ast = compilePlaylistFilter(source).ast; } catch(error) {
    // Preserve unrelated pre-existing invalid filters. An invalid expression
    // that mentions IDs cannot be safely rewritten without the user's review.
    if (!/\bid\b/.test(source) && ![...mapping.keys()].some(id => source.includes(id))) return source;
    throw failure('MIGRATION_PLAYLIST', 'An ID-dependent playlist expression needs manual review.');
  }
  const replacements = new Map();
  const allowed = new Set();
  const literals = [];
  const idMembers = [];
  const isID = node => node && node.type === 'MemberExpression' &&
    (node.computed ? node.property && node.property.value === 'id' : node.property && node.property.name === 'id');
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MemberExpression' && node.computed &&
        node.object.type === 'Identifier' && node.object.name === 'video' &&
        node.property.type !== 'Literal') {
      throw failure('MIGRATION_PLAYLIST', 'A playlist computes a video property name and needs manual review before its IDs can be converted.');
    }
    if (node.type === 'Literal') literals.push(node);
    if (isID(node)) idMembers.push(node);
    if (node.type === 'BinaryExpression' && ['===','!==','==','!='].includes(node.operator)) {
      const member = isID(node.left) ? node.left : isID(node.right) ? node.right : null;
      const literal = member === node.left ? node.right : node.left;
      if (member && member.object.type === 'Identifier' && member.object.name === 'video' &&
          literal && literal.type === 'Literal' && typeof literal.value === 'string') {
        const next = mapping.get(literal.value);
        if (!next) throw failure('MIGRATION_PLAYLIST', `A playlist refers to an unresolved video ID: ${literal.value}`);
        replacements.set(literal.value, next);
        allowed.add(member);
        allowed.add(literal);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  if (idMembers.some(node => !allowed.has(node)) ||
      literals.some(node => replacements.has(node.value) && !allowed.has(node))) {
    throw failure('MIGRATION_PLAYLIST', 'A complex ID-dependent playlist needs manual review; its expression was not changed.');
  }
  const replaced = new Set();
  const result = source.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, match => {
    const quote = match[0];
    const value = match.slice(1, -1);
    if (!replacements.has(value)) return match;
    replaced.add(value);
    return `${quote}${replacements.get(value)}${quote}`;
  });
  if (replaced.size !== replacements.size) {
    throw failure('MIGRATION_PLAYLIST', 'An escaped video ID in a playlist needs manual review.');
  }
  return result;
}

async function prepareMigration(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  assertOrdinaryFile(input);
  const originalBytes = fs.readFileSync(input);
  const data = Persistence.parseLibraryText(originalBytes.toString('utf8'), input);
  if (data.videoIdScheme === Identity.VIDEO_ID_SCHEME) {
    Identity.assertLibraryIdentity(data);
    return {status: 'already-current', input};
  }
  if (data.videoIdScheme !== undefined && data.videoIdScheme !== 1) {
    throw failure('UNSUPPORTED_VIDEO_ID_SCHEME', 'This utility converts scheme 1 libraries only.');
  }
  const sourceHash = sha256(originalBytes);
  const output = path.resolve(options.output || defaultOutput(input));
  if (output === path.dirname(input) || input.startsWith(output + path.sep)) {
    throw failure('MIGRATION_PATH', 'Choose a separate migration output directory that does not contain the source library.');
  }
  fs.mkdirSync(output, {recursive: true});
  if (fs.lstatSync(output).isSymbolicLink()) throw failure('MIGRATION_PATH', 'The migration output directory must not be a symbolic link.');
  const files = Object.fromEntries(Object.entries(filenames).map(([key, name]) => [key, path.join(output, name)]));
  let checkpoint = {format: FORMAT, input, sourceHash, cache: {}};
  if (fs.existsSync(files.checkpoint)) {
    assertOrdinaryFile(files.checkpoint);
    checkpoint = readJSON(files.checkpoint);
    if (checkpoint.format !== FORMAT || checkpoint.input !== input || checkpoint.sourceHash !== sourceHash ||
        !checkpoint.cache || typeof checkpoint.cache !== 'object' || Array.isArray(checkpoint.cache)) {
      throw failure('MIGRATION_SOURCE_CHANGED', 'The library or migration checkpoint changed. Preserve this output and choose a new --output directory.');
    }
    assertOrdinaryFile(files.original);
    if (sha256(fs.readFileSync(files.original)) !== sourceHash) {
      throw failure('MIGRATION_BACKUP_CHANGED', 'The preserved original does not match this migration.');
    }
  } else {
    if (fs.readdirSync(output).length) throw failure('MIGRATION_OUTPUT_NOT_EMPTY', 'Use an empty output directory for a new migration.');
    const backupFD = fs.openSync(files.original, 'wx');
    try { fs.writeFileSync(backupFD, originalBytes); fs.fsyncSync(backupFD); }
    finally { fs.closeSync(backupFD); }
    writeJSON(files.checkpoint, checkpoint);
  }
  for (const filename of Object.values(files)) {
    if (fs.existsSync(filename)) assertOrdinaryFile(filename);
  }
  // An old derivative must not look ready after a later, incomplete attempt.
  if (fs.existsSync(files.converted)) fs.unlinkSync(files.converted);
  const report = {format: FORMAT, status: 'running', input, output, sourceHash,
    targetScheme: Identity.VIDEO_ID_SCHEME, archiveMissingInactive: options.archiveMissingInactive === true,
    entries: [], issues: [], duplicates: [], droppedRecentIDs: [], bytesRead: 0, cachedPaths: 0};
  writeJSON(files.report, report);
  let dirty = 0;
  const flush = force => {
    if (force || dirty >= 25) { writeJSON(files.checkpoint, checkpoint); dirty = 0; }
  };
  const relinks = options.relinks || {};
  const resolvePath = filename => {
    const result = Object.prototype.hasOwnProperty.call(relinks, filename) ? relinks[filename] : filename;
    if (typeof result !== 'string' || !path.isAbsolute(result)) {
      throw failure('MIGRATION_PATH', `The media path must be absolute: ${String(result)}`);
    }
    return path.resolve(result);
  };
  async function identify(filename, dvd) {
    const target = resolvePath(filename);
    const result = await Fingerprint.fingerprintPath(target, {
      dvd: dvd === true ? true : undefined, previous: checkpoint.cache[target],
      shouldCancel: options.shouldCancel,
      onBytes: bytes => { report.bytesRead += bytes; }
    });
    checkpoint.cache[target] = result;
    if (result.cached) report.cachedPaths++;
    dirty++;
    flush(false);
    return {target, ...result};
  }
  const converted = clone(data);
  const archived = [];
  const idSets = new Map();
  const seenNewIDs = new Map();
  const oldRecordIDs = new Set();
  const total = ['media','inactive_media'].reduce((count, list) => count + (data[list] || []).filter(Boolean).length, 0);
  try {
    for (const list of ['media', 'inactive_media']) {
      if (!Array.isArray(data[list])) continue;
      const updated = [];
      for (let index = 0; index < data[list].length; index++) {
        const video = data[list][index];
        if (video === null) { updated.push(null); continue; }
        const entry = {list, index, oldId: video && video.id, title: video && video.title,
          originalPath: video && video.filename, state: 'pending'};
        report.entries.push(entry);
        if (options.onProgress) options.onProgress({current: report.entries.length, total, title: entry.title});
        if (!video || typeof video.id !== 'string' || !video.id) {
          report.issues.push({code: 'MIGRATION_INVALID_RECORD', list, index, message: 'A library record has no video ID.'});
          entry.state = 'failed';
          continue;
        }
        oldRecordIDs.add(video.id);
        let identity;
        try {
          identity = await identify(video.filename, video.dvd);
        } catch(error) {
          if (error.code === 'FINGERPRINT_CANCELED') throw error;
          const missing = ['ENOENT','ENOTDIR'].includes(error.code);
          if (list === 'inactive_media' && missing && options.archiveMissingInactive === true) {
            archived.push(clone(video));
            entry.state = 'archived';
          } else {
            entry.state = 'failed';
            report.issues.push({code: error.code || 'MIGRATION_READ_FAILED', list, index,
              filename: video.filename, message: error.message});
          }
          continue;
        }
        Object.assign(entry, {state: 'converted', newId: identity.id, filename: identity.target});
        if (!idSets.has(video.id)) idSets.set(video.id, new Set());
        idSets.get(video.id).add(identity.id);
        if (seenNewIDs.has(identity.id)) {
          report.issues.push({code: 'MIGRATION_DUPLICATE_RECORDS', newId: identity.id,
            first: seenNewIDs.get(identity.id), second: {list, index, oldId: video.id},
            message: 'Multiple library records produce one new ID. Resolve their metadata/history before conversion; no records were merged.'});
        } else seenNewIDs.set(identity.id, {list, index, oldId: video.id});
        const replacement = {...clone(video), id: identity.id, filename: identity.target};
        if (Array.isArray(video.duplicates)) {
          replacement.duplicates = [];
          for (const duplicate of video.duplicates) {
            try {
              const other = await identify(duplicate, video.dvd);
              const matches = other.id === identity.id;
              if (matches && other.target !== identity.target && !replacement.duplicates.includes(other.target)) {
                replacement.duplicates.push(other.target);
              }
              report.duplicates.push({oldId: video.id, path: duplicate, resolvedPath: other.target,
                state: matches ? 'matched' : 'different', newId: other.id});
            } catch(error) {
              if (error.code === 'FINGERPRINT_CANCELED') throw error;
              report.duplicates.push({oldId: video.id, path: duplicate, state: 'unavailable',
                code: error.code, message: error.message});
            }
          }
        }
        updated.push(replacement);
      }
      converted[list] = updated;
    }
    const mapping = new Map();
    for (const [oldId, values] of idSets) {
      if (values.size === 1) mapping.set(oldId, [...values][0]);
      else report.issues.push({code: 'MIGRATION_AMBIGUOUS_OLD_ID', oldId, newIds: [...values],
        message: 'One old ID belongs to different files. Its saved references need manual resolution.'});
    }
    if (Array.isArray(data.recently_watched)) {
      converted.recently_watched = [];
      for (const oldId of data.recently_watched) {
        const next = mapping.get(oldId);
        if (next) {
          if (!converted.recently_watched.includes(next)) converted.recently_watched.push(next);
        } else {
          report.droppedRecentIDs.push({oldId, reason: oldRecordIDs.has(oldId) ? 'unresolved-or-archived' : 'already-missing-record'});
        }
      }
    }
    for (const playlist of (converted.playlists || [])) {
      if (!playlist) continue;
      try { playlist.filter_function = rewriteFilter(playlist.filter_function, mapping); }
      catch(error) { report.issues.push({code: error.code, playlistId: playlist.id, name: playlist.name, message: error.message}); }
    }
    if (data.object_media && Object.keys(data.object_media).length) {
      report.issues.push({code: 'MIGRATION_LEGACY_INDEX',
        message: 'The retired object_media index is populated and needs review before conversion.'});
    }
    converted.videoIdScheme = Identity.VIDEO_ID_SCHEME;
    const validation = Persistence.validateLibraryData(converted);
    if (!validation.valid) report.issues.push({code: 'MIGRATION_VALIDATION', message: validation.message});
    Identity.assertLibraryIdentity(converted);
    // Neither preparing a conversion nor resuming it may follow edits to the
    // source library silently. Its exact original bytes remain the baseline.
    if (sha256(fs.readFileSync(input)) !== sourceHash) {
      throw failure('MIGRATION_SOURCE_CHANGED', 'The source library changed during conversion. Quit Mynda and use a new output directory.');
    }
    report.archivedInactive = archived.length;
    writeJSON(files.archive, {format: FORMAT, sourceHash, libraryId: data.id,
      videoIdScheme: data.videoIdScheme || 1, inactive_media: archived,
      recently_watched: data.recently_watched || []});
    if (report.issues.length) report.status = 'blocked';
    else {
      report.status = 'ready';
      const bytes = Persistence.serializeLibraryData(converted);
      Persistence.atomicWrite(files.converted, bytes);
      report.convertedHash = sha256(Buffer.from(bytes));
      report.videoCounts = {media: (converted.media || []).filter(Boolean).length,
        inactive_media: (converted.inactive_media || []).filter(Boolean).length};
    }
  } catch(error) {
    report.status = error.code === 'FINGERPRINT_CANCELED' ? 'interrupted' : 'blocked';
    report.issues.push({code: error.code || 'MIGRATION_FAILED', message: error.message});
  } finally {
    flush(true);
    writeJSON(files.report, report);
  }
  return report;
}

async function installMigration(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  const output = path.resolve(options.output || defaultOutput(input));
  const files = Object.fromEntries(Object.entries(filenames).map(([key, name]) => [key, path.join(output, name)]));
  for (const filename of [input, files.original, files.converted, files.report, files.checkpoint]) assertOrdinaryFile(filename);
  const report = readJSON(files.report);
  const checkpoint = readJSON(files.checkpoint);
  if (report.format !== FORMAT || report.input !== input || !['ready','installed'].includes(report.status) ||
      checkpoint.format !== FORMAT || checkpoint.sourceHash !== report.sourceHash || checkpoint.input !== input) {
    throw failure('MIGRATION_NOT_READY', 'Prepare a complete, unblocked conversion before using --install.');
  }
  const bytes = fs.readFileSync(files.converted);
  if (sha256(bytes) !== report.convertedHash || sha256(fs.readFileSync(files.original)) !== report.sourceHash) {
    throw failure('MIGRATION_OUTPUT_CHANGED', 'The converted library or original backup changed after validation.');
  }
  const converted = Persistence.parseLibraryText(bytes.toString('utf8'), files.converted);
  Identity.assertLibraryIdentity(converted);
  const currentHash = sha256(fs.readFileSync(input));
  if (currentHash === report.convertedHash) return {...report, status: 'already-installed'};
  if (currentHash !== report.sourceHash) throw failure('MIGRATION_SOURCE_CHANGED', 'The source library changed after preparation. It was not overwritten.');
  const checkedPaths = report.entries.filter(entry => entry.state === 'converted')
    .map(entry => ({filename: entry.filename, id: entry.newId}))
    .concat((report.duplicates || []).filter(entry => entry.state === 'matched')
      .map(entry => ({filename: entry.resolvedPath, id: entry.newId})));
  for (let index = 0; index < checkedPaths.length; index++) {
    const entry = checkedPaths[index];
    if (options.shouldCancel && options.shouldCancel()) throw failure('FINGERPRINT_CANCELED', 'Installation was canceled.');
    if (options.onProgress) options.onProgress({current: index + 1, total: checkedPaths.length, title: entry.filename});
    const cached = checkpoint.cache[entry.filename];
    if (!cached || cached.id !== entry.id ||
        (await Fingerprint.describePath(entry.filename)).signature !== cached.signature) {
      throw failure('MIGRATION_MEDIA_CHANGED', `Media changed after preparation. Run the migration again: ${entry.filename}`);
    }
  }
  if (options.shouldCancel && options.shouldCancel()) throw failure('FINGERPRINT_CANCELED', 'Installation was canceled.');
  if (sha256(fs.readFileSync(input)) !== report.sourceHash) {
    throw failure('MIGRATION_SOURCE_CHANGED', 'The source library changed while installation was being checked. It was not overwritten.');
  }
  Persistence.atomicWrite(input, bytes);
  report.status = 'installed';
  report.installedAt = new Date().toISOString();
  writeJSON(files.report, report);
  return report;
}

module.exports = {prepareMigration, installMigration, rewriteFilter, defaultOutput, filenames};
