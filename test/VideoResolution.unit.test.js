const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {RESOLUTION_TIERS, RESOLUTION_BUCKETS, getResolutionInfo} = require('../src/media/VideoResolution.js');

const suite = createSuite('Shared video resolution buckets', 'unit',
  'Protects common sizes, exact cutoffs, cropped/portrait/anamorphic video, unreliable metadata, and numeric ranks.');

function label(width, height, extra = {}) {
  return getResolutionInfo({width, height, ...extra}).label;
}

suite.test('uses one ordered catalog from 8K down to Unknown', () => {
  assert.deepStrictEqual(RESOLUTION_BUCKETS, [
    '8K', '4K', '1440p', '1080p', '720p', '576p', '480p', '360p', '240p', 'Below 240p', 'Unknown'
  ]);
  assert.deepStrictEqual(RESOLUTION_TIERS.map(tier => tier.rank), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1]);
  assert(Object.isFrozen(RESOLUTION_TIERS) && RESOLUTION_TIERS.every(Object.isFrozen));
});

suite.test('classifies the common HD and SD frame sizes, including 4:3 and PAL', () => {
  [
    [7680,4320,'8K'], [3840,2160,'4K'], [2560,1440,'1440p'], [1920,1080,'1080p'],
    [1440,1080,'1080p'], [1280,720,'720p'], [1024,576,'576p'], [720,576,'576p'],
    [720,480,'480p'], [640,480,'480p'], [640,360,'360p'], [426,240,'240p'],
    [320,240,'240p'], [256,144,'Below 240p']
  ].forEach(([width,height,expected]) => assert.strictEqual(label(width,height), expected, `${width}x${height}`));
});

suite.test('includes the agreed threshold and rejects the pixel immediately below it on each axis', () => {
  // Independent, reviewable cutoffs; these deliberately do not derive from
  // the production table, so an accidental threshold change fails this test.
  [
    ['8K',7296,4104], ['4K',3648,2052], ['1440p',2432,1368], ['1080p',1824,1026],
    ['720p',1216,684], ['576p',973,548], ['480p',812,456], ['360p',608,342], ['240p',405,228]
  ].forEach(([expected,long,short]) => {
    assert.strictEqual(label(short,short), expected);
    assert.notStrictEqual(label(short-1,short-1), expected);
    const croppedHeight = Math.ceil(long / 2.4);
    assert.strictEqual(label(long,croppedHeight), expected);
    assert.notStrictEqual(label(long-1,croppedHeight), expected);
  });
});

suite.test('keeps normally cropped movies in their expected class', () => {
  assert.strictEqual(label(1920,800), '1080p');
  assert.strictEqual(label(1280,534), '720p');
  assert.strictEqual(label(3840,1600), '4K');
  assert.strictEqual(label(7680,3200), '8K');
  assert.strictEqual(label(4096,1716), '4K');
});

suite.test('classifies portrait frames consistently and limits extreme panoramic width', () => {
  assert.strictEqual(label(1080,1920), '1080p');
  assert.strictEqual(label(480,854), '480p');
  assert.strictEqual(label(3440,1440), '1440p');
  assert.strictEqual(label(3840,1080), '1080p');
  assert.strictEqual(label(1080,3840), '1080p');
  assert.strictEqual(label(3840,1280), '4K'); // Exactly 3:1 still permits the width rule.
  assert.strictEqual(label(3840,1279), '1080p');
});

suite.test('uses pixel aspect ratio or older stored display aspect ratio for anamorphic video', () => {
  assert.strictEqual(label(720,360,{sample_aspect_ratio:'32:27'}), '480p');
  assert.strictEqual(label(720,432,{sample_aspect_ratio:'64:45'}), '576p');
  assert.strictEqual(label(720,360,{aspect_ratio:'64:27'}), '480p');
  assert.strictEqual(label(720,432,{aspect_ratio:'64:27'}), '576p');
  assert.strictEqual(label(352,576,{aspect_ratio:'4:3'}), '576p');
  assert.strictEqual(label(1440,1080,{sample_aspect_ratio:'4/3'}), '1080p');
  // A known square-pixel ratio takes precedence over a contradictory DAR.
  assert.strictEqual(label(640,360,{sample_aspect_ratio:'1:1',aspect_ratio:'4:1'}), '360p');
});

suite.test('ignores unusable aspect ratios without inventing a stretched resolution', () => {
  ['N/A','0:0','1:0','-1:2',Infinity,{},'broken'].forEach(aspect_ratio => {
    assert.strictEqual(label(1920,800,{aspect_ratio}), '1080p');
  });
  assert.strictEqual(label('640','480'), '480p');
});

suite.test('returns Unknown for bad dimensions and unverified artwork metadata', () => {
  [null,undefined,{}, {width:0,height:1080}, {width:1920,height:-1}, {width:NaN,height:1080},
    {width:Infinity,height:1080}, {width:'1920junk',height:1080}, {width:true,height:1080},
    {width:[1920],height:1080}, {width:1920.5,height:1080}].forEach(metadata => {
    assert.strictEqual(getResolutionInfo(metadata).rank, -1);
  });
  assert.strictEqual(label(2000,3000,{codec:'mjpeg'}), 'Unknown');
  assert.strictEqual(label(1920,1080,{codec:'h264',video_stream_selected:false}), 'Unknown');
  assert.strictEqual(label(640,480,{codec:'mjpeg',video_stream_selected:true}), '480p');
});

suite.test('retains exact stored dimensions for hover text without changing metadata', () => {
  const metadata = Object.freeze({width:720,height:432,sample_aspect_ratio:'64:45'});
  const info = getResolutionInfo(metadata);
  assert.strictEqual(info.title, '720 × 432 pixels (display 1024 × 432)');
  assert.strictEqual(info.label, '576p');
  assert.strictEqual(getResolutionInfo({width:1920,height:800}).title, '1920 × 800 pixels');
  assert.strictEqual(getResolutionInfo(null).title, 'Resolution unavailable');
});

runSuite(suite);
