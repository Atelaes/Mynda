'use strict';

// Native desktop operations behind the renderer bridge. The caller identity
// has already been checked by RendererBridge; grants here additionally bind
// filesystem work to a particular window and a directory approved by a user.
const fs = require('fs');
const path = require('path');
const LibraryExport = require('../library/LibraryExport');
const ShareService = require('../sharing/ShareService');

function failure(code, message) { return Object.assign(new Error(message), {code}); }
function text(value, name, maximum = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw failure('INVALID_APP_REQUEST', `Invalid ${name}.`);
  }
  return value;
}
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw failure('INVALID_APP_REQUEST', 'Invalid desktop operation options.');
  }
  return value;
}
function absolute(value) {
  text(value, 'file path');
  if (!path.isAbsolute(value)) throw failure('INVALID_APP_REQUEST', 'Choose an absolute directory path.');
  return path.resolve(value);
}
function identity(filename) {
  const real = fs.realpathSync(filename), stat = fs.statSync(real);
  return {path: real, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory()};
}
function sameIdentity(first, second) {
  return first.path === second.path && first.dev === second.dev && first.ino === second.ino;
}

function createDesktopService({app, dialog, shell, library, getWindow = () => null,
  scan = () => {}, removeWatchfolder, shareService,
  confirmationDialogIsDisabled = () => false, disableConfirmationDialog = () => {},
  log = console, shareLog = log, scanLog = log}) {
  const owners = new Map();
  function scope(event) {
    const owner = event.sender.id;
    if (!owners.has(owner)) owners.set(owner, {disposed: false, folders: new Map(), exports: new Map(), plans: new Map()});
    const state = owners.get(owner);
    alive(event, state);
    return state;
  }
  function alive(event, state) {
    if (state.disposed || event.sender.isDestroyed && event.sender.isDestroyed()) {
      throw failure('APP_UNAUTHORIZED', 'The application window is no longer available.');
    }
  }
  function notify(event, state, channel, ...args) {
    if (!state.disposed && !(event.sender.isDestroyed && event.sender.isDestroyed())) event.sender.send(channel, ...args);
  }
  async function message(event, options) {
    const parent = getWindow(event);
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }
  async function pick(event, options) {
    const parent = getWindow(event);
    return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
  }
  function grant(state, purpose, directory) {
    const selected = absolute(directory), record = identity(selected);
    if (!record.directory) throw failure('INVALID_SHARE_DIRECTORY', 'The selected path is not a directory.');
    state.folders.set(`${purpose}:${selected}`, record);
    return selected;
  }
  async function approvedDirectory(event, state, purpose, value) {
    const directory = absolute(value), current = identity(directory);
    if (!current.directory) throw failure('INVALID_SHARE_DIRECTORY', 'The selected path is not a directory.');
    const key = `${purpose}:${directory}`, previous = state.folders.get(key);
    if (previous) {
      if (!sameIdentity(previous, current)) throw failure('DIRECTORY_CHANGED', 'This directory changed since it was selected. Choose it again.');
      alive(event, state);
      return directory;
    }
    const result = await message(event, {
      type: 'question', buttons: ['Cancel', 'Use Directory'], defaultId: 0, cancelId: 0,
      title: purpose === 'share' ? 'Mynda Share Directory' : 'Add Watchfolder',
      message: purpose === 'share' ? 'Allow Mynda Share to read and write this directory?' : 'Add this directory as a Mynda watchfolder?',
      detail: directory
    });
    alive(event, state);
    if (result.response !== 1) throw failure('DIRECTORY_NOT_APPROVED', 'The directory was not approved.');
    if (!sameIdentity(current, identity(directory))) throw failure('DIRECTORY_CHANGED', 'The directory changed while awaiting confirmation. Choose it again.');
    state.folders.set(key, current);
    return directory;
  }
  function video(id) {
    text(id, 'video ID', 128);
    const result = [...(library.media || []), ...(library.inactive_media || [])].find(item => item && item.id === id);
    if (!result) throw failure('VIDEO_NOT_FOUND', 'This video is no longer in the library.');
    return result;
  }
  function launchScan(reason) {
    try { Promise.resolve(scan(reason)).catch(error => log.error('Could not start a watchfolder scan', {error})); }
    catch (error) { log.error('Could not start a watchfolder scan', {error}); }
  }
  async function shareResponse(action, operation) {
    try { return {ok: true, value: await operation()}; }
    catch (error) {
      const serialized = ShareService.serializeError(error);
      shareLog.warn('Share request was not completed', {action, error: serialized});
      return {ok: false, error: serialized};
    }
  }
  async function shareOptions(event, state, value, keys) {
    const options = object(value, ['directory', ...keys]);
    const directory = await approvedDirectory(event, state, 'share', options.directory);
    return {...options, directory};
  }
  function rememberPlan(state, kind, plan, directory, destinations = []) {
    if (!plan || typeof plan.token !== 'string') throw failure('SHARE_FAILED', 'The Share plan did not include a token.');
    while (state.plans.size >= 100) state.plans.delete(state.plans.keys().next().value);
    state.plans.set(plan.token, {kind, directory, destinations});
    return plan;
  }
  async function authorizedPlan(event, state, options, kind) {
    object(options, ['token']);
    const token = text(options.token, 'Share plan token', 128), plan = state.plans.get(token);
    if (!plan || plan.kind !== kind) throw failure('SHARE_PLAN_EXPIRED', 'Review a new Share plan in this window before continuing.');
    await approvedDirectory(event, state, 'share', plan.directory);
    for (const destination of plan.destinations) {
      if (!(library.settings.watchfolders || []).some(folder => folder.path === destination.path) ||
          !sameIdentity(destination.identity, identity(destination.path))) {
        throw failure('SHARE_PLAN_STALE', 'A destination watchfolder changed. Review a new import plan.');
      }
    }
    return token;
  }

  const methods = {
    'watchfolders.choose': async event => {
      const state = scope(event), result = await pick(event, {title: 'Choose Mynda Watchfolder', properties: ['openDirectory']});
      alive(event, state);
      return result.canceled || !result.filePaths[0] ? null : grant(state, 'watchfolder', result.filePaths[0]);
    },
    'watchfolders.add': async (event, value) => {
      const state = scope(event), options = object(value, ['address', 'kind']);
      const kind = text(options.kind, 'media kind', 100).toLowerCase();
      const folder = await approvedDirectory(event, state, 'watchfolder', options.address);
      if ((library.settings.watchfolders || []).some(item => path.resolve(item.path) === folder)) {
        await message(event, {type: 'warning', buttons: ['OK'], message: 'This directory is already a watchfolder!'});
        return {added: false};
      }
      const folderObject = {path: folder, kind, videos: []};
      await new Promise((resolve, reject) => library.add('settings.watchfolders.push', folderObject,
        error => error ? reject(error) : resolve()));
      notify(event, state, 'settings-watchfolder-added', folderObject);
      launchScan('watchfolder-added');
      return {added: true};
    },
    'watchfolders.remove': async (event, requestedPath) => {
      const state = scope(event), folder = (library.settings.watchfolders || []).find(item => item.path === requestedPath);
      if (!folder) throw failure('WATCHFOLDER_NOT_FOUND', 'This watchfolder is no longer in the library.');
      const preference = 'MynSettingsFolders-confirm-remove';
      if (!confirmationDialogIsDisabled(preference)) {
        const result = await message(event, {type: 'warning', buttons: ['Cancel', 'Remove Folder'], defaultId: 0, cancelId: 0,
          checkboxLabel: "Don't show this message again",
          message: 'Remove this watchfolder from the library?',
          detail: folder.path + '\n\nVideos will be removed from the active library. Their edited information will be kept in case you add the folder again later.'});
        alive(event, state);
        if (result.response !== 1) { notify(event, state, 'settings-watchfolder-remove', folder.path, false); return {removed: false}; }
        if (result.checkboxChecked) disableConfirmationDialog(preference, scanLog);
      }
      try {
        await new Promise((resolve, reject) => removeWatchfolder(folder.path, error => error ? reject(error) : resolve()));
        notify(event, state, 'settings-watchfolder-remove', folder.path, true);
        return {removed: true};
      } catch (error) { notify(event, state, 'settings-watchfolder-remove', folder.path, false); throw error; }
    },
    'dialogs.confirmPaneExit': async (event, value) => {
      const options = object(value, ['id', 'message']);
      if (!['editor-pane', 'settings-pane', 'player-pane'].includes(options.id)) throw failure('INVALID_APP_REQUEST', 'Unknown pane.');
      return message(event, {type: 'question', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
        title: 'Close Mynda Pane', message: text(options.message, 'confirmation message', 2048), checkboxLabel: "Don't show this dialog again"});
    },
    'dialogs.confirmPlaylistDelete': async (event, value) => {
      const options = object(value, ['id', 'name']);
      text(options.id, 'playlist ID', 256);
      if (typeof options.name !== 'string' || options.name.length > 1000) throw failure('INVALID_APP_REQUEST', 'Invalid playlist name.');
      return message(event, {type: 'question', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
        message: `Are you sure you want to delete ${options.name ? `the '${options.name}' playlist` : 'this playlist'}?`,
        checkboxLabel: "Don't show this message again"});
    },
    'dialogs.confirmVideoEdit': async (event, value) => {
      const options = object(value, ['changes', 'videoID', 'showSkipDialog']);
      const current = video(options.videoID), changes = object(options.changes,
        ['title', 'year', 'seen', 'watchlater', 'new', 'position', 'ratings', 'kind', 'genre', 'series', 'season', 'episode', 'director']);
      if (!Object.keys(changes).length || JSON.stringify(changes).length > 8192 ||
          typeof options.showSkipDialog !== 'boolean') throw failure('INVALID_APP_REQUEST', 'Invalid video changes.');
      let wording;
      const keys = Object.keys(changes);
      if (keys.length === 1 && keys[0] === 'ratings') {
        const rating = changes.ratings && changes.ratings.user;
        wording = `rate ${current.title} ${rating} star${Number(rating) > 1 ? 's' : ''}?`;
      } else if (keys.length === 1 && keys[0] === 'seen') {
        wording = `mark ${current.title} as ${changes.seen ? 'seen' : 'unseen'}?`;
      } else wording = `make these changes to ${current.title}?\n\n${keys.map(key => `${key}: ${JSON.stringify(changes[key])}`).join('\n')}`;
      return message(event, {type: 'question', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
        message: 'Are you sure you want to ' + wording,
        ...(options.showSkipDialog ? {checkboxLabel: "Don't show this dialog again"} : {})});
    },
    'files.revealVideo': async (event, value) => {
      object(value, ['videoID', 'duplicatePath']);
      const current = video(value.videoID);
      let filename = current.filename;
      if (value.duplicatePath !== undefined) {
        text(value.duplicatePath, 'duplicate path');
        if (!(current.duplicates || []).includes(value.duplicatePath)) throw failure('FILE_NOT_AUTHORIZED', 'This path is not a duplicate of the selected library video.');
        filename = value.duplicatePath;
      }
      shell.showItemInFolder(absolute(filename));
      return true;
    },
    'files.revealExport': async (event, filename) => {
      const state = scope(event), selected = absolute(filename), saved = state.exports.get(selected);
      if (!saved || !sameIdentity(saved, identity(selected))) throw failure('FILE_NOT_AUTHORIZED', 'Only a library export made in this window can be revealed.');
      shell.showItemInFolder(selected);
      return true;
    },
    'library.export': async event => {
      const state = scope(event);
      try {
        let defaultDirectory = '';
        try { defaultDirectory = app.getPath('documents'); } catch (_) {}
        const result = await LibraryExport.exportLibraryCopy({dialog, library, parentWindow: getWindow(event), defaultDirectory});
        alive(event, state);
        if (!result.canceled) { state.exports.set(absolute(result.filePath), identity(result.filePath)); log.info('Library exported', {destination: result.filePath}); }
        return {ok: true, value: result};
      } catch (error) {
        log.error('Could not export library', {error});
        return {ok: false, error: {code: error.code || 'EXPORT_FAILED', message: error.message || 'Mynda could not export the library.'}};
      }
    },
    'share.chooseDirectory': async event => shareResponse('choose-directory', async () => {
      const state = scope(event), result = await pick(event, {title: 'Choose Mynda Share Directory', properties: ['openDirectory', 'createDirectory']});
      alive(event, state);
      return {directory: result.canceled || !result.filePaths[0] ? null : grant(state, 'share', result.filePaths[0])};
    }),
    'share.getState': async () => ({ok: true, value: shareService.getState()}),
    'share.inspect': async (event, value) => shareResponse('inspect', async () => {
      const options = await shareOptions(event, scope(event), value, []);
      return shareService.inspect(options.directory);
    }),
    'share.createRequest': async (event, value) => shareResponse('create-request', async () => {
      const options = await shareOptions(event, scope(event), value, ['requestedKinds', 'includeDvds', 'overwrite']);
      if (!Array.isArray(options.requestedKinds) || options.requestedKinds.length > 1000 ||
          options.requestedKinds.some(kind => typeof kind !== 'string' || kind.length > 100) ||
          typeof options.includeDvds !== 'boolean' || typeof options.overwrite !== 'boolean') throw failure('INVALID_APP_REQUEST', 'Invalid Share request options.');
      return shareService.createRequest(options);
    }),
    'share.planFulfillment': async (event, value) => shareResponse('plan-fulfillment', async () => {
      const state = scope(event), options = await shareOptions(event, state, value, ['kindMappings', 'includeDvds']);
      if (!Array.isArray(options.kindMappings) || options.kindMappings.length > 1000 || typeof options.includeDvds !== 'boolean') throw failure('INVALID_APP_REQUEST', 'Invalid fulfillment mappings.');
      options.kindMappings.forEach(mapping => {
        object(mapping, ['requestedKindId', 'sourceKinds']);
        text(mapping.requestedKindId, 'requested media kind', 256);
        if (!Array.isArray(mapping.sourceKinds) || mapping.sourceKinds.length > 1000) throw failure('INVALID_APP_REQUEST', 'Invalid source media kinds.');
        mapping.sourceKinds.forEach(kind => text(kind, 'source media kind', 100));
      });
      const plan = await shareService.planFulfillment(options);
      alive(event, state);
      return rememberPlan(state, 'fulfill', plan, options.directory);
    }),
    'share.fulfillRequest': async (event, value) => shareResponse('fulfill-request', async () => {
      const state = scope(event), token = await authorizedPlan(event, state, value, 'fulfill');
      const result = await shareService.fulfillRequest({token});
      state.plans.delete(token);
      return result;
    }),
    'share.planImport': async (event, value) => shareResponse('plan-import', async () => {
      const state = scope(event), options = await shareOptions(event, state, value, ['kindMappings']);
      if (!Array.isArray(options.kindMappings) || options.kindMappings.length > 1000) throw failure('INVALID_APP_REQUEST', 'Invalid import mappings.');
      const destinations = options.kindMappings.map(mapping => {
        object(mapping, ['requestedKindId', 'localKind', 'watchfolder']);
        text(mapping.requestedKindId, 'requested media kind', 256);
        text(mapping.localKind, 'local media kind', 100);
        if (!(library.settings.watchfolders || []).some(folder => folder.path === mapping.watchfolder)) throw failure('INVALID_IMPORT_MAPPING', 'Choose a current watchfolder for each destination.');
        return {path: mapping.watchfolder, identity: identity(mapping.watchfolder)};
      });
      const plan = await shareService.planImport(options);
      alive(event, state);
      return rememberPlan(state, 'import', plan, options.directory, destinations);
    }),
    'share.import': async (event, value) => shareResponse('import', async () => {
      const state = scope(event), token = await authorizedPlan(event, state, value, 'import');
      const result = await shareService.importShare({token});
      state.plans.delete(token);
      if (result && result.shouldScan) setImmediate(() => launchScan('share-import'));
      return result;
    }),
    'share.cancel': async () => ({ok: true, value: {cancelRequested: shareService.cancel()}})
  };
  function dispose(owner) {
    const state = owners.get(owner);
    if (state) { state.disposed = true; state.folders.clear(); state.exports.clear(); state.plans.clear(); }
    owners.delete(owner);
  }
  return {methods, dispose};
}

module.exports = {createDesktopService};
