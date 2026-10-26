const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
require('@babel/register')({presets: [require.resolve('@babel/preset-react')], extensions: ['.js'], ignore: [/node_modules/], cache: false});
const {DiagnosticExport} = require('../src/renderer/DiagnosticExport');
const suite = createSuite('Diagnostic export settings', 'component',
  'Explains shared data, defaults to no detailed library, and handles saving, cancellation, failures and unmounts.');
function component() {
  global.window = global.window || {mynda: {}};
  window.mynda.app = {platform: 'darwin'};
  const instance = new DiagnosticExport({});
  instance.setState = patch => {instance.state = {...instance.state, ...patch};};
  return instance;
}
suite.test('renders privacy information and an unchecked optional snapshot with standard settings controls', () => {
  const view = component(), html = ReactDOMServer.renderToStaticMarkup(view.render());
  assert.strictEqual(view.state.includeLibrary, false);
  assert(html.includes('Nothing is sent automatically.'));
  assert(html.includes('video titles, filenames'));
  assert(html.includes('not a library backup'));
  assert(html.includes('every active and inactive video'));
  assert(!html.includes('checked=""'));
  assert(html.includes('subsection'));
});
suite.test('passes the opt-in flag, prevents duplicate requests and displays the saved ZIP and notes', async () => {
  const calls = []; let finish;
  global.window = {mynda: {diagnostics: {export: options => {calls.push(options); return new Promise(resolve => {finish = resolve;});}}}};
  const view = component(); view.state.includeLibrary = true;
  const pending = view.exportDiagnostics();
  assert(view.state.busy);
  await view.exportDiagnostics();
  assert.deepStrictEqual(calls, [{includeLibrary: true}]);
  finish({ok: true, value: {canceled: false, filePath: '/exports/report.zip', warnings: ['Older records omitted.']}});
  await pending;
  const html = ReactDOMServer.renderToStaticMarkup(view.render());
  assert(!view.state.busy);
  assert(html.includes('/exports/report.zip'));
  assert(html.includes('Older records omitted.'));
  assert(html.includes('Review it'));
});
suite.test('canceling the save dialog reports neither success nor failure', async () => {
  global.window = {mynda: {diagnostics: {export: async () => ({ok: true, value: {canceled: true}})}}};
  const view = component(); await view.exportDiagnostics();
  assert.strictEqual(view.state.message, '');
  assert.strictEqual(view.state.filePath, '');
  assert.strictEqual(view.state.busy, false);
});
suite.test('large saved ZIPs remain successful and recommend a file link', async () => {
  global.window = {mynda: {diagnostics: {export: async () => ({ok: true, value: {
    canceled: false, filePath: '/exports/large-report.zip', largeArchive: true,
    warnings: ['The ZIP may exceed your email attachment limit.']
  }})}}};
  const view = component(); await view.exportDiagnostics();
  const html = ReactDOMServer.renderToStaticMarkup(view.render());
  assert.strictEqual(view.state.error, false);
  assert.strictEqual(view.state.busy, false);
  assert(html.includes('Diagnostic ZIP saved.'));
  assert(html.includes('file link'));
  assert(html.includes('/exports/large-report.zip'));
  assert(html.includes('email attachment limit'));
  assert(!html.includes('attach it to your email'));
});
suite.test('shows actionable failures and permits retry', async () => {
  let calls = 0;
  global.window = {mynda: {diagnostics: {export: async () => {calls++; return {ok: false, error: {message: 'Not enough disk space.'}};}}}};
  const view = component(); await view.exportDiagnostics(); await view.exportDiagnostics();
  assert.strictEqual(calls, 2);
  assert(view.state.error);
  assert(view.state.message.includes('disk space'));
  assert.strictEqual(view.state.filePath, '');
});
suite.test('does not update an unmounted view when the native operation finishes', async () => {
  let finish;
  global.window = {mynda: {diagnostics: {export: () => new Promise(resolve => {finish = resolve;})}}};
  const view = component(), pending = view.exportDiagnostics();
  view.componentWillUnmount();
  view.setState = () => {throw new Error('setState after unmount');};
  finish({ok: true, value: {canceled: false, filePath: '/exports/report.zip'}});
  await pending;
});
suite.test('reveals only the returned export path and preserves it after a file-manager failure', async () => {
  const seen = [];
  global.window = {mynda: {files: {revealExport: async filename => {seen.push(filename); throw new Error();}}}};
  const view = component(); view.state.filePath = '/exports/report.zip';
  await view.reveal();
  assert.deepStrictEqual(seen, ['/exports/report.zip']);
  assert(view.state.error);
  assert.strictEqual(view.state.filePath, '/exports/report.zip');
});
runSuite(suite);
