const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const Migration = require('../scripts/lib/VideoIdMigration.js');
const {defaultLibraryPath, parseArguments} = require('../scripts/migrate-video-ids.js');
const {fingerprintPath} = require('../src/ContentFingerprint.js');
const {assertLibraryIdentity} = require('../src/VideoIdentity.js');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');

const suite = createSuite('One-time video ID migration', 'integration',
  'Converts disposable libraries, preserves edits/history, resumes safely, reports conflicts, and exercises the real CLI installation guard.');

function fixture(directory, extra = {}) {
  const filename = path.join(directory, 'movie.mkv');
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, 'movie bytes');
  return {id:'library-id', settings:{watchfolders:[]}, playlists:[],
    media:[{id:'old-movie-id',filename,title:'Edited title',seen:true,position:55,
      ratings:{user:4},tags:['custom'],series:'User series',seriesImdbID:'tt123',duplicates:[]}],
    inactive_media:[], recently_watched:['old-movie-id'], object_media:{}, ...extra};
}

function save(directory, data, name = 'library.json') {
  const input = path.join(directory, name);
  fs.writeFileSync(input, JSON.stringify(data, null, 2) + '\n');
  return input;
}

function converted(report) {
  return JSON.parse(fs.readFileSync(path.join(report.output, Migration.filenames.converted), 'utf8'));
}

suite.test('converts both lists, history, and literal ID filters while preserving unrelated data', () =>
  withTemporaryDirectory('id-migration-preservation', async directory => {
    const old = fixture(directory);
    const inactiveFile = path.join(directory, 'inactive.mkv'); fs.writeFileSync(inactiveFile, 'other bytes');
    old.inactive_media = [{...old.media[0],id:'old-inactive',filename:inactiveFile,title:'Inactive title'}];
    old.recently_watched.push('old-inactive');
    old.media[0].description = 'Keep old-movie-id as ordinary text';
    old.playlists = [{id:'old-movie-id',name:'Manual',filter_function:"video.id === 'old-movie-id' || video.id === 'old-inactive'"}];
    const input = save(directory, old);
    const before = fs.readFileSync(input);
    const report = await Migration.prepareMigration(input);
    assert.strictEqual(report.status, 'ready', JSON.stringify(report.issues));
    const next = converted(report);
    assertLibraryIdentity(next);
    assert.strictEqual(next.id, old.id);
    assert.strictEqual(next.playlists[0].id, old.playlists[0].id);
    assert.strictEqual(next.media[0].id, (await fingerprintPath(old.media[0].filename)).id);
    assert.deepStrictEqual({...next.media[0],id:old.media[0].id},old.media[0]);
    assert.deepStrictEqual({...next.inactive_media[0],id:old.inactive_media[0].id},old.inactive_media[0]);
    assert.deepStrictEqual(next.recently_watched, [next.media[0].id,next.inactive_media[0].id]);
    assert.strictEqual(next.playlists[0].filter_function,
      `video.id === '${next.media[0].id}' || video.id === '${next.inactive_media[0].id}'`);
    assert.deepStrictEqual(fs.readFileSync(input), before);
    assert.deepStrictEqual(fs.readFileSync(path.join(report.output, Migration.filenames.original)), before);
  }));

suite.test('gives independent libraries the same new ID for copied media', () =>
  withTemporaryDirectory('id-migration-cross-library', async directory => {
    const a = path.join(directory, 'A'); const b = path.join(directory, 'B');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const first = fixture(a);
    const second = fixture(b); second.id = 'other-library'; second.media[0].id = 'different-legacy-id';
    second.recently_watched = [second.media[0].id];
    const one = converted(await Migration.prepareMigration(save(a, first)));
    const two = converted(await Migration.prepareMigration(save(b, second)));
    assert.strictEqual(one.media[0].id, two.media[0].id);
    assert.notStrictEqual(one.id, two.id);
  }));

suite.test('resumes interrupted work using unchanged fingerprints without replacing the source', () =>
  withTemporaryDirectory('id-migration-resume', async directory => {
    const data = fixture(directory);
    const second = path.join(directory, 'two.mkv'); fs.writeFileSync(second, 'second movie');
    data.media.push({...data.media[0],id:'old-two',filename:second});
    const input = save(directory, data); const before = fs.readFileSync(input);
    let cancel = false;
    const partial = await Migration.prepareMigration(input, {
      shouldCancel:() => cancel, onProgress:p => {if (p.current === 2) cancel = true;}
    });
    assert.strictEqual(partial.status, 'interrupted');
    assert(!fs.existsSync(path.join(partial.output, Migration.filenames.converted)));
    const resumed = await Migration.prepareMigration(input);
    assert.strictEqual(resumed.status, 'ready');
    assert(resumed.cachedPaths >= 1);
    assert.deepStrictEqual(fs.readFileSync(input), before);
  }));

suite.test('blocks missing entries and archives only missing inactive records with explicit opt-in', () =>
  withTemporaryDirectory('id-migration-missing', async directory => {
    const data = fixture(directory);
    const missing = {...data.media[0],id:'missing-old-id',filename:path.join(directory,'gone.mkv'),tags:['preserve me']};
    data.inactive_media = [missing]; data.recently_watched.push(missing.id);
    const input = save(directory, data); const before = fs.readFileSync(input);
    const blocked = await Migration.prepareMigration(input);
    assert.strictEqual(blocked.status, 'blocked');
    assert(blocked.issues.some(issue => issue.code === 'ENOENT'));
    const ready = await Migration.prepareMigration(input,{archiveMissingInactive:true});
    assert.strictEqual(ready.status, 'ready');
    assert.deepStrictEqual(converted(ready).inactive_media, []);
    const archive = JSON.parse(fs.readFileSync(path.join(ready.output,Migration.filenames.archive),'utf8'));
    assert.deepStrictEqual(archive.inactive_media,[missing]);
    assert.deepStrictEqual(archive.recently_watched,data.recently_watched);
    assert.deepStrictEqual(fs.readFileSync(input), before);
    fs.unlinkSync(data.media[0].filename);
    const stillBlocked = await Migration.prepareMigration(input,{archiveMissingInactive:true});
    assert.strictEqual(stillBlocked.status, 'blocked');
    assert(stillBlocked.issues.some(issue => issue.list === 'media'));
  }));

suite.test('relinks an explicitly supplied path while retaining the original record', () =>
  withTemporaryDirectory('id-migration-relink', async directory => {
    const data = fixture(directory);
    const realPath = data.media[0].filename;
    data.media[0].filename = path.join(directory, 'old name.mkv');
    const input = save(directory,data);
    const report = await Migration.prepareMigration(input,{relinks:{[data.media[0].filename]:realPath}});
    assert.strictEqual(report.status,'ready');
    assert.strictEqual(converted(report).media[0].filename,realPath);
    assert.strictEqual(converted(report).media[0].position,55);
  }));

suite.test('rechecks duplicates and reports different or unavailable copies without copying metadata onto them', () =>
  withTemporaryDirectory('id-migration-duplicates', async directory => {
    const data = fixture(directory);
    const copy = path.join(directory,'copy.mkv'); fs.copyFileSync(data.media[0].filename,copy);
    const different = path.join(directory,'different.mkv'); fs.writeFileSync(different,'different bytes');
    data.media[0].duplicates = [copy,different,path.join(directory,'missing-copy.mkv')];
    const report = await Migration.prepareMigration(save(directory,data));
    assert.strictEqual(report.status,'ready');
    assert.deepStrictEqual(converted(report).media[0].duplicates,[copy]);
    assert.deepStrictEqual(report.duplicates.map(item => item.state),['matched','different','unavailable']);
    assert.strictEqual(converted(report).media.length,1);
  }));

suite.test('reports one old ID splitting and multiple records collapsing without silent merges', () =>
  withTemporaryDirectory('id-migration-conflicts', async directory => {
    const data = fixture(directory);
    const second = path.join(directory,'second.mkv'); fs.writeFileSync(second,'different content');
    data.media.push({...data.media[0],filename:second});
    const split = await Migration.prepareMigration(save(directory,data));
    assert.strictEqual(split.status,'blocked');
    assert(split.issues.some(issue => issue.code === 'MIGRATION_AMBIGUOUS_OLD_ID'));
    data.media[1].id = 'other-id'; fs.copyFileSync(data.media[0].filename,second);
    const collapsed = await Migration.prepareMigration(save(directory,data,'other-library.json'));
    assert.strictEqual(collapsed.status,'blocked');
    assert(collapsed.issues.some(issue => issue.code === 'MIGRATION_DUPLICATE_RECORDS'));
  }));

suite.test('stops for complex ID filters and leaves ordinary text expressions intact', () => {
  const mapping = new Map([['old-id','a'.repeat(64)]]);
  assert.strictEqual(Migration.rewriteFilter("video.title === 'old-id'",mapping),"video.title === 'old-id'");
  assert.throws(() => Migration.rewriteFilter('video.id.startsWith("old")',mapping),error => error.code === 'MIGRATION_PLAYLIST');
  assert.throws(() => Migration.rewriteFilter("video.id === 'unknown-id'",mapping),error => error.code === 'MIGRATION_PLAYLIST');
  assert.throws(() => Migration.rewriteFilter("video.id === 'old-id' && video.title === 'old-id'",mapping),error => error.code === 'MIGRATION_PLAYLIST');
  assert.throws(() => Migration.rewriteFilter("video['i' + 'd'] === 'old-id'",mapping),error => error.code === 'MIGRATION_PLAYLIST');
  assert.strictEqual(Migration.rewriteFilter("video['id'] === 'old-id'",mapping),`video['id'] === '${'a'.repeat(64)}'`);
  const quotedTitle = `video.id === 'old-id' || video.title === "Keep 'old-id' inside this title"`;
  assert.strictEqual(Migration.rewriteFilter(quotedTitle,mapping),
    `video.id === '${'a'.repeat(64)}' || video.title === "Keep 'old-id' inside this title"`);
});

suite.test('installs a validated copy atomically and keeps the exact original for rollback', () =>
  withTemporaryDirectory('id-migration-install', async directory => {
    const input = save(directory,fixture(directory)); const before = fs.readFileSync(input);
    const report = await Migration.prepareMigration(input);
    const result = await Migration.installMigration(input);
    assert.strictEqual(result.status,'installed');
    assertLibraryIdentity(JSON.parse(fs.readFileSync(input,'utf8')));
    assert.deepStrictEqual(fs.readFileSync(path.join(report.output,Migration.filenames.original)),before);
    assert.strictEqual((await Migration.installMigration(input)).status,'already-installed');
    assert.strictEqual((await Migration.prepareMigration(input)).status,'already-current');
  }));

suite.test('refuses changed sources, edited outputs, or changed media before installation', async () => {
  for (const change of ['source','output','media','duplicate']) {
    await withTemporaryDirectory('id-migration-stale-'+change,async directory => {
      const data = fixture(directory);
      const duplicate = path.join(directory,'copy.mkv'); fs.copyFileSync(data.media[0].filename,duplicate);
      data.media[0].duplicates=[duplicate];
      const input = save(directory,data); const report = await Migration.prepareMigration(input);
      if (change === 'source') fs.appendFileSync(input,' ');
      if (change === 'output') fs.appendFileSync(path.join(report.output,Migration.filenames.converted),' ');
      if (change === 'media') fs.appendFileSync(data.media[0].filename,'change');
      if (change === 'duplicate') fs.appendFileSync(duplicate,'change');
      const before = fs.readFileSync(input);
      await assert.rejects(() => Migration.installMigration(input),error =>
        ['MIGRATION_SOURCE_CHANGED','MIGRATION_OUTPUT_CHANGED','MIGRATION_MEDIA_CHANGED'].includes(error.code));
      assert.deepStrictEqual(fs.readFileSync(input),before);
    });
  }
});

suite.test('runs preparation and installation through the real CLI, including paths with spaces', () =>
  withTemporaryDirectory('id-migration-cli', async directory => {
    const input = save(directory,fixture(directory),'My Library.json');
    const script = path.join(__dirname,'..','scripts','migrate-video-ids.js');
    const invoke = args => spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});
    const prepare = invoke(['--input',input]);
    assert.strictEqual(prepare.status,0,prepare.stderr+prepare.stdout);
    assert.strictEqual(JSON.parse(fs.readFileSync(input,'utf8')).videoIdScheme,undefined);
    const install = invoke(['--input',input,'--install']);
    assert.strictEqual(install.status,0,install.stderr+install.stdout);
    assertLibraryIdentity(JSON.parse(fs.readFileSync(input,'utf8')));
    assert.strictEqual(invoke(['--unknown']).status,1);
  }));

suite.test('resolves native default paths and rejects conflicting command options', () => {
  assert.strictEqual(defaultLibraryPath('darwin',{},'/Users/test'),'/Users/test/Library/Application Support/mynda/Library/library.json');
  assert.strictEqual(defaultLibraryPath('linux',{XDG_CONFIG_HOME:'/config'},'/home/test'),'/config/mynda/Library/library.json');
  assert.strictEqual(defaultLibraryPath('win32',{APPDATA:'C:\\Profile\\Roaming'},'C:\\Profile'),
    'C:\\Profile\\Roaming\\mynda\\Library\\library.json');
  assert.throws(() => parseArguments(['--input']));
  assert.throws(() => parseArguments(['--install','--archive-missing-inactive']));
});

runSuite(suite);
