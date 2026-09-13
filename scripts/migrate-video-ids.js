#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const Migration = require('./lib/VideoIdMigration.js');

function defaultLibraryPath(platform = process.platform, env = process.env, userHome = os.homedir()) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const config = platform === 'darwin' ? api.join(userHome, 'Library', 'Application Support') :
    platform === 'win32' ? (env.APPDATA || api.join(userHome, 'AppData', 'Roaming')) :
      (env.XDG_CONFIG_HOME || api.join(userHome, '.config'));
  return api.join(config, 'mynda', 'Library', 'library.json');
}

function usage() {
  return `Mynda video ID conversion (scheme 1 -> scheme 2)

Quit Mynda before preparing or installing a conversion. Mount your media drives.

  npm run library:migrate
  npm run library:migrate -- --input "/absolute/path/library.json"
  npm run library:migrate -- --install

The default command reads your library and media, preserves the original,
and prepares a separate converted copy. It does NOT replace the live library.
Only --install replaces the source, after validating the prepared conversion.

Options:
  --input PATH                  Library JSON to convert (default: Mynda userData)
  --output PATH                 Separate output directory (same value on install)
  --relink PATH                 JSON object mapping exact old paths to new paths
  --archive-missing-inactive    Preserve missing inactive records in a separate
                                archive and omit them from the converted library
  --install                     Install an already prepared, unblocked conversion
  --help                        Show this help

Rerun the preparation command to resume; unchanged media reuse its checkpoint.
An interrupted or blocked conversion cannot be installed. The output directory
contains original-library.json, checkpoint.json, report.json, and, when ready,
converted-library.json. Keep this directory for rollback and recovery.
See MIGRATING_VIDEO_IDS.md for both computers' complete procedure.`;
}

function parseArguments(args) {
  const options = {};
  const values = {'--input': 'input', '--output': 'output', '--relink': 'relink'};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (values[arg]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (options[values[arg]]) throw new Error(`Repeated option: ${arg}`);
      options[values[arg]] = args[++index];
    } else if (arg === '--archive-missing-inactive') options.archiveMissingInactive = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.install && (options.relink || options.archiveMissingInactive)) {
    throw new Error('Relinking and archiving options belong to preparation. Install the validated result with --install only.');
  }
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { process.stdout.write(usage() + '\n'); return 0; }
  const input = path.resolve(options.input || defaultLibraryPath());
  if (!fs.existsSync(input)) {
    throw new Error(`Library not found: ${input}\nUse --input with the library path shown by Mynda or a manual export.`);
  }
  if (options.relink) {
    options.relinks = JSON.parse(fs.readFileSync(options.relink, 'utf8'));
    if (!options.relinks || typeof options.relinks !== 'object' || Array.isArray(options.relinks) ||
        Object.values(options.relinks).some(value => typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new Error('--relink must name a JSON object whose values are absolute media paths.');
    }
  }
  process.stdout.write(`Library: ${input}\n${options.install ? 'Checking the prepared conversion before installation.' :
    'Preparing a separate converted copy. The source library will not be replaced.'}\n`);
  let canceled = false;
  const cancel = () => {
    canceled = true;
    process.stdout.write('\nStopping after the current read and saving progress...\n');
  };
  process.once('SIGINT', cancel);
  options.shouldCancel = () => canceled;
  options.onProgress = progress => {
    if (progress.current === 1 || progress.current % 25 === 0 || progress.current === progress.total) {
      process.stdout.write(`Checking ${progress.current}/${progress.total}: ${progress.title || '(untitled video)'}\n`);
    }
  };
  let report;
  try {
    report = options.install ? await Migration.installMigration(input, options) : await Migration.prepareMigration(input, options);
  } finally {
    process.removeListener('SIGINT', cancel);
  }
  if (report.status === 'already-current') {
    process.stdout.write('This library already uses video ID scheme 2. No conversion is needed.\n');
    return 0;
  }
  process.stdout.write(`Result: ${report.status}\nOutput: ${report.output}\n`);
  if (report.videoCounts) process.stdout.write(`Converted entries: ${report.videoCounts.media} active, ${report.videoCounts.inactive_media} inactive\n`);
  if (report.cachedPaths !== undefined) process.stdout.write(`Reused cached fingerprints: ${report.cachedPaths}\n`);
  if (report.archivedInactive) process.stdout.write(`Archived missing inactive entries: ${report.archivedInactive}\n`);
  const duplicateChanges = (report.duplicates || []).filter(entry => entry.state !== 'matched');
  if (duplicateChanges.length) process.stdout.write(`Duplicate paths requiring attention: ${duplicateChanges.length} (listed in report.json)\n`);
  for (const issue of (report.issues || []).slice(0, 10)) {
    process.stdout.write(`  ${issue.code}: ${issue.message}${issue.filename ? '\n    ' + issue.filename : ''}\n`);
  }
  if ((report.issues || []).length > 10) process.stdout.write('  Additional issues are listed in report.json.\n');
  if (report.status === 'ready') {
    process.stdout.write('Review report.json, then run the same command with --install (and the same --input/--output, if supplied).\n');
    return 0;
  }
  if (['installed','already-installed'].includes(report.status)) {
    process.stdout.write('The converted library is installed. Keep the migration folder and use the updated Mynda on both computers.\n');
    return 0;
  }
  process.stdout.write('The source library was not replaced. Resolve the reported issues and rerun preparation to resume.\n');
  return report.status === 'interrupted' ? 130 : 2;
}

if (require.main === module) main().then(code => {process.exitCode = code;}).catch(error => {
  process.stderr.write(`${error.code || 'MIGRATION_ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = {main, defaultLibraryPath, parseArguments};
