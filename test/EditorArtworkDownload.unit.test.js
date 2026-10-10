const fs = require('fs');
const os = require('os');
const path = require('path');
const {Readable} = require('stream');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {createArtworkDownloader, MAX_ARTWORK_BYTES} = require('../src/main/EditorArtworkDownload');
const suite = createSuite('Bounded editor artwork downloads', 'unit',
  'Real stream writes with explicit redirects, size limits and partial-file cleanup.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-artwork-download-'));
let number = 0;
const destination = () => path.join(root, `${++number}.image`);
const response = (body, status = 200, headers = {}) => ({status, headers, data: Readable.from([body])});

suite.test('HTTP(S) data is streamed to an exclusive destination', async () => {
  const file = destination();
  const download = createArtworkDownloader({request: async (url, options) => {
    assert.strictEqual(url, 'https://example.test/image.png'); assert.strictEqual(options.maxRedirects, 0);
    return response(Buffer.from('image bytes'));
  }});
  assert.deepStrictEqual(await download('https://example.test/image.png', file), {success: true, message: file});
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'image bytes');
  await assert.rejects(download('https://example.test/image.png', file));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'image bytes', 'an existing file is never replaced or deleted');
});
suite.test('invalid schemes and credentials fail before any network request', async () => {
  let calls = 0;
  const download = createArtworkDownloader({request: async () => { calls++; return response(''); }});
  for (const url of ['file:///secret', 'ftp://example.test/a', 'https://user:password@example.test/a']) {
    await assert.rejects(download(url, destination()));
  }
  assert.strictEqual(calls, 0);
});
suite.test('cross-origin redirects cannot fetch another server without confirmation', async () => {
  const calls = [];
  const download = createArtworkDownloader({request: async url => {
    calls.push(url); return response('', 302, {location: 'http://127.0.0.1/private'});
  }});
  await assert.rejects(download('https://example.test/image', destination()), /not confirmed/);
  assert.deepStrictEqual(calls, ['https://example.test/image']);
});
suite.test('approved redirects work and relative redirects retain the approved origin', async () => {
  const calls = [], prompts = [];
  const download = createArtworkDownloader({request: async url => {
    calls.push(url);
    if (calls.length === 1) return response('', 302, {location: '/local'});
    if (calls.length === 2) return response('', 302, {location: 'https://cdn.example.test/image'});
    return response('image');
  }});
  const file = destination();
  await download('https://example.test/image', file, {approveRedirect: async url => { prompts.push(url); return true; }});
  assert.deepStrictEqual(prompts, ['https://cdn.example.test/image']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'image');
});
suite.test('redirect loops and non-HTTP redirect targets are rejected', async () => {
  let calls = 0;
  const loop = createArtworkDownloader({request: async () => { calls++; return response('', 302, {location: '/loop'}); }});
  await assert.rejects(loop('https://example.test/start', destination()), /Too many/);
  assert.strictEqual(calls, 6);
  const invalid = createArtworkDownloader({request: async () => response('', 302, {location: 'file:///secret'})});
  await assert.rejects(invalid('https://example.test/start', destination()), /Unsupported/);
});
suite.test('Content-Length cannot exceed the limit even before opening a file', async () => {
  const file = destination();
  const download = createArtworkDownloader({request: async () => response('image', 200, {'content-length': MAX_ARTWORK_BYTES + 1})});
  await assert.rejects(download('https://example.test/a', file), /20 MB/);
  assert.strictEqual(fs.existsSync(file), false);
});
suite.test('chunked oversized streams are stopped and their partial files removed', async () => {
  const file = destination();
  const download = createArtworkDownloader({request: async () => ({status: 200, headers: {},
    data: Readable.from([Buffer.alloc(MAX_ARTWORK_BYTES), Buffer.from('extra')])})});
  await assert.rejects(download('https://example.test/a', file), /20 MB/);
  assert.strictEqual(fs.existsSync(file), false);
});
suite.test('HTTP failures do not create an image file', async () => {
  const file = destination();
  const download = createArtworkDownloader({request: async () => response('not found', 404)});
  await assert.rejects(download('https://example.test/a', file), /404/);
  assert.strictEqual(fs.existsSync(file), false);
});

process.on('exit', () => fs.rmSync(root, {recursive: true, force: true}));
runSuite(suite);
