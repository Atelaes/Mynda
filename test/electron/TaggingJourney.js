// UI actions run in the production isolated renderer. Assertions and fixtures
// stay in main; there is no test IPC API or direct call to a tagging handler.
const assert = require('assert');
const fs = require('fs');
const {browserDriver,wait} = require('./BrowserDriver');
const {copy} = require('./TaggingFixtures');
const checks = require('./TaggingAssertions');

async function waitForChosenMetadata(ui, imdbID, previousDescription, timeout = 15000) {
  // These journeys start with a placeholder description and no artwork. An
  // IMDb ID alone cannot signal completion: the user may have just typed it.
  // File info holds the artwork reference; the paste-path input stays empty.
  let observed;
  try {
    await wait(async()=>{
      observed=await ui.inspect(previousDescription=>{
        const value=selector=>document.querySelector(selector)?.value || '';
        const description=value('#edit-field-description');
        return {imdbID:value('.edit-field-imdbID'),descriptionPresent:description.trim()!=='',
          descriptionChanged:description!==previousDescription,artworkPresent:value('.artwork-file-path')!==''};
      },previousDescription);
      return observed.imdbID===imdbID && observed.descriptionPresent && observed.descriptionChanged && observed.artworkPresent;
    },'chosen metadata and artwork in draft',timeout);
  } catch(error) {
    throw new Error(`${error.message}; observed draft: ${JSON.stringify(observed)}`);
  }
}

async function run({window,scenario,phase,library,originals,dialogs,network,status,disk,stage}) {
  const ui = browserDriver(window);
  const ids = originals.map(video=>video.id);
  const current = () => ids.map(id=>library.media.find(video=>video.id===id));
  const saved = () => {const data=JSON.parse(fs.readFileSync(library.path,'utf8'));
    return ids.map(id=>data.media.find(video=>video.id===id));};
  const value = selector => ui.inspect(selector=>document.querySelector(selector).value,selector);
  const all = async () => {await ui.click('#playlist-e2e'); await wait(()=>ui.exists(ui.row(ids[0])),'test library rows');};
  const settled = async () => {await library.whenIdle(); assert.deepStrictEqual(saved(),current(),'Renderer save must reach disk');};
  async function report(index) {
    await all(); await ui.edit(ids[index]);
    await wait(()=>ui.exists('#edit-autotag-report .folder-heading'),'saved tagging report heading');
    await ui.click('#edit-autotag-report .folder-heading');
    await wait(()=>ui.exists('.autotag-report-summary'),'readable tagging report');
    const text = await ui.inspect(()=>document.querySelector('.autotag-report-summary').textContent);
    assert(text.trim().length > 15,'Report must explain the outcome');
    const decision=current()[index].taggingDecision;
    const label=decision?{'ambiguous':'Needs a choice','unmatched':'Not matched','service-error':'Attempt interrupted'}[decision.status]:'Matched';
    const heading=await ui.inspect(()=>document.querySelector('#edit-autotag-report .folder-heading').textContent);
    assert(label && heading.includes(label),'The report must display the saved outcome');
    if (current()[index].imdbID) assert(await ui.exists('#edit-autotag-report a[href="https://www.imdb.com/title/' + current()[index].imdbID + '/"]'));
    await ui.closeEditor();
  }
  async function assertEditor(index) {
    await ui.edit(ids[index]);
    assert.strictEqual(await value('.edit-field-imdbID'),current()[index].imdbID);
    assert.strictEqual(await value('.edit-field-title'),current()[index].title);
    if (current()[index].artwork) {
      await wait(()=>ui.inspect(()=>{const img=document.getElementById('edit-artwork-image');
        return img.complete && img.naturalWidth > 0 && img.parentElement.dataset.artworkState === 'image';}),'saved artwork renders');
    }
    await ui.closeEditor();
  }
  async function batch(indices) {
    await all(); await ui.selectOnly(ids[indices[0]]);
    for (const index of indices.slice(1)) await ui.click(ui.row(ids[index]),{ctrlKey:process.platform!=='darwin',metaKey:process.platform==='darwin'});
    await wait(async()=> (await ui.selected()).length===indices.length,'selected batch');
    await ui.click('#edit-button'); await wait(()=>ui.exists('#edit-batch-notification'),'batch editor');
  }
  async function startAuto() {
    await ui.click('#playlist-new');
    await wait(()=>ui.exists('.playlist-bar .autotag:not(.cancel)'),'Auto-Tag button');
    const done = status.completed;
    dialogs.expect(options=>options.title==='Auto-Tag' && /^Auto-tag \d+ video/.test(options.message),1);
    await ui.click('.playlist-bar .autotag');
    return async()=>{await wait(()=>status.completed>done,'Auto-Tag completion',scenario==='live'?150000:30000); await settled();};
  }
  async function search(index) {
    await ui.click('#edit-search-button');
    await wait(()=>ui.exists('#edit-search-results tbody tr'),'catalog choices',scenario==='live'?60000:15000);
    assert.strictEqual(saved()[index].imdbID,originals[index].imdbID,'Searching must not save metadata');
  }
  async function choose(index, expected, response = 0) {
    const previousDescription=await value('#edit-field-description');
    dialogs.expect(options=>/^Are you sure you want to choose /.test(options.message),response);
    await ui.click('#edit-search-results tbody tr');
    await dialogs.drained();
    if (response === 0) await waitForChosenMetadata(ui,expected,previousDescription,scenario==='live'?60000:15000);
    assert.strictEqual(saved()[index].imdbID,originals[index].imdbID,'Choosing must not save metadata');
  }
  async function revert() {
    dialogs.expect(options=>/^Are you sure you want to revert/.test(options.message),0);
    await ui.click('.revert-btn'); await dialogs.drained();
  }
  async function manual(index, expected, exerciseRevert) {
    await all(); await ui.edit(ids[index]); await search(index);
    if (exerciseRevert) {
      await choose(index,expected,1); assert.strictEqual(await value('.edit-field-imdbID'),'');
      const hold=network.hold(({url,catalog})=>!catalog && url.pathname.includes(expected));
      const choosing=choose(index,expected);
      await wait(hold.started,'held artwork download');
      await ui.click('.rating .star:nth-child(3)');
      await ui.type('#list-widget-add-tags-input','during-lookup');
      await ui.click('#list-widget-add-tags .editor-inline-button');
      hold.release();await choosing;
      assert.strictEqual(await ui.inspect(()=>document.querySelectorAll('.rating .star.filled').length),3);
      assert(await ui.inspect(()=>[...document.querySelectorAll('.edit-field.tags .list-widget-item')]
        .some(node=>node.title==='during-lookup')),'A late metadata response lost a draft tag');
      await revert();
      await wait(async()=>await value('.edit-field-imdbID')==='','Revert clears draft match');
      // Entering an explicit ID uses the same actual search/selection flow.
      await ui.type('.edit-field-imdbID',expected); await search(index);
    }
    await choose(index,expected);
    await ui.save(()=>current()[index].imdbID===expected); await settled(); await ui.closeEditor();
  }
  await ui.start(); await all();
  if (phase === 'restart') {
    stage('restart-and-disk'); checks.verify(scenario,current()); await settled();
    for (let index=0; index<ids.length; index++) await assertEditor(index);
    if(current()[0].taggingEvidence || current()[0].taggingDecision)await report(0);
    return {restartVerified:true};
  }
  stage(scenario);
  if (['movies','episode-parents','episode-numbering','failures'].includes(scenario)) {
    const finish=await startAuto(); await finish(); checks.verify(scenario,current());
    for(let index=0;index<ids.length;index++)await report(index);
  } else if (scenario === 'manual') {
    const hold=network.hold(({query})=>[query.s,query.t].includes(originals[0].title));
    await ui.edit(ids[0]);await ui.click('#edit-search-button');await wait(hold.started,'delayed manual search');
    await ui.selectOnly(ids[1]);
    await wait(async()=>await value('.edit-field-title')===originals[1].title,'editor changes video during search');
    hold.release();
    await ui.inspect(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.strictEqual(await value('.edit-field-title'),originals[1].title);
    assert(!await ui.exists('#edit-search-results tbody tr'),'A stale search populated another video');
    assert.deepStrictEqual(saved(),originals);
    await ui.closeEditor();
    await manual(0,'tt19000002',true); await manual(1,'tt19000221',false);
    checks.verify(scenario,current());
    await report(0);
  } else if (scenario === 'batch') {
    const untouched = copy(current()[2]);
    await batch([0,1]);
    assert.strictEqual(await value('.edit-field-country'),'','Mixed country should be blank');
    await ui.type('#edit-field-description','Batch description');
    await ui.save(()=>current().slice(0,2).every(video=>video.description==='Batch description'));
    assert.strictEqual(current()[0].country,'Alpha'); assert.strictEqual(current()[1].country,'Beta');
    await ui.type('.edit-field-country','Shared country');
    await ui.save(()=>current().slice(0,2).every(video=>video.country==='Shared country'));
    await ui.type('.edit-field-country','');
    await ui.click('.rating .star:nth-child(3)');
    for (const [field,item,added] of [['cast','Common Cast','Added Cast'],['tags','common','added']]) {
      // Cast/tag removal is an immediate draft edit, with no native dialog.
      await ui.inspect((field,item)=>{
        const row=[...document.querySelectorAll('.edit-field.'+field+' .list-widget-item')].find(node=>node.title===item);
        if (!row) throw new Error('Missing common list item: '+item);
        const remove=row.querySelector('.list-widget-delete-item');
        if (!remove) throw new Error('Missing list remove control');
        remove.click(); return true;
      },field,item);
      await wait(()=>ui.inspect((field,item)=>![...document.querySelectorAll('.edit-field.'+field+' .list-widget-item')]
        .some(node=>node.title===item),field,item),'removed list item disappears before Save');
      await ui.type('#list-widget-add-'+field+'-input',added);
      await ui.click('#list-widget-add-'+field+' .editor-inline-button');
      await wait(()=>ui.inspect((field,item)=>[...document.querySelectorAll('.edit-field.'+field+' .list-widget-item')]
        .some(node=>node.title===item),field,added),'new list item appears before Save');
    }
    await ui.click('.artwork-remove');
    assert(current().slice(0,2).every(video=>video.artwork),'Removal must remain a draft until Save');
    await ui.save(()=>current().slice(0,2).every(video=>video.country==='' && video.artwork===''));
    assert.deepStrictEqual(current()[2],untouched);
    originals.slice(0,2).forEach(video=>assert(fs.existsSync(video.artwork),'Shared artwork must not be deleted'));
    await ui.closeEditor();
  } else if (scenario === 'selected' || scenario === 'live') {
    if (scenario === 'live') {const finish=await startAuto();await finish();await manual(1,'tt2543164',false);}
    const indices=scenario==='live'?[2,3]:[0,1];
    await batch(indices);
    if (scenario === 'selected') {
      await ui.type('.edit-field-country','Unsaved batch change');
      assert(await ui.inspect(()=>document.getElementById('edit-search-button').disabled));
      await revert();
      const before=copy(current());
      dialogs.expect(options=>options.title==='Auto-Tag Selected' && options.buttons.length===2,1);
      dialogs.expect(options=>options.title==='Choose Series',0);
      dialogs.expect(options=>options.title==='Auto-Tag Selected' && /no series was chosen/.test(options.message),0);
      await ui.click('#edit-search-button');await dialogs.drained();
      assert.deepStrictEqual(current(),before,'Canceling the series choice must change nothing');
    }
    dialogs.expect(options=>options.title==='Auto-Tag Selected' && options.buttons.length===2,1);
    if (scenario==='selected') dialogs.expect(options=>options.title==='Choose Series',options=>{
      const choice=options.buttons.findIndex(label=>label.includes('tt19000105')); assert(choice>0);return choice;});
    dialogs.expect(options=>options.title==='Auto-Tag Selected' && /finished for the selected/.test(options.message),0);
    await ui.click('#edit-search-button');await dialogs.drained(scenario==='live'?150000:30000);
    await wait(()=>indices.every(index=>current()[index].imdbID),'selected episodes saved');
    await ui.closeEditor();
  } else if (scenario==='concurrency' || scenario==='cancel') {
    const hold=network.hold(({query})=>[query.s,query.t].includes(originals[0].title));
    const finish=await startAuto(); await wait(hold.started,'held catalog request');
    if (scenario==='concurrency') {
      await all();await ui.edit(ids[0]);await ui.type('.edit-field-title','My corrected title');
      await ui.save(()=>current()[0].title==='My corrected title');
      assert.strictEqual(saved()[0].title,'My corrected title','User save must finish before the lookup resumes');
      hold.release();await finish();
      assert.strictEqual(await value('.edit-field-title'),'My corrected title');await ui.closeEditor();
    } else {
      dialogs.expect(options=>options.title==='Cancel Auto-Tag',1);
      await wait(()=>ui.exists('.playlist-bar .autotag.cancel'),'Cancel Auto-Tag button');
      await ui.click('.playlist-bar .autotag.cancel');await dialogs.drained();
      await wait(()=>ui.inspect(()=>document.querySelector('.playlist-bar .autotag.cancel').disabled),'cancellation acknowledged');
      hold.release();await finish();
    }
  } else if (scenario==='disk-full') {
    const before=copy(current()); disk.fail=true;
    dialogs.expect(options=>options.title==='Auto-Tag stopped' && /out of space/.test(options.message),0);
    // The confirmation precedes the expected error, so put it at the front.
    dialogs.prepend(options=>options.title==='Auto-Tag' && /^Auto-tag \d+ video/.test(options.message),1);
    await ui.click('#playlist-new');await ui.click('.playlist-bar .autotag');await dialogs.drained(30000);
    disk.fail=false; await settled();assert.deepStrictEqual(current(),before);assert.deepStrictEqual(saved(),before);
    await wait(()=>ui.exists('.playlist-bar .autotag:not(.cancel)'),'tagging controls recover after failed save');
    const finish=await startAuto();await finish();
  }
  await dialogs.drained(); await settled(); checks.verify(scenario,current());
  await all(); await assertEditor(0);
  return {taggingVerified:true};
}
module.exports={run,waitForChosenMetadata};
