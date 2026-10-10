const assert=require('assert');
const path=require('path');
const {ipcRenderer,remote}=require('electron');
const {ids,expected,assertSaved}=require('./LibraryJourneyFixtures');
const library=require(path.join(remote.app.getAppPath(),'src/renderer/RendererRuntime.js')).library;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let background='';
ipcRenderer.on('status-update',(_event,status)=>{background=status.action || '';});

async function wait(check,label,timeout=10000) {
  const start=Date.now();
  while(!check()) {
    if(Date.now()-start>timeout) throw new Error('Timed out waiting for '+label);
    await sleep(25);
  }
}
function element(selector) {
  const found=document.querySelector(selector);
  assert(found,'Missing UI control: '+selector);return found;
}
function click(selector,options={}) {
  const target=element(selector);
  target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,...options}));
}
function type(selector,value) {
  const target=element(selector);
  const prototype=target.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,'value').set.call(target,value);
  target.dispatchEvent(new Event('input',{bubbles:true}));
}
const row=id=>`tr[vid_id="${id}"]`;
async function selectOnly(id) {
  await wait(()=>document.querySelector(row(id)),'fixture row');
  const selected=[...document.querySelectorAll('tr.movie-row.selected')];
  if(selected.length!==1 || selected[0].getAttribute('vid_id')!==id) click(row(id));
  await wait(()=>document.querySelectorAll('tr.movie-row.selected').length===1 &&
    element(row(id)).classList.contains('selected'),'single selection');
}
async function edit(id) {
  await selectOnly(id);click('#edit-button');
  await wait(()=>document.querySelector('#edit-container .edit-field-title'),'editor');
}
async function save(check) {
  click('#edit-container .save-btn');
  await wait(check,'confirmed editor save');
  await wait(()=>element('#edit-container .save-btn').value==='Save','editor acknowledgment');
}
async function closeEditor() {
  click('#editor-pane .openable-close-btn');
  await wait(()=>!document.querySelector('#edit-container'),'closed editor');
}
async function settings() {
  click('#settings-button');
  await wait(()=>document.querySelector('#settings-tab-preferences'),'settings tabs');
  click('#settings-tab-preferences');
  await wait(()=>document.querySelectorAll('#settings-prefs-libraryexclusions input').length===2,'preference controls');
}
const first=()=>library.media.find(video=>video.id===ids[0]);
const stage=value=>ipcRenderer.send('journey:stage',value);

async function run(phase) {
  await library.ready;
  stage('initial-scan');
  await ipcRenderer.invoke('journey:startup-ready');
  await wait(()=>document.querySelector('#grid-container') && document.querySelector(row(ids[0])),'initial UI');
  if(phase==='restart') {
    stage('restart-values');
    assertSaved(library.getSaveObject());
    await edit(ids[0]);
    assert.strictEqual(element('#edit-container .edit-field-title').value,expected.title);
    assert.strictEqual(element('#edit-field-description').value,expected.description);
    assert.strictEqual(document.querySelectorAll('#edit-container .rating .star.filled').length,expected.rating);
    await closeEditor();
    await settings();
    assert([...document.querySelectorAll('#settings-prefs-libraryexclusions input')].every(input=>!input.checked));
    click('#settings-pane .openable-close-btn');
    click(row(ids[0]),{detail:2});
    stage('restart-resume');
    await wait(()=>window.__myndaJourneyPlayback.resumes.length>0,'resume command after restart');
    assert.strictEqual(window.__myndaJourneyPlayback.resumes[0],expected.position);
    return {phase,restartVerified:true};
  }

  // A real editor rating save; wait for the committed replica, not a DOM-only change.
  stage('editor-rating');
  await edit(ids[0]);
  click('#edit-container .rating .star:nth-child(4)');
  await save(()=>first().ratings.user===expected.rating);
  await closeEditor();

  // Pause the real scanner at its external metadata probe, outside the commit
  // queue. A renderer edit must finish before the test releases that probe.
  stage('scan-and-editor');
  await ipcRenderer.invoke('journey:arm-scan');
  click('#scan-button');
  await ipcRenderer.invoke('journey:scan-started');
  await edit(ids[0]);
  type('#edit-field-description','Saved before the scan finishes');
  await save(()=>first().description==='Saved before the scan finishes');
  type('#edit-field-description',expected.description);
  await ipcRenderer.invoke('journey:release-scan');
  await wait(()=>first().metadata.width===3840,'completed metadata scan');
  assert.strictEqual(element('#edit-field-description').value,expected.description);
  await save(()=>first().description===expected.description);
  await closeEditor();
  await wait(()=>background==='','completed scan status');

  // Real Auto-Tag entry, runner and save path; a fixture holds the catalog
  // response while the user changes identity, so the late result must lose.
  stage('autotag-and-editor');
  click('.playlist-bar .autotag');
  await ipcRenderer.invoke('journey:tag-started');
  await edit(ids[0]);
  type('#edit-container .edit-field-title',expected.title);
  await save(()=>first().title===expected.title);
  await ipcRenderer.invoke('journey:release-tag');
  await wait(()=>first().taggingDecision && first().taggingDecision.reason.code==='changed-during-lookup','catalog conflict report');
  assert.strictEqual(element('#edit-container .edit-field-title').value,expected.title);
  await closeEditor();

  stage('batch-editor');
  await selectOnly(ids[0]);
  click(row(ids[1]),{ctrlKey:process.platform!=='darwin',metaKey:process.platform==='darwin'});
  await wait(()=>document.querySelectorAll('tr.movie-row.selected').length===2,'batch selection');
  click('#edit-button');
  await wait(()=>document.querySelector('#edit-batch-notification'),'batch editor');
  type('#edit-container .edit-field-country',expected.country);
  await save(()=>library.media.filter(video=>[ids[0],ids[1]].includes(video.id)).every(video=>video.country===expected.country));
  assert.strictEqual(library.media.find(video=>video.id===ids[2]).country,'Original country 2');
  await closeEditor();

  stage('playback-history');
  await selectOnly(ids[0]);
  click(row(ids[0]),{detail:2});
  await wait(()=>document.querySelector('#player-pane .playing-message'),'started fixture playback');
  // Exercise the production ten-second Recently Played timer.
  await wait(()=>library.recently_watched[0]===ids[0],'Recently Played timer',15000);
  const player=window.__myndaJourneyPlayback.player;
  player.emit('timeposition',310);
  player.emit('seek',{end:expected.position});
  player.emit('stopped');
  await wait(()=>first().position===expected.position,'playback position commit');
  click('#player-pane .openable-close-btn');

  // Close immediately after two genuine checkbox changes; the Settings close
  // hook must flush both controls without waiting for the debounce timer.
  stage('settings-before-close');
  await settings();
  const controls=document.querySelectorAll('#settings-prefs-libraryexclusions input');
  controls[0].click();controls[1].click();
  assert([...controls].every(input=>!input.checked));
  return {phase,rating:true,scanConcurrentEdit:true,tagConflict:true,batch:true,playback:true,settingsStaged:true};
}
module.exports={run};
