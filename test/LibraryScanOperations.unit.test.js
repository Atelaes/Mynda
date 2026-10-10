const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {applyScanOperation,containsPath} = require('../src/library/LibraryScanOperations');
const suite = createSuite('Atomic scan library operations','unit',
  'Current-record moves, safe watchfolder containment, reactivation and preservation of concurrent edits.');
const video = (id,filename,extra={}) => ({id,filename,title:'Original',...extra});
const library = (media=[],inactive_media=[]) => ({media,inactive_media,settings:{watchfolders:[{path:'/Shows'}]}});
function freeze(value) {
  if (value && typeof value==='object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}

suite.test('moving a current record preserves edits and changes both collections without mutating input', () => {
  const current=video('one','/Shows/one.mkv',{title:'User correction',time:123});
  const state=freeze(library([current]));
  const result=applyScanOperation(state,{opType:'move-media',ids:['one'],from:'media',to:'inactive_media'});
  assert.deepStrictEqual(result.media,[]);
  assert.deepStrictEqual(result.inactive_media,[current]);
  assert.deepStrictEqual(state.media,[current]);assert.deepStrictEqual(state.inactive_media,[]);
});

suite.test('moves are idempotent and cannot create duplicate destination records', () => {
  const old=video('one','/Shows/one.mkv');
  const state=library([old],[old]);
  const result=applyScanOperation(state,{opType:'move-media',ids:['one'],from:'media',to:'inactive_media'});
  assert.strictEqual(result.inactive_media.length,1);
  assert.deepStrictEqual(applyScanOperation(result,{opType:'move-media',ids:['one']}),result);
});

suite.test('a missing old filename cannot deactivate a video whose current path changed', () => {
  const current=video('one','/Shows/moved.mkv');
  const state=library([current]);
  const result=applyScanOperation(state,{opType:'move-media',ids:['one'],from:'media',to:'inactive_media',
    expectedFilenames:{one:'/Shows/old.mkv'}});
  assert.deepStrictEqual(result,state);
});

suite.test('reactivation uses the current inactive record and preserves unrelated and overlapping edits', () => {
  const baseline=video('one','/Shows/old.mkv',{subtitles:['old.srt'],detected_subtitles:['old.srt'],new:true});
  const current={...baseline,title:'User title',subtitles:['manual.srt'],time:321,new:false};
  const discovered={...baseline,filename:'/Shows/new.mkv',subtitles:['found.srt'],detected_subtitles:['found.srt']};
  const state=freeze(library([],[current]));
  const result=applyScanOperation(state,{opType:'upsert-media',entry:[{video:discovered,baseline}]});
  assert.deepStrictEqual(result.inactive_media,[]);
  assert.strictEqual(result.media[0].title,'User title');assert.strictEqual(result.media[0].time,321);
  assert.strictEqual(result.media[0].new,false);assert.strictEqual(result.media[0].filename,'/Shows/new.mkv');
  assert.deepStrictEqual(result.media[0].subtitles,['manual.srt']);
  assert.deepStrictEqual(result.media[0].detected_subtitles,['old.srt']);
});

suite.test('reactivation preserves the complete detected/manual/ignored subtitle provenance', () => {
  const baseline=video('one','/Shows/old.mkv',{subtitles:[]});
  const discovered={...baseline,filename:'/Shows/new.mkv',subtitles:['manual.srt','found.srt'],
    detected_subtitles:['found.srt','ignored.srt'],manual_subtitles:['manual.srt'],
    ignored_subtitles:['ignored.srt'],subtitle_tracking_initialized:true};
  const result=applyScanOperation(library([],[baseline]),{opType:'upsert-media',entry:[{video:discovered,baseline}]});
  for(const field of ['subtitles','detected_subtitles','manual_subtitles','ignored_subtitles','subtitle_tracking_initialized']) {
    assert.deepStrictEqual(result.media[0][field],discovered[field]);
  }
});

suite.test('late additions cannot overwrite an existing record or resurrect a removed inactive record', () => {
  const current=video('one','/Shows/current.mkv',{title:'User title'});
  const stale=video('one','/Shows/old.mkv');
  const result=applyScanOperation(library([current]),{opType:'upsert-media',entry:[stale]});
  assert.deepStrictEqual(result.media,[current]);
  const absent=applyScanOperation(library(),{opType:'upsert-media',entry:[{video:stale,baseline:stale}]});
  assert.deepStrictEqual(absent.media,[]);
});

suite.test('new scanned records are detached and require a still-present watchfolder', () => {
  const input=video('one','/Shows/one.mkv',{subtitles:['one.srt']});
  const result=applyScanOperation(library(),{opType:'upsert-media',entry:[input],requireWatchfolder:true});
  input.subtitles.push('later.srt');
  assert.deepStrictEqual(result.media[0].subtitles,['one.srt']);
  const removed={...library(),settings:{watchfolders:[]}};
  assert.deepStrictEqual(applyScanOperation(removed,{opType:'upsert-media',entry:[input],requireWatchfolder:true}).media,[]);
});

suite.test('watchfolder removal is atomic and does not treat path prefixes or punctuation as patterns', () => {
  const own=video('one','/Shows (HD)/one.mkv'),neighbor=video('two','/Shows HD/two.mkv'),prefix=video('three','/Shows (HD) Archive/three.mkv');
  const state=freeze({...library([own,neighbor,prefix]),settings:{watchfolders:[{path:'/Shows (HD)'},{path:'/Shows HD'}]}});
  const result=applyScanOperation(state,{opType:'remove-watchfolder',path:'/Shows (HD)'});
  assert.deepStrictEqual(result.media,[neighbor,prefix]);assert.deepStrictEqual(result.inactive_media,[own]);
  assert.deepStrictEqual(result.settings.watchfolders,[{path:'/Shows HD'}]);
  assert.strictEqual(state.settings.watchfolders.length,2);
});

suite.test('path containment handles native Windows separators and case without matching sibling prefixes', () => {
  assert(containsPath('C:\\Shows','c:\\shows\\Season 1\\one.mkv','win32'));
  assert(!containsPath('C:\\Shows','C:\\Shows Archive\\one.mkv','win32'));
  assert(!containsPath('/Shows','/Shows Archive/one.mkv','linux'));
  assert(!containsPath('/Shows','/Shows/../Other/one.mkv','linux'));
});

runSuite(suite);
