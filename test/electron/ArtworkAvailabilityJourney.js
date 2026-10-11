const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {browserDriver, wait} = require('./BrowserDriver');

// The preceding drop journey supplies a real saved image. Introduce a missing
// reference in this disposable library, then exercise the ordinary UI/bridge.
async function inspectArtworkAvailability({window, videoId, userData, library}) {
  const ui = browserDriver(window);
  const original = library.media.find(video => video.id === videoId);
  const missing = path.join(userData, 'Library', 'Artwork', 'temporarily unavailable #1.png');
  const readSaved = () => JSON.parse(fs.readFileSync(path.join(userData, 'Library', 'library.json'), 'utf8'))
    .media.find(video => video.id === videoId);
  await library.patchMedia(videoId, {artwork: missing});
  await ui.edit(videoId);
  await wait(() => ui.inspect(() => {
    const image = document.getElementById('edit-artwork-image');
    return image && image.parentElement.dataset.artworkState === 'unavailable' && image.naturalWidth > 0;
  }), 'missing artwork placeholder');
  await wait(() => ui.inspect(() => document.querySelector('#detail-artwork .artwork-preview')
    .dataset.artworkState === 'unavailable'), 'details artwork placeholder');
  const geometry = await ui.inspect(() => {
    const image = document.getElementById('edit-artwork-image');
    const detail = document.getElementById('detail-artwork-img');
    return {editorHeight: image.getBoundingClientRect().height,
      detailsHeight: detail.getBoundingClientRect().height,
      placeholder: image.getAttribute('src'), detailsOpen: document.querySelector('.artwork-file-details').open};
  });
  assert(geometry.editorHeight > 60 && geometry.detailsHeight > 60, 'Missing artwork collapsed its reserved space');
  assert(geometry.placeholder.includes('qmark.png'));
  assert.strictEqual(geometry.detailsOpen, false);
  await ui.click('.artwork-file-details summary');
  assert.strictEqual(await ui.inspect(() => document.querySelector('.artwork-file-path').value), missing);
  await ui.click('.artwork-file-details summary');
  await ui.type('#edit-container .edit-field-title', 'Artwork availability test');
  await ui.save(() => readSaved().title === 'Artwork availability test');
  assert.strictEqual(readSaved().artwork, missing, 'Unrelated edits must retain the unavailable reference');

  fs.copyFileSync(original.artwork, missing);
  await ui.click('#editor-pane .artwork-unavailable button');
  await wait(() => ui.inspect(() => {
    const image = document.getElementById('edit-artwork-image');
    return image.parentElement.dataset.artworkState === 'image' && image.complete && image.naturalWidth > 0;
  }), 'restored artwork after Retry');
  const restoredHeight = await ui.inspect(() => document.getElementById('edit-artwork-image').getBoundingClientRect().height);
  assert(Math.abs(restoredHeight - geometry.editorHeight) < 1, 'Retry changed the reserved artwork height');
  await ui.click('#editor-pane .artwork-remove');
  await wait(() => ui.inspect(() => document.getElementById('edit-artwork-image')
    .parentElement.dataset.artworkState === 'empty'), 'cleared artwork draft');
  assert.strictEqual(readSaved().artwork, missing, 'Removal must wait for Save');
  await ui.save(() => readSaved().artwork === '');
  assert(fs.existsSync(missing) && fs.existsSync(original.artwork), 'Clearing a reference must not delete image files');
  await ui.closeEditor();
  await ui.edit(videoId);
  assert.strictEqual(await ui.inspect(() => document.querySelector('#editor-pane .artwork-remove').disabled), true);
  await ui.closeEditor();
  await library.patchMedia(videoId, {title: original.title});
  return true;
}

module.exports = {inspectArtworkAvailability};
