#!/usr/bin/env node
'use strict';
const path=require('path');
const os=require('os');
const Migration=require('./lib/ProfileMigration');

function defaultPaths(platform=process.platform,env=process.env,userHome=os.homedir()) {
  const api=platform==='win32'?path.win32:path.posix;
  const parent=platform==='darwin'?api.join(userHome,'Library','Application Support'):
    platform==='win32'?(env.APPDATA||api.join(userHome,'AppData','Roaming')):
      (env.XDG_CONFIG_HOME||api.join(userHome,'.config'));
  const name=require('../package.json').productName||require('../package.json').name;
  return {source:api.join(parent,'mynda'),destination:api.join(parent,name)};
}
function parseArguments(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    const name={'--source':'source','--destination':'destination','--output':'output'}[args[i]];
    if(name) {
      if(options[name]||!args[i+1]||args[i+1].startsWith('--')) throw new Error(`Supply exactly one value for ${args[i]}.`);
      options[name]=args[++i];
    } else if(args[i]==='--install') options.install=true;
    else if(args[i]==='--app-closed') options.appClosed=true;
    else if(args[i]==='--help') options.help=true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}
function usage() {
  return `Mynda profile and portable-artwork migration

Quit every Mynda instance and keep it closed until installation finishes.

  npm run profile:migrate -- --output "/path/to/private-backup" --app-closed
  npm run profile:migrate -- --output "/path/to/private-backup" --app-closed --install

Preparation copies and verifies the entire original profile, then prepares a
separate profile with relative artwork paths. It does not change the live profile.
Installation rechecks every checksum and swaps the prepared profile into place.
The exact original profile is also retained beside the installed profile.

Options:
  --source PATH       Existing profile (default: the lowercase mynda folder)
  --destination PATH  New sibling profile (default: the current product name)
  --output PATH       Required new private folder outside both profiles
  --app-closed        Confirm Mynda is closed and will stay closed
  --install           Install the migration saved in --output
  --help              Show this help

Review report.json in the private output directory before installing. Missing
artwork references are preserved and listed there; damaged historical snapshots
are retained byte-for-byte. The original encrypted activation file is backed up,
and the new profile starts without activation so you can re-enter the license.
No Keychain entries are read, renamed or deleted. Keep the verified backup and
retained original until the migrated application has been checked.
`;
}
async function main(args=process.argv.slice(2)) {
  const options=parseArguments(args);
  if(options.help) {process.stdout.write(usage()); return 0;}
  if(!options.output) throw new Error('Choose a new private backup folder with --output.');
  const defaults=defaultPaths();
  const result=options.install?await Migration.installMigration(options):
    await Migration.prepareMigration({...defaults,...options});
  // Summaries never print video titles, artwork filenames or credential data.
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  return 0;
}
if(require.main===module) main().then(code=>{process.exitCode=code;}).catch(error=>{
  process.stderr.write(`${error.code||'PROFILE_MIGRATION_FAILED'}: ${error.message}\n`);process.exitCode=1;
});
module.exports={main,defaultPaths,parseArguments};
