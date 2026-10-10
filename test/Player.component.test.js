const path = require('path');
const React = require('react');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
require('@babel/register')({presets: [require.resolve('@babel/preset-react')],
  extensions: ['.js'], ignore: [/node_modules/], cache: false});

const suite = createSuite('Isolated player pane', 'component',
  'Verifies that the UI requests video IDs, follows backend state and waits for confirmed playback shutdown.');

function fixture() {
  let listener, closeHook, finishPlay, finishStop;
  const calls = [], alerts = [];
  const playback = {
    onState(callback) {listener = callback; return () => {listener = null;};},
    play(id) {calls.push(['play', id]); return new Promise(resolve => {finishPlay = resolve;});},
    stop() {calls.push(['stop']); return new Promise(resolve => {finishStop = resolve;});}
  };
  global.window = {mynda: {playback}};
  global.alert = message => alerts.push(message);
  const {MynPlayer} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Player.js'), {
    './RendererRuntime.js': {library: {onBeforeClose(callback) {closeHook = callback; return () => {closeHook = null;};}},
      playerLog: {error() {}}}, './SharedComponents.js': {MynOpenablePane: React.Component}
  });
  let hidden = 0;
  const component = new MynPlayer({video: Object.freeze({id: 'video-a', title: 'First', filename: '/private/first.mkv'}),
    show: true, hideFunction() {hidden += 1;}});
  component.setState = update => Object.assign(component.state, update);
  const state = (status, revision, sessionId = 1) => ({sessionId, revision, videoId: 'video-a', status});
  return {component, calls, alerts, state, notify: value => listener(value), close: () => closeHook(),
    finishPlay: value => finishPlay(value), finishStop: value => finishStop(value), hidden: () => hidden,
    attached: () => Boolean(listener || closeHook)};
}

suite.test('only sends the library video ID and does not regress when an older start reply arrives', async () => {
  const f = fixture(); const starting = f.component.setUpVideo();
  assert.deepStrictEqual(f.calls, [['play', 'video-a']]);
  f.notify(f.state('playing', 2));
  assert.strictEqual(f.component.state.showPlayingMessage, true);
  f.finishPlay(f.state('loading', 1)); await starting;
  assert.strictEqual(f.component.state.showPlayingMessage, true);
  assert.strictEqual(f.component.state.showLoadingIndicator, false);
});

suite.test('ignores old players and hides the pane when the current MPV process exits', () => {
  const f = fixture();
  f.notify(f.state('playing', 4, 2));
  f.notify(f.state('closed', 3, 1));
  assert.strictEqual(f.hidden(), 0);
  f.notify(f.state('closed', 5, 2));
  assert.strictEqual(f.hidden(), 1);
});

suite.test('displays backend playback and save errors without touching library records', () => {
  const f = fixture();
  f.notify({...f.state('error', 1), errorMessage: 'Drive unavailable'});
  assert.strictEqual(f.component.state.errorMessage, 'Drive unavailable');
  f.notify({...f.state('playing', 2), saveError: 'Disk full'});
  assert.deepStrictEqual(f.alerts, ['Disk full']);
  assert(Object.isFrozen(f.component.state.video));
});

suite.test('the close hook waits for the backend to stop and confirm the final position save', async () => {
  const f = fixture(); let closed = false;
  const closing = f.close().then(() => {closed = true;});
  await Promise.resolve();
  assert.strictEqual(closed, false);
  assert.deepStrictEqual(f.calls, [['stop']]);
  f.finishStop(); await closing;
  assert.strictEqual(closed, true);
});

suite.test('unmount removes subscriptions and stops playback', async () => {
  const f = fixture();
  f.component.componentWillUnmount();
  assert.strictEqual(f.attached(), false);
  assert.deepStrictEqual(f.calls, [['stop']]);
  f.finishStop(); await Promise.resolve();
});

runSuite(suite);
