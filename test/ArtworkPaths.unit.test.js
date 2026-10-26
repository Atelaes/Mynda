'use strict';
const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {isRelativeArtwork} = require('../src/platform/ArtworkReference');
const {artworkDirectory, createArtworkPaths} = require('../src/platform/ArtworkPaths');

const suite = createSuite('Portable managed artwork references', 'unit',
  'Managed artwork follows its configured root without embedding profile paths in library data.');

suite.test('relative grammar retains literal filename characters and rejects traversal and schemes', () => {
  for (const value of ['poster.jpg', 'series/Season 1/Poster #1%?.jpg', '.poster.png', '%2e%2e.jpg']) {
    assert.strictEqual(isRelativeArtwork(value), true, value);
  }
  for (const value of ['', '.', '..', '../poster.jpg', 'series/../poster.jpg', '/poster.jpg',
    'series//poster.jpg', 'series/./poster.jpg', 'series/', 'file:///poster.jpg',
    'https://example.test/poster.jpg', 'C:\\poster.jpg', '\\\\server\\poster.jpg', 'poster\0.jpg',
    'series\\poster.jpg']) assert.strictEqual(isRelativeArtwork(value), false, value);
});

suite.test('current and former profile roots convert to the same relative spelling', () =>
  withTemporaryDirectory('artwork-relative-roots', parent => {
    const userData = path.join(parent, 'Mynda');
    const paths = createArtworkPaths({userData});
    assert.strictEqual(paths.directory, artworkDirectory(userData));
    const relative = 'series/Poster #1%?.jpg';
    for (const profile of ['Mynda', 'mynda']) {
      const legacy = path.join(artworkDirectory(path.join(parent, profile)), relative);
      assert.strictEqual(paths.reference(legacy), relative);
    }
    assert.strictEqual(paths.resolve(relative), path.join(paths.directory, relative));
    const alternate = createArtworkPaths({userData: path.join(parent, 'another-profile')});
    assert.strictEqual(alternate.resolve(relative), path.join(alternate.directory, relative));
    assert.strictEqual(alternate.reference(paths.resolve(relative)), paths.resolve(relative));
  }));

suite.test('explicit old roots support migration while unrelated files and URLs remain unchanged', () =>
  withTemporaryDirectory('artwork-legacy-roots', parent => {
    const oldRoot = path.join(parent, 'legacy-images');
    const paths = createArtworkPaths({userData: path.join(parent, 'new-profile'), legacyDirectories: [oldRoot]});
    assert.strictEqual(paths.reference(path.join(oldRoot, 'poster.jpg')), 'poster.jpg');
    for (const original of [path.join(parent, 'photo.jpg'), path.join(oldRoot + '-other', 'poster.jpg'),
      'https://example.test/poster.jpg', '', '../../images/qmark.png']) {
      assert.strictEqual(paths.reference(original), original);
    }
    const external = path.join(parent, 'photo.jpg');
    assert.strictEqual(paths.resolve(external), external);
    for (const invalid of ['../photo.jpg', 'nested/../../photo.jpg', 'https://example.test/photo.jpg']) {
      assert.throws(() => paths.resolve(invalid), /Invalid relative artwork path/);
    }
  }));

suite.test('canonical profile aliases normalize without treating an escaping symlink as managed artwork', () =>
  withTemporaryDirectory('artwork-symlink-roots', parent => {
    const actual = path.join(parent, 'actual-profile'), alias = path.join(parent, 'alias-profile');
    fs.mkdirSync(artworkDirectory(actual), {recursive: true});
    fs.symlinkSync(actual, alias, 'dir');
    const paths = createArtworkPaths({userData: alias});
    const file = path.join(artworkDirectory(actual), 'poster.jpg');
    fs.writeFileSync(file, 'image');
    assert.strictEqual(paths.reference(fs.realpathSync(file)), 'poster.jpg');
    assert.strictEqual(fs.realpathSync(paths.resolve('poster.jpg')), fs.realpathSync(file));
    const outside = path.join(parent, 'private.jpg');
    fs.writeFileSync(outside, 'external image');
    const link = path.join(paths.directory, 'outside.jpg');
    fs.symlinkSync(outside, link);
    assert.strictEqual(paths.reference(link), link);
    assert.throws(() => paths.resolve('outside.jpg'), /escapes/);
    assert.strictEqual(paths.resolve(link), link, 'Explicit absolute inputs remain subject to editor consent');
    fs.symlinkSync(parent, path.join(paths.directory, 'external-directory'), 'dir');
    assert.throws(() => paths.resolve('external-directory/new.jpg'), /escapes/);
  }));

suite.test('Windows drive and UNC roots produce forward-slash library references', () => {
  for (const userData of ['C:\\Users\\Tester\\AppData\\Roaming\\Mynda', '\\\\server\\profiles\\Mynda']) {
    const paths = createArtworkPaths({userData});
    const file = path.win32.join(paths.directory, 'series', 'Poster.jpg');
    assert.strictEqual(paths.reference(file), 'series/Poster.jpg');
    assert.strictEqual(paths.resolve('series/Poster.jpg'), file);
  }
});

runSuite(suite);
