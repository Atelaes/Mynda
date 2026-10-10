const {EventEmitter} = require('events');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {createPlaybackService} = require('../src/main/PlaybackService');

const suite = createSuite('Main-process playback ownership', 'unit',
  'Exercises authoritative video lookup, process races, playback events and confirmed persistence without starting MPV.');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const events = [], players = [], writes = [], timers = [], played = [], stops = [];
  const first = Object.freeze({id: 'video-a', filename: '/library/first.mkv', title: 'First', position: 25,
    metadata: {duration: 3000}, subtitles: ['/library/first.srt']});
  const second = Object.freeze({...first, id: 'video-b', filename: '/library/second.mkv', title: 'Second'});
  const library = {media: [first, second], settings: {watchfolders: []},
    patchMedia(id, changes, expected) {
      return new Promise((resolve, reject) => writes.push({id, changes, expected,
        finish(error) {
          if (error) {reject(error); return;}
          const current = library.media.find(video => video && video.id === id);
          if (current.position !== expected.position) {
            reject(Object.assign(new Error('Position changed'), {code: 'LIBRARY_CONFLICT'})); return;
          }
          library.media = library.media.map(video => video && video.id === id ? Object.freeze({...video, ...changes}) : video);
          resolve();
        }}));
    }, recordPlayed(id) {played.push(id); return Promise.resolve();}};
  class FakePlayer extends EventEmitter {
    constructor(config, args) {super(); this.config = config; this.args = args; this.calls = []; players.push(this);}
    async load(filename) {this.calls.push(['load', filename]);}
    async goToPosition(position) {this.calls.push(['resume', position]);}
    async addSubtitles(subtitle) {this.calls.push(['subtitles', subtitle]);}
    async play() {this.calls.push(['play']);}
  }
  const service = createPlaybackService({library, Player: FakePlayer,
    tools: {mpvPath: '/bundled/mpv'}, inspectTarget: () => ({available: true}),
    publish: value => events.push(value), setTimer(fn, ms) {const timer = {fn, ms}; timers.push(timer); return timer;},
    clearTimer(timer) {if (timer) timer.cleared = true;},
    processTools: {startMpvPlayer: async () => {}, stopMpvPlayer: player => stops.push(player),
      withMpvDiagnostics: error => error}, ...options});
  async function begin(id = first.id) {service.play(id); await tick(); return players[players.length - 1];}
  async function finish() {
    const stopping = service.stop();
    await tick();
    while (writes.length) {writes.shift().finish(); await tick();}
    await stopping;
  }
  return {service, library, events, players, writes, timers, played, stops, begin, finish};
}

suite.test('accepts only existing video IDs and resolves executable, path, resume and subtitles in main', async () => {
  const f = fixture();
  for (const value of [null, {}, {id: 'video-a', filename: '/other/file'}, '/other/file', 'unknown', '']) {
    assert.throws(() => f.service.play(value));
  }
  assert.strictEqual(f.players.length, 0);
  const player = await f.begin();
  assert.strictEqual(player.config.binary, '/bundled/mpv');
  assert.deepStrictEqual(player.calls, [['load', '/library/first.mkv'], ['resume', 25],
    ['subtitles', '/library/first.srt'], ['play']]);
  assert.strictEqual(f.service.getState().status, 'playing');
  assert(!Object.prototype.hasOwnProperty.call(f.service.getState(), 'filename'));
  await f.finish();
});

suite.test('patches only position, coalesces ticks and preserves concurrent title edits', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 10); player.emit('timeposition', 20); player.emit('seek', {end: 30.04});
  assert.strictEqual(f.library.media[0].position, 25);
  assert.strictEqual(f.writes.length, 1);
  const first = f.writes.shift();
  assert.deepStrictEqual(first.changes, {position: 10});
  f.library.media = f.library.media.map(video => Object.freeze({...video, title: 'Manual edit'}));
  first.finish(); await tick();
  assert.strictEqual(f.writes.length, 1);
  const last = f.writes.shift();
  assert.deepStrictEqual(last.changes, {position: 30});
  assert.deepStrictEqual(last.expected, {position: 10});
  last.finish(); await tick();
  assert.strictEqual(f.library.media[0].position, 30);
  assert.strictEqual(f.library.media[0].title, 'Manual edit');
  await f.finish();
});

suite.test('plays and saves a known video after legacy null library slots', async () => {
  const f = fixture();
  f.library.media = [null, ...f.library.media];
  const player = await f.begin();
  assert.strictEqual(f.service.getState().status, 'playing');
  player.emit('timeposition', 90);
  assert.strictEqual(f.writes.length, 1);
  f.writes.shift().finish(); await tick();
  assert.strictEqual(f.library.media[0], null);
  assert.strictEqual(f.library.media[1].position, 90);
  await f.finish();
});

suite.test('does not retry queued ticks across a conflicting manual position reset', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 10); player.emit('timeposition', 20);
  f.library.media = f.library.media.map(video => Object.freeze({...video, position: 0}));
  f.writes.shift().finish(Object.assign(new Error('Position reset'), {code: 'LIBRARY_CONFLICT'}));
  await tick();
  assert.strictEqual(f.writes.length, 0);
  assert.strictEqual(f.library.media[0].position, 0);
  assert(f.events.some(event => event.saveError && event.saveError.includes('Position reset')));
  // A genuinely later playback tick can save again with the new expectation.
  player.emit('timeposition', 35);
  assert.deepStrictEqual(f.writes[0].expected, {position: 0});
  f.writes.shift().finish(); await tick();
  await f.finish();
});

suite.test('shutdown drains a coalesced tick after an active position save', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 20); player.emit('timeposition', 30);
  let completed = false;
  const closing = f.service.stop().then(() => {completed = true;});
  f.writes.shift().finish(); await tick();
  assert.strictEqual(completed, false);
  assert.strictEqual(f.writes.length, 1);
  assert.deepStrictEqual(f.writes[0].changes, {position: 30});
  f.writes.shift().finish(); await closing;
  assert.strictEqual(completed, true);
  assert.strictEqual(f.library.media[0].position, 30);
  assert(f.timers[0].cleared);
  assert.strictEqual(player.listenerCount('timeposition'), 0);
});

suite.test('only counts uninterrupted successful playback after the ten-second timer', async () => {
  const f = fixture(); await f.begin();
  assert.deepStrictEqual(f.played, []);
  assert.strictEqual(f.timers[0].ms, 10000);
  f.timers[0].fn(); await tick();
  assert.deepStrictEqual(f.played, ['video-a']);
  await f.finish();
  await f.begin('video-b');
  const second = f.timers[1];
  await f.finish();
  second.fn();
  assert.deepStrictEqual(f.played, ['video-a']);
});

suite.test('normal completion resets positions near beginning and end without duplicate quit writes', async () => {
  for (const position of [2, 2995]) {
    const f = fixture(); const player = await f.begin();
    player.emit('timeposition', position);
    f.writes.shift().finish(); await tick();
    player.emit('stopped');
    assert.deepStrictEqual(f.writes[0].changes, {position: 0});
    f.writes.shift().finish(); await tick();
    player.emit('quit');
    assert.strictEqual(f.service.getState().status, 'closed');
    assert.strictEqual(f.writes.length, 0);
    await f.finish();
  }
});

suite.test('ignores events from a replaced player and cancels startup before it can restore old state', async () => {
  let finishStart;
  const f = fixture({processTools: {startMpvPlayer: () => new Promise(resolve => {finishStart = resolve;}),
    stopMpvPlayer() {}, withMpvDiagnostics: error => error}});
  f.service.play('video-a'); await tick();
  const old = f.players[0]; const firstStart = finishStart;
  f.service.play('video-b'); await tick();
  finishStart(); await tick();
  assert.strictEqual(f.service.getState().videoId, 'video-b');
  assert.strictEqual(f.service.getState().status, 'playing');
  firstStart(); await tick();
  assert.deepStrictEqual(old.calls, []);
  old.emit('timeposition', 500); old.emit('quit');
  assert.strictEqual(f.writes.length, 0);
  assert.strictEqual(f.service.getState().status, 'playing');
  await f.finish();
});

suite.test('canceling before the startup microtask does not construct a player', async () => {
  const f = fixture();
  f.service.play('video-a');
  await f.service.stop(); await tick();
  assert.strictEqual(f.players.length, 0);
});

suite.test('rejects unsupported DVDs before constructing MPV', async () => {
  const f = fixture({supportsDvd: async () => false});
  f.library.media = [Object.freeze({...f.library.media[0], dvd: true})];
  await f.begin();
  assert.strictEqual(f.players.length, 0);
  assert(f.service.getState().errorMessage.includes('does not include DVD playback support'));
  await f.finish();
});

suite.test('surfaces startup errors and does not mark failed playback as recently played', async () => {
  const f = fixture({processTools: {startMpvPlayer: async () => {throw new Error('Failed to launch');},
    stopMpvPlayer() {}, withMpvDiagnostics: error => error}});
  await f.begin();
  assert.strictEqual(f.service.getState().status, 'error');
  assert(f.service.getState().errorMessage.includes('Failed to launch'));
  assert.strictEqual(f.timers.length, 0);
  assert.deepStrictEqual(f.played, []);
  await f.finish();
});

suite.test('shutdown rejects a disk-full position commit instead of reporting a successful save', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 90);
  const closing = f.service.stop();
  f.writes.shift().finish(Object.assign(new Error('Disk full'), {code: 'ENOSPC'}));
  await assert.rejects(closing, error => error.code === 'ENOSPC');
  assert(f.events.some(event => event.saveError && event.saveError.includes('Disk full')));
  assert.strictEqual(f.writes.length, 0);
});

suite.test('a later Wait retries one failed disk write and closes after space is freed', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 90); player.emit('seek', {end: 105});
  const firstClose = f.service.stop();
  f.writes.shift().finish(Object.assign(new Error('Disk full'), {code: 'ENOSPC'}));
  await assert.rejects(firstClose, error => error.code === 'ENOSPC');
  await tick(); assert.strictEqual(f.writes.length, 0, 'Failure must not start a retry loop');
  const retry = f.service.stop();
  assert.strictEqual(f.writes.length, 1);
  assert.deepStrictEqual(f.writes[0].changes, {position: 105});
  assert.deepStrictEqual(f.writes[0].expected, {position: 25});
  f.writes.shift().finish(); await retry;
  assert.strictEqual(f.library.media[0].position, 105);
  await f.service.stop();
  assert.strictEqual(f.writes.length, 0, 'A completed retry must not be repeated');
});

suite.test('retrying after a disk failure never rebases over an intervening manual reset', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 90);
  const firstClose = f.service.stop();
  f.writes.shift().finish(Object.assign(new Error('Disk full'), {code: 'ENOSPC'}));
  await assert.rejects(firstClose, error => error.code === 'ENOSPC');
  f.library.media = f.library.media.map(video => video.id === 'video-a' ? Object.freeze({...video, position: 0}) : video);
  const retry = f.service.stop();
  assert.deepStrictEqual(f.writes[0].expected, {position: 25});
  f.writes.shift().finish();
  await assert.rejects(retry, error => error.code === 'LIBRARY_CONFLICT');
  assert.strictEqual(f.library.media[0].position, 0);
  await assert.rejects(f.service.stop(), error => error.code === 'LIBRARY_CONFLICT');
  assert.strictEqual(f.writes.length, 0, 'A conflict must not be retried by another Wait');
});

suite.test('concurrent Wait requests share one retry and another disk failure stays bounded', async () => {
  const f = fixture(); const player = await f.begin();
  player.emit('timeposition', 90);
  const firstClose = f.service.stop();
  f.writes.shift().finish(Object.assign(new Error('Disk full'), {code: 'ENOSPC'}));
  await assert.rejects(firstClose, error => error.code === 'ENOSPC');
  const retries = Promise.allSettled([f.service.stop(), f.service.stop()]);
  assert.strictEqual(f.writes.length, 1);
  f.writes.shift().finish(Object.assign(new Error('Disk still full'), {code: 'ENOSPC'}));
  assert((await retries).every(result => result.status === 'rejected' && result.reason.code === 'ENOSPC'));
  await tick(); assert.strictEqual(f.writes.length, 0);
});

runSuite(suite);
