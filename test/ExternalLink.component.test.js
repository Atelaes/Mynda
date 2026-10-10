const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
require('@babel/register')({presets: [require.resolve('@babel/preset-react')], extensions: ['.js'],
  ignore: [/node_modules/], cache: false});

const calls = [];
let response = async () => ({ok: true});
global.window = {mynda: {external: {open: async url => { calls.push(url); return response(); }}}};
const links = require('../src/renderer/ExternalLink.js');
const {ExternalLink, ImdbLink} = links;
const suite = createSuite('External links in the editor', 'component',
  'Real link rendering, activation, failed browser launches and catalog-result IDs.');
const html = node => ReactDOMServer.renderToStaticMarkup(node);
const unwrap = node => typeof node.type === 'function' ? unwrap(node.type(node.props)) : node;
const event = (type = 'click', button = 0) => ({type, button, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }});

suite.test('renders a copyable HTTPS link with no access to its opener', () => {
  const output = html(React.createElement(ImdbLink, {imdbID: 'tt1234567'}, '<IMDb>'));
  assert.match(output, /href="https:\/\/www.imdb.com\/title\/tt1234567\/"/);
  assert.match(output, /rel="noopener noreferrer"/);
  assert.match(output, /&lt;IMDb&gt;/);
});
suite.test('uses the named external-link bridge for mouse and keyboard activation and stops row selection', async () => {
  calls.length = 0; response = async () => ({ok: true});
  const link = unwrap(ImdbLink({imdbID: 'tt1234567', children: 'IMDb'}));
  for (const detail of [1, 0]) {
    const e = {...event(), detail}; await link.props.onClick(e);
    assert(e.prevented); assert(e.stopped);
  }
  assert.deepStrictEqual(calls, Array(2).fill('https://www.imdb.com/title/tt1234567/'));
});
suite.test('never creates an anchor for an invalid ID or arbitrary URL', () => {
  for (const imdbID of ['javascript:alert(1)', 'tt1/../../redirect', 'tt12?next=bad', undefined, {}]) {
    assert(!html(React.createElement(ImdbLink, {imdbID}, 'IMDb')).includes('<a'));
  }
  assert(!html(React.createElement(ExternalLink, {url: 'https://evil.invalid/'}, 'Link')).includes('<a'));
});
suite.test('reports a rejected request or browser launch failure without navigating', async () => {
  const oldAlert = global.alert, alerts = [];
  global.alert = message => alerts.push(message);
  try {
    for (const respond of [async () => ({ok: false}), async () => { throw Error('IPC unavailable'); }]) {
      response = respond;
      const link = unwrap(ImdbLink({imdbID: 'tt1234567', children: 'IMDb'}));
      const e = event(); await link.props.onClick(e);
      assert(e.prevented); assert(e.stopped);
    }
    assert.strictEqual(alerts.length, 2);
    assert(alerts.every(message => message.includes('default browser')));
  } finally { global.alert = oldAlert; response = async () => ({ok: true}); }
});
suite.test('catalog search results use the same component and refuse malformed returned IDs', async () => {
  const records = ['tt1234567', 'tt1/../../redirect'].map(imdbID => ({
    imdbID, Type: 'movie', Title: 'A result', Year: '2000', Poster: 'N/A'
  }));
  window.mynda.editor = {search: async () => ({status: 'ambiguous', choices: records})};
  const {MynEditorSearch} = loadFreshWithMocks(path.join(__dirname, '../src/renderer/Editor.js'), {
    electron: {ipcRenderer: {}}, './ExternalLink.js': links,
    '../tagging/OmdbHelper.js': {resolve: async () => ({status: 'ambiguous', choices: records})},
    './RendererRuntime.js': {}, './SharedComponents.js': {MynOpenablePane: React.Component},
    './EditorFields.js': {}, './AutotagReport.js': {}
  });
  const search = new MynEditorSearch({video: {id: 'fixture', title: 'A result', kind: 'movie'},
    placeholderImage: 'placeholder.png'});
  search.setState = patch => { search.state = {...search.state, ...patch}; };
  await search.handleSearch(event());
  const linkNodes = search.state.results.map(row => React.Children.toArray(row.props.children)[3].props.children);
  assert(linkNodes.every(node => node.type === ImdbLink));
  assert.strictEqual(unwrap(linkNodes[0]).type, 'a');
  assert.strictEqual(unwrap(linkNodes[1]).type, 'span');
  calls.length = 0;
  const e = event(); await unwrap(linkNodes[0]).props.onClick(e);
  assert(e.prevented && e.stopped);
  assert.deepStrictEqual(calls, ['https://www.imdb.com/title/tt1234567/']);
});

runSuite(suite);
