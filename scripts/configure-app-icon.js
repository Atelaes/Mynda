// Run once after extracting the icon update. Merge only icon settings into
// the user's package.json, preserving dependencies and other build options.
const fs = require('fs');
const path = require('path');

const icons = {
  default: 'images/mynda-icon.png',
  mac: 'build/mynda.icns',
  win: 'build/mynda.ico',
  linux: 'build/icons'
};

function configureAppIcon(root) {
  root = path.resolve(root);
  const filename = path.join(root, 'package.json');
  const original = fs.readFileSync(filename, 'utf8');
  const config = JSON.parse(original);
  if (config.name !== 'mynda') throw new Error('Run this script inside the Mynda project.');
  const assets = [icons.default, icons.mac, icons.win,
    ...[16, 32, 48, 64, 128, 256, 512, 1024].map(size => `${icons.linux}/${size}x${size}.png`)];
  for (const asset of assets) {
    if (!fs.statSync(path.join(root, asset)).isFile()) throw new Error(`Missing icon: ${asset}`);
  }
  if (!config.build || typeof config.build !== 'object' || Array.isArray(config.build)) {
    throw new Error('Expected Mynda\'s electron-builder settings in package.json under "build".');
  }
  config.build.icon = icons.default;
  for (const platform of ['mac', 'win', 'linux']) {
    const current = config.build[platform];
    if (current != null && (typeof current !== 'object' || Array.isArray(current))) {
      throw new Error(`Expected build.${platform} to be an object; no settings were changed.`);
    }
    config.build[platform] = {...current, icon: icons[platform]};
  }
  if (JSON.stringify(JSON.parse(original)) === JSON.stringify(config)) {
    return {changed: false};
  }

  // Keep the backup outside the build input so it cannot enter the app bundle.
  const backup = fs.mkdtempSync(path.join(path.dirname(root), `${path.basename(root)}-before-fix88-`));
  fs.copyFileSync(filename, path.join(backup, 'package.json'), fs.constants.COPYFILE_EXCL);
  const indent = (original.match(/\n([ \t]+)"/) || [null, '  '])[1];
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const updated = JSON.stringify(config, null, indent).replace(/\n/g, newline) + newline;
  const temporary = `${filename}.fix88-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, {flag: 'wx', mode: fs.statSync(filename).mode});
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {changed: true, backup};
}

if (require.main === module) {
  try {
    const result = configureAppIcon(path.resolve(__dirname, '..'));
    console.log(result.changed ?
      `Mynda's Mac, Windows, and Linux icons are configured.\nPrevious package.json: ${result.backup}` :
      'Mynda\'s app icons are already configured.');
  } catch (error) {
    console.error(`Could not configure Mynda's app icon: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {configureAppIcon};
