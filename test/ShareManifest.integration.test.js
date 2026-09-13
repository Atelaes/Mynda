const fs = require('fs');
const path = require('path');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory,
  rejectsWithCode
} = require('./helpers/TestHarness.js');
const ShareManifest = require('../src/ShareManifest.js');

const suite = createSuite(
  'Share manifest validation and persistence',
  'integration',
  'Validates hostile paths and uses real temporary files for Share request reads and atomic writes.'
);

function validManifest() {
  return {
    format: ShareManifest.SHARE_FORMAT,
    version: ShareManifest.SHARE_VERSION,
    videoIdScheme: 2,
    revision: 1,
    request: {
      id: 'request-1',
      requestingLibraryId: 'library-a',
      createdAt: '2026-09-07T01:00:00.000Z',
      requestedKinds: [{id: 'kind-movie', label: ' Movie '}],
      includeDvds: true,
      inventory: [{id: '1'.repeat(64), mediaType: 'file', size: 100}]
    },
    fulfillment: {
      status: 'complete',
      createdAt: '2026-09-07T01:05:00.000Z',
      updatedAt: '2026-09-07T01:06:00.000Z',
      fulfillingLibraryId: 'library-b',
      includeDvds: true,
      kindMappings: [{requestedKindId: 'kind-movie', sourceKinds: ['Movie']}],
      items: [{
        videoId: '2'.repeat(64),
        title: 'Alien',
        sourceKind: 'Movie',
        requestedKindId: 'kind-movie',
        requestedKindLabel: 'movie',
        dvd: false,
        destinationRelativePath: 'Alien/Alien.mkv',
        packageDirectory: 'Mynda Share Files/request-1/shared-video',
        totalBytes: 4,
        files: [{
          role: 'video',
          packagePath: 'Mynda Share Files/request-1/shared-video/content/000001',
          destinationRelativePath: 'Alien/Alien.mkv',
          size: 4,
          sha256: 'a'.repeat(64)
        }]
      }],
      omissions: []
    },
    imports: []
  };
}

suite.test('accepts a complete manifest, normalizes kinds, and leaves the source untouched', () => {
  const source = validManifest();
  const validated = ShareManifest.validateManifest(source);
  assert.notStrictEqual(validated, source);
  assert.strictEqual(validated.request.requestedKinds[0].label, 'movie');
  assert.deepStrictEqual(validated.fulfillment.kindMappings[0].sourceKinds, ['movie']);
  assert.strictEqual(source.request.requestedKinds[0].label, ' Movie ');
});

suite.test('rejects absolute, escaping, empty, and null-containing paths', () => {
  for (const unsafe of ['../outside.mkv', '/absolute/movie.mkv', 'C:\\Movies\\movie.mkv']) {
    assert.throws(
      () => ShareManifest.validatePortableRelativePath(unsafe),
      error => error instanceof ShareManifest.ShareManifestError && error.code === 'UNSAFE_SHARE_PATH'
    );
  }
  assert.throws(
    () => ShareManifest.validatePortableRelativePath(''),
    error => error.code === 'INVALID_SHARE_PATH'
  );
  assert.throws(
    () => ShareManifest.validatePortableRelativePath('movie\0evil.mkv'),
    error => error.code === 'INVALID_SHARE_PATH'
  );
});

suite.test('joins only destinations contained by the selected root', () => withTemporaryDirectory(
  'share-safe-join',
  directory => {
    assert.strictEqual(
      ShareManifest.safeJoin(directory, 'Movies/Alien.mkv'),
      path.join(directory, 'Movies', 'Alien.mkv')
    );
    assert.throws(() => ShareManifest.safeJoin(directory, '../../outside'),
      error => error.code === 'UNSAFE_SHARE_PATH');
  }
));

suite.test('rejects duplicate requested kinds and duplicate inventory IDs', () => {
  const duplicateKind = validManifest();
  duplicateKind.request.requestedKinds.push({id: 'kind-other', label: 'MOVIE'});
  assert.throws(() => ShareManifest.validateManifest(duplicateKind),
    error => error.code === 'INVALID_SHARE_REQUEST');

  const duplicateInventory = validManifest();
  duplicateInventory.request.inventory.push({id: '1'.repeat(64), mediaType: 'file', size: 100});
  assert.throws(() => ShareManifest.validateManifest(duplicateInventory),
    error => error.code === 'INVALID_SHARE_REQUEST');
});

suite.test('rejects checksum, byte-total, and requested-kind inconsistencies', () => {
  const badChecksum = validManifest();
  badChecksum.fulfillment.items[0].files[0].sha256 = 'not-a-checksum';
  assert.throws(() => ShareManifest.validateManifest(badChecksum),
    error => error.code === 'INVALID_SHARE_FULFILLMENT');

  const badTotal = validManifest();
  badTotal.fulfillment.items[0].totalBytes = 5;
  assert.throws(() => ShareManifest.validateManifest(badTotal),
    error => error.code === 'INVALID_SHARE_FULFILLMENT');

  const wrongKind = validManifest();
  wrongKind.fulfillment.items[0].requestedKindLabel = 'show';
  assert.throws(() => ShareManifest.validateManifest(wrongKind),
    error => error.code === 'INVALID_SHARE_FULFILLMENT');
});

suite.test('writes and reads a manifest without leaving partial files behind', () => withTemporaryDirectory(
  'share-manifest-roundtrip',
  async directory => {
    const first = validManifest();
    const filePath = await ShareManifest.writeManifest(directory, first);
    assert.strictEqual(filePath, path.join(directory, ShareManifest.MANIFEST_FILENAME));
    assert.deepStrictEqual(await ShareManifest.readManifest(directory),
      ShareManifest.validateManifest(first));

    first.revision = 2;
    first.imports.push({
      importingLibraryId: 'library-c',
      importedAt: '2026-09-07T02:00:00.000Z',
      status: 'complete',
      readyForScan: 1,
      failedVideos: 0
    });
    await ShareManifest.writeManifest(directory, first);
    assert.strictEqual((await ShareManifest.readManifest(directory)).revision, 2);
    assert.deepStrictEqual(
      fs.readdirSync(directory).filter(name => /\.tmp-|\.previous$/.test(name)),
      []
    );
  }
));

suite.test('reports missing and malformed Share request files with stable codes', () => withTemporaryDirectory(
  'share-manifest-errors',
  async directory => {
    await rejectsWithCode(() => ShareManifest.readManifest(directory), 'SHARE_REQUEST_NOT_FOUND');
    fs.writeFileSync(path.join(directory, ShareManifest.MANIFEST_FILENAME), '{broken');
    await rejectsWithCode(() => ShareManifest.readManifest(directory), 'INVALID_SHARE_MANIFEST');
  }
));

suite.test('rejects old Share versions, incompatible ID schemes, and legacy IDs in new manifests', () => {
  const old = validManifest(); old.version = 1;
  assert.throws(() => ShareManifest.validateManifest(old), error => error.code === 'UNSUPPORTED_SHARE_VERSION');
  const missing = validManifest(); delete missing.videoIdScheme;
  assert.throws(() => ShareManifest.validateManifest(missing), error => error.code === 'UNSUPPORTED_SHARE_ID_SCHEME');
  const badInventory = validManifest(); badInventory.request.inventory[0].id = 'legacy-id';
  assert.throws(() => ShareManifest.validateManifest(badInventory), error => error.code === 'INVALID_SHARE_REQUEST');
  const badFulfillment = validManifest(); badFulfillment.fulfillment.items[0].videoId = 'legacy-id';
  assert.throws(() => ShareManifest.validateManifest(badFulfillment), error => error.code === 'INVALID_SHARE_FULFILLMENT');
});

runSuite(suite);
