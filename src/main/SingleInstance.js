// Run before importing the main application: importing it constructs the
// authoritative Library and may initialize its on-disk state.
function startSingleInstance({app, BrowserWindow, start}) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    const window = windows.find(candidate => !candidate.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  start();
  return true;
}

module.exports = {startSingleInstance};
