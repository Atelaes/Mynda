'use strict';
const {app} = require('electron');
const {credentials} = require('./MetadataConnection');
const PREFIX = 'MYNDA_CREDENTIAL_RESULT:';

async function run() {
  let outcome;
  try {
    if (!app.requestSingleInstanceLock()) throw new Error('Quit Mynda before changing its connection from Terminal.');
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) throw new Error('Invalid connection command.');
      chunks.push(chunk);
    }
    let command;
    try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) { throw new Error('Invalid connection command.'); }
    await app.whenReady();
    const store = credentials();
    if (command.action === 'read-for-test' && !app.isPackaged) {
      // Only the explicit live-test launcher consumes this private pipe. This
      // capability is never exposed by preload, the UI, or the packaged app.
      const connection = await store.getConfig();
      process.stdout.write(PREFIX + JSON.stringify({ok:true,connection}) + '\n', ()=>app.exit(0));
      return;
    }
    let status;
    if (command.action === 'setup') status = await store.save(command.config, {check:false, onlyIfMissing:true});
    else if (command.action === 'connect') status = await store.changeServer(command.url);
    else throw new Error('Invalid connection command.');
    outcome = {ok:true, url:status.url};
  } catch (error) {
    const messages = require('../tagging/MetadataCredentials').messages;
    outcome = {ok:false, message:messages[error.code] ||
      (error.message === 'Quit Mynda before changing its connection from Terminal.' ? error.message : 'Could not update connection settings.')};
  }
  process.stdout.write(PREFIX + JSON.stringify(outcome) + '\n', ()=>app.exit(outcome.ok ? 0 : 1));
}
run();
