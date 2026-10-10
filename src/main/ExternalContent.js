const fs = require('fs');
const path = require('path');
const {fileURLToPath} = require('url');
const {OPEN_EXTERNAL_CHANNEL, approvedExternalURL} = require('../platform/ExternalLinks');

function isApplicationPage(value, rendererPath) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.username || url.password || url.search) return false;
    const actual = path.resolve(fileURLToPath(url));
    const expected = path.resolve(rendererPath);
    // macOS /var and /private/var can refer to the same temporary application.
    // Electron's filesystem also resolves paths inside a packaged ASAR.
    return actual === expected || fs.realpathSync(actual) === fs.realpathSync(expected);
  } catch (_) { return false; }
}

function installExternalContentPolicy({ipcMain, shell, rendererPath, log}) {
  const protectedContents = new WeakSet();
  const protectedSessions = new WeakSet();
  const warn = (message, details = {}) => { if (log) log.warn(message, details); };

  function trustedSender(event) {
    try {
      const sender = event.sender;
      return protectedContents.has(sender) && !sender.isDestroyed() &&
        event.senderFrame === sender.mainFrame &&
        isApplicationPage(sender.getURL(), rendererPath) &&
        isApplicationPage(event.senderFrame.url, rendererPath);
    } catch (_) { return false; }
  }

  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (event, requestedURL) => {
    const url = approvedExternalURL(requestedURL);
    if (!trustedSender(event) || !url) {
      warn('Rejected an external-link request');
      return {ok: false, message: 'This link is not an approved Mynda destination.'};
    }
    try {
      await shell.openExternal(url);
      return {ok: true};
    } catch (error) {
      warn('Could not open an external link in the default browser', {error});
      return {ok: false, message: 'Mynda could not open the link in your default browser.'};
    }
  });

  function protectWindow(window) {
    const contents = window.webContents;
    if (protectedContents.has(contents)) return;
    protectedContents.add(contents);
    contents.once('destroyed', () => protectedContents.delete(contents));
    const block = action => event => {
      event.preventDefault();
      warn(`Blocked ${action} in the Mynda window`);
    };
    // The application loads its own entry point using loadFile. Page-driven
    // navigation, redirects and popups must never turn this privileged window
    // into a browser. Only an explicit UI link uses the validated IPC above.
    contents.on('will-navigate', block('page navigation'));
    contents.on('will-redirect', block('a navigation redirect'));
    contents.setWindowOpenHandler(() => ({action: 'deny'}));
    // Electron 12's default window.open implementation also uses this event.
    contents.on('new-window', block('a popup'));
    contents.on('will-attach-webview', block('an embedded webview'));

    const session = contents.session;
    if (!protectedSessions.has(session)) {
      protectedSessions.add(session);
      // MPV is a separate native player; Mynda's web interface needs no camera,
      // microphone, location, notifications, fullscreen or protocol permissions.
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    }
  }

  return {protectWindow};
}

module.exports = {installExternalContentPolicy, isApplicationPage};
