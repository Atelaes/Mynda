'use strict';

// Explicit, offline migration. No app startup hook silently renames a profile.
// The full original and its hash manifest remain available after installation.
const fs = require('fs');
const io = fs.promises;
const path = require('path');
const os = require('os');
const {createHash, randomUUID} = require('crypto');
const {createArtworkPaths, artworkDirectory} = require('../../src/platform/ArtworkPaths');
const {isRelativeArtwork} = require('../../src/platform/ArtworkReference');
const {parseLibraryText} = require('../../src/library/LibraryPersistence');

const FORMAT = 'mynda-profile-migration-v1';
const filenames = {state:'migration.json', report:'report.json', backup:'original-profile', prepared:'prepared-profile'};
const failure = (code, message) => Object.assign(new Error(message), {code});
const exists = async name => {try {await io.lstat(name); return true;} catch (e) {if(e.code==='ENOENT') return false; throw e;}};
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

// Do not follow links out of the profile. Preserve their spelling in the backup.
async function inventory(directory) {
  const entries = [];
  async function visit(relative) {
    const filename = relative ? path.join(directory, relative) : directory;
    const stat = await io.lstat(filename);
    const entry = {path:relative, type:stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'unsupported'};
    if (entry.type === 'unsupported') throw failure('PROFILE_SPECIAL_FILE', 'The profile contains a live socket or another unsupported file. Quit Mynda and retry.');
    if (entry.type === 'file') Object.assign(entry,{bytes:stat.size,sha256:await fileHash(filename)});
    if (entry.type === 'symlink') entry.target = await io.readlink(filename);
    entries.push(entry);
    if (entry.type === 'directory') for (const name of (await io.readdir(filename)).sort()) await visit(relative ? path.join(relative,name) : name);
  }
  await visit('');
  return entries;
}

async function verify(directory, expected, code = 'PROFILE_CHANGED') {
  if (!same(await inventory(directory), expected)) throw failure(code, 'Profile files changed or failed checksum verification. Preserve the migration folder and prepare a fresh migration.');
}

async function privateCopy(source, destination, entries) {
  await io.mkdir(destination,{mode:0o700});
  for (const entry of entries) {
    if (!entry.path) continue;
    const from = path.join(source,entry.path), to = path.join(destination,entry.path);
    if (entry.type === 'directory') await io.mkdir(to,{mode:0o700});
    else if (entry.type === 'symlink') await io.symlink(entry.target,to);
    else {
      await io.copyFile(from,to,fs.constants.COPYFILE_EXCL);
      await io.chmod(to,0o600);
      const stat = await io.stat(from);
      await io.utimes(to,stat.atime,stat.mtime);
    }
  }
  await verify(destination,entries,'PROFILE_COPY_FAILED');
}

async function writeJSON(filename, value) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await io.open(temporary,'wx',0o600);
    await handle.writeFile(JSON.stringify(value,null,2)+'\n');
    await handle.sync(); await handle.close(); handle = null;
    await io.rename(temporary,filename);
  } finally {
    if (handle) await handle.close();
    await io.unlink(temporary).catch(e=>{if(e.code!=='ENOENT') throw e;});
  }
}

async function sameDirectory(a,b) {
  try {
    const first=await io.stat(a),second=await io.stat(b);
    return first.dev===second.dev && first.ino===second.ino;
  } catch(e) {if(e.code==='ENOENT') return false; throw e;}
}

async function assertOffline(source, appClosed) {
  if (!appClosed) throw failure('PROFILE_APP_OPEN', 'Quit Mynda, then pass --app-closed to confirm that it will stay closed during migration.');
  try {
    const lock = await io.readlink(path.join(source,'SingletonLock'));
    const match = /^(.*)-(\d+)$/.exec(lock);
    if (match && match[1] === os.hostname()) {
      try {process.kill(Number(match[2]),0);}
      catch(e) {if(e.code==='ESRCH') return; throw failure('PROFILE_APP_OPEN','Mynda may still be running. Quit it before migrating.');}
      throw failure('PROFILE_APP_OPEN','Mynda is still running. Quit it before migrating.');
    }
  } catch(e) {if(!['ENOENT','EINVAL'].includes(e.code)) throw e;}
}

function isWithin(parent, child) {
  const relative=path.relative(parent,child);
  return !relative || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));
}

async function convertLibraries(source, prepared, sourceManifest) {
  const paths = createArtworkPaths({userData:source});
  const targetRoot = artworkDirectory(prepared);
  const report = {libraries:0, active:0, inactive:0, convertedReferences:0, importedFiles:0,
    missingArtwork:[], skippedSnapshots:[], credentialsReset:true};
  const imports = new Map();
  async function importArtwork(value) {
    let imported=imports.get(value);
    if (imported===undefined) {
      try {
        const stat=await io.stat(value);
        if (!stat.isFile()) throw new Error('Not a file');
        const hash=await fileHash(value);
        const extension=/^\.[a-z0-9]{1,10}$/i.test(path.extname(value)) ? path.extname(value).toLowerCase() : '.image';
        imported=`imported-${hash}${extension}`;
        if (await exists(targetRoot) && (await io.lstat(targetRoot)).isSymbolicLink()) throw failure('PROFILE_ARTWORK_LINK','The artwork folder is a symlink. Choose a real managed folder before importing external artwork.');
        await io.mkdir(targetRoot,{recursive:true,mode:0o700});
        const destination=path.join(targetRoot,imported);
        if (await exists(destination)) {
          if (!(await io.lstat(destination)).isFile() || await fileHash(destination)!==hash) throw failure('PROFILE_ARTWORK_COLLISION','An imported artwork destination contains different bytes.');
        } else {
          await io.copyFile(value,destination,fs.constants.COPYFILE_EXCL);
          await io.chmod(destination,0o600);
          if (await fileHash(destination)!==hash || await fileHash(value)!==hash) throw failure('PROFILE_ARTWORK_CHANGED','External artwork changed while it was being copied.');
          report.importedFiles++;
        }
      } catch(e) {
        if (e.code && e.code.startsWith('PROFILE_')) throw e;
        imported=null;
      }
      imports.set(value,imported);
    }
    return imported;
  }
  async function managedPathHasLink(reference) {
    let current=paths.directory;
    for (const segment of ['',...reference.split('/')]) {
      if(segment) current=path.join(current,segment);
      try {if((await io.lstat(current)).isSymbolicLink()) return true;}
      catch(e) {if(e.code==='ENOENT') return false; throw e;}
    }
    return false;
  }
  const candidates=sourceManifest.filter(item=>item.type==='file' &&
    (/^Library[\\/]library(?:-[^\\/]+)?\.json$/i.test(item.path) ||
      /^Library[\\/](?:Backups|Recovery)[\\/].*\.json$/i.test(item.path)));
  if (!candidates.some(item=>item.path===path.join('Library','library.json'))) {
    throw failure('PROFILE_LIBRARY_MISSING','No primary Library/library.json was found in this profile.');
  }
  for (const item of candidates) {
    const filename = path.join(prepared,item.path);
    let library;
    try {library=parseLibraryText(await io.readFile(filename,'utf8'));}
    catch(e) {
      if (item.path===path.join('Library','library.json')) throw failure('PROFILE_LIBRARY_INVALID','The primary library is unreadable; resolve library recovery before migrating.');
      report.skippedSnapshots.push(item.path); continue;
    }
    report.libraries++;
    for (const group of ['media','inactive_media']) {
      const videos=library[group] || [];
      if (item.path===path.join('Library','library.json')) report[group==='media'?'active':'inactive']=videos.length;
      for (let index=0; index<videos.length; index++) {
        const video=videos[index], value=video && video.artwork;
        if (typeof value!=='string' || !value || /^https?:\/\//i.test(value)) continue;
        const reference=paths.reference(value);
        if (isRelativeArtwork(reference)) {
          let found=false, resolved;
          try {
            // Profile migration has explicit consent to import referenced images;
            // unlike renderer resolution it may materialize an old linked image.
            resolved=path.join(paths.directory,...reference.split('/'));
            found=(await io.stat(resolved)).isFile();
          } catch (_) {}
          // Absolute symlink targets may still name the old profile. Copy their
          // bytes to a regular managed file before the profile is renamed.
          const portable=found && await managedPathHasLink(reference) ? await importArtwork(resolved) : reference;
          video.artwork=portable || reference;
          if (video.artwork!==value) report.convertedReferences++;
          if (!found || !portable) report.missingArtwork.push({library:item.path,group,index,reference});
          continue;
        }
        // Existing external images become managed files. Missing references stay
        // intact and are reported; the migration never drops a user's artwork.
        if (!path.isAbsolute(value)) {
          report.missingArtwork.push({library:item.path,group,index,reference:value}); continue;
        }
        const imported=await importArtwork(value);
        if (imported) {video.artwork=imported; report.convertedReferences++;}
        else report.missingArtwork.push({library:item.path,group,index,reference:value});
      }
    }
    await writeJSON(filename,library);
  }
  const connection=path.join(prepared,'connection');
  if (await exists(connection) && (await io.lstat(connection)).isSymbolicLink()) throw failure('PROFILE_CONNECTION_LINK','The connection folder is a symlink. No credential files were changed.');
  await io.mkdir(connection,{recursive:true,mode:0o700});
  // The original encrypted credentials remain in the verified backup. This
  // marker also prevents development legacy credentials from being reimported.
  await writeJSON(path.join(connection,'metadata-credentials.json'),{version:1,removed:true});
  return report;
}

async function readState(output) {
  const state=JSON.parse(await io.readFile(path.join(output,filenames.state),'utf8'));
  if (state.format!==FORMAT || !/^[a-f0-9-]{36}$/.test(state.id) || typeof state.source!=='string' || typeof state.destination!=='string' ||
      !path.isAbsolute(state.source) || !path.isAbsolute(state.destination) ||
      !Array.isArray(state.sourceManifest) || !Array.isArray(state.preparedManifest)) throw failure('PROFILE_STATE_INVALID','This is not a complete profile migration.');
  const parent=path.dirname(state.source);
  if (parent!==path.dirname(state.destination) || state.source===state.destination ||
      state.installStage!==path.join(parent,`.Mynda-migration-${state.id}`) ||
      state.originalRetained!==path.join(parent,`.mynda-before-migration-${state.id}`)) {
    throw failure('PROFILE_STATE_INVALID','The migration journal contains unexpected directory locations.');
  }
  return state;
}

function summary(state, output) {
  const report=state.report;
  return {status:state.status,output,source:state.source,destination:state.destination,
    backup:path.join(output,filenames.backup),originalRetained:state.originalRetained,
    files:state.sourceManifest.filter(entry=>entry.type==='file').length,
    bytes:state.sourceManifest.reduce((sum,entry)=>sum+(entry.bytes||0),0),
    active:report.active,inactive:report.inactive,libraries:report.libraries,
    convertedReferences:report.convertedReferences,importedFiles:report.importedFiles,
    missingArtwork:report.missingArtwork.length,skippedSnapshots:report.skippedSnapshots.length,
    credentialsReset:report.credentialsReset};
}

async function prepareMigration({source,destination,output,appClosed=false} = {}) {
  source=path.resolve(source); destination=path.resolve(destination); output=path.resolve(output);
  await assertOffline(source,appClosed);
  if (!(await io.lstat(source)).isDirectory()) throw failure('PROFILE_SOURCE','Choose a real profile directory, not a symlink.');
  if (source===destination) throw failure('PROFILE_SAME_PATH','Choose distinct source and destination profile names.');
  if (path.dirname(source)!==path.dirname(destination)) throw failure('PROFILE_DESTINATION','The destination must be a sibling of the source profile.');
  const sourceReal=await io.realpath(source);
  const outputReal=await exists(output)?await io.realpath(output):path.join(await io.realpath(path.dirname(output)),path.basename(output));
  if (isWithin(source,output)||isWithin(destination,output)||isWithin(sourceReal,outputReal)) throw failure('PROFILE_OUTPUT','The backup directory must be outside both profile folders.');
  if (await exists(destination) && !await sameDirectory(source,destination)) throw failure('PROFILE_DESTINATION_EXISTS','The destination already contains a different profile. Nothing was merged or replaced.');
  if (await exists(output)) {
    const state=await readState(output);
    if (state.source!==source || state.destination!==destination) throw failure('PROFILE_OUTPUT_EXISTS','This output folder belongs to a different migration.');
    await verify(path.join(output,filenames.backup),state.sourceManifest,'PROFILE_BACKUP_CHANGED');
    if (state.status==='ready') {
      await verify(source,state.sourceManifest,'PROFILE_SOURCE_CHANGED');
      await verify(path.join(output,filenames.prepared),state.preparedManifest,'PROFILE_PREPARED_CHANGED');
    }
    return summary(state,output);
  }
  await io.mkdir(output,{mode:0o700});
  const sourceManifest=await inventory(source);
  await privateCopy(source,path.join(output,filenames.backup),sourceManifest);
  await verify(source,sourceManifest,'PROFILE_SOURCE_CHANGED');
  await privateCopy(path.join(output,filenames.backup),path.join(output,filenames.prepared),sourceManifest);
  const report=await convertLibraries(source,path.join(output,filenames.prepared),sourceManifest);
  await verify(source,sourceManifest,'PROFILE_SOURCE_CHANGED');
  const id=randomUUID(), parent=path.dirname(source);
  const state={format:FORMAT,id,status:'ready',createdAt:new Date().toISOString(),source,destination,
    installStage:path.join(parent,`.Mynda-migration-${id}`),
    originalRetained:path.join(parent,`.mynda-before-migration-${id}`),sourceManifest,
    preparedManifest:await inventory(path.join(output,filenames.prepared)),report};
  await writeJSON(path.join(output,filenames.report),report);
  await writeJSON(path.join(output,filenames.state),state);
  return summary(state,output);
}

async function installMigration({output,source,destination,appClosed=false,rename=io.rename.bind(io)} = {}) {
  output=path.resolve(output);
  const state=await readState(output), stateFile=path.join(output,filenames.state);
  if ((source&&path.resolve(source)!==state.source)||(destination&&path.resolve(destination)!==state.destination)) throw failure('PROFILE_STATE_MISMATCH','The supplied profile paths do not match this prepared migration.');
  await assertOffline(state.destination,appClosed);
  await assertOffline(state.source,appClosed);
  await verify(path.join(output,filenames.backup),state.sourceManifest,'PROFILE_BACKUP_CHANGED');
  if (state.status==='installed') {
    if (!await exists(state.destination)) throw failure('PROFILE_DESTINATION_MISSING','The installed profile has been moved or removed. The migration backup remains available.');
    return {...summary(state,output),status:'already-installed'};
  }
  if (!['ready','installing','source-moved'].includes(state.status)) throw failure('PROFILE_STATE_INVALID','Migration is not ready to install.');
  await verify(path.join(output,filenames.prepared),state.preparedManifest,'PROFILE_PREPARED_CHANGED');

  // A process interruption can happen between a directory rename and journaling
  // it. Reconcile the directories using full hashes before retrying anything.
  if (await exists(state.originalRetained)) {
    await verify(state.originalRetained,state.sourceManifest,'PROFILE_ORIGINAL_CHANGED');
    if (await exists(state.destination)) {
      await verify(state.destination,state.preparedManifest,'PROFILE_DESTINATION_CHANGED');
      state.status='installed'; await writeJSON(stateFile,state); return summary(state,output);
    }
    if (await exists(state.source)) throw failure('PROFILE_RECOVERY_CONFLICT','Both the old profile and retained original exist. Preserve them and resolve the conflict before retrying.');
    await rename(state.originalRetained,state.source);
  }
  await verify(state.source,state.sourceManifest,'PROFILE_SOURCE_CHANGED');
  if (await exists(state.destination) && !await sameDirectory(state.source,state.destination)) throw failure('PROFILE_DESTINATION_EXISTS','The destination now contains a different profile. Nothing was replaced.');
  if (await exists(state.installStage)) {
    await verify(state.installStage,state.preparedManifest,'PROFILE_STAGE_CHANGED');
  } else await privateCopy(path.join(output,filenames.prepared),state.installStage,state.preparedManifest);
  await verify(state.source,state.sourceManifest,'PROFILE_SOURCE_CHANGED');
  await assertOffline(state.source,appClosed);
  let moved=false, installed=false;
  try {
    state.status='installing'; await writeJSON(stateFile,state);
    await rename(state.source,state.originalRetained); moved=true;
    state.status='source-moved'; await writeJSON(stateFile,state);
    await rename(state.installStage,state.destination); installed=true;
    await verify(state.destination,state.preparedManifest,'PROFILE_INSTALL_FAILED');
    state.status='installed'; state.installedAt=new Date().toISOString(); await writeJSON(stateFile,state);
    return summary(state,output);
  } catch(error) {
    // Roll back only directories moved by this invocation. Both backups remain.
    if (installed) await rename(state.destination,state.installStage);
    if (moved) await rename(state.originalRetained,state.source);
    state.status='ready'; await writeJSON(stateFile,state);
    throw error;
  }
}

module.exports={prepareMigration,installMigration,inventory,verify,filenames,FORMAT};
