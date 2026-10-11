const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
require('@babel/register')({presets: [require.resolve('@babel/preset-react')], extensions: ['.js'], ignore: [/node_modules/], cache: false});
const ArtworkImage = require('../src/renderer/ArtworkImage');
const suite = createSuite('Artwork availability and placeholders', 'component',
  'Real image event handlers, retry, source changes and safe fallback without changing library records.');
function fixture(source = '/Artwork/poster #1%.png', extra = {}) {
  const component = new ArtworkImage({source, showStatus: true, allowRetry: true, ...extra});
  component.setState = update => Object.assign(component.state,
    typeof update === 'function' ? update(component.state) : update);
  return component;
}
function image(component) { return React.Children.toArray(component.render().props.children).find(child => child.type === 'img'); }
function markup(component) { return ReactDOMServer.renderToStaticMarkup(component.render()); }

suite.test('missing images use the placeholder, retain their reference, and offer Retry', () => {
  const component = fixture();
  assert.strictEqual(image(component).props.src, 'file:///Artwork/poster%20%231%25.png');
  image(component).props.onError();
  assert.strictEqual(image(component).props.src, '../../images/qmark.png');
  assert.strictEqual(component.props.source, '/Artwork/poster #1%.png');
  assert(markup(component).includes('Artwork unavailable'));
  assert(markup(component).includes('>Retry</button>'));
});
suite.test('retry creates a new image request and restores artwork after a successful load', () => {
  const component = fixture();
  const old = image(component);
  old.props.onError(); component.retry();
  const retried = image(component);
  assert.notStrictEqual(retried.key, old.key);
  assert.strictEqual(retried.props.src, old.props.src);
  retried.props.onLoad();
  assert(!markup(component).includes('Artwork unavailable'));
});
suite.test('late failures cannot replace a newer image or a successful retry', () => {
  const component = fixture();
  const old = image(component);
  component.props = {...component.props, source: '/Artwork/new.png'};
  Object.assign(component.state, ArtworkImage.getDerivedStateFromProps(component.props, component.state));
  image(component).props.onLoad(); old.props.onError();
  assert.strictEqual(image(component).props.src, 'file:///Artwork/new.png');
  const beforeRetry = image(component);
  beforeRetry.props.onError(); component.retry(); image(component).props.onLoad();
  beforeRetry.props.onError();
  assert.strictEqual(component.state.failed, false);
});
suite.test('a broken placeholder ends in a text fallback without an image-error loop', () => {
  const component = fixture();
  image(component).props.onError(); image(component).props.onError();
  assert.strictEqual(image(component), undefined);
  assert(markup(component).includes('No artwork'));
  assert(markup(component).includes('artwork-preview'));
});
suite.test('empty artwork shows a placeholder without a missing-file warning', () => {
  const component = fixture('');
  assert.strictEqual(image(component).props.src, '../../images/qmark.png');
  assert(!markup(component).includes('Artwork unavailable'));
  assert(!markup(component).includes('>Retry</button>'));
});
suite.test('the blurred details background loads only after the actual image succeeds', () => {
  const component = fixture('/Artwork/poster.png', {backdrop: true});
  assert(!markup(component).includes('optional-artwork-duplicate'));
  image(component).props.onLoad();
  assert(markup(component).includes('optional-artwork-duplicate'));
  image(component).props.onError();
  assert(!markup(component).includes('optional-artwork-duplicate'));
});
runSuite(suite);
