const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {pipeline} = require('stream');
const {promisify} = require('util');
const {v4: uuidv4} = require('uuid');
const ShareManifest = require('./ShareManifest.js');

const pipelineAsync = promisify(pipeline);
const MIN_FREE_SPACE_RESERVE = 128 * 1024 * 1024;
const MAX_FREE_SPACE_RESERVE = 1024 * 1024 * 1024;

class ShareServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ShareServiceError';
    this.code = code;
    this.details = details;
  }
}

function shareError(code, message, details) {
  return new ShareServiceError(code, message, details);
}

function serializeError(err) {
  return {
    code: err && err.code ? String(err.code) : 'SHARE_FAILED',
    message: err && err.message ? err.message : String(err),
    details: err && err.details ? err.details : undefined
  };
}

function normalizeKind(value) {
  return ShareManifest.normalizeKind(value);
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {sensitivity: 'base'});
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(normalizeKind).filter(Boolean)));
}

function safeIdentifier(value) {
  const original = String(value || 'item');
  const cleaned = original.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 72) || 'item';
  const suffix = crypto.createHash('sha1').update(original).digest('hex').slice(0, 8);
  return `${cleaned}-${suffix}`;
}

function portableJoin(...parts) {
  return ShareManifest.validatePortableRelativePath(path.posix.join(...parts));
}

function filePathKey(value) {
  let key = path.resolve(String(value || ''));
  if (process.platform === 'win32') key = key.toLowerCase();
  return key;
}

async function lstatOrNull(filePath) {
  try {
    return await fs.promises.lstat(filePath);
  } catch(err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function assertNoSymlinkPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw shareError('UNSAFE_SHARE_PATH', 'A Share path leaves its allowed directory.', {
      root: resolvedRoot,
      path: resolvedTarget
    });
  }

  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = resolvedRoot;
  for (let index=-1; index<parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    const stats = await lstatOrNull(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw shareError('SHARE_SYMLINK_UNSUPPORTED',
        'Mynda will not read or write a Share path through a symbolic link.', {path: current});
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A non-directory blocks a Share path.', {path: current});
    }
  }
}

async function removePath(filePath) {
  const stats = await lstatOrNull(filePath);
  if (!stats) return;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await fs.promises.unlink(filePath);
    return;
  }
  const entries = await fs.promises.readdir(filePath);
  for (const entry of entries) {
    await removePath(path.join(filePath, entry));
  }
  await fs.promises.rmdir(filePath);
}

async function syncFile(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
}

async function hashFile(filePath, shouldCancel) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      if (shouldCancel && shouldCancel()) {
        stream.destroy(shareError('SHARE_CANCELED', 'The Share operation was canceled.'));
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyFileVerified(source, destination, options = {}) {
  const sourceStats = await fs.promises.lstat(source);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw shareError('INVALID_SHARE_FILE', 'A Share item is not a regular file.', {path: source});
  }
  if (Number.isSafeInteger(options.expectedSize) && sourceStats.size !== options.expectedSize) {
    throw shareError('SHARE_FILE_SIZE_MISMATCH', 'A Share file has changed size.', {
      path: source,
      expectedSize: options.expectedSize,
      actualSize: sourceStats.size
    });
  }

  const existingStats = await lstatOrNull(destination);
  if (existingStats) {
    if (!existingStats.isFile() || existingStats.isSymbolicLink() || existingStats.size !== sourceStats.size) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A different file already exists at a Share destination.', {path: destination});
    }
    const destinationHash = await hashFile(destination, options.shouldCancel);
    const sourceHash = options.expectedHash || await hashFile(source, options.shouldCancel);
    if (destinationHash !== sourceHash) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A different file already exists at a Share destination.', {path: destination});
    }
    return {sha256: sourceHash, bytes: sourceStats.size, reused: true};
  }

  await fs.promises.mkdir(path.dirname(destination), {recursive: true});
  const temporaryPath = `${destination}.mynda-partial-${process.pid}-${uuidv4()}`;
  const hash = crypto.createHash('sha256');
  const readStream = fs.createReadStream(source);
  const writeStream = fs.createWriteStream(temporaryPath, {flags: 'wx'});

  readStream.on('data', chunk => {
    if (options.shouldCancel && options.shouldCancel()) {
      readStream.destroy(shareError('SHARE_CANCELED', 'The Share operation was canceled.'));
      return;
    }
    hash.update(chunk);
    if (options.onBytes) options.onBytes(chunk.length);
  });

  try {
    await pipelineAsync(readStream, writeStream);
    const resultHash = hash.digest('hex');
    if (options.expectedHash && resultHash !== options.expectedHash) {
      throw shareError('SHARE_CHECKSUM_MISMATCH', 'A Share file failed checksum verification.', {
        path: source,
        expectedChecksum: options.expectedHash,
        actualChecksum: resultHash
      });
    }
    await syncFile(temporaryPath);

    // A hard link creates the final name without exposing a partial file and
    // without overwriting anything that may have appeared since preflight.
    try {
      await fs.promises.link(temporaryPath, destination);
      await fs.promises.unlink(temporaryPath);
    } catch(err) {
      if (err.code === 'EEXIST') {
        throw shareError('SHARE_DESTINATION_CONFLICT',
          'A file appeared at a Share destination while it was being copied.', {path: destination});
      }
      // Removable filesystems such as exFAT may not permit hard links. Both
      // callers place this file in a Mynda-owned package or staging directory,
      // so after one last conflict check an atomic rename is safe and avoids
      // writing a multi-gigabyte video to the same drive a second time.
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(err.code)) {
        if (await lstatOrNull(destination)) {
          throw shareError('SHARE_DESTINATION_CONFLICT',
            'A file appeared at a Share destination while it was being copied.', {path: destination});
        }
        await fs.promises.rename(temporaryPath, destination);
      } else {
        throw err;
      }
    }
    return {sha256: resultHash, bytes: sourceStats.size, reused: false};
  } catch(err) {
    try { await fs.promises.unlink(temporaryPath); } catch(cleanupErr) {}
    throw err;
  }
}

async function listDirectoryFiles(root, shouldCancel, relativeDirectory = '') {
  if (shouldCancel && shouldCancel()) {
    throw shareError('SHARE_CANCELED', 'The Share operation was canceled.');
  }
  const directory = relativeDirectory ?
    path.join(root, ...relativeDirectory.split('/')) : root;
  const entries = await fs.promises.readdir(directory, {withFileTypes: true});
  entries.sort((a, b) => compareText(a.name, b.name));
  let files = [];
  for (const entry of entries) {
    if (shouldCancel && shouldCancel()) {
      throw shareError('SHARE_CANCELED', 'The Share operation was canceled.');
    }
    const relativePath = relativeDirectory ?
      path.posix.join(relativeDirectory, entry.name) : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw shareError('SHARE_SYMLINK_UNSUPPORTED',
        'Mynda will not follow symbolic links while sharing a DVD folder.', {path: fullPath});
    }
    if (entry.isDirectory()) {
      files = files.concat(await listDirectoryFiles(root, shouldCancel, relativePath));
    } else if (entry.isFile()) {
      const stats = await fs.promises.lstat(fullPath);
      files.push({sourcePath: fullPath, relativePath: relativePath, size: stats.size});
    } else {
      throw shareError('SHARE_SPECIAL_FILE_UNSUPPORTED',
        'A DVD folder contains an unsupported filesystem entry.', {path: fullPath});
    }
  }
  return files;
}

async function describePrimaryMedia(video, shouldCancel) {
  const filename = video && video.filename;
  if (typeof filename !== 'string' || filename === '') {
    throw shareError('SHARE_SOURCE_MISSING', 'A library video has no source path.', {
      videoId: video && video.id
    });
  }
  let stats;
  try {
    stats = await fs.promises.lstat(filename);
  } catch(err) {
    throw shareError('SHARE_SOURCE_MISSING', 'A library video source is unavailable.', {
      path: filename,
      error: err.message
    });
  }
  if (stats.isSymbolicLink()) {
    throw shareError('SHARE_SYMLINK_UNSUPPORTED',
      'Mynda will not follow a symbolic-link media source.', {path: filename});
  }
  if (video.dvd) {
    if (!stats.isDirectory()) {
      throw shareError('INVALID_DVD_SOURCE', 'A DVD library entry is no longer a directory.', {
        path: filename
      });
    }
    const files = await listDirectoryFiles(filename, shouldCancel);
    if (files.length === 0) {
      throw shareError('EMPTY_DVD_SOURCE', 'A requested DVD folder does not contain any files.', {
        path: filename
      });
    }
    return {
      mediaType: 'dvd',
      size: files.reduce((sum, file) => sum + file.size, 0),
      files: files
    };
  }
  if (!stats.isFile()) {
    throw shareError('INVALID_VIDEO_SOURCE', 'A video library entry is no longer a regular file.', {
      path: filename
    });
  }
  return {mediaType: 'file', size: stats.size, files: null};
}

function findContainingWatchfolder(filename, watchfolders) {
  if (typeof filename !== 'string' || !Array.isArray(watchfolders)) return null;
  const resolvedFilename = path.resolve(filename);
  return watchfolders
    .filter(folder => folder && typeof folder.path === 'string' && folder.path !== '')
    .map(folder => ({folder: folder, resolved: path.resolve(folder.path)}))
    .filter(candidate => {
      const relative = path.relative(candidate.resolved, resolvedFilename);
      return relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })
    .sort((a, b) => b.resolved.length - a.resolved.length)
    .map(candidate => candidate.folder)[0] || null;
}

function portableRelative(root, child) {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return ShareManifest.toPortableRelativePath(relative);
}

function reasonCounts(omissions) {
  const counts = {};
  for (const omission of omissions || []) {
    const reason = omission.reason || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function reserveForDisk(totalSize) {
  const percentage = Number.isFinite(totalSize) ? Math.floor(totalSize * 0.005) : 0;
  return Math.min(MAX_FREE_SPACE_RESERVE, Math.max(MIN_FREE_SPACE_RESERVE, percentage));
}

class ShareService {
  constructor(options = {}) {
    this.library = options.library;
    this.log = options.log || {debug() {}, info() {}, warn() {}, error() {}};
    this.checkDiskSpace = options.checkDiskSpace;
    this.sendProgress = options.sendProgress || (() => {});
    this.conflictingOperationActive = options.conflictingOperationActive || (() => false);
    this.busy = null;
    this.cancelRequested = false;
    this.fulfillmentPlans = new Map();
    this.importPlans = new Map();
  }

  isBusy() {
    return Boolean(this.busy);
  }

  getState() {
    return {
      busy: Boolean(this.busy),
      phase: this.busy && this.busy.phase,
      cancelable: Boolean(this.busy && this.busy.cancelable),
      cancelRequested: this.cancelRequested
    };
  }

  cancel() {
    if (!this.busy || !this.busy.cancelable || this.cancelRequested) return false;
    this.cancelRequested = true;
    this.log.info('Share cancellation requested', {phase: this.busy.phase});
    this._emitProgress({cancelRequested: true});
    return true;
  }

  _isCanceled() {
    return this.cancelRequested;
  }

  _throwIfCanceled() {
    if (this._isCanceled()) {
      throw shareError('SHARE_CANCELED', 'The Share operation was canceled.');
    }
  }

  _emitProgress(progress) {
    const state = Object.assign({}, this.getState(), progress || {});
    try {
      this.sendProgress(state);
    } catch(err) {
      this.log.warn('Could not send Share progress to the renderer', {error: err});
    }
  }

  async _run(phase, options, operation) {
    if (this.busy) {
      throw shareError('SHARE_BUSY', 'Another Share operation is already running.', {
        phase: this.busy.phase
      });
    }
    if (this.conflictingOperationActive()) {
      throw shareError('SHARE_OPERATION_CONFLICT',
        'Share cannot run while Mynda is scanning watchfolders or running Auto-Tag.');
    }
    this.busy = {phase: phase, cancelable: options && options.cancelable !== false};
    this.cancelRequested = false;
    this._emitProgress({numCurrent: 0, numTotal: 0, bytesCurrent: 0, bytesTotal: 0});
    try {
      if (this.library && typeof this.library.whenIdle === 'function') {
        await this.library.whenIdle();
      }
      return await operation();
    } finally {
      this.busy = null;
      this.cancelRequested = false;
      this._emitProgress({busy: false, phase: null, cancelable: false, cancelRequested: false});
    }
  }

  async _ensureDirectory(directory, writable) {
    if (typeof directory !== 'string' || directory.trim() === '') {
      throw shareError('INVALID_SHARE_DIRECTORY', 'Choose a Share directory first.');
    }
    const resolved = path.resolve(directory);
    let stats;
    try {
      stats = await fs.promises.lstat(resolved);
    } catch(err) {
      throw shareError('INVALID_SHARE_DIRECTORY', 'The selected Share directory is unavailable.', {
        path: resolved,
        error: err.message
      });
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw shareError('INVALID_SHARE_DIRECTORY', 'The selected Share path is not a directory.', {
        path: resolved
      });
    }
    if (writable) {
      const testPath = path.join(resolved, `.mynda-share-write-test-${process.pid}-${uuidv4()}`);
      try {
        await fs.promises.writeFile(testPath, '', {flag: 'wx'});
        await fs.promises.unlink(testPath);
      } catch(err) {
        try { await fs.promises.unlink(testPath); } catch(cleanupErr) {}
        throw shareError('SHARE_DIRECTORY_NOT_WRITABLE',
          'Mynda cannot write to the selected Share directory.', {
            path: resolved,
            error: err.message
          });
      }
    }
    return resolved;
  }

  _localKinds() {
    const configured = new Set(uniqueStrings(
      this.library && this.library.settings && this.library.settings.used &&
      this.library.settings.used.kinds
    ));
    const counts = new Map();
    for (const video of (this.library && this.library.media) || []) {
      if (!video) continue;
      const kind = normalizeKind(video.kind);
      if (kind) counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const values = new Set([...configured, ...counts.keys()]);
    return Array.from(values).sort(compareText).map(kind => ({
      value: kind,
      label: kind,
      configured: configured.has(kind),
      activeVideos: counts.get(kind) || 0
    }));
  }

  _watchfolders() {
    return ((this.library && this.library.settings && this.library.settings.watchfolders) || [])
      .filter(folder => folder && typeof folder.path === 'string')
      .map(folder => ({path: folder.path, kind: normalizeKind(folder.kind)}));
  }

  async createRequest(options = {}) {
    return this._run('request', {cancelable: true}, async () => {
      const directory = await this._ensureDirectory(options.directory, true);
      const existingManifest = await lstatOrNull(ShareManifest.manifestPath(directory));
      if (existingManifest && options.overwrite !== true) {
        throw shareError('SHARE_REQUEST_EXISTS',
          `A ${ShareManifest.MANIFEST_FILENAME} file already exists in this directory.`, {
            replaceable: true,
            path: ShareManifest.manifestPath(directory)
          });
      }

      const kindLabels = uniqueStrings(options.requestedKinds);
      if (kindLabels.length === 0) {
        throw shareError('NO_SHARE_KINDS', 'Select at least one media kind for the Share request.');
      }
      const requestId = uuidv4();
      const requestedKinds = kindLabels.map(label => ({id: uuidv4(), label: label}));
      const media = ((this.library && this.library.media) || [])
        .filter(Boolean)
        .map(video => ({id: video.id, filename: video.filename, dvd: Boolean(video.dvd)}));
      const inventory = [];
      const omissions = [];
      const seenIDs = new Set();

      for (let index=0; index<media.length; index++) {
        this._throwIfCanceled();
        const video = media[index];
        this._emitProgress({numCurrent: index + 1, numTotal: media.length});
        if (!video.id || seenIDs.has(video.id)) continue;
        seenIDs.add(video.id);
        try {
          const primary = await describePrimaryMedia(video, () => this._isCanceled());
          inventory.push({
            id: video.id,
            mediaType: primary.mediaType,
            size: primary.size
          });
        } catch(err) {
          if (err.code === 'SHARE_CANCELED') throw err;
          omissions.push({videoId: video.id || '', reason: err.code || 'source-unavailable'});
          this.log.warn('Could not include a library video in the Share inventory', {
            videoId: video.id,
            filename: video.filename,
            error: err
          });
        }
      }

      const manifest = {
        format: ShareManifest.SHARE_FORMAT,
        version: ShareManifest.SHARE_VERSION,
        revision: 1,
        request: {
          id: requestId,
          requestingLibraryId: String(this.library.id || ''),
          createdAt: new Date().toISOString(),
          requestedKinds: requestedKinds,
          includeDvds: options.includeDvds !== false,
          inventory: inventory
        },
        fulfillment: null,
        imports: []
      };
      const filePath = await ShareManifest.writeManifest(directory, manifest);
      this.fulfillmentPlans.clear();
      this.importPlans.clear();
      const result = {
        requestId: requestId,
        manifestPath: filePath,
        requestedKinds: requestedKinds,
        includeDvds: manifest.request.includeDvds,
        inventoriedVideos: inventory.length,
        unavailableVideos: omissions.length,
        replacedExistingRequest: Boolean(existingManifest)
      };
      this.log.info('Share request created', result);
      return result;
    });
  }

  async inspect(directory) {
    const resolved = await this._ensureDirectory(directory, false);
    const manifest = await ShareManifest.readManifest(resolved);
    const localKinds = this._localKinds();
    // A resumed package can legitimately contain a source kind that has since
    // been removed from the fulfilling library. Keep that saved mapping
    // visible so its already-packaged items can be retained or deliberately
    // unmapped instead of failing behind an invisible stale checkbox.
    if (manifest.fulfillment &&
        manifest.fulfillment.fulfillingLibraryId === String(this.library.id || '')) {
      const knownKinds = new Set(localKinds.map(kind => kind.value));
      manifest.fulfillment.items.forEach(item => {
        const sourceKind = normalizeKind(item.sourceKind);
        if (sourceKind && !knownKinds.has(sourceKind)) {
          localKinds.push({
            value: sourceKind,
            label: sourceKind,
            configured: false,
            activeVideos: 0,
            packagedOnly: true
          });
          knownKinds.add(sourceKind);
        }
      });
      localKinds.sort((a, b) => compareText(a.value, b.value));
    }
    const localKindSet = new Set(localKinds.map(kind => kind.value));
    const watchfolders = this._watchfolders();
    const savedMappings = new Map(
      ((manifest.fulfillment && manifest.fulfillment.kindMappings) || [])
        .map(mapping => [mapping.requestedKindId, mapping.sourceKinds])
    );
    const defaultFulfillmentMappings = manifest.request.requestedKinds.map(requestedKind => ({
      requestedKindId: requestedKind.id,
      sourceKinds: savedMappings.has(requestedKind.id) ?
        savedMappings.get(requestedKind.id).filter(sourceKind => localKindSet.has(sourceKind)) :
        (localKindSet.has(requestedKind.label) ? [requestedKind.label] : [])
    }));

    const localActiveIDs = new Set(((this.library && this.library.media) || [])
      .filter(Boolean).map(video => video.id));
    const fulfilledKindIDs = new Set(
      ((manifest.fulfillment && manifest.fulfillment.items) || [])
        .filter(item => !localActiveIDs.has(item.videoId))
        .map(item => item.requestedKindId)
    );
    const importKinds = manifest.request.requestedKinds.filter(kind => fulfilledKindIDs.has(kind.id));
    const defaultImportMappings = importKinds.map(kind => {
      const localKind = localKindSet.has(kind.label) ? kind.label : '';
      const watchfolder = watchfolders.find(folder => folder.kind === localKind);
      return {
        requestedKindId: kind.id,
        localKind: localKind,
        watchfolder: watchfolder ? watchfolder.path : ''
      };
    });

    const fulfillment = manifest.fulfillment ? {
      status: manifest.fulfillment.status,
      createdAt: manifest.fulfillment.createdAt,
      updatedAt: manifest.fulfillment.updatedAt,
      fulfillingLibraryId: manifest.fulfillment.fulfillingLibraryId,
      includeDvds: manifest.fulfillment.includeDvds,
      itemCount: manifest.fulfillment.items.length,
      dvdCount: manifest.fulfillment.items.filter(item => item.dvd).length,
      totalBytes: manifest.fulfillment.items.reduce((sum, item) => sum + item.totalBytes, 0),
      omissionCounts: reasonCounts(manifest.fulfillment.omissions)
    } : null;

    return {
      directory: resolved,
      request: {
        id: manifest.request.id,
        createdAt: manifest.request.createdAt,
        requestingLibraryId: manifest.request.requestingLibraryId,
        belongsToThisLibrary: manifest.request.requestingLibraryId === String(this.library.id || ''),
        requestedKinds: manifest.request.requestedKinds,
        includeDvds: manifest.request.includeDvds,
        inventoryCount: manifest.request.inventory.length
      },
      fulfillment: fulfillment,
      localKinds: localKinds,
      watchfolders: watchfolders,
      defaultFulfillmentMappings: defaultFulfillmentMappings,
      importKinds: importKinds,
      defaultImportMappings: defaultImportMappings
    };
  }

  _normalizeFulfillmentMappings(mappings, manifest) {
    const requestedIDs = new Set(manifest.request.requestedKinds.map(kind => kind.id));
    const availableKinds = new Set(this._localKinds().map(kind => kind.value));
    if (manifest.fulfillment &&
        manifest.fulfillment.fulfillingLibraryId === String(this.library.id || '')) {
      manifest.fulfillment.items.forEach(item => availableKinds.add(normalizeKind(item.sourceKind)));
    }
    const normalized = [];
    const usedSourceKinds = new Map();
    const supplied = new Map();
    for (const mapping of Array.isArray(mappings) ? mappings : []) {
      if (mapping && requestedIDs.has(mapping.requestedKindId)) {
        supplied.set(mapping.requestedKindId, uniqueStrings(mapping.sourceKinds));
      }
    }
    for (const requestedKind of manifest.request.requestedKinds) {
      const sourceKinds = supplied.get(requestedKind.id) || [];
      for (const sourceKind of sourceKinds) {
        if (!availableKinds.has(sourceKind)) {
          throw shareError('UNKNOWN_SOURCE_KIND',
            `The fulfilling library no longer contains the “${sourceKind}” media kind.`);
        }
        if (usedSourceKinds.has(sourceKind)) {
          throw shareError('SOURCE_KIND_MAPPED_TWICE',
            `The “${sourceKind}” media kind is mapped to more than one requested kind.`, {
              firstRequestedKindId: usedSourceKinds.get(sourceKind),
              secondRequestedKindId: requestedKind.id
            });
        }
        usedSourceKinds.set(sourceKind, requestedKind.id);
      }
      normalized.push({requestedKindId: requestedKind.id, sourceKinds: sourceKinds});
    }
    return normalized;
  }

  async _buildTransferItem(video, primary, requestedKind, sourceKind, requestId, watchfolders) {
    const watchfolder = findContainingWatchfolder(video.filename, watchfolders);
    if (!watchfolder) {
      throw shareError('SOURCE_OUTSIDE_WATCHFOLDER',
        'A requested video is not inside one of the fulfilling library’s watchfolders.', {
          videoId: video.id,
          filename: video.filename
        });
    }
    const destinationRelativePath = portableRelative(watchfolder.path, video.filename);
    const packageDirectory = portableJoin(
      ShareManifest.FILES_DIRECTORY,
      safeIdentifier(requestId),
      safeIdentifier(video.id)
    );
    const sourceFiles = [];
    const subtitleOmissions = [];
    let sequence = 1;
    const addSourceFile = (sourcePath, size, role, destinationPath) => {
      const packagePath = portableJoin(
        packageDirectory,
        'content',
        String(sequence++).padStart(6, '0')
      );
      sourceFiles.push({
        sourcePath: sourcePath,
        size: size,
        role: role,
        packagePath: packagePath,
        destinationRelativePath: ShareManifest.validatePortableRelativePath(destinationPath)
      });
    };

    if (video.dvd) {
      for (const file of primary.files) {
        addSourceFile(
          file.sourcePath,
          file.size,
          'dvd-content',
          portableJoin(destinationRelativePath, file.relativePath)
        );
      }
    } else {
      addSourceFile(video.filename, primary.size, 'video', destinationRelativePath);
    }

    const subtitleDestinationKeys = new Set(sourceFiles.map(file =>
      file.destinationRelativePath.toLowerCase()
    ));
    const subtitles = Array.from(new Set(Array.isArray(video.subtitles) ? video.subtitles : []));
    const manualSubtitleKeys = new Set(
      (Array.isArray(video.manual_subtitles) ? video.manual_subtitles : []).map(filePathKey)
    );
    for (const subtitle of subtitles) {
      this._throwIfCanceled();
      try {
        const stats = await fs.promises.lstat(subtitle);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw shareError('INVALID_SUBTITLE_SOURCE', 'A subtitle is not a regular file.', {path: subtitle});
        }
        const subtitleWatchfolder = findContainingWatchfolder(subtitle, [watchfolder]);
        const preserveRelativePath = subtitleWatchfolder &&
          !manualSubtitleKeys.has(filePathKey(subtitle));
        const destinationName = path.posix.basename(destinationRelativePath)
          .replace(/\.dvdmedia$/i, '');
        const videoBase = video.dvd ? destinationName : path.posix.parse(destinationName).name;
        let subtitleDestination = preserveRelativePath ?
          portableRelative(watchfolder.path, subtitle) :
          portableJoin(
            path.posix.dirname(destinationRelativePath),
            `${videoBase}.${path.basename(subtitle)}`
          );
        const parsed = path.posix.parse(subtitleDestination);
        let suffix = 2;
        while (subtitleDestinationKeys.has(subtitleDestination.toLowerCase())) {
          subtitleDestination = portableJoin(parsed.dir, `${parsed.name} (${suffix++})${parsed.ext}`);
        }
        subtitleDestinationKeys.add(subtitleDestination.toLowerCase());
        addSourceFile(subtitle, stats.size, 'subtitle', subtitleDestination);
      } catch(err) {
        if (err.code === 'SHARE_CANCELED') throw err;
        subtitleOmissions.push({
          videoId: video.id,
          title: String(video.title || path.basename(video.filename)),
          subtitle: path.basename(String(subtitle || '')),
          reason: 'subtitle-unavailable'
        });
        this.log.warn('A subtitle will be omitted from a shared video', {
          videoId: video.id,
          subtitle: subtitle,
          error: err
        });
      }
    }

    if (sourceFiles.length === 0) {
      throw shareError('EMPTY_DVD_SOURCE', 'A requested DVD folder does not contain any files.', {
        videoId: video.id,
        filename: video.filename
      });
    }

    return {
      videoId: video.id,
      title: String(video.title || path.basename(video.filename)),
      sourceKind: sourceKind,
      requestedKindId: requestedKind.id,
      requestedKindLabel: requestedKind.label,
      dvd: Boolean(video.dvd),
      destinationRelativePath: destinationRelativePath,
      packageDirectory: packageDirectory,
      mediaBytes: primary.size,
      totalBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
      sourceFiles: sourceFiles,
      subtitleOmissions: subtitleOmissions
    };
  }

  async _quickPackageItemIsComplete(directory, item) {
    try {
      for (const file of item.files) {
        const filePath = ShareManifest.safeJoin(directory, file.packagePath);
        await assertNoSymlinkPath(directory, filePath);
        const stats = await fs.promises.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.size) return false;
      }
      return true;
    } catch(err) {
      return false;
    }
  }

  async planFulfillment(options = {}) {
    return this._run('fulfillment-plan', {cancelable: true}, async () => {
      const directory = await this._ensureDirectory(options.directory, true);
      const manifest = await ShareManifest.readManifest(directory);
      const mappings = this._normalizeFulfillmentMappings(options.kindMappings, manifest);
      const sourceToRequested = new Map();
      const requestedByID = new Map(manifest.request.requestedKinds.map(kind => [kind.id, kind]));
      for (const mapping of mappings) {
        for (const sourceKind of mapping.sourceKinds) {
          sourceToRequested.set(sourceKind, requestedByID.get(mapping.requestedKindId));
        }
      }

      if (manifest.fulfillment && manifest.fulfillment.items.length > 0 &&
          manifest.fulfillment.fulfillingLibraryId !== String(this.library.id || '')) {
        throw shareError('FULFILLMENT_LIBRARY_MISMATCH',
          'This request already contains media from a different fulfilling library.');
      }

      const includeDvds = manifest.request.includeDvds && options.includeDvds !== false;
      const inventory = new Map(manifest.request.inventory.map(entry => [entry.id, entry]));
      const validExistingItems = [];
      const alreadyPackagedIDs = new Set();
      for (const item of (manifest.fulfillment && manifest.fulfillment.items) || []) {
        const mappedRequestedKind = sourceToRequested.get(normalizeKind(item.sourceKind));
        const mappingStillApplies = mappedRequestedKind &&
          mappedRequestedKind.id === item.requestedKindId;
        const dvdStillIncluded = !item.dvd || includeDvds;
        if (mappingStillApplies && dvdStillIncluded &&
            await this._quickPackageItemIsComplete(directory, item)) {
          validExistingItems.push(item);
          alreadyPackagedIDs.add(item.videoId);
        }
      }

      const media = ((this.library && this.library.media) || [])
        .filter(Boolean)
        .slice()
        .sort((a, b) => Number(b.dateadded || 0) - Number(a.dateadded || 0));
      const watchfolders = (this.library.settings && this.library.settings.watchfolders) || [];
      let items = [];
      const omissions = [];
      let alreadyPresent = 0;
      let alreadyPackaged = validExistingItems.length;
      const seenVideoIDs = new Set();

      for (const mapping of mappings) {
        if (mapping.sourceKinds.length === 0) {
          const requestedKind = requestedByID.get(mapping.requestedKindId);
          omissions.push({
            requestedKindId: mapping.requestedKindId,
            requestedKindLabel: requestedKind && requestedKind.label,
            reason: 'requested-kind-unmapped'
          });
        }
      }

      for (let index=0; index<media.length; index++) {
        this._throwIfCanceled();
        const video = media[index];
        const sourceKind = normalizeKind(video.kind);
        const requestedKind = sourceToRequested.get(sourceKind);
        if (!requestedKind || !video.id || seenVideoIDs.has(video.id)) continue;
        seenVideoIDs.add(video.id);
        this._emitProgress({numCurrent: index + 1, numTotal: media.length});

        if (alreadyPackagedIDs.has(video.id)) {
          continue;
        }
        if (video.dvd && !includeDvds) {
          omissions.push({videoId: video.id, title: video.title || '', reason: 'dvd-excluded'});
          continue;
        }

        try {
          const primary = await describePrimaryMedia(video, () => this._isCanceled());
          const targetEntry = inventory.get(video.id);
          if (targetEntry) {
            if (targetEntry.mediaType === primary.mediaType && targetEntry.size === primary.size) {
              alreadyPresent++;
            } else {
              omissions.push({
                videoId: video.id,
                title: video.title || '',
                reason: 'identity-conflict'
              });
            }
            continue;
          }
          const item = await this._buildTransferItem(
            video, primary, requestedKind, sourceKind, manifest.request.id, watchfolders
          );
          omissions.push(...item.subtitleOmissions);
          items.push(item);
        } catch(err) {
          if (err.code === 'SHARE_CANCELED') throw err;
          omissions.push({
            videoId: video.id,
            title: video.title || '',
            reason: err.code || 'source-unavailable'
          });
          this.log.warn('A requested video cannot be included in the Share plan', {
            videoId: video.id,
            filename: video.filename,
            error: err
          });
        }
      }

      // Two source watchfolders can contain the same relative path. Since the
      // importer chooses one destination root per requested kind, omit both
      // sides rather than arbitrarily overwriting one of them.
      const pathOwners = new Map();
      const collisionIDs = new Set();
      for (const item of items) {
        for (const file of item.sourceFiles) {
          const key = `${item.requestedKindId}\0${file.destinationRelativePath.toLowerCase()}`;
          if (pathOwners.has(key)) {
            collisionIDs.add(pathOwners.get(key));
            collisionIDs.add(item.videoId);
          } else {
            pathOwners.set(key, item.videoId);
          }
        }
      }
      if (collisionIDs.size > 0) {
        items = items.filter(item => {
          if (!collisionIDs.has(item.videoId)) return true;
          omissions.push({videoId: item.videoId, title: item.title, reason: 'destination-path-conflict'});
          return false;
        });
      }

      const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
      const disk = await this.checkDiskSpace(directory);
      const reserveBytes = reserveForDisk(disk.size);
      const enoughSpace = totalBytes === 0 || disk.free >= totalBytes + reserveBytes;
      const token = uuidv4();
      const plan = {
        token: token,
        directory: directory,
        manifestRevision: manifest.revision,
        requestId: manifest.request.id,
        mappings: mappings,
        includeDvds: includeDvds,
        items: items,
        existingItems: validExistingItems,
        omissions: omissions,
        totalBytes: totalBytes,
        availableBytes: disk.free,
        reserveBytes: reserveBytes,
        enoughSpace: enoughSpace
      };
      this.fulfillmentPlans.clear();
      this.fulfillmentPlans.set(token, plan);
      const summary = {
        token: token,
        videos: items.length,
        dvds: items.filter(item => item.dvd).length,
        subtitles: items.reduce((sum, item) =>
          sum + item.sourceFiles.filter(file => file.role === 'subtitle').length, 0),
        totalBytes: totalBytes,
        alreadyPresent: alreadyPresent,
        alreadyPackaged: alreadyPackaged,
        omissions: omissions.length,
        omissionCounts: reasonCounts(omissions),
        availableBytes: disk.free,
        reserveBytes: reserveBytes,
        enoughSpace: enoughSpace,
        includeDvds: includeDvds
      };
      this.log.info('Share fulfillment plan prepared', summary);
      return summary;
    });
  }

  async _copyItemToPackage(plan, item, onBytes) {
    const finalDirectory = ShareManifest.safeJoin(plan.directory, item.packageDirectory);
    await assertNoSymlinkPath(plan.directory, finalDirectory);
    const finalStats = await lstatOrNull(finalDirectory);
    const useExistingDirectory = Boolean(finalStats && finalStats.isDirectory() && !finalStats.isSymbolicLink());
    if (finalStats && !useExistingDirectory) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A file conflicts with a Share package item directory.', {path: finalDirectory});
    }

    const workingDirectory = useExistingDirectory ? finalDirectory :
      path.join(path.dirname(finalDirectory), `.${path.basename(finalDirectory)}.mynda-partial`);
    if (!useExistingDirectory) {
      await removePath(workingDirectory);
      await fs.promises.mkdir(workingDirectory, {recursive: true});
    }

    const manifestFiles = [];
    try {
      for (const sourceFile of item.sourceFiles) {
        this._throwIfCanceled();
        const withinItem = path.posix.relative(item.packageDirectory, sourceFile.packagePath);
        const destination = ShareManifest.safeJoin(workingDirectory, withinItem);
        await assertNoSymlinkPath(plan.directory, destination);
        const copyResult = await copyFileVerified(sourceFile.sourcePath, destination, {
          expectedSize: sourceFile.size,
          shouldCancel: () => this._isCanceled(),
          onBytes: onBytes
        });
        manifestFiles.push({
          role: sourceFile.role,
          packagePath: sourceFile.packagePath,
          destinationRelativePath: sourceFile.destinationRelativePath,
          size: sourceFile.size,
          sha256: copyResult.sha256
        });
      }
      if (!useExistingDirectory) {
        await fs.promises.mkdir(path.dirname(finalDirectory), {recursive: true});
        if (await lstatOrNull(finalDirectory)) {
          throw shareError('SHARE_DESTINATION_CONFLICT',
            'A Share package item appeared while it was being copied.', {path: finalDirectory});
        }
        await fs.promises.rename(workingDirectory, finalDirectory);
      }
    } catch(err) {
      if (!useExistingDirectory) {
        try { await removePath(workingDirectory); } catch(cleanupErr) {}
      }
      throw err;
    }

    return {
      videoId: item.videoId,
      title: item.title,
      sourceKind: item.sourceKind,
      requestedKindId: item.requestedKindId,
      requestedKindLabel: item.requestedKindLabel,
      dvd: item.dvd,
      destinationRelativePath: item.destinationRelativePath,
      packageDirectory: item.packageDirectory,
      totalBytes: item.totalBytes,
      files: manifestFiles
    };
  }

  async fulfillRequest(options = {}) {
    return this._run('fulfill', {cancelable: true}, async () => {
      const plan = this.fulfillmentPlans.get(options.token);
      if (!plan) {
        throw shareError('SHARE_PLAN_EXPIRED',
          'The fulfillment plan is no longer available. Prepare the plan again.');
      }
      const manifest = await ShareManifest.readManifest(plan.directory);
      if (manifest.request.id !== plan.requestId || manifest.revision !== plan.manifestRevision) {
        throw shareError('SHARE_PLAN_STALE',
          'The Share request changed after the plan was prepared. Prepare it again.');
      }
      const disk = await this.checkDiskSpace(plan.directory);
      if (plan.totalBytes > 0 && disk.free < plan.totalBytes + plan.reserveBytes) {
        throw shareError('SHARE_INSUFFICIENT_SPACE',
          'The Share directory no longer has enough free space for this plan.', {
            availableBytes: disk.free,
            requiredBytes: plan.totalBytes,
            reserveBytes: plan.reserveBytes
          });
      }

      let fulfillment = {
        status: 'in-progress',
        createdAt: manifest.fulfillment && manifest.fulfillment.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fulfillingLibraryId: String(this.library.id || ''),
        includeDvds: plan.includeDvds,
        kindMappings: plan.mappings,
        items: plan.existingItems.slice(),
        omissions: plan.omissions.slice()
      };
      manifest.fulfillment = fulfillment;
      manifest.revision++;
      await ShareManifest.writeManifest(plan.directory, manifest);

      let completed = 0;
      let copiedBytes = 0;
      let failed = 0;
      let canceled = false;
      const onBytes = bytes => {
        copiedBytes += bytes;
        this._emitProgress({
          numCurrent: completed,
          numTotal: plan.items.length,
          bytesCurrent: Math.min(copiedBytes, plan.totalBytes),
          bytesTotal: plan.totalBytes
        });
      };

      for (const item of plan.items) {
        try {
          this._throwIfCanceled();
          const manifestItem = await this._copyItemToPackage(plan, item, onBytes);
          const previousItems = fulfillment.items;
          const previousUpdatedAt = fulfillment.updatedAt;
          const previousRevision = manifest.revision;
          fulfillment.items = fulfillment.items.filter(existing => existing.videoId !== item.videoId);
          fulfillment.items.push(manifestItem);
          fulfillment.updatedAt = new Date().toISOString();
          manifest.revision++;
          try {
            await ShareManifest.writeManifest(plan.directory, manifest);
          } catch(err) {
            fulfillment.items = previousItems;
            fulfillment.updatedAt = previousUpdatedAt;
            manifest.revision = previousRevision;
            throw err;
          }
          completed++;
          this._emitProgress({
            numCurrent: completed,
            numTotal: plan.items.length,
            bytesCurrent: Math.min(copiedBytes, plan.totalBytes),
            bytesTotal: plan.totalBytes
          });
          this.log.info('Video added to Share package', {
            videoId: item.videoId,
            title: item.title,
            dvd: item.dvd,
            bytes: item.totalBytes
          });
        } catch(err) {
          if (err.code === 'SHARE_CANCELED') {
            canceled = true;
            break;
          }
          failed++;
          fulfillment.omissions.push({
            videoId: item.videoId,
            title: item.title,
            reason: err.code || 'copy-failed'
          });
          this.log.error('Could not add video to Share package', {
            videoId: item.videoId,
            title: item.title,
            error: err
          });
          if (err.code === 'ENOSPC') break;
        }
      }

      fulfillment.status = canceled ? 'canceled' :
        (failed > 0 || fulfillment.omissions.length > 0 ? 'partial' : 'complete');
      fulfillment.updatedAt = new Date().toISOString();
      manifest.revision++;
      await ShareManifest.writeManifest(plan.directory, manifest);
      this.fulfillmentPlans.delete(options.token);
      const result = {
        status: fulfillment.status,
        packagedVideos: completed,
        totalPackagedVideos: fulfillment.items.length,
        failedVideos: failed,
        omittedVideos: fulfillment.omissions.length,
        omissionCounts: reasonCounts(fulfillment.omissions),
        copiedBytes: copiedBytes,
        canceled: canceled
      };
      this.log.info('Share fulfillment finished', result);
      return result;
    });
  }

  _normalizeImportMappings(mappings, manifest, neededKindIDs) {
    const requestedByID = new Map(manifest.request.requestedKinds.map(kind => [kind.id, kind]));
    neededKindIDs = neededKindIDs ||
      new Set((manifest.fulfillment.items || []).map(item => item.requestedKindId));
    const watchfolders = this._watchfolders();
    const byPath = new Map(watchfolders.map(folder => [path.resolve(folder.path), folder]));
    const normalized = new Map();

    for (const mapping of Array.isArray(mappings) ? mappings : []) {
      if (!mapping || !neededKindIDs.has(mapping.requestedKindId)) continue;
      const requestedKind = requestedByID.get(mapping.requestedKindId);
      const localKind = normalizeKind(mapping.localKind);
      const watchfolderPath = typeof mapping.watchfolder === 'string' ? path.resolve(mapping.watchfolder) : '';
      const watchfolder = byPath.get(watchfolderPath);
      if (!requestedKind || !localKind || !watchfolder) {
        throw shareError('INVALID_IMPORT_MAPPING',
          'Every shared media kind needs a valid destination watchfolder.');
      }
      if (watchfolder.kind !== localKind) {
        throw shareError('IMPORT_KIND_MISMATCH',
          `The selected watchfolder assigns “${watchfolder.kind}” rather than “${localKind}”.`, {
            watchfolder: watchfolder.path,
            requestedKind: requestedKind.label
          });
      }
      normalized.set(mapping.requestedKindId, {
        requestedKindId: mapping.requestedKindId,
        requestedKindLabel: requestedKind.label,
        localKind: localKind,
        watchfolder: watchfolder.path
      });
    }
    for (const kindID of neededKindIDs) {
      if (!normalized.has(kindID)) {
        const kind = requestedByID.get(kindID);
        throw shareError('MISSING_IMPORT_MAPPING',
          `Choose a destination watchfolder for the “${kind ? kind.label : 'unknown'}” media kind.`);
      }
    }
    return normalized;
  }

  async planImport(options = {}) {
    return this._run('import-plan', {cancelable: true}, async () => {
      const directory = await this._ensureDirectory(options.directory, false);
      const manifest = await ShareManifest.readManifest(directory);
      if (!manifest.fulfillment) {
        throw shareError('SHARE_NOT_FULFILLED',
          'This Share request has not been fulfilled yet.');
      }
      const activeIDs = new Set(((this.library && this.library.media) || [])
        .filter(Boolean).map(video => video.id));
      const neededKindIDs = new Set(manifest.fulfillment.items
        .filter(item => !activeIDs.has(item.videoId))
        .map(item => item.requestedKindId));
      const mappings = this._normalizeImportMappings(options.kindMappings, manifest, neededKindIDs);
      let alreadyInLibrary = 0;
      const omissions = [];
      let items = [];

      for (let index=0; index<manifest.fulfillment.items.length; index++) {
        this._throwIfCanceled();
        const item = manifest.fulfillment.items[index];
        this._emitProgress({numCurrent: index + 1, numTotal: manifest.fulfillment.items.length});
        if (activeIDs.has(item.videoId)) {
          alreadyInLibrary++;
          continue;
        }
        const mapping = mappings.get(item.requestedKindId);
        let itemInvalid = false;
        const files = [];
        let requiredBytes = 0;

        try {
          const primaryDestination = ShareManifest.safeJoin(mapping.watchfolder, item.destinationRelativePath);
          await assertNoSymlinkPath(mapping.watchfolder, primaryDestination);
          const primaryStats = await lstatOrNull(primaryDestination);
          if (item.dvd && primaryStats && (!primaryStats.isDirectory() || primaryStats.isSymbolicLink())) {
            throw shareError('SHARE_DESTINATION_CONFLICT',
              'A non-directory conflicts with an imported DVD folder.', {path: primaryDestination});
          }
          if (!item.dvd && primaryStats && (!primaryStats.isFile() || primaryStats.isSymbolicLink())) {
            throw shareError('SHARE_DESTINATION_CONFLICT',
              'A directory conflicts with an imported video file.', {path: primaryDestination});
          }

          let dvdFilesMissing = 0;
          for (const file of item.files) {
            const source = ShareManifest.safeJoin(directory, file.packagePath);
            await assertNoSymlinkPath(directory, source);
            let sourceStats;
            try {
              sourceStats = await fs.promises.lstat(source);
            } catch(err) {
              throw shareError('SHARE_PACKAGE_INCOMPLETE',
                'A file in the Share package is missing or unreadable.', {
                  path: source,
                  error: err.message
                });
            }
            if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size !== file.size) {
              throw shareError('SHARE_PACKAGE_INCOMPLETE',
                'A file in the Share package is missing or incomplete.', {path: source});
            }
            const destination = ShareManifest.safeJoin(mapping.watchfolder, file.destinationRelativePath);
            await assertNoSymlinkPath(mapping.watchfolder, destination);
            const destinationStats = await lstatOrNull(destination);
            if (destinationStats) {
              if (!destinationStats.isFile() || destinationStats.isSymbolicLink() ||
                  destinationStats.size !== file.size) {
                throw shareError('SHARE_DESTINATION_CONFLICT',
                  'A different file exists at an import destination.', {path: destination});
              }
              const destinationHash = await hashFile(destination, () => this._isCanceled());
              if (destinationHash !== file.sha256) {
                throw shareError('SHARE_DESTINATION_CONFLICT',
                  'A different file exists at an import destination.', {path: destination});
              }
            } else {
              requiredBytes += file.size;
              if (file.role === 'dvd-content') dvdFilesMissing++;
            }
            files.push({
              role: file.role,
              source: source,
              destination: destination,
              safeRoot: mapping.watchfolder,
              destinationRelativePath: file.destinationRelativePath,
              size: file.size,
              sha256: file.sha256,
              exists: Boolean(destinationStats)
            });
          }
          // An existing, incomplete DVD directory is not safe to fill in place:
          // startup scanning could mistake it for a complete disc after a crash.
          if (item.dvd && primaryStats && dvdFilesMissing > 0) {
            throw shareError('PARTIAL_DVD_DESTINATION',
              'An incomplete DVD folder already exists at the import destination.', {
                path: primaryDestination
              });
          }
          items.push({
            item: item,
            mapping: mapping,
            primaryDestination: primaryDestination,
            files: files,
            requiredBytes: requiredBytes
          });
        } catch(err) {
          itemInvalid = true;
          omissions.push({videoId: item.videoId, title: item.title, reason: err.code || 'import-conflict'});
          this.log.warn('A shared video cannot be included in the import plan', {
            videoId: item.videoId,
            title: item.title,
            error: err
          });
        }
        if (itemInvalid) continue;
      }

      const pathOwners = new Map();
      const collisionIDs = new Set();
      for (const planned of items) {
        for (const file of planned.files) {
          const key = path.resolve(file.destination).toLowerCase();
          if (pathOwners.has(key)) {
            collisionIDs.add(pathOwners.get(key));
            collisionIDs.add(planned.item.videoId);
          } else {
            pathOwners.set(key, planned.item.videoId);
          }
        }
      }
      if (collisionIDs.size > 0) {
        items = items.filter(planned => {
          if (!collisionIDs.has(planned.item.videoId)) return true;
          omissions.push({
            videoId: planned.item.videoId,
            title: planned.item.title,
            reason: 'destination-path-conflict'
          });
          return false;
        });
      }

      const volumes = new Map();
      const diskByWatchfolder = new Map();
      for (const planned of items) {
        const watchfolderKey = path.resolve(planned.mapping.watchfolder);
        if (!diskByWatchfolder.has(watchfolderKey)) {
          diskByWatchfolder.set(
            watchfolderKey,
            await this.checkDiskSpace(planned.mapping.watchfolder)
          );
        }
        const disk = diskByWatchfolder.get(watchfolderKey);
        const key = disk.diskPath || path.resolve(planned.mapping.watchfolder);
        if (!volumes.has(key)) {
          volumes.set(key, {
            diskPath: key,
            availableBytes: disk.free,
            totalSize: disk.size,
            requiredBytes: 0
          });
        }
        volumes.get(key).requiredBytes += planned.requiredBytes;
      }
      let enoughSpace = true;
      const volumeSummaries = Array.from(volumes.values()).map(volume => {
        const reserveBytes = reserveForDisk(volume.totalSize);
        const fits = volume.availableBytes >= volume.requiredBytes + reserveBytes;
        if (!fits) enoughSpace = false;
        return Object.assign({}, volume, {reserveBytes: reserveBytes, enoughSpace: fits});
      });

      const token = uuidv4();
      const plan = {
        token: token,
        directory: directory,
        manifestRevision: manifest.revision,
        requestId: manifest.request.id,
        mappings: Array.from(mappings.values()),
        items: items,
        omissions: omissions,
        totalBytes: items.reduce((sum, item) => sum + item.requiredBytes, 0),
        enoughSpace: enoughSpace,
        volumes: volumeSummaries
      };
      this.importPlans.clear();
      this.importPlans.set(token, plan);
      const summary = {
        token: token,
        videos: items.length,
        dvds: items.filter(item => item.item.dvd).length,
        filesToCopy: items.reduce((sum, item) =>
          sum + item.files.filter(file => !file.exists).length, 0),
        totalBytes: plan.totalBytes,
        alreadyInLibrary: alreadyInLibrary,
        omissions: omissions.length,
        omissionCounts: reasonCounts(omissions),
        volumes: volumeSummaries,
        enoughSpace: enoughSpace
      };
      this.log.info('Share import plan prepared', summary);
      return summary;
    });
  }

  async _verifyExistingDestination(file) {
    await assertNoSymlinkPath(file.safeRoot, file.destination);
    const stats = await lstatOrNull(file.destination);
    if (!stats) return false;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.size) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A different file exists at an import destination.', {path: file.destination});
    }
    const checksum = await hashFile(file.destination, () => this._isCanceled());
    if (checksum !== file.sha256) {
      throw shareError('SHARE_DESTINATION_CONFLICT',
        'A different file exists at an import destination.', {path: file.destination});
    }
    return true;
  }

  async _importItem(plan, planned, onBytes) {
    const item = planned.item;
    const watchfolder = planned.mapping.watchfolder;
    const stagingRoot = path.join(
      path.resolve(watchfolder),
      ShareManifest.IMPORT_STAGING_DIRECTORY,
      safeIdentifier(plan.requestId),
      safeIdentifier(item.videoId)
    );
    const containment = path.relative(path.resolve(watchfolder), stagingRoot);
    if (containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
      throw shareError('UNSAFE_SHARE_PATH', 'Could not create a safe Share staging directory.');
    }
    await assertNoSymlinkPath(watchfolder, stagingRoot);
    await removePath(stagingRoot);
    await fs.promises.mkdir(stagingRoot, {recursive: true});

    const stagedFiles = [];
    let existingFiles = 0;
    try {
      for (let index=0; index<planned.files.length; index++) {
        this._throwIfCanceled();
        const file = planned.files[index];
        if (await this._verifyExistingDestination(file)) {
          existingFiles++;
          continue;
        }
        let stagedDestination;
        if (item.dvd && file.role === 'dvd-content') {
          const withinDvd = path.posix.relative(
            item.destinationRelativePath,
            file.destinationRelativePath
          );
          stagedDestination = ShareManifest.safeJoin(path.join(stagingRoot, 'dvd'), withinDvd);
        } else {
          stagedDestination = path.join(stagingRoot, 'files', String(index).padStart(6, '0'));
        }
        await copyFileVerified(file.source, stagedDestination, {
          expectedSize: file.size,
          expectedHash: file.sha256,
          shouldCancel: () => this._isCanceled(),
          onBytes: onBytes
        });
        stagedFiles.push({file: file, stagedDestination: stagedDestination});
      }

      // Commit subtitles first and the primary video/DVD last. If Mynda or the
      // computer stops between renames, the next scan cannot admit a video
      // whose accompanying staged files have not yet been committed.
      const auxiliary = stagedFiles.filter(entry => entry.file.role === 'subtitle');
      const regularVideo = stagedFiles.filter(entry => entry.file.role === 'video');
      for (const entry of auxiliary) {
        await assertNoSymlinkPath(watchfolder, entry.file.destination);
        await fs.promises.mkdir(path.dirname(entry.file.destination), {recursive: true});
        if (await lstatOrNull(entry.file.destination)) {
          throw shareError('SHARE_DESTINATION_CONFLICT',
            'A file appeared at an import destination.', {path: entry.file.destination});
        }
        await fs.promises.rename(entry.stagedDestination, entry.file.destination);
      }

      if (item.dvd) {
        const stagedDvd = path.join(stagingRoot, 'dvd');
        const stagedDvdStats = await lstatOrNull(stagedDvd);
        if (stagedDvdStats) {
          await assertNoSymlinkPath(watchfolder, planned.primaryDestination);
          await fs.promises.mkdir(path.dirname(planned.primaryDestination), {recursive: true});
          if (await lstatOrNull(planned.primaryDestination)) {
            throw shareError('SHARE_DESTINATION_CONFLICT',
              'A DVD folder appeared at an import destination.', {path: planned.primaryDestination});
          }
          await fs.promises.rename(stagedDvd, planned.primaryDestination);
        }
      } else {
        for (const entry of regularVideo) {
          await assertNoSymlinkPath(watchfolder, entry.file.destination);
          await fs.promises.mkdir(path.dirname(entry.file.destination), {recursive: true});
          if (await lstatOrNull(entry.file.destination)) {
            throw shareError('SHARE_DESTINATION_CONFLICT',
              'A video appeared at an import destination.', {path: entry.file.destination});
          }
          await fs.promises.rename(entry.stagedDestination, entry.file.destination);
        }
      }
      await removePath(stagingRoot);
      return {
        copiedFiles: stagedFiles.length,
        existingFiles: existingFiles,
        copiedBytes: stagedFiles.reduce((sum, entry) => sum + entry.file.size, 0)
      };
    } catch(err) {
      try { await removePath(stagingRoot); } catch(cleanupErr) {}
      throw err;
    }
  }

  async importShare(options = {}) {
    return this._run('import', {cancelable: true}, async () => {
      const plan = this.importPlans.get(options.token);
      if (!plan) {
        throw shareError('SHARE_PLAN_EXPIRED',
          'The import plan is no longer available. Prepare the plan again.');
      }
      const manifest = await ShareManifest.readManifest(plan.directory);
      if (manifest.request.id !== plan.requestId || manifest.revision !== plan.manifestRevision) {
        throw shareError('SHARE_PLAN_STALE',
          'The Share package changed after the import plan was prepared. Prepare it again.');
      }
      for (const volume of plan.volumes) {
        const disk = await this.checkDiskSpace(volume.diskPath);
        if (disk.free < volume.requiredBytes + volume.reserveBytes) {
          throw shareError('SHARE_INSUFFICIENT_SPACE',
            'An import destination no longer has enough free space.', {
              diskPath: volume.diskPath,
              availableBytes: disk.free,
              requiredBytes: volume.requiredBytes,
              reserveBytes: volume.reserveBytes
            });
        }
      }

      let completed = 0;
      let failed = 0;
      let copiedBytes = 0;
      let copiedFiles = 0;
      let existingFiles = 0;
      let canceled = false;
      const onBytes = bytes => {
        copiedBytes += bytes;
        this._emitProgress({
          numCurrent: completed,
          numTotal: plan.items.length,
          bytesCurrent: Math.min(copiedBytes, plan.totalBytes),
          bytesTotal: plan.totalBytes
        });
      };

      for (const planned of plan.items) {
        try {
          this._throwIfCanceled();
          const result = await this._importItem(plan, planned, onBytes);
          completed++;
          copiedFiles += result.copiedFiles;
          existingFiles += result.existingFiles;
          this._emitProgress({
            numCurrent: completed,
            numTotal: plan.items.length,
            bytesCurrent: Math.min(copiedBytes, plan.totalBytes),
            bytesTotal: plan.totalBytes
          });
          this.log.info('Shared video prepared for library import', {
            videoId: planned.item.videoId,
            title: planned.item.title,
            destinationWatchfolder: planned.mapping.watchfolder,
            dvd: planned.item.dvd
          });
        } catch(err) {
          if (err.code === 'SHARE_CANCELED') {
            canceled = true;
            break;
          }
          failed++;
          this.log.error('Could not import shared video', {
            videoId: planned.item.videoId,
            title: planned.item.title,
            error: err
          });
        }
      }

      const importRecord = {
        importedAt: new Date().toISOString(),
        importingLibraryId: String(this.library.id || ''),
        status: canceled ? 'canceled' :
          (failed > 0 || plan.omissions.length > 0 ? 'partial' : 'complete'),
        readyForScan: completed,
        failedVideos: failed
      };
      try {
        manifest.imports.push(importRecord);
        manifest.revision++;
        await ShareManifest.writeManifest(plan.directory, manifest);
      } catch(err) {
        // Imported media is already safely committed. Failure to append the
        // optional history must not turn those successful copies into failures.
        this.log.warn('Could not record Share import history in the package', {error: err});
      }
      this.importPlans.delete(options.token);
      const result = {
        status: importRecord.status,
        readyForScan: completed,
        failedVideos: failed,
        omittedVideos: plan.omissions.length,
        omissionCounts: reasonCounts(plan.omissions),
        copiedFiles: copiedFiles,
        existingFiles: existingFiles,
        copiedBytes: copiedBytes,
        canceled: canceled,
        shouldScan: completed > 0
      };
      this.log.info('Share import finished', result);
      return result;
    });
  }
}

module.exports = ShareService;
module.exports.ShareServiceError = ShareServiceError;
module.exports.serializeError = serializeError;
module.exports.findContainingWatchfolder = findContainingWatchfolder;
module.exports.copyFileVerified = copyFileVerified;
