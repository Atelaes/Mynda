const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {VIDEO_ID_SCHEME, isVideoID} = require('./VideoIdentity.js');

const BLOCK_BYTES = 256 * 1024;
const SAMPLE_COUNT = 5;
const DOMAIN = 'mynda-content-id-v2';
const PLAYBACK_EXTENSION = /\.(ifo|bup|vob)$/i;

function fingerprintError(code, message, filename) {
  const error = new Error(message);
  error.code = code;
  error.filename = filename;
  return error;
}

function checkCanceled(options) {
  if (options.shouldCancel && options.shouldCancel()) {
    throw fingerprintError('FINGERPRINT_CANCELED', 'Video ID calculation was canceled.');
  }
}

// Each field has an unsigned 64-bit big-endian byte-length prefix. Numeric
// fields are decimal ASCII. Neither host endianness nor JSON/locale ordering
// participates in the protocol. Keep this framing unchanged for scheme 2.
function frameLength(hash, size) {
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(size));
  hash.update(prefix);
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  frameLength(hash, bytes.length);
  hash.update(bytes);
}

function startHash(kind) {
  const hash = crypto.createHash('sha256');
  frame(hash, DOMAIN);
  frame(hash, kind);
  return hash;
}

function sampleRanges(size, full = false) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid fingerprint file size');
  if (full || size <= BLOCK_BYTES * SAMPLE_COUNT) return [{offset: 0, length: size}];
  return Array.from({length: SAMPLE_COUNT}, (_, index) => ({
    offset: Math.floor((size - BLOCK_BYTES) * index / (SAMPLE_COUNT - 1)),
    length: BLOCK_BYTES
  }));
}

function stamp(stats) {
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) throw new Error('Unsupported file size');
  return [stats.size, stats.mtimeMs, stats.ctimeMs, String(stats.dev), String(stats.ino)];
}

async function regularFile(filename) {
  const stats = await fs.promises.lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw fingerprintError('FINGERPRINT_FILE_TYPE', 'Video ID calculation requires a regular, non-symlink file.', filename);
  }
  return stats;
}

async function describePath(filename, options = {}) {
  checkCanceled(options);
  const target = path.resolve(filename);
  const stats = await fs.promises.lstat(target);
  if (stats.isSymbolicLink()) {
    throw fingerprintError('FINGERPRINT_FILE_TYPE', 'Use the actual media path instead of a symbolic link.', target);
  }
  if (stats.isFile() && options.dvd !== true) {
    const files = [{name: '', path: target, size: stats.size, stamp: stamp(stats)}];
    return {mediaType: 'file', size: stats.size, files, signature: JSON.stringify(['file', files])};
  }
  if (!stats.isDirectory() || options.dvd === false) {
    throw fingerprintError('FINGERPRINT_FILE_TYPE', 'The media path is not the expected file or DVD folder.', target);
  }
  const rootEntries = await fs.promises.readdir(target, {withFileTypes: true});
  const dvdRoots = rootEntries.filter(entry => entry.name.toUpperCase() === 'VIDEO_TS');
  if (dvdRoots.length > 1 || (dvdRoots.length === 1 && !dvdRoots[0].isDirectory())) {
    throw fingerprintError('FINGERPRINT_DVD_AMBIGUOUS', 'The DVD has an ambiguous VIDEO_TS directory.', target);
  }
  if (dvdRoots.length && rootEntries.some(entry => PLAYBACK_EXTENSION.test(entry.name))) {
    throw fingerprintError('FINGERPRINT_DVD_AMBIGUOUS', 'DVD playback files occur both inside and outside VIDEO_TS.', target);
  }
  const playbackRoot = dvdRoots.length ? path.join(target, dvdRoots[0].name) : target;
  const files = [];
  const names = new Set();
  async function walk(directory, parts) {
    checkCanceled(options);
    for (const entry of await fs.promises.readdir(directory, {withFileTypes: true})) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw fingerprintError('FINGERPRINT_FILE_TYPE', 'A DVD playback directory contains a symbolic link.', fullPath);
      }
      if (entry.isDirectory()) {
        await walk(fullPath, parts.concat(entry.name));
      } else if (PLAYBACK_EXTENSION.test(entry.name)) {
        const name = parts.concat(entry.name).join('/').toUpperCase();
        if (names.has(name)) throw fingerprintError('FINGERPRINT_DVD_AMBIGUOUS', 'DVD filenames differ only in casing.', fullPath);
        names.add(name);
        const fileStats = await regularFile(fullPath);
        files.push({name, path: fullPath, size: fileStats.size, stamp: stamp(fileStats)});
      }
    }
  }
  await walk(playbackRoot, []);
  if (!files.length || !files.some(file => /\.VOB$/.test(file.name))) {
    throw fingerprintError('FINGERPRINT_DVD_EMPTY', 'No DVD video playback files were found.', target);
  }
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const size = files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(size)) throw new Error('Unsupported DVD size');
  return {mediaType: 'dvd', size, files, signature: JSON.stringify(['dvd', files])};
}

async function digestFile(file, options, full = false) {
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || JSON.stringify(stamp(before)) !== JSON.stringify(file.stamp)) {
      throw fingerprintError('FINGERPRINT_CHANGED', 'The media file changed while its ID was being calculated. Try again after copying or editing finishes.', file.path);
    }
    const hash = startHash(full ? 'complete-playback-file' : 'sampled-file');
    const ranges = sampleRanges(file.size, full);
    frame(hash, file.size);
    frame(hash, ranges.length);
    const buffer = Buffer.alloc(Math.min(BLOCK_BYTES, Math.max(1, file.size)));
    for (const range of ranges) {
      frame(hash, range.offset);
      frame(hash, range.length);
      frameLength(hash, range.length);
      let read = 0;
      while (read < range.length) {
        checkCanceled(options);
        const {bytesRead} = await handle.read(buffer, 0,
          Math.min(buffer.length, range.length - read), range.offset + read);
        if (!bytesRead) throw fingerprintError('FINGERPRINT_CHANGED', 'The media file ended before its ID calculation finished.', file.path);
        hash.update(buffer.subarray(0, bytesRead));
        read += bytesRead;
        if (options.onBytes) options.onBytes(bytesRead);
      }
    }
    if (JSON.stringify(stamp(await handle.stat())) !== JSON.stringify(file.stamp)) {
      throw fingerprintError('FINGERPRINT_CHANGED', 'The media file changed during ID calculation.', file.path);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function fingerprintPath(filename, options = {}) {
  const description = await describePath(filename, options);
  const previous = options.previous;
  if (previous && previous.scheme === VIDEO_ID_SCHEME && isVideoID(previous.id) &&
      previous.signature === description.signature) {
    return {...previous, cached: true};
  }
  let id;
  if (description.mediaType === 'file') {
    id = await digestFile(description.files[0], options);
  } else {
    const hash = startHash('dvd');
    frame(hash, description.files.length);
    frame(hash, description.size);
    for (const file of description.files) {
      const fileID = await digestFile(file, options, /\.(IFO|BUP)$/.test(file.name));
      frame(hash, file.name);
      frame(hash, file.size);
      frame(hash, fileID);
    }
    id = hash.digest('hex');
  }
  checkCanceled(options);
  if ((await describePath(filename, options)).signature !== description.signature) {
    throw fingerprintError('FINGERPRINT_CHANGED', 'The media path or DVD contents changed during ID calculation.', filename);
  }
  return {id, scheme: VIDEO_ID_SCHEME, mediaType: description.mediaType,
    size: description.size, signature: description.signature, cached: false};
}

module.exports = {BLOCK_BYTES, SAMPLE_COUNT, sampleRanges, describePath, fingerprintPath};
