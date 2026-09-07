const fs = require('fs');
const path = require('path');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');
const {libraryFixture, videoFixture} = require('./helpers/Fixtures.js');
const Persistence = require('../src/LibraryPersistence.js');

const suite = createSuite(
  'Library persistence and recovery',
  'integration',
  'Uses real temporary files to protect Mynda library writes, backups, and recovery.'
);

suite.test('accepts compatible old libraries and rejects unsafe structures', () => {
  assert.deepStrictEqual(Persistence.validateLibraryData({settings: {}, media: []}), {
    valid: true,
    message: ''
  });
  assert.strictEqual(Persistence.validateLibraryData(null).valid, false);
  assert.strictEqual(Persistence.validateLibraryData({settings: [], media: []}).valid, false);
  assert.strictEqual(Persistence.validateLibraryData({settings: {}, media: {}}).valid, false);
  assert.strictEqual(Persistence.validateLibraryData({settings: {}, media: [], playlists: {}}).valid, false);
});

suite.test('labels malformed JSON and invalid library JSON consistently', () => {
  assert.throws(
    () => Persistence.parseLibraryText('{not json', 'broken.json'),
    error => error instanceof Persistence.InvalidLibraryError &&
      error.code === 'INVALID_LIBRARY' && error.source === 'broken.json'
  );
  assert.throws(
    () => Persistence.parseLibraryText(JSON.stringify({hello: 'world'}), 'wrong.json'),
    error => error instanceof Persistence.InvalidLibraryError &&
      /settings/.test(error.message)
  );
});

suite.test('atomically writes and reads a complete library', () => withTemporaryDirectory(
  'persistence-roundtrip',
  directory => {
    const filePath = path.join(directory, 'nested', 'library.json');
    const expected = libraryFixture({media: [videoFixture()]});
    Persistence.writeLibraryFile(filePath, expected);

    const loaded = Persistence.readLibraryFile(filePath);
    assert.deepStrictEqual(loaded.data, expected);
    assert.strictEqual(loaded.text, JSON.stringify(expected));
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.tmp-')),
      []
    );
  }
));

suite.test('refuses invalid replacement data without touching the existing file', () => withTemporaryDirectory(
  'persistence-reject',
  directory => {
    const filePath = path.join(directory, 'library.json');
    const original = libraryFixture({media: [videoFixture()]});
    Persistence.writeLibraryFile(filePath, original);
    const before = fs.readFileSync(filePath, 'utf8');

    assert.throws(
      () => Persistence.writeLibraryFile(filePath, {settings: {}, media: 'not-an-array'}),
      error => error.code === 'INVALID_LIBRARY'
    );
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before);
  }
));

suite.test('uses portable, sortable backup filenames and ignores unrelated files', () => withTemporaryDirectory(
  'backup-names',
  directory => {
    const first = 'library-2026-09-07T01-02-03-004Z-p1-1.json';
    const second = 'library-2026-09-07T02-02-03-004Z-p1-2.json';
    fs.writeFileSync(path.join(directory, first), '{}');
    fs.writeFileSync(path.join(directory, second), '{}');
    fs.writeFileSync(path.join(directory, 'notes.json'), '{}');

    assert.strictEqual(Persistence.safeTimestamp(new Date('2026-09-07T01:02:03.004Z')),
      '2026-09-07T01-02-03-004Z');
    assert.strictEqual(Persistence.parseAutomaticBackupDate(first).toISOString(),
      '2026-09-07T01:02:03.004Z');
    assert.strictEqual(Persistence.parseAutomaticBackupDate('notes.json'), null);
    assert.deepStrictEqual(Persistence.listAutomaticBackups(directory).map(item => item.name),
      [second, first]);
  }
));

suite.test('keeps the newest backup in each retention bucket', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');
  const backups = [
    '2026-09-07T11:50:00.000Z',
    '2026-09-07T11:10:00.000Z',
    '2026-09-07T10:50:00.000Z',
    '2026-09-05T10:00:00.000Z',
    '2026-09-05T08:00:00.000Z',
    '2026-07-15T10:00:00.000Z',
    '2025-05-01T10:00:00.000Z',
    '2019-01-01T10:00:00.000Z'
  ].map((date, index) => ({path: `backup-${index}`, date: new Date(date)}));

  const retained = Persistence.retainedAutomaticBackups(backups, now);
  assert.deepStrictEqual(retained.map(item => item.path), [
    'backup-0',
    'backup-2',
    'backup-3',
    'backup-5',
    'backup-6',
    'backup-7'
  ]);
});

suite.test('creates a validated backup and skips corrupt newer recovery candidates', () => withTemporaryDirectory(
  'backup-recovery',
  directory => {
    const libraryPath = path.join(directory, 'library.json');
    const backupDirectory = path.join(directory, 'Backups');
    const expected = libraryFixture({media: [videoFixture()]});
    Persistence.writeLibraryFile(libraryPath, expected);

    const firstDate = new Date('2026-09-07T01:00:00.000Z');
    const created = Persistence.createAutomaticBackup(libraryPath, backupDirectory, firstDate);
    assert.strictEqual(fs.existsSync(created.path), true);
    assert.deepStrictEqual(Persistence.readLibraryFile(created.path).data, expected);

    const corruptName = 'library-2026-09-07T02-00-00-000Z-p99-1.json';
    fs.writeFileSync(path.join(backupDirectory, corruptName), '{broken');
    const recovery = Persistence.findLatestValidAutomaticBackup(backupDirectory);
    assert.strictEqual(recovery.backup.path, created.path);
    assert.strictEqual(recovery.invalidNewerCount, 1);
    assert.strictEqual(recovery.candidateCount, 2);
  }
));

suite.test('preserves damaged bytes exactly in the Recovery directory', () => withTemporaryDirectory(
  'damaged-preservation',
  directory => {
    const libraryPath = path.join(directory, 'library.json');
    const recoveryDirectory = path.join(directory, 'Recovery');
    const damaged = Buffer.from('{"media": [\npartially written');
    fs.writeFileSync(libraryPath, damaged);

    const preserved = Persistence.preserveDamagedLibrary(
      libraryPath,
      recoveryDirectory,
      new Date('2026-09-07T03:04:05.006Z')
    );
    assert.deepStrictEqual(fs.readFileSync(preserved), damaged);
    assert(/library-damaged-2026-09-07T03-04-05-006Z/.test(path.basename(preserved)));
  }
));

runSuite(suite);
