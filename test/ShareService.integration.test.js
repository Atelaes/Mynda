const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory,
  rejectsWithCode
} = require('./helpers/TestHarness.js');
const ShareService = require('../src/sharing/ShareService.js');
const ShareManifest = require('../src/sharing/ShareManifest.js');
const {fingerprintPath} = require('../src/library/ContentFingerprint.js');
const {withWindowsFileSync} = require('./helpers/WindowsFileSync.js');

const suite = createSuite(
  'Share service filesystem workflow',
  'integration',
  'Exercises request, fulfillment, checksummed copying, and import across isolated temporary libraries.'
);

const roomyDisk = directory => Promise.resolve({
  diskPath: path.resolve(directory),
  free: 20 * 1024 * 1024 * 1024,
  size: 100 * 1024 * 1024 * 1024
});

function library(id, watchfolders, media = []) {
  return {
    id,
    videoIdScheme: 2,
    media,
    settings: {
      watchfolders,
      used: {kinds: ['movie', 'show']}
    },
    whenIdle: () => Promise.resolve()
  };
}

function serviceFor(testLibrary, options = {}) {
  return new ShareService(Object.assign({
    library: testLibrary,
    checkDiskSpace: roomyDisk,
    log: {debug() {}, info() {}, warn() {}, error() {}}
  }, options));
}

suite.test('finds the deepest containing watchfolder without prefix collisions', () => {
  const folders = [
    {path: path.join(path.sep, 'media', 'Movies'), kind: 'movie'},
    {path: path.join(path.sep, 'media', 'Movies', 'Classics'), kind: 'classic'},
    {path: path.join(path.sep, 'media', 'Movies-Other'), kind: 'other'}
  ];
  assert.strictEqual(
    ShareService.findContainingWatchfolder(
      path.join(path.sep, 'media', 'Movies', 'Classics', 'Alien.mkv'),
      folders
    ),
    folders[1]
  );
  assert.strictEqual(
    ShareService.findContainingWatchfolder(
      path.join(path.sep, 'media', 'Movies-Other', 'Film.mkv'),
      [folders[0]]
    ),
    null
  );
});

suite.test('copies, verifies, reuses, and rejects conflicting destination files', () => withTemporaryDirectory(
  'share-copy',
  async directory => {
    const source = path.join(directory, 'source.bin');
    const destination = path.join(directory, 'nested', 'destination.bin');
    const contents = Buffer.from('verified media bytes');
    const checksum = crypto.createHash('sha256').update(contents).digest('hex');
    fs.writeFileSync(source, contents);

    const copied = await ShareService.copyFileVerified(source, destination, {
      expectedSize: contents.length,
      expectedHash: checksum
    });
    assert.deepStrictEqual(copied, {sha256: checksum, bytes: contents.length, reused: false});
    assert.deepStrictEqual(fs.readFileSync(destination), contents);

    const reused = await ShareService.copyFileVerified(source, destination, {
      expectedSize: contents.length,
      expectedHash: checksum
    });
    assert.strictEqual(reused.reused, true);

    fs.writeFileSync(destination, Buffer.alloc(contents.length, 1));
    await rejectsWithCode(
      () => ShareService.copyFileVerified(source, destination, {expectedHash: checksum}),
      'SHARE_DESTINATION_CONFLICT'
    );
  }
));

suite.test('serializes errors into a renderer-safe shape', () => {
  const error = new ShareService.ShareServiceError('EXAMPLE', 'Example failure', {item: 3});
  assert.deepStrictEqual(ShareService.serializeError(error), {
    code: 'EXAMPLE',
    message: 'Example failure',
    details: {item: 3}
  });
  assert.strictEqual(ShareService.serializeError('plain failure').code, 'SHARE_FAILED');
});

suite.test('blocks concurrent and conflicting operations and resets state afterward', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const instance = serviceFor(library('busy-library', [], []));
  const running = instance._run('test-phase', {cancelable: true}, () => gate);
  assert.deepStrictEqual(instance.getState(), {
    busy: true,
    phase: 'test-phase',
    cancelable: true,
    cancelRequested: false
  });
  assert.strictEqual(instance.cancel(), true);
  await rejectsWithCode(
    () => instance._run('second', {cancelable: true}, async () => {}),
    'SHARE_BUSY'
  );
  release('finished');
  await running;
  assert.strictEqual(instance.isBusy(), false);

  const conflicting = serviceFor(library('conflict-library', [], []), {
    conflictingOperationActive: () => true
  });
  await rejectsWithCode(
    () => conflicting._run('request', {cancelable: true}, async () => {}),
    'SHARE_OPERATION_CONFLICT'
  );
});

suite.test('completes a request-to-fulfillment-to-import round trip', () => withTemporaryDirectory(
  'share-roundtrip',
  async directory => {
    const shareDirectory = path.join(directory, 'Share');
    const sourceWatchfolder = path.join(directory, 'Source Movies');
    const destinationWatchfolder = path.join(directory, 'Imported Movies');
    const sourceMovie = path.join(sourceWatchfolder, 'Alien (1979)', 'Alien.mkv');
    const sourceSubtitle = path.join(sourceWatchfolder, 'Alien (1979)', 'Alien.en.srt');
    fs.mkdirSync(path.dirname(sourceMovie), {recursive: true});
    fs.mkdirSync(destinationWatchfolder, {recursive: true});
    fs.mkdirSync(shareDirectory, {recursive: true});
    fs.writeFileSync(sourceMovie, 'movie data');
    fs.writeFileSync(sourceSubtitle, 'subtitle data');

    const requestingLibrary = library('requester', [
      {path: destinationWatchfolder, kind: 'movie'}
    ]);
    const requester = serviceFor(requestingLibrary);
    const request = await requester.createRequest({
      directory: shareDirectory,
      requestedKinds: ['movie'],
      includeDvds: true
    });
    assert.strictEqual(request.inventoriedVideos, 0);
    assert.strictEqual(fs.existsSync(request.manifestPath), true);

    const fulfillingLibrary = library('fulfiller', [
      {path: sourceWatchfolder, kind: 'movie'}
    ], [{
      id: (await fingerprintPath(sourceMovie)).id,
      title: 'Alien',
      kind: 'movie',
      filename: sourceMovie,
      dvd: false,
      dateadded: 1700000000,
      subtitles: [sourceSubtitle],
      detected_subtitles: [sourceSubtitle],
      manual_subtitles: []
    }]);
    const fulfiller = serviceFor(fulfillingLibrary);
    const inspection = await fulfiller.inspect(shareDirectory);
    assert.strictEqual(inspection.request.requestedKinds[0].label, 'movie');
    const requestedKindId = inspection.request.requestedKinds[0].id;

    const fulfillmentPlan = await fulfiller.planFulfillment({
      directory: shareDirectory,
      includeDvds: true,
      kindMappings: [{requestedKindId, sourceKinds: ['movie']}]
    });
    assert.strictEqual(fulfillmentPlan.videos, 1);
    assert.strictEqual(fulfillmentPlan.subtitles, 1);
    assert.strictEqual(fulfillmentPlan.enoughSpace, true);

    const fulfillment = await fulfiller.fulfillRequest({token: fulfillmentPlan.token});
    assert.strictEqual(fulfillment.status, 'complete');
    assert.strictEqual(fulfillment.packagedVideos, 1);
    const fulfilledManifest = await ShareManifest.readManifest(shareDirectory);
    assert.strictEqual(fulfilledManifest.fulfillment.items.length, 1);
    assert.strictEqual(fulfilledManifest.fulfillment.items[0].files.length, 2);

    const importPlan = await requester.planImport({
      directory: shareDirectory,
      kindMappings: [{
        requestedKindId,
        localKind: 'movie',
        watchfolder: destinationWatchfolder
      }]
    });
    assert.strictEqual(importPlan.videos, 1);
    assert.strictEqual(importPlan.filesToCopy, 2);
    assert.strictEqual(importPlan.enoughSpace, true);

    const imported = await requester.importShare({token: importPlan.token});
    assert.strictEqual(imported.status, 'complete');
    assert.strictEqual(imported.readyForScan, 1);
    assert.strictEqual(imported.shouldScan, true);

    const importedMovie = path.join(destinationWatchfolder, 'Alien (1979)', 'Alien.mkv');
    const importedSubtitle = path.join(destinationWatchfolder, 'Alien (1979)', 'Alien.en.srt');
    assert.strictEqual(fs.readFileSync(importedMovie, 'utf8'), 'movie data');
    assert.strictEqual((await fingerprintPath(importedMovie)).id, fulfillingLibrary.media[0].id);
    assert.strictEqual(fs.readFileSync(importedSubtitle, 'utf8'), 'subtitle data');

    const finalManifest = await ShareManifest.readManifest(shareDirectory);
    assert.strictEqual(finalManifest.imports.length, 1);
    assert.strictEqual(finalManifest.imports[0].status, 'complete');
  }
));

suite.test('rejects an expired plan token without copying anything', async () => {
  const instance = serviceFor(library('test-library', [], []));
  await rejectsWithCode(() => instance.fulfillRequest({token: 'missing'}), 'SHARE_PLAN_EXPIRED');
  await rejectsWithCode(() => instance.importShare({token: 'missing'}), 'SHARE_PLAN_EXPIRED');
});

suite.test('blocks Share writes from a library whose IDs have not been converted', async () => {
  const old = library('legacy-library', [], []); delete old.videoIdScheme;
  const instance = serviceFor(old);
  let ran = false;
  await rejectsWithCode(() => instance._run('request', {}, async () => {ran = true;}), 'LIBRARY_ID_MIGRATION_REQUIRED');
  assert.strictEqual(ran, false);
  assert.strictEqual(instance.isBusy(), false);
});

suite.test('flushes copied media on Windows and removes incomplete output after a disk failure', () =>
  withTemporaryDirectory('share-copy-windows-flush', directory => withWindowsFileSync(async policy => {
    const source = path.join(directory, 'source.bin');
    const destination = path.join(directory, 'copied.bin');
    const failedDestination = path.join(directory, 'failed.bin');
    const bytes = Buffer.from('preserve every source byte');
    fs.writeFileSync(source, bytes);
    await ShareService.copyFileVerified(source, destination);
    assert.strictEqual(policy.syncs, 1);
    assert.deepStrictEqual(fs.readFileSync(destination), bytes);
    policy.failWith = 'EIO';
    await assert.rejects(() => ShareService.copyFileVerified(source, failedDestination), error => error.code === 'EIO');
    assert.strictEqual(policy.syncs, 2);
    assert.deepStrictEqual(fs.readFileSync(source), bytes);
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), ['copied.bin', 'source.bin']);
  })));

runSuite(suite);
