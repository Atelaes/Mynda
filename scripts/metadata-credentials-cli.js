const path = require('path');
const {spawn} = require('child_process');
const {messages} = require('../src/tagging/MetadataCredentials');
const PREFIX = 'MYNDA_CREDENTIAL_RESULT:';

function runCredentialCommand(command, {launch = spawn, executable = require('electron')} = {}) {
  return new Promise((resolve, reject)=>{
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = launch(executable, [path.resolve(__dirname, '..'), '--metadata-credentials-cli'],
      {env, stdio:['pipe','pipe','pipe']});
    let output = '', overflow = false;
    const timer = setTimeout(()=>{child.kill(); reject(new Error('Connection setup timed out. Check for a system keychain prompt and try again.'));}, 120000);
    child.stdout.on('data', data=>{
      if (output.length + data.length > 65536) { overflow = true; child.kill(); }
      else output += data.toString();
    });
    child.stderr.resume();
    child.stdin.on('error', ()=>{});
    child.once('error', ()=>{clearTimeout(timer); reject(new Error('Could not start Mynda. Run npm ci and check the Electron installation.'));});
    child.once('close', code=>{
      clearTimeout(timer);
      const allowed = [...Object.values(messages), 'Quit Mynda before changing its connection from Terminal.'];
      try {
        const line = output.split(/\r?\n/).filter(value=>value.startsWith(PREFIX)).pop();
        const result = JSON.parse(line.slice(PREFIX.length));
        if (overflow || code !== 0 || result.ok !== true) throw new Error(allowed.includes(result.message) ? result.message : 'Could not update connection settings.');
        resolve(result);
      } catch (error) { reject(new Error(allowed.includes(error.message) ? error.message : 'Could not update connection settings.')); }
    });
    // Secrets travel through this private pipe, never argv or the environment.
    child.stdin.end(JSON.stringify(command));
  });
}
module.exports = {runCredentialCommand};
