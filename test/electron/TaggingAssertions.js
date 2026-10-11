const assert = require('assert');
const fs = require('fs');
function matched(video, imdbID, parent) {
  assert.strictEqual(video.imdbID,imdbID,video.title);
  if (parent) assert.strictEqual(video.seriesImdbID,parent);
  assert(video.taggingEvidence, 'Missing match evidence');
  assert(['movie','episode','explicit-id'].includes(video.taggingEvidence.kind), 'Missing completed match kind');
  assert(!video.taggingDecision || video.taggingDecision.status === 'matched', 'An old failure survived a match');
}
function unchangedPersonal(video) {
  assert.strictEqual(video.ratings.user,4);
  assert.strictEqual(video.seen,true);
  assert.strictEqual(video.watchlater,true);
  assert.strictEqual(video.position,42);
}
function artwork(video) {
  assert(video.artwork && fs.statSync(video.artwork).size > 0,'Downloaded artwork must exist on disk');
  assert(!/^https?:/.test(video.artwork),'Saved artwork must be local');
}
function verify(scenario, videos) {
  const [a,b,c] = videos;
  if (scenario === 'movies') {
    matched(a,'tt19000001'); artwork(a); unchangedPersonal(a);
    assert.deepStrictEqual(a.ratings,{user:4,imdb:7.8,rt:84,mc:72});
    assert.strictEqual(a.new,false);
    for (const video of [b,c]) {
      assert.strictEqual(video.imdbID,''); assert(video.taggingDecision.reason.code);
      assert.strictEqual(video.description,'Original description'); assert.strictEqual(video.new,true);
    }
    assert.strictEqual(b.taggingDecision.status,'ambiguous');
  } else if (scenario === 'episode-parents') {
    matched(a,'tt19000201','tt19000101'); matched(b,'tt19000202','tt19000101');
    assert.strictEqual(c.imdbID,''); assert(c.taggingDecision.reason.code);
  } else if (scenario === 'episode-numbering') {
    videos.forEach((video,index) => {
      matched(video,'tt1900021' + (index+1),'tt19000103');
      assert.strictEqual(String(video.season),'1'); assert.strictEqual(String(video.episode),String(index+1));
      assert.strictEqual(String(video.taggingEvidence.requested.season),'1');
      assert.strictEqual(String(video.taggingEvidence.matched.season),'2');
      assert.strictEqual(String(video.taggingEvidence.original.season),'1');
    });
  } else if (scenario === 'manual') {
    matched(a,'tt19000002'); matched(b,'tt19000221','tt19000104'); artwork(a); artwork(b);
    assert.strictEqual(a.new,true); assert.strictEqual(b.new,true); unchangedPersonal(a);
    assert.strictEqual(a.taggingEvidence.identities.record.origin,'user');
  } else if (scenario === 'batch') {
    for (const [index,video] of [a,b].entries()) {
      assert.strictEqual(video.country,''); assert.strictEqual(video.artwork,'');
      assert.strictEqual(video.ratings.user,3);
      assert.deepStrictEqual(video.cast,[index === 0 ? 'Alpha Cast' : 'Beta Cast','Added Cast']);
      assert(video.tags.includes(index === 0 ? 'alpha' : 'beta')); assert(video.tags.includes('added'));
      assert(!video.tags.includes('common'));
      assert.strictEqual(video.title,index === 0 ? 'Batch Alpha' : 'Batch Beta');
    }
    assert.strictEqual(c.country,'Original country'); assert.strictEqual(c.ratings.user,4);
  } else if (scenario === 'selected') {
    matched(a,'tt19000231','tt19000105'); matched(b,'tt19000232','tt19000105');
    assert.strictEqual(a.new,true); assert.strictEqual(b.new,true);
    assert.strictEqual(a.taggingEvidence.identities.series.origin,'user');
    assert.strictEqual(c.imdbID,''); assert.strictEqual(c.autotag_tried,false);
  } else if (scenario === 'concurrency') {
    assert.strictEqual(a.title,'My corrected title'); assert.strictEqual(a.imdbID,'');
    assert.strictEqual(a.taggingDecision.reason.code,'changed-during-lookup');
    assert.strictEqual(a.autotag_tried,false); assert.strictEqual(b.title,'Untouched Control');
  } else if (scenario === 'failures') {
    for (const video of videos.slice(0,3)) {
      assert.strictEqual(video.taggingDecision.status,'service-error'); assert.strictEqual(video.autotag_tried,false);
      assert.strictEqual(video.imdbID,''); assert.strictEqual(video.description,'Original description');
    }
    matched(videos[3],'tt19000008'); assert.strictEqual(videos[3].artwork,'');
  } else if (scenario === 'cancel') {
    matched(a,'tt19000006'); assert.strictEqual(b.imdbID,''); assert.strictEqual(b.autotag_tried,false);
    assert(!b.taggingDecision,'Unprocessed video must not acquire a failure');
  } else if (scenario === 'disk-full') {
    matched(a,'tt19000009'); matched(b,'tt19000010');
  } else if (scenario === 'live') {
    matched(a,'tt0133093'); matched(b,'tt2543164'); artwork(a); artwork(b);
    for (const video of videos.slice(2)) {
      assert(/^tt\d+$/.test(video.imdbID)); assert.strictEqual(video.seriesImdbID,'tt0903747');
      assert.strictEqual(String(video.season),'1'); assert(video.taggingEvidence);
    }
    assert.notStrictEqual(videos[2].imdbID,videos[3].imdbID);
    assert.strictEqual(String(videos[2].episode),'1'); assert.strictEqual(String(videos[3].episode),'2');
    for (const video of videos) {
      unchangedPersonal(video); assert(typeof video.description === 'string' && video.description.length > 0);
      for (const [source,max] of [['imdb',10],['rt',100],['mc',100]]) {
        if (video.ratings[source] !== '' && video.ratings[source] != null)
          assert(Number(video.ratings[source]) >= 0 && Number(video.ratings[source]) <= max);
      }
    }
  } else throw new Error('No assertions for scenario: ' + scenario);
}
module.exports = {verify,matched,artwork,unchangedPersonal};
