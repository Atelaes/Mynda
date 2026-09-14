const path = require('path');
const LibraryPersistence = require('./LibraryPersistence.js');

function exportError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

function samePath(first, second, platform = process.platform) {
  if (typeof first !== 'string' || typeof second !== 'string' || !first || !second) {
    return false;
  }
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => {
    const resolved = api.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

function jsonExportPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const trimmed = filePath.trim();
  return path.extname(trimmed) ? trimmed : `${trimmed}.json`;
}

async function exportLibraryCopy(options = {}) {
  const dialog = options.dialog;
  const library = options.library;
  if (!dialog || typeof dialog.showSaveDialog !== 'function') {
    throw exportError('EXPORT_DIALOG_UNAVAILABLE', 'The library export dialog is unavailable.');
  }
  if (!library || typeof library.saveCopy !== 'function') {
    throw exportError('EXPORT_LIBRARY_UNAVAILABLE', 'The library cannot be exported right now.');
  }

  const filename = LibraryPersistence.manualBackupFilename(options.now || new Date());
  const defaultPath = typeof options.defaultDirectory === 'string' && options.defaultDirectory ?
    path.join(options.defaultDirectory, filename) : filename;
  const dialogOptions = {
    title: 'Export Mynda Library',
    buttonLabel: 'Export',
    defaultPath: defaultPath,
    filters: [{name: 'Mynda Library', extensions: ['json']}]
  };
  const result = options.parentWindow ?
    await dialog.showSaveDialog(options.parentWindow, dialogOptions) :
    await dialog.showSaveDialog(dialogOptions);

  if (!result || result.canceled || !result.filePath) {
    return {canceled: true, filePath: null};
  }

  const destination = jsonExportPath(result.filePath);
  if (samePath(destination, library.path)) {
    throw exportError(
      'EXPORT_PRIMARY_LIBRARY',
      'Choose a location other than Mynda\'s live library file.'
    );
  }

  if (typeof library.whenIdle === 'function') {
    await library.whenIdle();
  }

  try {
    library.saveCopy(destination);
  } catch(err) {
    throw exportError(
      'EXPORT_WRITE_FAILED',
      'Mynda could not write the exported library file.',
      err
    );
  }

  return {canceled: false, filePath: destination};
}

module.exports = {
  samePath,
  jsonExportPath,
  exportLibraryCopy
};
