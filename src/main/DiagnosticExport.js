'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {randomUUID} = require('crypto');
const {Readable} = require('stream');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');
const {createRedactor} = require('../platform/DiagnosticRedaction');

const LOG_NAMES = /^mynda-(?:info|error|ui-diagnostics)(?:\.[1-4])?\.log$/;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const EMAIL_ADVISORY_BYTES = 18 * 1024 * 1024;
const VIDEO_FIELDS = ['id', 'filename', 'title', 'kind', 'year', 'series', 'season', 'episode',
  'new', 'autotag_tried', 'imdbID', 'seriesImdbID', 'catalogRef', 'catalogSeriesRef',
  'metadata', 'taggingEvidence', 'taggingDecision', 'dvd'];
const failure = (code, message) => Object.assign(new Error(message), {code});
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

function summary(data) {
  const active = data.media || [], inactive = data.inactive_media || [];
  return {active: active.length, inactive: inactive.length,
    new: active.filter(video => video.new).length,
    attempted: active.filter(video => video.autotag_tried).length,
    withCatalogIdentity: active.filter(video => video.catalogRef || video.imdbID).length,
    watchfolders: (data.settings?.watchfolders || []).length};
}

function diagnosticLibrary(data, redact) {
  // This intentionally is not a restorable library backup. No viewing history,
  // user ratings/tags, custom playlists, artwork or media bytes are included.
  // Serialize one redacted record at a time, respecting ZIP backpressure instead
  // of accumulating another full library object, JSON string and ZIP buffer.
  async function* records() {
    yield '{"format":"mynda-diagnostic-library","version":1';
    let considered = 0;
    for (const group of ['media', 'inactive_media']) {
      yield `,"${group}":[`;
      let first = true;
      for (const video of data[group] || []) {
        const picked = Object.fromEntries(VIDEO_FIELDS.filter(key => Object.hasOwn(video, key)).map(key => [key, video[key]]));
        picked.ratings = Object.fromEntries(['imdb', 'rt', 'mc'].filter(key => video.ratings?.[key] !== undefined)
          .map(key => [key, video.ratings[key]]));
        yield (first ? '' : ',') + JSON.stringify(redact.object(picked));
        first = false;
        if (++considered % 100 === 0) await yieldTurn();
      }
      yield ']';
    }
    yield '}';
  }
  return {stream: Readable.from(records(), {objectMode: false}),
    active: (data.media || []).length, inactive: (data.inactive_media || []).length};
}

async function collectLogs(directory, redact, maximum) {
  const entries = [], notes = [], files = [];
  if (!directory) return {entries, notes: ['File logging has not been initialized.'], files};
  let names;
  try { names = await fs.promises.readdir(directory); }
  catch (error) { return {entries, notes: [`Logs unavailable (${error.code || 'READ_FAILED'}).`], files}; }
  const candidates = [];
  for (const name of names.filter(name => LOG_NAMES.test(name))) {
    try {
      const stat = await fs.promises.lstat(path.join(directory, name));
      if (stat.isFile() && !stat.isSymbolicLink()) candidates.push({name, stat});
      else notes.push(`${name}: skipped non-regular file.`);
    } catch (error) { notes.push(`${name}: unavailable (${error.code || 'READ_FAILED'}).`); }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
  let remaining = maximum;
  for (const {name, stat} of candidates) {
    let handle;
    try {
      if (remaining <= 0) { notes.push(`${name}: omitted because the log size limit was reached.`); continue; }
      handle = await fs.promises.open(path.join(directory, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) {
        notes.push(`${name}: changed during export; retry to include it.`); continue;
      }
      const length = Math.min(current.size, remaining), start = current.size - length;
      const buffer = Buffer.alloc(length);
      const {bytesRead} = await handle.read(buffer, 0, length, start);
      remaining -= bytesRead;
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (start) { const newline = content.indexOf('\n'); content = newline < 0 ? '' : content.slice(newline + 1); }
      // Only complete log records: a concurrently appended/truncated line must
      // not leave half a credential field outside the redaction grammar.
      const lastNewline = content.lastIndexOf('\n');
      const partial = lastNewline !== content.length - 1;
      content = lastNewline < 0 ? '' : content.slice(0, lastNewline + 1);
      const clean = redact.log(content);
      entries.push({name: `logs/${name}`, content: clean});
      files.push({name, bytes: Buffer.byteLength(clean), originalBytes: current.size,
        modifiedAt: current.mtime.toISOString(), truncated: start > 0 || partial || bytesRead !== length});
    } catch (error) { notes.push(`${name}: unavailable (${error.code || 'READ_FAILED'}).`); }
    finally { if (handle) await handle.close(); }
    await yieldTurn();
  }
  return {entries, notes, files};
}

async function writeArchive(destination, entries) {
  const temporary = path.join(path.dirname(destination), `.mynda-diagnostics-${randomUUID()}.tmp`);
  const zip = new ZipFile();
  const output = fs.createWriteStream(temporary, {flags: 'wx', mode: 0o600});
  const done = pipeline(zip.outputStream, output);
  // Attach the rejection handler immediately, including failures before end().
  done.catch(() => {});
  zip.on('error', error => zip.outputStream.destroy(error));
  try {
    for (const entry of entries) {
      if (entry.stream) {
        entry.stream.on('error', error => zip.outputStream.destroy(error));
        zip.addReadStream(entry.stream, entry.name, {mode: 0o100600});
      } else zip.addBuffer(Buffer.from(entry.content), entry.name, {mode: 0o100600});
    }
    zip.end();
    await done;
    const bytes = (await fs.promises.stat(temporary)).size;
    await fs.promises.rename(temporary, destination);
    return {bytes};
  } catch (error) {
    zip.outputStream.destroy(); output.destroy();
    await done.catch(() => {});
    throw error;
  } finally {
    for (const entry of entries) if (entry.stream) entry.stream.destroy();
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function createDiagnosticExporter({app, dialog, library, logger, getStatus = async () => ({}),
  getKnownSecrets = async () => [], getRuntime = () => ({}),
  maxLogBytes = MAX_LOG_BYTES, emailAdvisoryBytes = EMAIL_ADVISORY_BYTES, writeZip = writeArchive}) {
  let busy = false;
  return async ({includeLibrary = false, parentWindow, assertAlive = () => {}} = {}) => {
    if (busy) throw failure('DIAGNOSTIC_EXPORT_BUSY', 'A diagnostic export is already in progress.');
    busy = true;
    try {
      const createdAt = new Date().toISOString();
      const options = {title: 'Export Mynda Diagnostics', buttonLabel: 'Export',
        defaultPath: path.join(app.getPath('documents'), `Mynda Diagnostics ${createdAt.replace(/[:.]/g, '-')}.zip`),
        filters: [{name: 'Diagnostic ZIP', extensions: ['zip']}]};
      const chosen = parentWindow ? await dialog.showSaveDialog(parentWindow, options) : await dialog.showSaveDialog(options);
      assertAlive();
      if (chosen.canceled || !chosen.filePath) return {canceled: true};
      const destination = path.extname(chosen.filePath).toLowerCase() === '.zip' ? chosen.filePath : chosen.filePath + '.zip';
      await logger.flush();
      // Library data is immutable after each committed transaction. Capture one
      // revision without waiting for an entire scan/autotag run or forcing saves.
      const data = library.getSaveObject(), revision = library.revision;
      const paths = [['userData', '[USER_DATA]'], ['home', '[HOME]']].map(([name, label]) => [app.getPath(name), label]);
      paths.push([app.getAppPath(), '[APP]']);
      (data.settings?.watchfolders || []).forEach((folder, i) => paths.push([folder.path, `[WATCHFOLDER_${i + 1}]`]));
      const redact = createRedactor({paths, secrets: await getKnownSecrets()});
      const logs = await collectLogs(logger.getLogDirectory(), redact, maxLogBytes);
      const warnings = [...logs.notes];
      if (logs.files.some(file => file.truncated)) warnings.push('Some older or incomplete log records were omitted.');
      let connection;
      try {
        const status = await getStatus();
        connection = {hasCredential: Boolean(status.hasCredential), verified: Boolean(status.verified),
          serverOrigin: status.url ? new URL(status.url).origin : null, message: status.message || null};
      } catch (_) { connection = {unavailable: true}; warnings.push('Activation status was unavailable.'); }
      const report = redact.object({format: 'mynda-diagnostics', version: 1, createdAt,
        app: {version: app.getVersion(), packaged: app.isPackaged},
        system: {platform: process.platform, architecture: process.arch, osRelease: os.release(),
          electron: process.versions.electron || null, chrome: process.versions.chrome || null, node: process.versions.node},
        activation: connection, runtime: getRuntime(), library: {...summary(data), revision},
        logs: logs.files, limits: {logBytes: maxLogBytes, libraryBytes: null, emailAdvisoryBytes}, warnings});
      const entries = [...logs.entries];
      if (includeLibrary) {
        const snapshot = diagnosticLibrary(data, redact);
        entries.push({name: 'library-diagnostic.json', stream: snapshot.stream});
        report.librarySnapshot = {included: true, active: snapshot.active, inactive: snapshot.inactive, truncated: false};
      } else report.librarySnapshot = {included: false};
      report.warnings = warnings;
      entries.push({name: 'diagnostics.json', content: JSON.stringify(report, null, 2) + '\n'});
      entries.push({name: 'README.txt', content:
        'Mynda diagnostic export\n\nReview these files before emailing them to the Mynda team. Nothing was sent automatically.\n' +
        'Includes recent application logs and a technical summary. Request IDs are preserved to correlate server logs.\n' +
        'Known credentials, URL queries, email addresses and configured personal path prefixes are redacted.\n' +
        'Video titles, filenames, folder names beneath watchfolders and other log text can remain.\n' +
        'No media, artwork, credential files, environment variables or crash dumps are included.\n' +
        (includeLibrary ? 'library-diagnostic.json contains selected metadata and tagging evidence for every active and inactive video; it is NOT a library backup.\n' : 'No detailed library snapshot was requested.\n') +
        'See diagnostics.json for omitted/truncated logs. Include what happened and approximately when in your email.\n' +
        'If the ZIP is too large for an email attachment, share it using a file link instead.\n'});
      assertAlive();
      let archive;
      try { archive = await writeZip(destination, entries); }
      catch (error) {
        throw failure('DIAGNOSTIC_EXPORT_WRITE_FAILED', error.code === 'ENOSPC' ?
          'There is not enough disk space to save the diagnostic ZIP.' :
          'Mynda could not save the diagnostic ZIP. Check the destination and available disk space, then try again.');
      }
      const largeArchive = archive.bytes > emailAdvisoryBytes;
      if (largeArchive) warnings.push(`The ZIP is ${(archive.bytes / (1024 * 1024)).toFixed(1)} MiB and may exceed your email attachment limit. Share it using a file link instead.`);
      return {canceled: false, filePath: destination, warnings, includedLibrary: includeLibrary,
        archiveBytes: archive.bytes, largeArchive};
    } finally { busy = false; }
  };
}

module.exports = {createDiagnosticExporter, createRedactor, collectLogs, diagnosticLibrary, writeArchive};
