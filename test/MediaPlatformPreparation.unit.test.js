const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
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
  const arm = Preparation.preparationCommand({platform: 'linux', arch: 'arm64', scriptsDirectory});
  assert.strictEqual(mac.args[0], path.join(scriptsDirectory, 'prepare-media-tools-macos.sh'));
  assert.strictEqual(windows.command, 'powershell.exe');
  assert(windows.args.includes(path.join(scriptsDirectory, 'prepare-media-tools-windows.ps1')));
  assert.strictEqual(linux.args[0], path.join(scriptsDirectory, 'prepare-media-tools-linux.sh'));
  assert.strictEqual(arm.target, 'linux-arm64');
  assert.strictEqual(arm.args[0], linux.args[0]);
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
  assert.throws(() => Preparation.preparationCommand({platform: 'linux', arch: 'arm'}),
    /64-bit OS and 64-bit Node/);
});

// Exercise the same shell functions the real build uses. No compilers,
// downloads, /etc changes, or spoofed machine architecture are needed.
if (process.platform !== 'win32') {
  const policy = path.resolve(__dirname, '../scripts/lib/linux-media-target.sh');
  const run = (script, ...args) => spawnSync('bash', ['-c',
    'set -euo pipefail; source "$1"; shift; ' + script, 'policy-test', policy, ...args], {encoding: 'utf8'});
  suite.test('selects separate Bookworm ARM64 and Ubuntu x64 baselines', () => {
    for (const machine of ['aarch64', 'arm64']) {
      const result = run('select_linux_media_target "$1"; linux_media_baseline_matches debian 12; printf "%s" "$TARGET"', machine);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, 'linux-arm64');
    }
    assert.strictEqual(run('select_linux_media_target x86_64; linux_media_baseline_matches ubuntu 24.04').status, 0);
    assert.notStrictEqual(run('select_linux_media_target aarch64; linux_media_baseline_matches ubuntu 24.04').status, 0);
    assert.notStrictEqual(run('select_linux_media_target armv7l').status, 0);
  });
  suite.test('limits ARM compilation by default and validates an explicit job count', () => {
    assert.strictEqual(run('select_linux_media_target aarch64; linux_media_build_jobs').stdout.trim(), '2');
    assert.strictEqual(run('select_linux_media_target aarch64; linux_media_build_jobs 4').stdout.trim(), '4');
    for (const jobs of ['0', '-1', 'all', '2; echo unsafe']) {
      assert.notStrictEqual(run('select_linux_media_target aarch64; linux_media_build_jobs "$1"', jobs).status, 0);
    }
  });
}

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
  assert(powershell.includes('cygpath.exe'));
  assert(powershell.includes("$env:MSYS2_PATH_TYPE = 'inherit'"));
  // Native PowerShell arguments must contain a filename, not Bash source with
  // embedded quotes. Windows PowerShell 5.1 corrupts the latter before launch.
  assert.strictEqual(
    /^\s*&\s*\$Bash\b[^\r\n]*(?:\s-[a-z]*c[a-z]*\b|\s--command\b)/m.test(powershell),
    false,
    'Pass the Windows build script as a file; do not restore a bash -c command string'
  );
  assert(windows.includes('mingw-w64-ucrt-x86_64-shaderc'));
  assert(windows.includes('-Dd3d11=enabled'));
  assert(windows.includes('objdump -p'));
  assert(windows.includes('${TMPDIR:-/tmp}'));
  assert.strictEqual(windows.includes('${TEMP:-/tmp}'), false);
  assert(linux.includes('linux_media_baseline_matches'));
  assert(linux.includes('-Dwayland=enabled'));
  assert(linux.includes('-Dx11=enabled'));
  assert(linux.includes("patchelf --set-rpath '$ORIGIN/lib:$ORIGIN'"));
});

runSuite(suite);
