'use strict';
const {contextBridge, ipcRenderer, webUtils} = require('electron');
const {createBridge} = require('./Bridge');
const libraryChannels = { 'library.snapshot':'library:snapshot', 'library.commit':'library:commit',
  'library.closeReady':'library:close-ready', 'external.open':'external:open' };
const bridge = createBridge({
  platform:process.platform,
  getPathForFile(file) {
    if (webUtils) return webUtils.getPathForFile(file);
    // Compatibility while this preparatory commit still runs on Electron 12.
    if (typeof File === 'undefined' || !(file instanceof File)) throw new TypeError('Expected a dropped file.');
    return file.path;
  },
  async invoke(method, ...args) {
    if (Object.prototype.hasOwnProperty.call(libraryChannels, method)) return ipcRenderer.invoke(libraryChannels[method], ...args);
    const response = await ipcRenderer.invoke('mynda:invoke', method, args);
    if (!response || response.ok !== true) {
      const error = new Error(response && response.error && response.error.message || 'Mynda could not complete this request.');
      error.code = response && response.error && response.error.code;
      throw error;
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
