
const electron = require('electron');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const _ = require('lodash');
const { ipcRenderer } = require('electron');
const { trackManualSubtitleEdit } = require('./SubtitleMatcher.js');

// LibraryPersistence owns file validation, atomic writes, automatic snapshots,
// retention, and preservation of damaged bytes. Keeping those mechanics out of
// this class lets a future manual-backup UI reuse them without duplicating the
// main library's save logic.
const LibraryPersistence = require('./LibraryPersistence.js');
const Logger = require('./Logger.js');

const libraryLog = Logger.child('Library');

class Library {
  constructor() {
    this.env = (electron.app) ? 'server' : 'browser';
    this.browser = null;
    if (this.env === 'server') {
      electron.ipcMain.on('lib-sync-op', (event, message) => {
        message.origin = event.sender;
        this.alter(message)
      });
      electron.ipcMain.on('lib-confirm', (event, message) => {
        this.getConfirm(message)
      });
      electron.ipcMain.on('lib-beacon', (event, message) => {
        this.browser = event.sender;
      });
    } else {
      ipcRenderer.on('lib-sync-op', (event, message) => {
        this.alter(message)
      });
      ipcRenderer.on('lib-confirm', (event, message) => {
        this.getConfirm(message)
      });
      ipcRenderer.send('lib-beacon');
    }

    // Both Electron processes construct a Library instance. They resolve the
    // same user-data paths here, while the existing IPC queue keeps their
    // in-memory copies synchronized after either side initiates an edit.
    this.dataPath = (electron.app || electron.remote.app).getPath('userData');
    this.libraryDirectory = path.join(this.dataPath, 'Library');
    this.path = path.join(this.libraryDirectory, 'library.json');
    this.artworkDirectory = path.join(this.libraryDirectory, 'Artwork');

    // Automatic restore points and preserved damaged originals are deliberately
    // separated. Retention manages Backups; it must never prune Recovery files.
    this.backupDirectory = path.join(this.libraryDirectory, 'Backups');
    this.recoveryDirectory = path.join(this.libraryDirectory, 'Recovery');

    // loadIssue remains null during an ordinary startup. load() populates it
    // only when the primary exists but cannot safely be used, which blocks all
    // normal primary saves until index.js resolves the startup dialog.
    this.loadIssue = null;

    // Each process caches the last snapshot it created. The due-check refreshes
    // from disk once this cache ages out, accounting for backups made by the
    // other Electron process.
    this.lastAutomaticBackupDate = null;
    LibraryPersistence.ensureDirectory(this.libraryDirectory);
    LibraryPersistence.ensureDirectory(this.artworkDirectory);

    // On a healthy startup this is the primary library. During recovery it is
    // the newest validated backup loaded provisionally, or a provisional empty
    // default when no backup exists. No application window opens until the user
    // accepts or declines that recovery choice in index.js.
    this.applyLibraryData(this.load());

    this.Queue = [];
    this.arrayCleanupHistory = {};
    this.waitConfirm = null;
    this.idleWaiters = [];
    // this.lastUpdate = Date.now();
  }

  // Normalize data from every entry path: ordinary primary load, automatic
  // backup recovery, and explicit empty-library creation. Centralizing this
  // prevents recovered older libraries from bypassing current migrations and
  // default-field repair.
  applyLibraryData(data) {
    Object.keys(defaultLibrary).map((key) => {
      this[key] = typeof data[key] === 'undefined' ? _.cloneDeep(defaultLibrary[key]) : data[key];
    });

    // Remove the retired per-video field from both active and inactive media.
    for (const listName of ['media', 'inactive_media']) {
      if (Array.isArray(this[listName])) {
        this[listName].forEach(video => {
          if (video && typeof video === 'object') delete video.collections;
        });
      }
    }

    // Retired or otherwise unsupported playlist views fall back to the flat view.
    if (Array.isArray(this.playlists)) {
      this.playlists.forEach(playlist => {
        if (playlist && playlist.view !== 'series') playlist.view = 'flat';
      });
    }

    // Keep only confirmation preferences that the current build supports.
    try {
      const supportedDialogs = Object.keys(defaultLibrary.settings.preferences.override_dialogs);
      this.settings.preferences.override_dialogs = _.pick(
        {
          ...defaultLibrary.settings.preferences.override_dialogs,
          ...(this.settings.preferences.override_dialogs || {})
        },
        supportedDialogs
      );
    } catch (err) {
      this.settings.preferences.override_dialogs = _.cloneDeep(defaultLibrary.settings.preferences.override_dialogs);
    }
  }

  // Prepare a full-video replacement that originated in the renderer's editor.
  // This is needed for both ordinary one-video saves and replaceMediaBatch().
  // A scan may have refreshed the video's subtitle state after the editor was
  // opened, so unrelated metadata edits must not overwrite that newer state.
  // When subtitles really were edited, record the user's additions/removals so
  // later scans know which detected files should stay ignored or manually kept.
  prepareRendererVideoReplacement(oldVideo, replacement) {
    const subtitlesWereEdited = replacement.__mynda_subtitles_edited === true;
    delete replacement.__mynda_subtitles_edited;

    if (oldVideo && subtitlesWereEdited) {
      return trackManualSubtitleEdit(oldVideo, replacement);
    }
    if (oldVideo) {
      replacement.subtitles = _.cloneDeep(oldVideo.subtitles || []);
      for (const property of [
        'detected_subtitles',
        'manual_subtitles',
        'ignored_subtitles',
        'subtitle_tracking_initialized'
      ]) {
        if (Object.prototype.hasOwnProperty.call(oldVideo, property)) {
          replacement[property] = _.cloneDeep(oldVideo[property]);
        } else {
          delete replacement[property];
        }
      }
    }
    return replacement;
  }

  // Master changing function used by add, replace, and remove.
  //opType: the type of operation (add, replace, remove)
  //address: the location of the operation
  //entry: the item to be placed, not used in remove
  //sync, whether this was prompted by counterpart library
  alter({ opType = null, address = null, entry = null, sync = false, origin = null, cb = (err) => { if (err) console.log(err) } } = {}) {
    //console.log(`alter(${opType}, ${address}, ${JSON.stringify(entry)}, ${sync}, ${origin})`);
    //let startTime = new Date();
    try {
      // A large editor batch arrives as a list of complete replacement videos,
      // not as a prebuilt media array. Resolve it only when this operation
      // reaches the front of the Library queue: earlier queued changes may have
      // altered media in the meantime, and building the array sooner could
      // accidentally overwrite them with stale data.
      //
      // Once prepared, turn the batch into one ordinary replacement of media.
      // The existing save/sync machinery below will therefore perform one
      // atomic library write and one renderer-to-backend IPC round trip.
      if (opType === 'replace-media-batch') {
        if (!Array.isArray(entry)) {
          throw 'A media batch replacement requires an array of videos.';
        }

        let updatedMedia = this.media.slice();
        let seenIDs = new Set();
        for (const suppliedVideo of entry) {
          if (!suppliedVideo || typeof suppliedVideo !== 'object' || !suppliedVideo.id) {
            throw 'Every media batch replacement requires a video with an id.';
          }
          if (seenIDs.has(suppliedVideo.id)) {
            throw `The media batch contains duplicate video id ${suppliedVideo.id}.`;
          }
          seenIDs.add(suppliedVideo.id);

          const mediaIndex = updatedMedia.findIndex(video =>
            video && video.id === suppliedVideo.id
          );
          if (mediaIndex < 0) {
            throw `Unable to find video ${suppliedVideo.id} for batch replacement.`;
          }

          let replacement = _.cloneDeep(suppliedVideo);
          if (this.env === 'browser' && !sync) {
            replacement = this.prepareRendererVideoReplacement(
              updatedMedia[mediaIndex],
              replacement
            );
          }
          updatedMedia[mediaIndex] = replacement;
        }

        opType = 'replace';
        address = 'media';
        entry = updatedMedia;
      }

      //Start with some basic validation
      if (!['add', 'replace', 'remove'].includes(opType)) {
        throw 'Unrecognized operation type.';
      } else if (['add', 'replace'].includes(opType) && typeof entry === "undefined") {
        throw 'Add or replace operations require entry';
      } else if (opType === 'remove' && entry) {
        throw 'Remove operations should not contain an entry';
      }

      // Full-video replacements made in the renderer are editor saves. Record
      // subtitle additions/removals before mirroring the replacement to the
      // backend so later scans can preserve the user's choices.
      if (this.env === 'browser' && !sync && opType === 'replace' &&
        /^media\.[^.]+$/.test(address) && entry && typeof entry === 'object') {
        const selector = address.slice('media.'.length);
        let oldVideo = null;
        if (Number.isInteger(Number(selector))) {
          oldVideo = this.media[Number(selector)];
        } else if (selector.includes('=')) {
          const components = selector.split('=');
          const property = components[0];
          const value = components.slice(1).join('=');
          oldVideo = this.media.find(video =>
            video && typeof video[property] !== 'undefined' && video[property] === value
          );
        }
        entry = this.prepareRendererVideoReplacement(oldVideo, entry);
      }

      //Get one step away from the location specified by address
      //Most operations won't work if we go all the way
      let addArr = address.split('.');
      let dest = this;
      // let addEnd = addArr[addArr.length-1];
      let addEnd = addArr.pop();
      // for (let i=0; i<addArr.length-1; i++) {
      for (let i = 0; i < addArr.length; i++) {
        dest = dest[addArr[i]];
      }

      //Figure out what we have to do and do it
      //Start with operations on an array
      //Push is used as address terminus if we're just adding to end of array
      if (Array.isArray(dest)) {
        if (addEnd === 'push') {
          switch (opType) {
            case 'add':
              dest.push(entry);
              break;
            default:
              throw "Push can only be used with add.";
          }
        } else {
          switch (opType) {
            case 'add':
              throw "Add can only be used with push.";
              // dest.splice(addEnd, 0, entry);
              break;
            case 'replace':
              // if addEnd is an integer, we take it as an index
              if (Number.isInteger(Number(addEnd))) {
                dest[addEnd] = entry;
                // otherwise, addEnd should be a string of form:
                // 'property=value' (e.g. 'id=582c8160-b185-5843-9eaf-8e71f177ae65')
                // and we'll try to find an object in dest with that prop/value pair
                // and replace it with entry
              } else if (addEnd.split('=').length > 1) {
                let components = addEnd.split('=');
                let prop = components[0];
                let val = components.slice(1).join('=');

                let found = false;
                for (let i = 0; i < dest.length; i++) {
                  if (typeof dest[i][prop] !== 'undefined' && dest[i][prop] === val) {
                    console.log(`found element to replace at index ${i}; replacing...`);
                    found = true;
                    dest[i] = entry;
                    // we could remove the break statement to replace all instances
                    // instead of just the first one
                    break;
                  }
                }
                if (!found) {
                  throw `Unable to find element (${addEnd}) to replace.`
                }

                // let results = dest.filter(el => typeof el[prop] !== 'undefined' && el[prop] === val);
                // if (results.length > 0) {
                //   console.log('found element to replace, replacing...');
                //   results[0] = entry;
                // } else {
                //   throw `Unable to find element (${addEnd}) to replace.`
                // }
              } else {
                throw 'Unable to parse address for replace operation'
              }
              break;
            case 'remove':
              // remember the array we're operating on so that once the queue is empty,
              // we can clean up any null values left after something is removed
              // the key is the address minus addEnd; this way if multiple things are
              // removed from that same array, this same key will be overwritten;
              // this is good because we only need to remember the edited array once
              // let temp = [...addArr];
              // temp.splice(-1);
              this.arrayCleanupHistory[addArr.join('.')] = dest;

              // if there are items in queue, don't remove elements,
              // because that will throw off other operations reliant on indices;
              // at the end, all the null elements will be removed
              // if (this.Queue.length > 0) {
              dest.splice(addEnd, 1, null);
            // } else {
            //   dest.splice(addEnd, 1);
            // }
          }
        }
      } else {
        //If we're not in array, then we're in an object
        switch (opType) {
          case 'add':
            if (dest[addEnd]) {
              throw 'Something already exists at that location, use replace.';
            } else {
              dest[addEnd] = entry;
            }
            break;
          case 'replace':
            // if (typeof dest[addEnd] !== "undefined") {
            dest[addEnd] = entry;
            // } else {
            //   throw 'Nothing to replace, use add.';
            // }
            break;
          case 'remove':
            delete dest[addEnd];
        }
      }

      // cleanup...
      // get rid of null placeholders in any array that we've removed something from,
      // but only if the queue is empty
      if (this.Queue.length === 0) {
        //console.log('cleaning up...');
        // console.log(JSON.stringify(this.arrayCleanupHistory));
        Object.keys(this.arrayCleanupHistory).map(key => {
          let cleaned = this.arrayCleanupHistory[key];
          if (Array.isArray(cleaned)) {
            //console.log(`cleaning ${key}`);
            cleaned = cleaned.filter(el => el !== null);
            // console.log(`Cleaned: ${JSON.stringify(cleaned)}`);

            // for some reason we have to do this part over again, I don't know...
            let destination = this;
            let map = key.split('.');
            let end = map.pop();
            map.map(loc => {
              destination = destination[loc];
            });
            // console.log(`\nBefore cleaning: ${JSON.stringify(destination[end])}\n`);
            destination[end] = _.cloneDeep(cleaned);
            // console.log(`\nAfter cleaning: ${JSON.stringify(destination[end])}\n`);
            // console.log(`\n==== WATCHFOLDERS ====\n\n\n${JSON.stringify(this.settings.watchfolders)}\n\n\n`);
            // console.log(`\n==== INACTIVE_MEDIA ====\n\n\n${JSON.stringify(this.inactive_media)}\n\n\n`);
          }
        });
        // reset it
        this.arrayCleanupHistory = {};
      }

      // save to file, communicate with partner library
      if (sync) {
        //If this was requested by other library, let them know we did it
        this.confirm({ opType: opType, address: address, entry: entry, sync: sync, origin: origin });
      } else {

        // Start by saving to file.
        this.save();

        //If this was a local operation, request other library mirror it
        this.sync({ opType: opType, address: address, entry: entry, sync: sync, origin: origin });

        // execute callback;
        cb();
      }

      // let React know that we've done a save, so that it can perform whatever re-rendering it needs to
      if (this.env === 'browser') {
        savedPing.saved(address);
      }
    } catch (e) {
      cb(`Error with library alter event.  op: ${opType}, add: ${address}, value: ${JSON.stringify(entry)}, sync: ${sync}, origin: ${origin} - ${e}`);
    }
    //let endTime = new Date();
    //let totalTime = endTime - startTime;
    //console.log(`alter( ${JSON.stringify(arguments[0])}) took ${totalTime}ms.`)

  }

  // Takes a string address in dot format, and adds "addition" to that location.
  add(address, addition, cb) {
    //console.log('adding...')
    this.addToQueue({ opType: 'add', address: address, entry: addition, sync: false, origin: null, cb: cb });
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  replace(address, replacement, cb) {
    this.addToQueue({ opType: 'replace', address: address, entry: replacement, sync: false, origin: null, cb: cb });
  }

  // Replace many editor videos as one queued operation. alter() deliberately
  // receives the individual videos rather than a whole array assembled here,
  // so it can merge them into the freshest media state when the queue reaches
  // this job. The final operation still uses the normal atomic save, IPC sync,
  // confirmation, callback, and savedPing behavior of replace('media', ...).
  replaceMediaBatch(replacements, cb) {
    this.addToQueue({
      opType: 'replace-media-batch',
      address: 'media',
      entry: replacements,
      sync: false,
      origin: null,
      cb: cb
    });
  }

  // Takes a string address in dot format, and removes whatever is there.
  remove(address, cb) {
    this.addToQueue({ opType: 'remove', address: address, entry: null, sync: false, origin: null, cb: cb });
  }

  addToQueue(argObj) {
    if (this.waitConfirm) {
      //console.log('Something already in pipeline, adding to queue...')
      this.Queue.push(argObj);
    } else {
      //console.log('Nothing in pipeline, performing operation now...')
      this.alter(argObj);
    }
  }

  // A local Library callback means that process has saved and sent its IPC
  // mirror operation; it does not mean the other Electron process has applied
  // it yet. Long-running workflows such as Auto-Tag need this stronger barrier
  // before announcing completion, otherwise the user can begin a conflicting
  // edit while an older full-library synchronization is still in flight.
  whenIdle() {
    if (!this.waitConfirm && this.Queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  resolveIdleWaiters() {
    if (this.waitConfirm || this.Queue.length > 0) return;

    const waiters = this.idleWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that a change has been made that should be mirrored.
  sync(argObj) {
    // tell partner to replicate the action.
    argObj.sync = true;
    if (this.waitConfirm) {
      console.log("Trying to create confirm, but something already at waitConfirm.");
    } else {
      this.waitConfirm = _.cloneDeep(argObj);
    }
    if (this.env === 'server') {
      try {
        //console.log('Sending a mirror request to browser');
        this.browser.send('lib-sync-op', argObj);
      } catch (err) {
        //console.log('Browser does not exist yet or did not send beacon. Continuing server operation without sending sync operation.');
        this.getConfirm(); // manually call getConfirm to proceed to the next item in queue
      }
    } else {
      //console.log('Sending a mirror request to server');
      ipcRenderer.send('lib-sync-op', argObj);
    }
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that it has received and implemented the
  // requested change.
  confirm(argObj) {
    if (this.env === 'server') {
      let origin = argObj.origin;
      argObj.origin = null;  //This is only added on syncOps received by server.
      origin.send('lib-confirm', argObj);
    } else {
      ipcRenderer.send('lib-confirm', argObj);
    }
  }

  getConfirm(argObj) {
    if (_.isEqual(argObj, this.waitConfirm)) {
      //console.log("Got a valid confirmation back, sync operation successful!")
    } else if (typeof argObj === "undefined") {
      // sync op was aborted, getConfirm was called manually by the server (from the sync() function) to move to the next queue item
    } else {
      console.log("Got a confirmation that didn't match what was expected.")
      console.log(argObj);
      console.log(this.waitConfirm);
    }

    this.waitConfirm = null;
    if (this.Queue.length > 0) {
      console.log(`${this.Queue.length} items left in queue, moving to next item...`);
      let nextOp = this.Queue.shift();
      console.log(`Next item: ${nextOp.opType} ${nextOp.address}`);
      this.alter(nextOp);
    }

    // alter(nextOp) sets waitConfirm again when it starts another outbound
    // synchronization. Only the confirmation for the final queued operation
    // reaches this point with both waitConfirm and Queue empty.
    this.resolveIdleWaiters();
  }

  // Build the serializable portion of the Library instance. IPC state, queues,
  // paths, and recovery bookkeeping are class internals and must not leak into
  // library.json or a manual library copy.
  getSaveObject() {
    let saveObj = {};
    Object.keys(defaultLibrary).map((key) => { saveObj[key] = this[key] });
    return saveObj;
  }

  // index.js asks for this after Electron becomes ready. Returning a clone lets
  // the recovery UI inspect paths and error details without mutating the state
  // that guards primary saves.
  getLoadIssue() {
    if (!this.loadIssue) return null;
    return _.cloneDeep(this.loadIssue);
  }

  // Called at startup and before ordinary primary saves. Most invocations exit
  // immediately because the last automatic snapshot is less than an hour old.
  // When due, this captures the currently committed primary—the restore point
  // immediately before the upcoming edit—and then applies tiered retention.
  maybeCreateAutomaticBackup(now = new Date()) {
    // A malformed primary must never become a restore point. While loadIssue is
    // unresolved, the only legal writes are the explicit recovery methods.
    if (this.loadIssue) return null;
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
        console.log('No library found; created a default empty library.');
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

      console.error(`Could not load ${this.path}: ${this.loadIssue.errorMessage}`);
      if (backup) {
        // "Provisionally" is important: index.js still asks the user before the
        // damaged primary is preserved and replaced on disk.
        console.log(`Provisionally loaded automatic backup ${backup.path}.`);
        return _.cloneDeep(backup.data);
      }

      // With no usable backup, defaults exist in memory only so construction can
      // finish. Primary saving remains blocked until the user explicitly opts
      // to create an empty library; choosing Quit leaves library.json untouched.
      console.error('No valid automatic library backup was available.');
      return _.cloneDeep(defaultLibrary);
    }
  }
}

const defaultLibrary = {
  "id": uuidv4(),
  "settings": {
    "watchfolders": [],
    "themes": {
      "appearances": [
        {
          "name": "Dark Theme",
          "path": "../themes/appearances/dark-theme.css",
          "dependencies": {
            "fonts": [],
            "images": []
          }
        }
      ],
      "layouts": [
        {
          "name": "Default Layout Theme",
          "path": "../themes/layouts/default-layout-theme.css",
          "dependencies": {}
        }
      ]
    },
    "preferences": {
      "defaultcolumns": {
        "used": [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused": [
          "kind",
          "lastseen",
          "watchlater",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration",
          "resolution"
        ]
      },
      "defaultdefaultcolumns": {
        "used": [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused": [
          "kind",
          "lastseen",
          "watchlater",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration",
          "resolution"
        ]
      },
      "hide_description": "show",
      "override_dialogs": {
        "MynEditorSearch-confirm-select": false,
        "MynEditor-confirm-exit": false,
        "MynEditorEdit-confirm-revert": false,
        "MynLibTable-confirm-inlineEdit": false
      },
      "include_user_rating_in_avg": false,
      "include_new_vids_in_playlists": true,
      "remove_autotagged_from_new": true
    },
    "used": {
      "kinds": [
        "movie",
        "show"
      ],
      "genres": [],
      "tags": []
    }
  },
  "playlists": [
    {
      "id": "new",
      "name": "New",
      "filter_function": "video.new === true",
      "view": "flat",
      "tab": true,
      "flatDefaultSort": "dateadded",
      "columns": [
        "title",
        "dateadded",
        "seen",
        "ratings_user"
      ]
    },
    {
      "id": "1",
      "name": "Movies",
      "filter_function": "video.kind === 'movie'",
      "view": "flat",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "watchlater",
        "ratings_user",
        "dateadded"
      ]
    },
    {
      "id": "2",
      "name": "Shows",
      "filter_function": "video.kind === 'show'",
      "view": "series",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "watchlater",
        "ratings_user",
        "dateadded"
      ]
    },
    {
      "id": "3",
      "name": "♥",
      "filter_function": "video.watchlater === true",
      "view": "flat",
      "tab": true,
      "columns": [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "ratings_user",
        "dateadded"
      ]
    }
  ],
  "recently_watched": [],
  "media": [],
  "object_media": {},
  "inactive_media": []
};

// expose the class
module.exports = Library;
