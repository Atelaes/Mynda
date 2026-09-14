const fs = require('fs');
const path = require('path');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 366 * DAY_MS;
const AUTOMATIC_BACKUP_INTERVAL_MS = HOUR_MS;

// Automatic backup filenames encode their creation time in UTC. Apart from
// making the files readable to a person browsing the folder, that lets us
// rebuild the retention timeline without maintaining a separate index file
// that could itself become lost or corrupted.
const AUTOMATIC_BACKUP_PATTERN = /^library-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-p\d+-\d+)?\.json$/;

// Automatic snapshots remain ordinary Mynda library JSON files in
// Library/Backups. Retention keeps hourly snapshots for one day, daily for one
// month, weekly for one year, monthly through five years, and yearly after
// that. The same atomic writer and plain-file format can later be used by a
// manual backup UI without coupling user-selected backups to this retention.

let temporaryFileNumber = 0;
let backupFileNumber = 0;

// Parsing and structural-validation failures use a recognizable error code.
// Library.load() uses this to distinguish a malformed library from a normal
// first launch, where library.json simply does not exist yet (ENOENT).
class InvalidLibraryError extends Error {
  constructor(message, source, cause) {
    super(message);
    this.name = 'InvalidLibraryError';
    this.code = 'INVALID_LIBRARY';
    this.source = source;
    this.cause = cause;
  }
}

// JSON arrays are objects in JavaScript, but none of the fields tested as
// object-shaped library sections should accept an array.
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// This is intentionally a compatibility-oriented structural check rather
// than a rigid schema. Older Mynda libraries can omit fields that newer builds
// supply from defaults, but a library must at least contain settings and media.
function validateLibraryData(data) {
  if (!isObject(data)) {
    return {valid: false, message: 'The library root must be an object.'};
  }
  if (!isObject(data.settings)) {
    return {valid: false, message: 'The library settings field is missing or invalid.'};
  }
  if (!Array.isArray(data.media)) {
    return {valid: false, message: 'The library media field is missing or invalid.'};
  }

  for (const field of ['inactive_media', 'playlists', 'recently_watched']) {
    if (typeof data[field] !== 'undefined' && !Array.isArray(data[field])) {
      return {valid: false, message: `The library ${field} field must be an array.`};
    }
  }
  if (typeof data.id !== 'undefined' && typeof data.id !== 'string') {
    return {valid: false, message: 'The library id field must be a string.'};
  }
  return {valid: true, message: ''};
}

// Turn JSON text into a library only after both parsing and the lightweight
// structural check succeed. This path is used for the primary library and for
// every recovery candidate, so a syntactically valid but obviously unrelated
// JSON file cannot be offered to the user as a backup.
function parseLibraryText(text, source = 'library data') {
  let data;
  try {
    data = JSON.parse(text);
  } catch(err) {
    throw new InvalidLibraryError(`Could not parse ${source}: ${err.message}`, source, err);
  }

  const validation = validateLibraryData(data);
  if (!validation.valid) {
    throw new InvalidLibraryError(`Could not use ${source}: ${validation.message}`, source);
  }
  return data;
}

// Validate before serialization as well as after reading. A programming error
// that replaces media with a non-array, for example, is rejected before any
// temporary or primary file is touched.
function serializeLibraryData(data, source = 'library data') {
  const validation = validateLibraryData(data);
  if (!validation.valid) {
    throw new InvalidLibraryError(`Could not save ${source}: ${validation.message}`, source);
  }
  try {
    return JSON.stringify(data);
  } catch(err) {
    throw new InvalidLibraryError(`Could not serialize ${source}: ${err.message}`, source, err);
  }
}

// Common reader for the live library, automatic backups, tests, and eventually
// manual imports. Returning both forms avoids reparsing when a caller also
// needs the original serialized contents.
function readLibraryFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    data: parseLibraryText(text, filePath),
    text: text
  };
}

// All persistence paths can create their own parent directory. This matters on
// a first run and when Backups or Recovery has never been needed before.
function ensureDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true});
}

// Renaming a fully flushed temporary file is the atomic commit. Immediately
// afterward, atomicWrite() reaches this helper to flush the containing
// directory too, adding crash durability on platforms that support it.
function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch(err) {
    // Some filesystems do not permit directory fsync. The completed atomic
    // rename is still safer than writing directly over the destination.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch(err) {}
    }
  }
}

// The central crash-safety primitive. Every caller writes a complete file next
// to the destination, flushes it, and only then renames it into place. During a
// normal save, a crash can therefore leave either the old complete library or
// the new complete library—not a half-overwritten library.json.
function atomicWrite(filePath, contents) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  ensureDirectory(directory);

  const temporaryPath = path.join(
    directory,
    `.${basename}.tmp-p${process.pid}-${Date.now()}-${++temporaryFileNumber}`
  );
  let descriptor = null;

  try {
    // "wx" refuses to reuse an existing temporary filename. The PID, current
    // time, and counter already make collision unlikely; this flag makes an
    // accidental collision safe rather than destructive.
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    // The temporary file is on the same filesystem as its destination, so the
    // rename publishes either the complete old file or the complete new file.
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } catch(err) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch(closeError) {}
    }
    try { fs.unlinkSync(temporaryPath); } catch(unlinkError) {}
    throw err;
  }

  return filePath;
}

// Library JSON always passes through structural validation before it reaches
// atomicWrite(). preserveDamagedLibrary() intentionally calls atomicWrite()
// directly because damaged bytes would, by definition, fail validation.
function writeLibraryFile(filePath, data) {
  return atomicWrite(filePath, serializeLibraryData(data, filePath));
}

// ISO timestamps sort chronologically as text. Colons and the millisecond dot
// are replaced so the resulting names are legal on Windows as well as macOS.
function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace('.', '-');
}

// Automatic names include process and sequence identifiers because Mynda has
// both a main-process and renderer-process Library instance. If they happen to
// create a snapshot at the same millisecond, neither can overwrite the other.
function automaticBackupFilename(date = new Date()) {
  return `library-${safeTimestamp(date)}-p${process.pid}-${++backupFileNumber}.json`;
}

// This helper is not wired to a button yet. A future manual-backup dialog can
// use it to suggest a readable, cross-platform filename in the folder selected
// by the user.
function manualBackupFilename(date = new Date()) {
  return `Mynda Library Backup ${safeTimestamp(date)}.json`;
}

// Reconstruct the creation date from an automatic filename. Files that do not
// match Mynda's exact naming scheme are ignored so retention never deletes a
// user's unrelated JSON files from the Backups folder.
function parseAutomaticBackupDate(filename) {
  const match = AUTOMATIC_BACKUP_PATTERN.exec(filename);
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  const date = new Date(Date.UTC(
    numbers[0], numbers[1]-1, numbers[2], numbers[3],
    numbers[4], numbers[5], numbers[6]
  ));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

// Discover only automatic snapshots, newest first. This ordering is important:
// both retention and startup recovery prefer the newest member of a time tier.
function listAutomaticBackups(backupDirectory) {
  let entries;
  try {
    entries = fs.readdirSync(backupDirectory, {withFileTypes: true});
  } catch(err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return entries
    .filter(entry => entry.isFile())
    .map(entry => ({
      name: entry.name,
      path: path.join(backupDirectory, entry.name),
      date: parseAutomaticBackupDate(entry.name)
    }))
    .filter(entry => entry.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.name.localeCompare(a.name));
}

// The following UTC key helpers deliberately avoid local daylight-saving-time
// boundaries. A backup cannot fall into an unexpected duplicate or missing
// hour merely because the local clock moved forward or backward.
function utcHourKey(date) {
  return date.toISOString().slice(0, 13);
}

function utcDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function utcWeekKey(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return utcDayKey(start);
}

// Assign one retention bucket based on age. We keep fine-grained restore points
// near the present and progressively fewer snapshots as they age:
// hourly < 1 day, daily < 1 month, weekly < 1 year, monthly < 5 years,
// and yearly thereafter.
function retentionBucket(date, now = new Date()) {
  const age = Math.max(0, now.getTime() - date.getTime());
  if (age < DAY_MS) {
    return `hour:${utcHourKey(date)}`;
  }
  if (age < 31 * DAY_MS) {
    return `day:${utcDayKey(date)}`;
  }
  if (age < YEAR_MS) {
    return `week:${utcWeekKey(date)}`;
  }
  if (age < 5 * YEAR_MS) {
    return `month:${date.toISOString().slice(0, 7)}`;
  }
  return `year:${date.getUTCFullYear()}`;
}

// Select the newest backup in every retention bucket. This function only makes
// the policy decision; pruneAutomaticBackups() performs the actual deletions,
// which keeps the retention math easy to test without touching a filesystem.
function retainedAutomaticBackups(backups, now = new Date()) {
  const retained = [];
  const usedBuckets = new Set();

  // Backups are newest-first, so the first file in each progressively coarser
  // bucket is the newest snapshot retained for that period.
  backups.forEach(backup => {
    const bucket = retentionBucket(backup.date, now);
    if (!usedBuckets.has(bucket)) {
      usedBuckets.add(bucket);
      retained.push(backup);
    }
  });
  return retained;
}

// This runs only after a new automatic snapshot has been committed. It removes
// older duplicates within a bucket but leaves every unrecognized file alone.
function pruneAutomaticBackups(backupDirectory, now = new Date()) {
  const backups = listAutomaticBackups(backupDirectory);
  const retained = retainedAutomaticBackups(backups, now);
  const retainedPaths = new Set(retained.map(backup => backup.path));
  const removed = [];

  backups.forEach(backup => {
    if (retainedPaths.has(backup.path)) return;
    try {
      fs.unlinkSync(backup.path);
      removed.push(backup.path);
    } catch(err) {
      // Another Mynda process may have pruned the same file first.
      if (err.code !== 'ENOENT') throw err;
    }
  });
  return {retained: retained, removed: removed};
}

// Normal library saves call this before considering a snapshot. The cached date
// avoids unnecessary directory reads during frequent saves; once it appears an
// hour old, we refresh from disk because the other Electron process may already
// have created the due backup.
function automaticBackupIsDue(backupDirectory, now = new Date(), lastBackupDate = null) {
  if (lastBackupDate instanceof Date && !Number.isNaN(lastBackupDate.getTime()) &&
      now.getTime() - lastBackupDate.getTime() < AUTOMATIC_BACKUP_INTERVAL_MS) {
    return false;
  }

  // Refresh from disk whenever the process-local timestamp appears due. The
  // renderer and backend each own a Library instance, so the other process may
  // already have created this hour's snapshot.
  const backups = listAutomaticBackups(backupDirectory);
  const newestDate = backups.length > 0 ? backups[0].date : null;
  if (!newestDate) return true;
  return now.getTime() - newestDate.getTime() >= AUTOMATIC_BACKUP_INTERVAL_MS;
}

// Snapshot the currently committed primary library before a new primary save
// replaces it. Reading through readLibraryFile() means malformed data can never
// be promoted into the automatic backup history.
function createAutomaticBackup(libraryPath, backupDirectory, now = new Date()) {
  // Only a validated primary library can become an automatic restore point.
  const currentLibrary = readLibraryFile(libraryPath).data;
  ensureDirectory(backupDirectory);
  const backupPath = path.join(backupDirectory, automaticBackupFilename(now));
  writeLibraryFile(backupPath, currentLibrary);
  const retention = pruneAutomaticBackups(backupDirectory, now);
  return {
    path: backupPath,
    date: now,
    retainedCount: retention.retained.length,
    removedCount: retention.removed.length
  };
}

// Reached only when the primary library failed to load. Candidates are checked
// newest-first; corrupt backups are skipped until a structurally valid library
// is found. The skipped count is shown in the recovery dialog so the choice is
// transparent to the user.
function findLatestValidAutomaticBackup(backupDirectory) {
  const backups = listAutomaticBackups(backupDirectory);
  let invalidCount = 0;

  for (const backup of backups) {
    try {
      const loaded = readLibraryFile(backup.path);
      return {
        backup: {...backup, data: loaded.data},
        candidateCount: backups.length,
        invalidNewerCount: invalidCount
      };
    } catch(err) {
      invalidCount += 1;
    }
  }
  return {
    backup: null,
    candidateCount: backups.length,
    invalidNewerCount: invalidCount
  };
}

// Before a recovery choice overwrites library.json, preserve its exact original
// bytes in Library/Recovery. This is intentionally not parsed or normalized:
// even malformed data may contain material useful for a later manual repair.
function preserveDamagedLibrary(libraryPath, recoveryDirectory, now = new Date()) {
  const contents = fs.readFileSync(libraryPath);
  ensureDirectory(recoveryDirectory);
  const recoveredPath = path.join(
    recoveryDirectory,
    `library-damaged-${safeTimestamp(now)}-p${process.pid}-${++backupFileNumber}.json`
  );
  atomicWrite(recoveredPath, contents);
  return recoveredPath;
}

module.exports = {
  AUTOMATIC_BACKUP_INTERVAL_MS,
  InvalidLibraryError,
  validateLibraryData,
  parseLibraryText,
  serializeLibraryData,
  readLibraryFile,
  ensureDirectory,
  atomicWrite,
  writeLibraryFile,
  safeTimestamp,
  automaticBackupFilename,
  manualBackupFilename,
  parseAutomaticBackupDate,
  listAutomaticBackups,
  retentionBucket,
  retainedAutomaticBackups,
  pruneAutomaticBackups,
  automaticBackupIsDue,
  createAutomaticBackup,
  findLatestValidAutomaticBackup,
  preserveDamagedLibrary
};
