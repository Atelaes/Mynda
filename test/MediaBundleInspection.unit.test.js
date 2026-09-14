const fs = require('fs');
const path = require('path');
const Inspection = require('../src/media/MediaBundleInspection.js');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Windows and Linux media-bundle inspection',
  'unit',
  'Checks PE/ELF architecture, private-library closure, app-relative loading, and prohibited DVD dependencies.'
);

function peFixture(machine = Inspection.PE_MACHINES.x64, dependency) {
  const buffer = Buffer.alloc(1024);
  const peOffset = 0x80;
  const optionalOffset = peOffset + 24;
  const optionalSize = 240;
  buffer.write('MZ', 0);
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write('PE\0\0', peOffset, 'binary');
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(dependency ? 1 : 0, peOffset + 6);
  buffer.writeUInt16LE(optionalSize, peOffset + 20);
  buffer.writeUInt16LE(0x20b, optionalOffset);
  buffer.writeBigUInt64LE(BigInt(0x140000000), optionalOffset + 24);
  buffer.writeUInt32LE(16, optionalOffset + 108);

  if (dependency) {
    buffer.writeUInt32LE(0x1000, optionalOffset + 112 + 8);
    buffer.writeUInt32LE(40, optionalOffset + 112 + 12);
    const sectionOffset = optionalOffset + optionalSize;
    buffer.write('.idata', sectionOffset, 'ascii');
    buffer.writeUInt32LE(0x200, sectionOffset + 8);
    buffer.writeUInt32LE(0x1000, sectionOffset + 12);
    buffer.writeUInt32LE(0x200, sectionOffset + 16);
    buffer.writeUInt32LE(0x200, sectionOffset + 20);
    buffer.writeUInt32LE(0x1050, 0x200 + 12);
    buffer.write(`${dependency}\0`, 0x250, 'ascii');
  }
  return buffer;
}

function elfFixture(machine = Inspection.ELF_MACHINES.x64) {
  const buffer = Buffer.alloc(64);
  buffer[0] = 0x7f;
  buffer.write('ELF', 1, 'ascii');
  buffer[4] = 2;
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

suite.test('reads x64 PE architecture and imported DLL names without external tools', () => {
  const buffer = peFixture(Inspection.PE_MACHINES.x64, 'Helper.DLL');
  assert.strictEqual(Inspection.peArchitecture(buffer), 'x64');
  assert.deepStrictEqual(Inspection.parsePeImports(buffer), ['helper.dll']);
  assert.strictEqual(Inspection.isWindowsSystemDll('KERNEL32.dll'), true);
  assert.strictEqual(Inspection.isWindowsSystemDll('api-ms-win-core-file-l1-1-0.dll'), true);
  assert.strictEqual(Inspection.isWindowsSystemDll('helper.dll'), false);
});

suite.test('accepts a closed x64 Windows DLL set and rejects a missing import', async () => {
  await withTemporaryDirectory('windows-media-bundle', directory => {
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg.exe'),
      ffprobe: path.join(directory, 'ffprobe.exe'),
      mpv: path.join(directory, 'mpv.exe')
    };
    fs.writeFileSync(paths.ffmpeg, peFixture());
    fs.writeFileSync(paths.ffprobe, peFixture());
    fs.writeFileSync(paths.mpv, peFixture(Inspection.PE_MACHINES.x64, 'helper.dll'));
    fs.writeFileSync(path.join(directory, 'helper.dll'), peFixture());
    assert.deepStrictEqual(
      Inspection.assertWindowsBundle(directory, paths, 'x64'),
      {files: 4, architecture: 'x64'}
    );
    fs.unlinkSync(path.join(directory, 'helper.dll'));
    assert.throws(
      () => Inspection.assertWindowsBundle(directory, paths, 'x64'),
      /missing helper\.dll/
    );
  });
});

suite.test('rejects the MSYS runtime and wrong Windows architecture', async () => {
  await withTemporaryDirectory('windows-media-policy', directory => {
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg.exe'),
      ffprobe: path.join(directory, 'ffprobe.exe'),
      mpv: path.join(directory, 'mpv.exe')
    };
    fs.writeFileSync(paths.ffmpeg, peFixture());
    fs.writeFileSync(paths.ffprobe, peFixture());
    fs.writeFileSync(paths.mpv, peFixture(Inspection.PE_MACHINES.x64, 'msys-2.0.dll'));
    assert.throws(() => Inspection.assertWindowsBundle(directory, paths, 'x64'), /MSYS runtime/);

    fs.writeFileSync(paths.mpv, peFixture(Inspection.PE_MACHINES.arm64));
    assert.throws(() => Inspection.assertWindowsBundle(directory, paths, 'x64'), /PE architecture arm64/);
  });
});

suite.test('parses ELF architecture, dependencies, and RUNPATH', () => {
  assert.strictEqual(Inspection.elfArchitecture(elfFixture()), 'x64');
  assert.deepStrictEqual(Inspection.parseElfDynamic([
    ' 0x0000000000000001 (NEEDED)             Shared library: [libhelper.so.1]',
    ' 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN/lib:$ORIGIN]'
  ].join('\n')), {
    needed: ['libhelper.so.1'],
    searchPaths: ['$ORIGIN/lib', '$ORIGIN']
  });
});

suite.test('accepts a closed app-relative Linux library set', async () => {
  await withTemporaryDirectory('linux-media-bundle', async directory => {
    const library = path.join(directory, 'lib', 'libhelper.so.1');
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg'),
      ffprobe: path.join(directory, 'ffprobe'),
      mpv: path.join(directory, 'mpv')
    };
    Object.values(paths).forEach(filename => fs.writeFileSync(filename, elfFixture()));
    fs.mkdirSync(path.dirname(library), {recursive: true});
    fs.writeFileSync(library, elfFixture());
    const runner = async (command, args) => ({
      stdout: args[1] === library ?
        ' 0x1 (NEEDED) Shared library: [libc.so.6]\n 0x1d (RUNPATH) Library runpath: [$ORIGIN]\n' :
        ' 0x1 (NEEDED) Shared library: [libhelper.so.1]\n 0x1d (RUNPATH) Library runpath: [$ORIGIN/lib]\n',
      stderr: ''
    });
    assert.deepStrictEqual(
      await Inspection.assertLinuxBundle(directory, paths, 'x64', runner),
      {files: 4, architecture: 'x64'}
    );
  });
});

suite.test('rejects unstaged and non-app-relative Linux dependencies', async () => {
  await withTemporaryDirectory('linux-media-policy', async directory => {
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg'),
      ffprobe: path.join(directory, 'ffprobe'),
      mpv: path.join(directory, 'mpv')
    };
    Object.values(paths).forEach(filename => fs.writeFileSync(filename, elfFixture()));
    const missingRunner = async () => ({
      stdout: ' 0x1 (NEEDED) Shared library: [libmissing.so.1]\n 0x1d (RUNPATH) Library runpath: [$ORIGIN/lib]\n',
      stderr: ''
    });
    await assert.rejects(
      Inspection.assertLinuxBundle(directory, paths, 'x64', missingRunner),
      /unstaged Linux dependencies/
    );
  });
});

runSuite(suite);
