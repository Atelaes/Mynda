const fs = require('fs');
const path = require('path');
const Preparation = require('../scripts/prepare-media-tools.js');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Cross-platform media preparation',
  'unit',
  'Checks host dispatch, platform baselines, pinned sources, and non-libdvdcss build policy without compiling the tools.'
);

suite.test('dispatches each supported host to its native preparation script', () => {
  const scriptsDirectory = '/project/scripts';
  const mac = Preparation.preparationCommand({platform: 'darwin', arch: 'arm64', scriptsDirectory});
  const windows = Preparation.preparationCommand({platform: 'win32', arch: 'x64', scriptsDirectory});
  const linux = Preparation.preparationCommand({platform: 'linux', arch: 'x64', scriptsDirectory});
  assert.strictEqual(mac.args[0], path.join(scriptsDirectory, 'prepare-media-tools-macos.sh'));
  assert.strictEqual(windows.command, 'powershell.exe');
  assert(windows.args.includes(path.join(scriptsDirectory, 'prepare-media-tools-windows.ps1')));
  assert.strictEqual(linux.args[0], path.join(scriptsDirectory, 'prepare-media-tools-linux.sh'));
});

suite.test('rejects unsupported host and architecture combinations explicitly', () => {
  assert.throws(
    () => Preparation.preparationCommand({platform: 'darwin', arch: 'x64'}),
    error => error && error.code === 'MYNDA_MEDIA_PLATFORM_UNSUPPORTED'
  );
  assert.throws(
    () => Preparation.preparationCommand({platform: 'freebsd', arch: 'x64'}),
    error => error && error.code === 'MYNDA_MEDIA_PLATFORM_UNSUPPORTED'
  );
});

suite.test('keeps all native recipes on the same checksummed source versions', () => {
  ['macos', 'windows-msys2', 'linux'].forEach(platform => {
    const script = fs.readFileSync(path.resolve(
      __dirname, '..', 'scripts', `prepare-media-tools-${platform}.sh`
    ), 'utf8');
    [
      'FFMPEG_VERSION="6.1.6"',
      'MPV_VERSION="0.41.0"',
      'DVDREAD_VERSION="7.1.1"',
      'DVDNAV_VERSION="7.0.0"',
      '--disable-gpl',
      '--disable-nonfree',
      '-Dlibdvdcss=disabled',
      '-DMYNDA_DISABLE_LIBDVDCSS',
      'libdvdread-no-libdvdcss.patch'
    ].forEach(value => assert(script.includes(value), `${platform} recipe is missing ${value}`));
    assert.strictEqual((script.match(/_SHA256="[a-f0-9]{64}"/g) || []).length, 4);
  });
});

suite.test('uses UCRT64/Direct3D on Windows and an Ubuntu 24.04 Wayland/X11 baseline on Linux', () => {
  const powershell = fs.readFileSync(path.resolve(
    __dirname, '..', 'scripts', 'prepare-media-tools-windows.ps1'
  ), 'utf8');
  const windows = fs.readFileSync(path.resolve(
    __dirname, '..', 'scripts', 'prepare-media-tools-windows-msys2.sh'
  ), 'utf8');
  const linux = fs.readFileSync(path.resolve(
    __dirname, '..', 'scripts', 'prepare-media-tools-linux.sh'
  ), 'utf8');
  assert(windows.includes('MSYSTEM:-}') && windows.includes('UCRT64'));
  assert(powershell.includes("$env:MSYSTEM = 'UCRT64'"));
  assert(powershell.includes('MYNDA_MSYS2_ROOT'));
  assert(powershell.includes('cygpath -u'));
  assert(windows.includes('mingw-w64-ucrt-x86_64-shaderc'));
  assert(windows.includes('-Dd3d11=enabled'));
  assert(windows.includes('objdump -p'));
  assert(windows.includes('${TMPDIR:-/tmp}'));
  assert.strictEqual(windows.includes('${TEMP:-/tmp}'), false);
  assert(linux.includes('VERSION_ID:-}') && linux.includes('24.04'));
  assert(linux.includes('-Dwayland=enabled'));
  assert(linux.includes('-Dx11=enabled'));
  assert(linux.includes("patchelf --set-rpath '$ORIGIN/lib:$ORIGIN'"));
});

runSuite(suite);
