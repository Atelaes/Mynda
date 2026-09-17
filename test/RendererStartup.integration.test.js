const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const {assert,createSuite,runSuite,withTemporaryDirectory}=require('./helpers/TestHarness');
const root=path.resolve(__dirname,'..');
const suite=createSuite('Renderer startup after an update','integration',
  'Real Babel compilation across launches, unchanged ZIP timestamps, and saved-report IMDb links.');

suite.test('a source overlay replaces cached plain-text reports even when its timestamp is unchanged',async()=>{
  await withTemporaryDirectory('renderer-update',directory=>{
    const reportFile=path.join(directory,'AutotagReport.js');
    const legacyReport="const React=require('react');\n"+
      "exports.MynAutotagReport=({video})=><p>{video.taggingEvidence.imdbID} {video.taggingEvidence.seriesID}</p>;\n";
    const timestamp=new Date('2020-01-01T00:00:00Z');
    const writeReport=source=>{fs.writeFileSync(reportFile,source);fs.utimesSync(reportFile,timestamp,timestamp);};
    const cacheFile=path.join(directory,'babel-cache.json');
    const launch=mode=>{
      const env={...process.env,BABEL_CACHE_PATH:cacheFile};delete env.BABEL_DISABLE_CACHE;
      const child=spawnSync(process.execPath,[path.join(__dirname,'helpers/RendererStartupProbe.js'),
        path.join(root,'src/renderer/index.html'),reportFile,mode],{cwd:directory,env,encoding:'utf8',timeout:20000});
      assert.ifError(child.error);assert.strictEqual(child.status,0,child.stderr);
      return JSON.parse(child.stdout).markup;
    };
    writeReport(legacyReport);
    const before=launch('legacy-cache');
    assert(before.includes('tt7654321'));assert(!before.includes('<a'));
    assert(fs.existsSync(cacheFile),'The negative control must actually warm the disk cache');
    writeReport(fs.readFileSync(path.join(root,'src/renderer/AutotagReport.js'),'utf8'));
    assert.strictEqual(launch('legacy-cache'),before,'Reproduce the stale renderer from a same-timestamp overlay');
    const updated=launch('current');
    for (const id of ['tt7654321','tt1234567']) assert.match(updated,
      new RegExp('<a[^>]+href="https://www\\.imdb\\.com/title/'+id+'/"[^>]*>'+id+'</a>'));
    // A second replacement with identical mtime must also be loaded, without
    // needing a manually bumped release number or clearing a user's files.
    writeReport(legacyReport.replace('<p>','<strong>').replace('</p>','</strong>'));
    assert.match(launch('current'),/^<strong>/);
  });
});

runSuite(suite);
