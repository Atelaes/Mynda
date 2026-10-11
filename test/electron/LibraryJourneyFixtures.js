const assert = require('assert');
const path = require('path');

// Actual scheme-2 fingerprints of the three tiny, deterministic fixture files.
const ids = ['824025dafcaeaff5f3f845f5042d1ecfbcec2842b1d4e832905cb802a59f0543',
  '34e11df5b16c05e593962db60a053a6bb98eb0fc0a502606928384c13d7990ba',
  'ee9c2fc818545df608bace9de5ce625bdf481d3df3ded2fa921818e20af48f83'];
const expected = {rating:4, description:'Manual description during scan',
  title:'Personal Alpha', country:'Shared test country', position:321.3,
  cast:['Avery Example','Morgan Sample']};

function videos(directory) {
  return ids.map((id,index)=>({id,title:['Alpha','Beta','Gamma'][index],year:2000+index,
    kind:'movie',series:'',season:'',episode:'',seriesImdbID:'',imdbID:'',
    director:'Fixture Director',directorsort:'Director, Fixture',cast:[],
    description:'Original '+index,genre:'Drama',tags:['fixture-'+index],seen:false,new:true,
    position:0,ratings:{user:'',imdb:8,rt:80,mc:70},dateadded:1700000000+index,lastseen:'',
    filename:path.join(directory,`fixture-${index}.mkv`),duplicates:[],artwork:'',subtitles:[],
    boxoffice:'',rated:'',languages:['English'],country:'Original country '+index,
    metadata:{checked:true,video_stream_checked:true,duration:7200,width:1920,height:1080,codec:'h264'},
    autotag_tried:index!==0,dvd:false,watchlater:false}));
}

function assertSaved(data) {
  const first=data.media.find(video=>video.id===ids[0]);
  const second=data.media.find(video=>video.id===ids[1]);
  const third=data.media.find(video=>video.id===ids[2]);
  assert.strictEqual(data.media.length,3);
  assert.strictEqual(first.title,expected.title);
  assert.strictEqual(first.description,expected.description);
  assert.strictEqual(first.ratings.user,expected.rating);
  assert.deepStrictEqual(first.cast,expected.cast);
  assert.strictEqual(first.ratings.imdb,8,'Manual rating must not change the catalog rating');
  assert.strictEqual(first.metadata.width,3840,'Scan metadata must survive manual saves');
  assert.strictEqual(first.taggingDecision.reason.code,'changed-during-lookup');
  assert.strictEqual(first.autotag_tried,false,'Conflicting Auto-Tag result stays retryable');
  assert.strictEqual(first.country,expected.country);
  assert.strictEqual(second.country,expected.country);
  assert.strictEqual(second.title,'Beta');
  assert.deepStrictEqual(second.tags,['fixture-1']);
  assert.strictEqual(third.country,'Original country 2','Batch must not change unselected videos');
  assert.strictEqual(third.title,'Gamma');
  assert.strictEqual(first.position,expected.position);
  assert.strictEqual(data.recently_watched[0],ids[0]);
  assert.strictEqual(data.settings.preferences.exclude_samples_from_library,false);
  assert.strictEqual(data.settings.preferences.exclude_trailers_from_library,false);
}

module.exports={ids,expected,videos,assertSaved};
