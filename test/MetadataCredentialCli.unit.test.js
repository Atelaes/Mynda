const {EventEmitter} = require('events');
const {PassThrough} = require('stream');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {runCredentialCommand} = require('../scripts/metadata-credentials-cli');
const suite=createSuite('Credential Terminal transport','unit','Private stdin, fixed arguments, safe failures and required completion markers.');
const token='synthetic-secret-token-never-in-argv';
function launchFixture(response,code=0) {
  const calls=[];let input='';
  function launch(executable,args,options) {
    calls.push({executable,args,options});
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    child.stdin.on('data',data=>{input+=data;});
    child.stdin.on('finish',()=>{child.stdout.write(response);child.emit('close',code);});
    return child;
  }
  return {launch,calls,input:()=>input};
}
suite.test('sends credentials only over stdin and keeps argv and environment free of the token',async()=>{
  const fixture=launchFixture('MYNDA_CREDENTIAL_RESULT:{"ok":true,"url":"https://fixture.example"}\n');
  const config={url:'https://fixture.example',token};
  await runCredentialCommand({action:'setup',config},{...fixture,executable:'/fixture/electron'});
  assert.deepStrictEqual(JSON.parse(fixture.input()),{action:'setup',config});
  assert(!JSON.stringify(fixture.calls).includes(token));
  assert(fixture.calls[0].args.includes('--metadata-credentials-cli'));
});
suite.test('malformed, missing and secret-bearing error responses remain generic',async()=>{
  for(const reply of [token,'',`MYNDA_CREDENTIAL_RESULT:${JSON.stringify({ok:false,message:token})}\n`]) {
    const fixture=launchFixture(reply,1);
    await assert.rejects(runCredentialCommand({action:'connect',url:'https://fixture.example'},{...fixture,executable:'/fixture/electron'}),
      error=>error.message==='Could not update connection settings.'&&!error.message.includes(token));
  }
});
runSuite(suite);
