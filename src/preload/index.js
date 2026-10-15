'use strict';
const {contextBridge, ipcRenderer, webUtils} = require('electron');
const {createBridge} = require('./Bridge');
const libraryChannels = { 'library.snapshot':'library:snapshot', 'library.commit':'library:commit',
  'library.closeReady':'library:close-ready', 'external.open':'external:open' };
const bridge = createBridge({
  platform:process.platform,
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  async invoke(method, ...args) {
    if (Object.prototype.hasOwnProperty.call(libraryChannels, method)) return ipcRenderer.invoke(libraryChannels[method], ...args);
    const response = await ipcRenderer.invoke('mynda:invoke', method, args);
    if (!response || response.ok !== true) {
      // contextBridge copies native Error objects without custom properties.
      // Reject with the main process's small, plain error contract so `code`
      // survives in the page (activation and other actionable failures use it).
      throw Object.freeze({
        code:response && response.error && response.error.code || 'APP_REQUEST_FAILED',
        message:response && response.error && response.error.message || 'Mynda could not complete this request.'
      });
    }
    return response.value;
  },
  subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('A notification callback is required.');
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
contextBridge.exposeInMainWorld('mynda', bridge);
