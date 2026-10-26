// Create a genuine disk-backed DOM File through Chromium's test driver. The
// application still uses its production preload, approval and editor save.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {browserDriver, wait} = require('./BrowserDriver');

async function inspectArtworkDrop({app, dialog, window, videoId, userData, library}) {
  const source = path.join(userData, 'electron44-drop.png');
  fs.copyFileSync(path.join(app.getAppPath(), 'images', 'mynda-icon.png'), source);
  const canonical = fs.realpathSync(source);
  const ui = browserDriver(window), contents = window.webContents;
  const resolveArtwork = value => path.isAbsolute(value) ? value : path.join(library.artworkDirectory, value);
  const originalArtwork = library.media.find(video => video.id === videoId).artwork;
  const previousDialog = dialog.showMessageBox;
  let approvals = 0;
  dialog.showMessageBox = (...args) => {
    const options = args[args.length - 1];
    if (options.message === 'Use this image as artwork?' && options.detail === canonical &&
        JSON.stringify(options.buttons) === JSON.stringify(['Cancel', 'Use Image'])) {
      // First exercise cancellation, then approve the actual editor drop.
      return Promise.resolve({response: ++approvals === 1 ? 0 : 1});
    }
    return previousDialog(...args);
  };
  let attached = false;
  try {
    await ui.edit(videoId);
    contents.closeDevTools();
    contents.debugger.attach('1.3'); attached = true;
    await ui.inspect(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'mynda-drop-fixture'; input.hidden = true;
      document.body.appendChild(input);
    });
    const {root} = await contents.debugger.sendCommand('DOM.getDocument');
    const {nodeId} = await contents.debugger.sendCommand('DOM.querySelector', {
      nodeId:root.nodeId, selector:'#mynda-drop-fixture'
    });
    await contents.debugger.sendCommand('DOM.setFileInputFiles', {nodeId, files:[canonical]});
    const cancellation = await ui.inspect(async () => {
      const file = document.getElementById('mynda-drop-fixture').files[0];
      return {hasLegacyPath:'path' in file, accepted:await window.mynda.editor.inspectDroppedArtwork(file)};
    });
    assert.deepStrictEqual(cancellation, {hasLegacyPath:false, accepted:null});
    assert.strictEqual(library.media.find(video => video.id === videoId).artwork, originalArtwork);
    await ui.inspect(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(document.getElementById('mynda-drop-fixture').files[0]);
      document.dispatchEvent(new DragEvent('drop', {dataTransfer,bubbles:true,cancelable:true}));
    });
    await wait(() => ui.inspect(() => document.getElementById('edit-artwork-image')
      .getAttribute('src').includes('electron44-drop.png')), 'approved dropped artwork preview');
    assert.strictEqual(approvals, 2, 'The native artwork approval was not exercised');
    assert.strictEqual(library.media.find(video => video.id === videoId).artwork, originalArtwork,
      'A drop must remain an editor draft until Save');
    await ui.save(() => {
      const artwork = library.media.find(video => video.id === videoId).artwork;
      return artwork !== originalArtwork && artwork && fs.existsSync(resolveArtwork(artwork));
    });
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'Library', 'library.json'), 'utf8'));
    const artwork = saved.media.find(video => video.id === videoId).artwork;
    assert(!path.isAbsolute(artwork), 'Saved managed artwork must be relative');
    assert.strictEqual(path.dirname(resolveArtwork(artwork)), library.artworkDirectory);
    assert(fs.readFileSync(resolveArtwork(artwork)).equals(fs.readFileSync(source)), 'Saved artwork bytes changed');
    await ui.closeEditor();
    return true;
  } finally {
    dialog.showMessageBox = previousDialog;
    if (attached && contents.debugger.isAttached()) contents.debugger.detach();
    await ui.inspect(() => { const input = document.getElementById('mynda-drop-fixture'); if (input) input.remove(); });
  }
}

module.exports = {inspectArtworkDrop};
