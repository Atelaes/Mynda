
'use strict';
const electron = require('electron');
const fs = require('fs');
const path = require('path');
const {fileURLToPath} = require('url');
const {v4: uuidv4} = require('uuid');
const _ = require('lodash');
const {normalizeDuplicatePaths} = require('./LibraryDuplicates');
const VideoIdentity = require('./VideoIdentity');
const LibraryPersistence = require('./LibraryPersistence.js');
const Operations = require('./LibraryOperations');
const defaultLibrary = require('./LibraryDefaults');
const commands = require('./LibraryCommands');
const libraryLog = require('../platform/Logger.js').child('Library');

function normalizeLibraryData(data) {
  const library = {};

    Object.keys(defaultLibrary).map((key) => {
      library[key] = typeof data[key] === 'undefined' ? _.cloneDeep(defaultLibrary[key]) : data[key];
    });
    // Missing scheme means a legacy library, never a freshly fingerprinted
    // library. Conversion is an explicit offline operation, not a default.
    library.videoIdScheme = data.videoIdScheme === undefined ? 1 : data.videoIdScheme;

    // Existing libraries predate some preference fields. Add new preferences
    // individually so a user's explicit false value is preserved, while a
    // missing or malformed value receives the current default.
    if (!library.settings || typeof library.settings !== 'object' || Array.isArray(library.settings)) {
      library.settings = _.cloneDeep(defaultLibrary.settings);
    }
    if (!library.settings.preferences ||
        typeof library.settings.preferences !== 'object' ||
        Array.isArray(library.settings.preferences)) {
      library.settings.preferences = _.cloneDeep(defaultLibrary.settings.preferences);
    }
    for (const preferenceName of [
      'remove_edited_from_new',
      'exclude_samples_from_library',
      'exclude_trailers_from_library'
    ]) {
      if (typeof library.settings.preferences[preferenceName] !== 'boolean') {
        library.settings.preferences[preferenceName] =
          defaultLibrary.settings.preferences[preferenceName];
      }
    }

    // Remove the retired per-video field and add current universal fields to
    // every active and inactive video. Non-show videos retain an empty parent
    // series ID, while duplicate paths are normalized and cannot include the
    // selected library copy itself.
    for (const listName of ['media', 'inactive_media']) {
      if (Array.isArray(library[listName])) {
        library[listName].forEach(video => {
          if (!video || typeof video !== 'object') return;
          delete video.collections;
          video.seriesImdbID = video.kind === 'show' &&
            typeof video.seriesImdbID === 'string' ? video.seriesImdbID : '';
          video.duplicates = normalizeDuplicatePaths(video.duplicates, video.filename);
        });
      }
    }

    // Retired or otherwise unsupported playlist views fall back to the flat view.
    if (Array.isArray(library.playlists)) {
      library.playlists.forEach(playlist => {
        if (playlist && playlist.view !== 'series') playlist.view = 'flat';
      });
    }

    // Keep only confirmation preferences that the current build supports.
    try {
      const supportedDialogs = Object.keys(defaultLibrary.settings.preferences.override_dialogs);
      library.settings.preferences.override_dialogs = _.pick(
        {
          ...defaultLibrary.settings.preferences.override_dialogs,
          ...(library.settings.preferences.override_dialogs || {})
        },
        supportedDialogs
      );
    } catch (err) {
      library.settings.preferences.override_dialogs = _.cloneDeep(defaultLibrary.settings.preferences.override_dialogs);
    }

  return library;
}
function errorPayload(error) {
  return {message: error.message, code: error.code, address: error.address, id: error.id,
    libraryPath: error.libraryPath, libraryOperation: error.libraryOperation};
}
class Library {
  constructor({authorizeRenderer, validateRendererCommit} = {}) {
    this.authorizeRenderer = authorizeRenderer;
    this.validateRendererCommit = validateRendererCommit;
    this.env = 'server';
    this.dataPath = electron.app.getPath('userData');
    this.libraryDirectory = path.join(this.dataPath, 'Library');
    this.path = path.join(this.libraryDirectory, 'library.json');
    this.artworkDirectory = path.join(this.libraryDirectory, 'Artwork');
    this.backupDirectory = path.join(this.libraryDirectory, 'Backups');
    this.recoveryDirectory = path.join(this.libraryDirectory, 'Recovery');
    this.loadIssue = null;
    this.lastAutomaticBackupDate = null;
    this.session = uuidv4();
    this.revision = 0;
    this.queue = [];
    this.running = false;
    this.scheduled = false;
    this.foregroundStreak = 0;
    this.idleWaiters = [];
    this.renderers = new Set();
    this.requests = new Map();
    this.stopping = false;
    LibraryPersistence.ensureDirectory(this.libraryDirectory);
    LibraryPersistence.ensureDirectory(this.artworkDirectory);
    this.applyLibraryData(this.load());
    for (const key of Object.keys(defaultLibrary)) Object.defineProperty(this, key, {enumerable: true, get: () => this._data[key]});
    if (typeof electron.ipcMain.handle === 'function') {
      electron.ipcMain.handle('library:snapshot', event => {
        this.validateSender(event);
        this.renderers.add(event.sender);
        return this.snapshot();
      });
      electron.ipcMain.handle('library:commit', async (event, request) => {
        try {
          this.validateSender(event);
          if (!request || typeof request.requestId !== 'string' || request.requestId.length > 200) throw Operations.failure('INVALID_LIBRARY_OPERATION', 'A request identifier is required.');
          const key = `${event.sender.id}:${request.requestId}`;
          if (!this.requests.has(key)) {
            if (this.validateRendererCommit) this.validateRendererCommit(request,event);
            const promise = this.enqueue(request.operations, {actor: 'renderer', priority: 'user',
              updateUsedLists: Boolean(request.options && request.options.updateUsedLists), requestId: request.requestId});
            this.requests.set(key, promise);
            promise.then(() => this.trimRequests(), () => this.trimRequests());
          }
          return await this.requests.get(key);
        } catch (error) { return {error: errorPayload(error)}; }
      });
    }
  }
  validateSender(event) {
    if (this.authorizeRenderer) {
      if (!this.authorizeRenderer(event)) throw Operations.failure('LIBRARY_UNAUTHORIZED', 'Library access is limited to the application window.');
      return;
    }
    const sender = event && event.sender;
    let valid = false;
    try {
      if (sender && typeof sender.getURL === 'function') {
        const actual = path.resolve(fileURLToPath(sender.getURL()));
        const expected = path.resolve(__dirname, '../renderer/index.html');
        // CommonJS resolves directory symlinks, but loadFile keeps the launch
        // path. macOS /var and /private/var can therefore name this same file.
        // Electron's fs also canonicalizes paths within an ASAR archive.
        valid = actual === expected || fs.realpathSync(actual) === fs.realpathSync(expected);
      }
    } catch (_) {}
    if (!valid || !event.senderFrame || event.senderFrame !== sender.mainFrame ||
        (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
      throw Operations.failure('LIBRARY_UNAUTHORIZED', 'Library access is limited to the application window.');
    }
  }
  trimRequests() {
    // Completed request IDs allow reconnect/repeated delivery without a second write.
    while (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value);
  }
  snapshot() {
    return {session: this.session, revision: this.revision, data: this._data,
      paths: {dataPath: this.dataPath, libraryDirectory: this.libraryDirectory, path: this.path,
        artworkDirectory: this.artworkDirectory, backupDirectory: this.backupDirectory, recoveryDirectory: this.recoveryDirectory}};
  }
  applyLibraryData(data) { this._data = Operations.deepFreeze(normalizeLibraryData(_.cloneDeep(data))); }
  getSaveObject() { return this._data; }
  transaction(operations, callback, options = {}) {
    let prepared;
    try { prepared = operations.map(op => Operations.prepareOperation(this._data, op)); }
    catch (error) {
      const failed = Promise.reject(error);
      failed.catch(err => { if (callback) callback(err); else libraryLog.error('Library command rejected', {error: err}); });
      return failed;
    }
    const promise = this.enqueue(prepared, {...options, actor: 'backend'});
    promise.then(result => {
      if (callback) { try { callback(null, result); } catch (error) { libraryLog.error('Library save callback failed after commit', {error}); } }
    }, error => {
      if (callback) { try { callback(error); } catch (callbackError) { libraryLog.error('Library failure callback failed', {error: callbackError}); } }
      else libraryLog.error('Library operation failed', {error});
    });
    return promise;
  }
  stopBackgroundWrites() { this.stopping = true; }
  resumeWrites() { this.stopping = false; }
  enqueue(operations, options = {}) {
    return new Promise((resolve, reject) => {
      if (this.stopping && options.priority === 'background') {
        reject(Operations.failure('LIBRARY_CLOSING', 'Mynda is closing; no new background save was accepted.'));
        return;
      }
      this.queue.push({operations: _.cloneDeep(operations), options: {...options}, resolve, reject});
      this.schedule();
    });
  }
  schedule() {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.drainOne(); });
  }
  drainOne() {
    if (this.running || !this.queue.length) { this.resolveIdle(); return; }
    let index = this.queue.findIndex(job => job.options.priority !== 'background');
    const background = this.queue.findIndex(job => job.options.priority === 'background');
    if (index < 0 || (this.foregroundStreak >= 8 && background >= 0)) index = background >= 0 ? background : 0;
    const job = this.queue.splice(index, 1)[0];
    this.foregroundStreak = job.options.priority === 'background' ? 0 : this.foregroundStreak + 1;
    this.running = true;
    let committed = false;
    try {
      const before = this._data;
      const outcome = Operations.applyOperations(before, job.operations, job.options);
      VideoIdentity.assertLibraryIdentity(outcome.data);
      if (this.loadIssue) throw new Error('Refusing to overwrite an unreadable library before recovery is resolved.');
      let delta = {sections: {}, records: {}};
      if (outcome.data !== before) {
        const candidate = Operations.deepFreeze(outcome.data);
        delta = Operations.makeDelta(before, candidate);
        this.maybeCreateAutomaticBackup();
        LibraryPersistence.writeLibraryFile(this.path, candidate);
        committed = true;
        this._data = candidate;
        this.revision++;
      }
      const response = {session: this.session, revision: this.revision, delta, addresses: outcome.addresses,
        requestId: job.options.requestId, skipped: outcome.skipped, conflicts: outcome.skipped};
      if (committed) {
        for (const renderer of this.renderers) {
          try {
            if (renderer.isDestroyed && renderer.isDestroyed()) { this.renderers.delete(renderer); continue; }
            renderer.send('library:committed', response);
          } catch (error) { this.renderers.delete(renderer); try { libraryLog.warn('Renderer disconnected after library commit', {error}); } catch (_) {} }
        }
      }
      job.resolve(response);
    } catch (error) {
      error.libraryPath = this.path;
      error.libraryOperation = {phase: committed ? 'publish' : 'commit', committed};
      job.reject(error);
    } finally {
      this.running = false;
      if (this.queue.length) this.schedule();
      else this.resolveIdle();
    }
  }
  whenIdle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  resolveIdle() {
    if (this.running || this.queue.length) return;
    this.idleWaiters.splice(0).forEach(resolve => resolve());
  }
  // index.js asks for this after Electron becomes ready. Returning a clone lets
  // the recovery UI inspect paths and error details without mutating the state
  // that guards primary saves.
  getLoadIssue() {
    if (!this.loadIssue) return null;
    return _.cloneDeep(this.loadIssue);
  }

  getIdentityIssue() {
    return VideoIdentity.libraryIdentityIssue(this);
  }

  // Called at startup and before ordinary primary saves. Most invocations exit
  // immediately because the last automatic snapshot is less than an hour old.
  // When due, this captures the currently committed primary—the restore point
  // immediately before the upcoming edit—and then applies tiered retention.
  maybeCreateAutomaticBackup(now = new Date()) {
    // A malformed primary must never become a restore point. While loadIssue is
    // unresolved, the only legal writes are the explicit recovery methods.
    if (this.loadIssue || this.getIdentityIssue()) return null;
    if (!LibraryPersistence.automaticBackupIsDue(
      this.backupDirectory,
      now,
      this.lastAutomaticBackupDate
    )) {
      return null;
    }

    try {
      const backup = LibraryPersistence.createAutomaticBackup(
        this.path,
        this.backupDirectory,
        now
      );
      this.lastAutomaticBackupDate = backup.date;
      libraryLog.info('Automatic library backup created', {
        backupPath: backup.path,
        retainedBackups: backup.retainedCount,
        prunedBackups: backup.removedCount
      });
      return backup;
    } catch(err) {
      // Atomic primary saving can still proceed if an automatic snapshot fails.
      // Report the failure prominently so the user does not unknowingly remain
      // without the intended backup protection.
      libraryLog.error('Could not create automatic library backup', {
        libraryPath: this.path,
        backupDirectory: this.backupDirectory,
        error: err && err.stack ? err.stack : String(err)
      });
      return null;
    }
  }

  // Save either the live library or a standalone copy. Both paths use the same
  // validated atomic writer, which is also the foundation for a future manual
  // "Back Up Library" command.
  save(loc = this.path, options = {}) {
    const isPrimarySave = path.resolve(loc) === path.resolve(this.path);

    // This guard is reached if some ordinary edit or scan attempts to save
    // before the startup recovery dialog has resolved. Refusing the operation
    // is safer than silently replacing the user's unreadable evidence file.
    if (isPrimarySave && this.loadIssue && !options.recoveryWrite) {
      throw new Error('Refusing to overwrite an unreadable library before recovery is resolved.');
    }
    VideoIdentity.assertLibraryIdentity(this);

    // Automatic snapshots belong only to the live primary. Exports, future
    // manual backups, and recovery commits use the same atomic writer without
    // entering automatic retention.
    if (isPrimarySave && options.automaticBackup !== false) {
      this.maybeCreateAutomaticBackup();
    }

    try {
      // writeLibraryFile validates the object, writes a flushed sibling temp
      // file, and atomically renames it over the destination.
      LibraryPersistence.writeLibraryFile(loc, this.getSaveObject());
      return loc;
    } catch(err) {
      libraryLog.error('Could not save library file', {
        libraryPath: loc,
        error: err && err.stack ? err.stack : String(err)
      });
      throw err;
    }
  }

  // Reserved for the later user-initiated backup feature. The caller supplies
  // a path chosen by the user; the resulting file is validated and atomic but
  // is not placed in, or pruned by, the automatic Backups directory.
  saveCopy(loc) {
    return this.save(loc, {automaticBackup: false});
  }

  // Used immediately before either recovery action replaces library.json. The
  // original bytes go to Recovery even if they are not parseable JSON.
  preserveUnreadableLibrary() {
    return LibraryPersistence.preserveDamagedLibrary(
      this.path,
      this.recoveryDirectory
    );
  }

  // Reached when startup found a valid automatic backup and the user clicked
  // "Restore Backup." load() already placed that backup into memory and
  // applyLibraryData() already ran current migrations, so this method preserves
  // the damaged primary and atomically commits the prepared in-memory library.
  restoreLatestAutomaticBackup() {
    if (!this.loadIssue || !this.loadIssue.latestBackupPath) {
      throw new Error('No validated automatic library backup is available to restore.');
    }
    VideoIdentity.assertLibraryIdentity(this);

    // Preserve first. If preservation itself fails, the unreadable primary is
    // left untouched and the caller reports that recovery could not proceed.
    const issue = this.loadIssue;
    const preservedPath = this.preserveUnreadableLibrary();
    this.loadIssue = null;
    try {
      // applyLibraryData() already migrated the validated backup loaded during
      // construction, so save that current in-memory form as the new primary.
      this.save(this.path, {automaticBackup: false, recoveryWrite: true});
    } catch(err) {
      // Reinstate the guard so no later code can mistake this failed recovery
      // attempt for a healthy, writable library.
      this.loadIssue = issue;
      throw err;
    }

    return {
      restoredBackupPath: issue.latestBackupPath,
      restoredBackupDate: issue.latestBackupDate,
      preservedLibraryPath: preservedPath
    };
  }

  // Reached only when no valid automatic backup exists and the user explicitly
  // chooses "Create Empty Library." This is never the default action. The
  // damaged source is preserved before defaults replace the provisional state.
  createEmptyLibraryAfterLoadFailure() {
    if (!this.loadIssue) {
      throw new Error('The library does not have an unresolved load failure.');
    }

    const issue = this.loadIssue;
    const preservedPath = this.preserveUnreadableLibrary();
    this.applyLibraryData(_.cloneDeep(defaultLibrary));
    this.loadIssue = null;
    try {
      this.save(this.path, {automaticBackup: false, recoveryWrite: true});
    } catch(err) {
      // As above, a failed atomic commit restores the unresolved-failure flag;
      // index.js will alert the user and quit rather than opening the app.
      this.loadIssue = issue;
      throw err;
    }
    return {preservedLibraryPath: preservedPath};
  }

  // Load failures never overwrite library.json. If possible, use the newest
  // validated automatic backup provisionally; index.js asks the user whether
  // to commit that recovery before creating the application window.
  load() {
    try {
      // The overwhelmingly common path: parse and structurally validate the
      // live primary before exposing any of its contents to the application.
      return LibraryPersistence.readLibraryFile(this.path).data;
    } catch(error) {
      // ENOENT is expected on the very first launch. It is not corruption, so
      // create a validated empty primary without presenting a recovery dialog.
      if (error && error.code === 'ENOENT') {
        const newLibrary = _.cloneDeep(defaultLibrary);
        LibraryPersistence.writeLibraryFile(this.path, newLibrary);
        libraryLog.info('No library file was found; created a default empty library', {
          path: this.path
        });
        return newLibrary;
      }

      // Any other read/parse/validation failure is treated as a recovery event.
      // Search newest-first for a valid automatic snapshot, but do not alter
      // the primary merely because a candidate was found.
      let backupSearch = {
        backup: null,
        candidateCount: 0,
        invalidNewerCount: 0
      };
      let backupSearchError = '';
      try {
        backupSearch = LibraryPersistence.findLatestValidAutomaticBackup(this.backupDirectory);
      } catch(backupError) {
        backupSearchError = backupError && backupError.message ? backupError.message : String(backupError);
      }

      const backup = backupSearch.backup;

      // Store only compact UI/logging metadata here. The selected backup's data
      // is returned below and becomes ordinary in-memory Library fields.
      this.loadIssue = {
        type: error && error.code === 'INVALID_LIBRARY' ? 'malformed' : 'unreadable',
        libraryPath: this.path,
        errorCode: error && error.code ? error.code : '',
        errorMessage: error && error.message ? error.message : String(error),
        latestBackupPath: backup ? backup.path : '',
        latestBackupDate: backup ? backup.date.toISOString() : '',
        backupCandidateCount: backupSearch.candidateCount,
        invalidNewerBackups: backupSearch.invalidNewerCount,
        backupSearchError: backupSearchError
      };

      libraryLog.error('Could not load the primary library', this.loadIssue);
      if (backup) {
        // "Provisionally" is important: index.js still asks the user before the
        // damaged primary is preserved and replaced on disk.
        libraryLog.warn('Provisionally loaded an automatic library backup', {
          backupPath: backup.path,
          backupDate: backup.date
        });
        return _.cloneDeep(backup.data);
      }

      // With no usable backup, defaults exist in memory only so construction can
      // finish. Primary saving remains blocked until the user explicitly opts
      // to create an empty library; choosing Quit leaves library.json untouched.
      libraryLog.error('No valid automatic library backup was available', this.loadIssue);
      return _.cloneDeep(defaultLibrary);
    }
  }
}
Object.assign(Library.prototype, commands);


// expose the class
module.exports = Library;
