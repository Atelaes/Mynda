'use strict';
const _ = require('lodash');
const {v4: uuidv4} = require('uuid');
const Operations = require('./LibraryProtocol');
const commands = require('./LibraryClientCommands');

class LibraryClient {
  constructor({api, log, initialData, onSaved, onSavedBatch}) {
    this.env = 'browser';
    this.api = api;
    this.onSaved = onSaved;
    this.onSavedBatch = onSavedBatch;
    this.log = log;
    this._data = Operations.deepFreeze(_.cloneDeep(initialData));
    for (const key of Object.keys(initialData)) Object.defineProperty(this, key, {enumerable: true, get: () => this._data[key]});
    this.session = null;
    this.revision = -1;
    this.pending = new Set();
    this.listeners = new Set();
    this.requestNumber = 0;
    this.clientId = uuidv4();
    this.beforeClose = new Set();
    this.delivery = Promise.resolve();
    this.resync = null;
    this.closing = false;
    this.api.onCommitted(message => {
      this.receive(message).catch(error => this.log.error('Could not synchronize library', {error}));
    });
    this.api.onCloseCanceled(() => { this.closing = false; this.closeToken = null; });
    this.api.onPrepareClose(request => {
      this.prepareForClose(request).catch(error => this.log.error('Could not prepare library shutdown', {error}));
    });
    this.ready = this.refresh();
    this.ready.catch(error => this.log.error('Could not load the library from the backend', {error}));
  }
  refresh() {
    if (this.resync) return this.resync;
    this.resync = Promise.resolve().then(() => this.api.snapshot()).then(snapshot => {
      if (snapshot.error) throw Object.assign(new Error(snapshot.error.message), snapshot.error);
      if (snapshot.session !== this.session || snapshot.revision >= this.revision) {
        this._data = Operations.deepFreeze(_.cloneDeep(snapshot.data));
        Object.assign(this, snapshot.paths);
        this.session = snapshot.session;
        this.revision = snapshot.revision;
        this.notify(['media', 'inactive_media', 'settings', 'playlists', 'recently_watched']);
      }
      return this;
    }).finally(() => { this.resync = null; });
    return this.resync;
  }
  onBeforeClose(handler) { this.beforeClose.add(handler); return () => this.beforeClose.delete(handler); }
  async prepareForClose(request) {
    let failure;
    this.closing = false;
    this.closeToken = request.token;
    try {
      for (const handler of this.beforeClose) await handler();
      if (this.closeToken !== request.token) return;
      await this.whenIdle();
      if (this.closeToken !== request.token) return;
      this.closing = true;
    } catch (error) { failure = {message: error.message, code: error.code}; }
    if (this.closeToken !== request.token) return;
    await this.api.closeReady({token: request.token, error: failure});
  }
  receive(message) {
    if (!this.diagnostics?.isEnabled()) {
      const delivery = this.delivery.then(() => this.acceptMessage(message));
      this.delivery = delivery.catch(() => {});
      return delivery;
    }
    const received = this.diagnostics?.receive(message);
    const delivery = this.delivery.then(() => {
      const start = this.diagnostics?.beginDelivery(received);
      return this.acceptMessage(message).then(result => {
        this.diagnostics?.applied(start,this.revision);
        return result;
      });
    });
    this.delivery = delivery.catch(() => {});
    return delivery;
  }
  async acceptMessage(message) {
    if (!message || message.error) throw Object.assign(new Error(message && message.error && message.error.message || 'Invalid library response.'), message && message.error);
    if (message.session === this.session && message.revision <= this.revision) return;
    if (message.session !== this.session || message.revision !== this.revision + 1) {
      await this.refresh();
      // An existing snapshot request may have captured state before this commit.
      if (message.session === this.session && message.revision > this.revision + 1) await this.refresh();
      if (message.session !== this.session || message.revision <= this.revision) return;
      if (message.revision !== this.revision + 1) throw Operations.failure('LIBRARY_REVISION_GAP', 'The library must be refreshed before editing.');
    }
    this._data = Operations.applyDelta(this._data, message.delta);
    this.revision = message.revision;
    this.notify(message.addresses || []);
  }
  notify(addresses) {
    // The root view consumes the complete committed snapshot once. Keep the
    // individual notifications for consumers that need specific record changes.
    try {
      if (this.onSavedBatch && addresses.length) this.onSavedBatch(addresses);
    } catch (error) { this.log.error('Library display refresh failed after commit', {error}); }
    for (const address of addresses) {
      try {
        if (this.onSaved) this.onSaved(address);
        for (const listener of this.listeners) listener(address);
      } catch (error) { this.log.error('Library display refresh failed after commit', {error}); }
    }
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  transaction(operations, callback, options = {}) {
    // Capture a detached baseline now, never after an asynchronous wait.
    let prepared, preparationError;
    try {
      if (this.closing) throw Operations.failure('LIBRARY_CLOSING', 'Mynda is closing. Cancel closing before making another edit.');
      prepared = operations.map(op => Operations.prepareOperation(this._data, op));
    }
    catch (error) { preparationError = error; }
    const requestId = `${this.clientId}:${++this.requestNumber}`;
    const promise = Promise.resolve().then(async () => {
      await this.ready;
      if (preparationError) throw preparationError;
      let response;
      try {
        response = await this.api.commit({requestId, operations: prepared,
          options: {updateUsedLists: Boolean(options.updateUsedLists)}});
      } catch (cause) {
        throw Operations.failure('LIBRARY_COMMIT_UNKNOWN', 'Mynda could not confirm this save. Reopen the library before retrying; the backend may already have saved it.', {cause});
      }
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      try { await this.receive(response); }
      catch (error) {
        error.libraryOperation = {committed: true, phase: 'display'};
        error.message = 'The changes were saved, but the interface could not refresh. Reopen the library before editing again. ' + error.message;
        throw error;
      }
      return response;
    });
    this.pending.add(promise);
    promise.then(result => {
      this.pending.delete(promise);
      if (callback) { try { callback(null, result); } catch (error) { this.log.error('Library save callback failed', {error}); } }
    }, error => {
      this.pending.delete(promise);
      if (callback) { try { callback(error); } catch (callbackError) { this.log.error('Library error callback failed', {error: callbackError}); } }
      else this.log.error('Library save failed', {error});
    });
    return promise;
  }
  async whenIdle() {
    // Caller callbacks may submit another ready change (for example playback position).
    while (this.pending.size) { await Promise.all([...this.pending]); await Promise.resolve(); }
  }
  getSaveObject() { return this._data; }
  save() { throw Operations.failure('LIBRARY_READ_ONLY', 'Only the backend can write the library.'); }
  saveCopy() { throw Operations.failure('LIBRARY_READ_ONLY', 'Export the library through the backend.'); }
}
Object.assign(LibraryClient.prototype, commands);
module.exports = LibraryClient;
