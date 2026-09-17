const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const Match = require('../src/tagging/EpisodeMatch.js');
const corpus = require('./fixtures/EpisodeTitleCorpus.json');

const suite = createSuite('Episode title and runtime sanity checks', 'unit',
  'Checks current tags, strict correction rules, optional duration probes, and real title fixtures from both libraries.');
const state = (a, b, series) => Match.assessEpisodeTitle(a, b, series).state;

for (const source of ['Torgo', 'Atelaes']) {
  suite.test(`replays every reviewed ${source} title pair`, () => {
    const pairs = corpus.pairs.filter(pair => pair.source === source);
    assert.strictEqual(pairs.length, source === 'Torgo' ? 2573 : 84);
    for (const pair of pairs) {
      const actual = state(pair.localTitle, pair.omdbTitle, pair.series);
      const label = `${source}: ${pair.series} S${pair.season}E${pair.episode}: ${pair.localTitle} -> ${pair.omdbTitle}`;
      if (pair.expected === 'reject') assert.strictEqual(actual, 'contradiction', label);
      else assert.notStrictEqual(actual, 'contradiction', label);
      if (pair.expected === 'requiresConfirmedSeries') {
        assert.strictEqual(Match.usefulEpisodeTitle(pair.omdbTitle), null, label);
      }
    }
  });
}

suite.test('keeps strict corrections narrower than the forgiving acceptance check', () => {
  for (const [a, b] of [['The Litch', 'The Lich'], ['Election', 'Election Day'],
    ['Unification Part 1', 'Unification I'], ['The Clip Show', 'The Chronicle']]) {
    assert.notStrictEqual(state(a, b, 'Seinfeld'), 'contradiction');
    assert.strictEqual(Match.episodeTitlesMatch(a, b), false);
  }
});

suite.test('preserves the ER suffix and Heroes chapter fixes in strict matching', () => {
  for (const [a, b] of [['Home FS', 'Home'], ['John Carter M D WS', 'John Carter, M.D.'],
    ['Day One FS AC3', 'Day One'], ['Going Home FS DVD-SFM', 'Going Home'],
    ['Genesis', "Chapter One 'Genesis'"], ['Collision', 'Chapter Four: Collision']]) {
    assert.strictEqual(Match.episodeTitlesMatch(a, b), true, `${a} -> ${b}`);
  }
  assert.strictEqual(Match.episodeTitlesMatch('Home fan edit', 'Home'), false);
  assert.strictEqual(Match.episodeTitlesMatch('Home commentary', 'Home'), false);
});

suite.test('never treats different part numbers as spelling mistakes', () => {
  for (const [a, b] of [['Workforce Part 1', 'Workforce, Part II'],
    ['Unification I', 'Unification II'], ['Islands Part 2: Dragon', 'Islands Part 3: Dragon'],
    ['Islands Part Two: Dragon', 'Islands Part Three: Dragon'], ['Day 12', 'Day 13']]) {
    assert.strictEqual(state(a, b), 'contradiction', `${a} -> ${b}`);
  }
});

suite.test('allows equivalent part labels and split pilot naming', () => {
  for (const [a, b] of [['Pilot Pt.1', 'Pilot'], ['Pilot Pt.2', 'Pilot'],
    ['The Shining Beacon Part 1', 'The Shining Beacon'], ['Unification Part 2', 'Unification II']]) {
    assert.strictEqual(state(a, b), 'compatible');
  }
});

suite.test('treats missing, generic, different-script and oversized titles as inconclusive', () => {
  for (const title of ['', 'N/A', 'Episode #1.1', 'Episode 01', 'TBA', 'S01E01']) {
    assert.strictEqual(Match.usefulEpisodeTitle(title), null, title);
    assert.strictEqual(state(title, 'A Real Title'), 'inconclusive');
  }
  assert.strictEqual(Match.usefulEpisodeTitle('Heroes S01E01 1080p', 'Heroes'), null);
  assert.strictEqual(state('你好世界', 'A Real Title'), 'inconclusive');
  assert.strictEqual(state('a'.repeat(10000), 'A Real Title'), 'inconclusive');
  assert.strictEqual(Match.usefulEpisodeTitle('Home'), 'Home');
});

suite.test('recognizes bonus labels even against generic episode results', () => {
  assert.strictEqual(state('Loglady', 'Episode #2.1'), 'contradiction');
  assert.strictEqual(state('Loglady', 'Coma'), 'contradiction');
  assert.strictEqual(state('Loglady', 'Loglady'), 'compatible');
  assert.strictEqual(state('Behind the Scenes', 'Different Episode'), 'contradiction');
});

suite.test('release-only tags are inconclusive without hiding edited episode titles', () => {
  for (const [title,series] of [
    ['Better.Call.Saul.S02E01.720p.BluRay.x264.ShAaNiG','Better Call Saul'],
    ['friends_s01e02_720p_bluray_x264-sujaidr','Friends'],
    ['WandaVision.S01E01.720p.DSNP.WEBRip.x264-GalaxyTV','WandaVision'],
    ['bob.ep01.dvdrip.xvid-deity','Band of Brothers']
  ]) assert.strictEqual(Match.usefulEpisodeTitle(title,series),null,title);
  for (const title of ['Heroes S01E01 Genesis 1080p','Heroes S01E01 Loglady 1080p',
    'Heroes S01E01 My Edited Title','Heroes S01E01 1080p fan edit',
    'Heroes S01E01 1080p My Edited Title','Heroes 1080p My Edited Title S01E01',
    'Heroes S01E01 1080p-fan-edit','Heroes S01E01 1080p [fan edit]']) {
    assert.strictEqual(Match.usefulEpisodeTitle(title,'Heroes'),title);
  }
  assert.strictEqual(Match.usefulEpisodeTitle('Elfen Lied - Vector 1','Elfen Lied',{dvd:true}),null);
  assert.strictEqual(Match.usefulEpisodeTitle('Elfen Lied - Vector 1','Elfen Lied'), 'Elfen Lied - Vector 1');
});

suite.test('keeps the reviewed Seinfeld alias scoped to that series', () => {
  assert.strictEqual(state('The Clip Show', 'The Chronicle', 'Seinfeld'), 'compatible');
  assert.strictEqual(state('The Clip Show', 'The Chronicle', 'Another Show'), 'contradiction');
});

const runtime = (local, remote, extra = {}) => Match.assessEpisodeRuntime({
  title: 'A Real Episode', metadata: {duration: local * 60}, ...extra
}, {Runtime: remote});

suite.test('rejects only gross runtime conflicts in either direction', () => {
  assert.strictEqual(runtime(2, '45 min').state, 'contradiction');
  assert.strictEqual(runtime(45, '2 min').state, 'contradiction');
  assert.strictEqual(runtime(1, '7 min').state, 'contradiction');
});

suite.test('preserves short cartoons, ordinary edits, half pilots and double episodes', () => {
  for (const [local, remote] of [[43,45], [21,24], [22,44], [44,22], [3,3], [1,5], [10,40]]) {
    assert.strictEqual(runtime(local, `${remote} min`).state, 'compatible', `${local}/${remote}`);
  }
});

suite.test('does not infer a mismatch from missing duration or incomparable media', () => {
  assert.strictEqual(runtime(0, '45 min').state, 'inconclusive');
  assert.strictEqual(runtime(45, 'N/A').state, 'inconclusive');
  assert.strictEqual(runtime(NaN, '45 min').state, 'inconclusive');
  assert.strictEqual(runtime(2, '45 min', {dvd: true}).state, 'inconclusive');
  assert.strictEqual(runtime(2, '45 min', {title: 'Pilot Pt.1'}).state, 'inconclusive');
  assert.strictEqual(runtime(90, '11 min', {title: '10.14 - 10.15 - Finale'}).state, 'inconclusive');
});

const quietLogger = {child: () => ({debug() {}})};
function durationReader(options = {}) {
  const Runtime = loadFreshWithMocks(path.join(__dirname, '../src/tagging/EpisodeRuntime.js'), {
    '../media/MediaTools.js': {probeFile() { throw new Error('Unexpected real probe'); }},
    '../platform/Logger.js': quietLogger
  });
  return Runtime.createDurationReader(options);
}

suite.test('probes missing duration once, with a timeout, without mutating tags', async () => {
  let calls = 0;
  const read = durationReader({probe: async (filename, options) => {
    calls++; assert.strictEqual(filename, 'some-media.mkv');
    assert.strictEqual(options.timeout, 7000);
    return {format: {duration: '2700'}, streams: [{codec_type: 'video'}]};
  }});
  const video = {id: 'one', filename: 'some-media.mkv', title: 'Edited Title', series: 'Edited Series', metadata: {width: 1920}};
  const [a, b] = await Promise.all([read(video, {Runtime:'45 min'}), read(video, {Runtime:'45 min'})]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(a.metadata.duration, 2700);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.title, 'Edited Title');
  assert.strictEqual(a.series, 'Edited Series');
  assert.deepStrictEqual(video.metadata, {width: 1920});
});

suite.test('does not probe stored durations, DVDs or catalog entries without duration', async () => {
  const read = durationReader({probe: () => { throw new Error('Should not probe'); }});
  for (const [video, data] of [
    [{filename:'one', metadata:{duration:2700}}, {Runtime:'45 min'}],
    [{filename:'dvd', dvd:true}, {Runtime:'45 min'}], [{filename:'one'}, {Runtime:'N/A'}]
  ]) assert.strictEqual(await read(video, data), video);
});

suite.test('allows a failed probe, suppresses immediate retries, and retries after expiry', async () => {
  let calls = 0, time = 1000;
  const read = durationReader({now: () => time, probe: async () => {calls++; throw new Error('Unavailable drive');}});
  const video = {filename:'unavailable.mkv'};
  assert.strictEqual(await read(video, {Runtime:'45 min'}), video);
  await read(video, {Runtime:'45 min'}); assert.strictEqual(calls, 1);
  time += 60001;
  await read(video, {Runtime:'45 min'}); assert.strictEqual(calls, 2);
});

suite.test('recognizes all 198 observed release labels without weakening real title contradictions', () => {
  const recovery = require('./fixtures/UnmatchedShowRecovery.json');
  assert.strictEqual(recovery.releaseLabels.length, 198);
  for (const item of recovery.releaseLabels) {
    assert.strictEqual(Match.usefulEpisodeTitle(item.video.title, item.video.series), null, item.video.title);
    assert.strictEqual(state(item.video.title, item.catalogTitle, item.video.series), 'inconclusive');
    assert.strictEqual(Match.episodeTitlesMatch(item.video.title, item.catalogTitle), false);
  }
  for (const item of recovery.protectedPairs) {
    assert.strictEqual(state(item.video.title, item.catalogTitle, item.video.series), 'contradiction');
  }
  for (const title of ['Friends S01E01 The Wrong Episode 1080p', 'An Edited Title',
    'Home commentary', 'Wrong Series S01E01 A Real Title']) {
    assert.strictEqual(Match.usefulEpisodeTitle(title, 'Friends'), title);
  }
});

suite.test('keeps numerical titles and short acronym titles as evidence without inventing Roman parts', () => {
  assert.strictEqual(Match.usefulEpisodeTitle('11001001'), '11001001');
  assert.strictEqual(state('11001001', 'Too Short a Season'), 'contradiction');
  assert.strictEqual(state('11001001', '11001001'), 'compatible');
  assert.strictEqual(state('LA X', 'LA X: Part 1', 'Lost'), 'compatible');
  assert.strictEqual(state('Workforce Part 1', 'Workforce Part II'), 'contradiction');
  assert.strictEqual(state('Unification I', 'Unification II'), 'contradiction');
});

suite.test('normalizes structured Doctor Who titles while preserving parts, edits, and clips', () => {
  assert.strictEqual(Match.usefulEpisodeTitle('The Daleks Pt 1 The Dead Planet', 'Dr Who'), 'The Dead Planet');
  assert.strictEqual(Match.usefulEpisodeTitle('The Smugglers Pt 2 [missing]', 'Doctor Who'), 'The Smugglers: Episode 2');
  assert.strictEqual(state('The Smugglers Pt 2 [missing]', 'The Smugglers: Episode 3', 'Dr Who'), 'contradiction');
  assert.strictEqual(Match.usefulEpisodeTitle('Story Pt 2 Specific Title', 'Another Show'), 'Story Pt 2 Specific Title');
  assert.strictEqual(state('Pilot Loglady', 'Pilot', 'Twin Peaks'), 'contradiction');
  assert.strictEqual(state('The Smugglers - Surviving Clips', 'The Smugglers: Episode 4', 'Dr Who'), 'contradiction');
  assert.strictEqual(Match.episodeTitlesMatch('RevengeOfTheCreature Vol25 Shout', 'Revenge of the Creature'), true);
  assert.strictEqual(Match.episodeTitlesMatch('Home unknown Shout', 'Home'), false);
});

runSuite(suite);
