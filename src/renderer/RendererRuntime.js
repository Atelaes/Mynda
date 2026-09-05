// Shared renderer services. CommonJS caches this module, so every component
// receives the same Library instance and logger set.
const Library = require('../Library.js');
const Logger = require('../Logger.js');

const library = new Library();

const frontendLog = Logger.child('Renderer');
const libraryViewLog = Logger.child('LibraryView');
const playerLog = Logger.child('Player');
const settingsLog = Logger.child('Settings');
const editorLog = Logger.child('Editor');
const artworkLog = Logger.child('Artwork');

const placeholderImage = "../images/qmark.png";

// Most long-running status messages originate in index.js and arrive through
// Electron IPC. Batch editing is different: the renderer prepares the edited
// videos and submits one Library.replaceMediaBatch() operation, so there is no
// backend loop that can report its progress. A local DOM event lets that
// renderer-side workflow reuse MynNotify instead of creating a second progress
// UI or bouncing a message through the main process.
const LOCAL_STATUS_UPDATE_EVENT = 'mynda-local-status-update';

function sendLocalStatusUpdate(status) {
  window.dispatchEvent(new CustomEvent(LOCAL_STATUS_UPDATE_EVENT, {detail: status}));
}

function confirmationDialogIsDisabled(dialogName) {
  return Boolean(
    library.settings &&
    library.settings.preferences &&
    library.settings.preferences.override_dialogs &&
    library.settings.preferences.override_dialogs[dialogName] === true
  );
}

function disableConfirmationDialog(dialogName, log = frontendLog) {
  if (!dialogName || confirmationDialogIsDisabled(dialogName)) return;

  log.debug('User disabled a confirmation dialog', {dialog: dialogName});
  const overrideDialogs = library.settings &&
    library.settings.preferences &&
    library.settings.preferences.override_dialogs;
  const address = overrideDialogs ?
    `settings.preferences.override_dialogs.${dialogName}` :
    'settings.preferences.override_dialogs';
  const value = overrideDialogs ? true : {[dialogName]: true};
  library.replace(address, value, err => {
    if (err) {
      log.error('Could not save confirmation-dialog preference', {
        dialog: dialogName,
        error: err
      });
    }
  });
}

module.exports = {
  library,
  frontendLog,
  libraryViewLog,
  playerLog,
  settingsLog,
  editorLog,
  artworkLog,
  placeholderImage,
  LOCAL_STATUS_UPDATE_EVENT,
  sendLocalStatusUpdate,
  confirmationDialogIsDisabled,
  disableConfirmationDialog
};
