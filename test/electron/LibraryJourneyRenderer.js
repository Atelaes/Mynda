// Runs in the main test process. UI actions use the isolated browser DOM;
// external fixtures and authoritative library observations stay in main.
const assert = require('assert');
const {ids, expected, assertSaved} = require('./LibraryJourneyFixtures');
const {browserDriver, wait} = require('./BrowserDriver');

async function run({window, phase, library, playback, startupReady, armScan,
  scanStarted, releaseScan, tagStarted, releaseTag, background, stage}) {
  const ui = browserDriver(window);
  await ui.start();
  stage('initial-scan');
  await startupReady;
  await wait(() => ui.exists(ui.row(ids[0])), 'initial fixture UI');
  const first = () => library.media.find(video => video.id === ids[0]);

  if (phase === 'restart') {
    stage('restart-values');
    assertSaved(library.getSaveObject());
    await ui.edit(ids[0]);
    const values = await ui.inspect(() => ({
      title:document.querySelector('#edit-container .edit-field-title').value,
      description:document.querySelector('#edit-field-description').value,
      rating:document.querySelectorAll('#edit-container .rating .star.filled').length,
      cast:[...document.querySelectorAll('#edit-container .edit-field.cast .list-widget-item')].map(item => item.title)
    }));
    assert.deepStrictEqual(values, {title:expected.title, description:expected.description,
      rating:expected.rating, cast:expected.cast});
    await ui.closeEditor();
    await ui.settings();
    assert(await ui.inspect(() => [...document.querySelectorAll('#settings-prefs-libraryexclusions input')]
      .every(input => !input.checked)));
    await ui.click('#settings-pane .openable-close-btn');
    await ui.click(ui.row(ids[0]), {detail:2});
    stage('restart-resume');
    await wait(() => playback.resumes.length > 0, 'resume command after restart');
    await wait(() => ui.exists('#player-pane .playing-message'), 'resumed fixture playback');
    assert.strictEqual(playback.resumes[0], expected.position);
    return {phase, restartVerified:true};
  }

  stage('editor-cast-and-rating');
  await ui.edit(ids[0]);
  for (let index = 0; index < expected.cast.length; index++) {
    await ui.type('#list-widget-add-cast-input', expected.cast[index]);
    await ui.click('#list-widget-add-cast .editor-inline-button');
    assert.deepStrictEqual(await ui.inspect(() =>
      [...document.querySelectorAll('#edit-container .edit-field.cast .list-widget-item')].map(item => item.title)),
      expected.cast.slice(0, index + 1), 'A cast addition must be visible before Save');
    assert.deepStrictEqual(first().cast, [], 'Typing cast members must not save the library');
  }
  await ui.click('#edit-container .rating .star:nth-child(4)');
  await ui.save(() => first().ratings.user === expected.rating);
  assert.deepStrictEqual(first().cast, expected.cast);
  await ui.closeEditor();

  // Hold the scanner outside the commit queue: a real editor save must finish
  // before the external metadata fixture is released.
  stage('scan-and-editor');
  await armScan();
  await ui.click('#scan-button');
  await scanStarted;
  await ui.edit(ids[0]);
  await ui.type('#edit-field-description', 'Saved before the scan finishes');
  await ui.save(() => first().description === 'Saved before the scan finishes');
  await ui.type('#edit-field-description', expected.description);
  releaseScan();
  await wait(() => first().metadata.width === 3840, 'completed metadata scan');
  assert.strictEqual(await ui.inspect(() => document.querySelector('#edit-field-description').value), expected.description);
  await ui.save(() => first().description === expected.description);
  await ui.closeEditor();
  await wait(() => background() === '', 'completed scan status');

  stage('autotag-and-editor');
  await ui.click('.playlist-bar .autotag');
  await tagStarted;
  await ui.edit(ids[0]);
  await ui.type('#edit-container .edit-field-title', expected.title);
  await ui.save(() => first().title === expected.title);
  releaseTag();
  await wait(() => first().taggingDecision && first().taggingDecision.reason.code === 'changed-during-lookup',
    'catalog conflict report');
  assert.strictEqual(await ui.inspect(() => document.querySelector('#edit-container .edit-field-title').value), expected.title);
  await ui.closeEditor();

  stage('batch-editor');
  await ui.selectOnly(ids[0]);
  await ui.click(ui.row(ids[1]), {ctrlKey:process.platform !== 'darwin', metaKey:process.platform === 'darwin'});
  await wait(async () => (await ui.selected()).length === 2, 'batch selection');
  await ui.click('#edit-button');
  await wait(() => ui.exists('#edit-batch-notification'), 'batch editor');
  await ui.type('#edit-container .edit-field-country', expected.country);
  await ui.save(() => library.media.filter(video => [ids[0], ids[1]].includes(video.id))
    .every(video => video.country === expected.country));
  assert.strictEqual(library.media.find(video => video.id === ids[2]).country, 'Original country 2');
  await ui.closeEditor();

  stage('playback-history');
  await ui.selectOnly(ids[0]);
  await ui.click(ui.row(ids[0]), {detail:2});
  await wait(() => ui.exists('#player-pane .playing-message'), 'started fixture playback');
  await wait(() => library.recently_watched[0] === ids[0], 'Recently Played timer', 15000);
  playback.player.emit('timeposition', 310);
  playback.player.emit('seek', {end:expected.position});
  playback.player.emit('stopped');
  await wait(() => first().position === expected.position, 'playback position commit');
  const stoppedPlayer = playback.player;
  await ui.click('#player-pane .openable-close-btn');
  await wait(() => playback.stops.includes(stoppedPlayer), 'backend player cleanup');
  assert.strictEqual(stoppedPlayer.listenerCount('timeposition'), 0, 'Closed players must not keep saving positions');

  // The real Settings close hook must flush two freshly changed controls.
  stage('settings-before-close');
  await ui.settings();
  assert(await ui.inspect(() => {
    const controls = document.querySelectorAll('#settings-prefs-libraryexclusions input');
    controls[0].click(); controls[1].click();
    return [...controls].every(input => !input.checked);
  }));
  return {phase, rating:true, scanConcurrentEdit:true, tagConflict:true, batch:true, playback:true, settingsStaged:true};
}

module.exports = {run};
