'use strict';

// Electron 12 / Chromium 89 decodes PNGs without their ICC profile, then
// labels the Dock bitmap as macOS Generic RGB. Encode the development image
// in that space with ColorSync; retain the sRGB ICNS as the canonical artwork.
// https://github.com/chromium/chromium/blob/89.0.4389.128/ui/gfx/image/image_mac.mm
// https://github.com/chromium/chromium/blob/89.0.4389.128/skia/ext/skia_utils_mac.mm

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngChunks(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Expected a PNG image.');
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('Truncated PNG chunk.');
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) throw new Error('Truncated PNG data.');
    chunks.push({
      type: png.toString('ascii', offset + 4, offset + 8),
      data: png.subarray(offset + 8, end - 4),
      bytes: png.subarray(offset, end)
    });
    offset = end;
  }
  const header = chunks[0];
  if (!header || header.type !== 'IHDR' || header.data.length !== 13 ||
      header.data.readUInt32BE(0) !== 1024 || header.data.readUInt32BE(4) !== 1024 ||
      !chunks.some(chunk => chunk.type === 'IDAT') ||
      chunks[chunks.length - 1].type !== 'IEND') {
    throw new Error('Expected a complete 1024 x 1024 PNG.');
  }
  const profile = chunks.find(chunk => chunk.type === 'iCCP');
  if (!profile) throw new Error('The icon needs an embedded colour profile. Install fix93 first.');
  const separator = profile.data.indexOf(0);
  if (separator < 1 || profile.data[separator + 1] !== 0) throw new Error('Invalid PNG colour profile.');
  const icc = zlib.inflateSync(profile.data.subarray(separator + 2));
  if (icc.length < 128 || icc.toString('ascii', 36, 40) !== 'acsp' ||
      icc.toString('ascii', 16, 20) !== 'RGB ') throw new Error('Expected an RGB colour profile.');
  return chunks;
}

function extractCanonicalPng(icns) {
  if (icns.length < 8 || icns.toString('ascii', 0, 4) !== 'icns' ||
      icns.readUInt32BE(4) !== icns.length) throw new Error('Invalid ICNS file.');
  let png;
  for (let offset = 8; offset < icns.length;) {
    if (offset + 8 > icns.length) throw new Error('Truncated ICNS entry.');
    const length = icns.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > icns.length) throw new Error('Invalid ICNS entry.');
    if (icns.toString('ascii', offset, offset + 4) === 'ic10') {
      if (png) throw new Error('Duplicate 1024-pixel ICNS representation.');
      png = icns.subarray(offset + 8, offset + length);
    }
    offset += length;
  }
  if (!png) throw new Error('The ICNS has no 1024-pixel PNG representation.');
  readPngChunks(png);
  return png;
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('Mac development-icon conversion is only needed on macOS.');
    return;
  }
  const project = path.resolve(__dirname, '..');
  const profile = '/System/Library/ColorSync/Profiles/Generic RGB Profile.icc';
  const destination = path.join(project, 'images', 'mynda-icon-mac.png');
  if (!fs.existsSync(profile)) throw new Error('macOS Generic RGB profile was not found: ' + profile);
  const canonical = extractCanonicalPng(fs.readFileSync(path.join(project, 'build', 'mynda.icns')));
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.mynda-icon-colour-'));
  try {
    const input = path.join(temporary, 'source-srgb.png');
    const output = path.join(temporary, 'development-generic-rgb.png');
    fs.writeFileSync(input, canonical);
    execFileSync('/usr/bin/sips', ['--matchTo', profile, input, '--out', output], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    const chunks = readPngChunks(fs.readFileSync(output));
    // The ICC profile describes the converted pixels. Chromium 89 ignores
    // ICC but applies gAMA/sRGB hints; omit those hints to avoid a second
    // conversion before Chromium assigns Generic RGB to the Dock bitmap.
    const png = Buffer.concat([PNG_SIGNATURE, ...chunks
      .filter(chunk => !['gAMA', 'sRGB', 'cHRM'].includes(chunk.type))
      .map(chunk => chunk.bytes)]);
    fs.writeFileSync(output, png);
    fs.chmodSync(output, fs.statSync(destination).mode & 0o777);
    fs.renameSync(output, destination);
    console.log('Prepared the Mac development icon using the macOS Generic RGB profile.');
    console.log('Restart development with npm start. The packaged ICNS is unchanged.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error('Could not prepare the Mac development icon: ' + error.message);
  process.exitCode = 1;
}
