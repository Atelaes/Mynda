const {assert,createSuite,runSuite}=require('./helpers/TestHarness');
const LibraryClient=require('../src/library/LibraryClient');
const {makeDelta}=require('../src/library/LibraryProtocol');
const {libraryFixture,videoFixture}=require('./helpers/Fixtures');
const suite=createSuite('Committed library notifications','unit',
  'One batch notification sees all committed records; individual listeners, resyncs and duplicate delivery remain safe.');

async function fixture() {
  let snapshot={session:'session',revision:0,paths:{},data:libraryFixture({
    media:Array.from({length:20},(_,i)=>videoFixture({id:String(i),title:'Original',new:true}))})};
  const batches=[],saved=[],individual=[],errors=[];
  const client=new LibraryClient({initialData:snapshot.data,
    api:{snapshot:async()=>snapshot,onCommitted(){},onCloseCanceled(){},onPrepareClose(){}},
    log:{error:(...args)=>errors.push(args)},onSaved:address=>saved.push(address),
    onSavedBatch:addresses=>batches.push({addresses:[...addresses],revision:client.revision,
      titles:client.media.map(v=>v.title)})});
  client.subscribe(address=>individual.push(address));
  await client.ready;batches.length=0;saved.length=0;individual.length=0;
  return {client,batches,saved,individual,errors,setSnapshot(value){snapshot=value;}};
}

suite.test('twenty record changes produce one complete batch callback and all individual notifications',async()=>{
  const f=await fixture(),before=f.client.getSaveObject();
  const after={...before,media:before.media.map(v=>({...v,title:'Tagged',new:false}))};
  const addresses=after.media.map(v=>`media.${v.id}`);
  const message={session:'session',revision:1,addresses,delta:makeDelta(before,after)};
  await f.client.receive(message);
  assert.deepStrictEqual(f.batches,[{addresses,revision:1,titles:Array(20).fill('Tagged')}]);
  assert.deepStrictEqual(f.saved,addresses);assert.deepStrictEqual(f.individual,addresses);
  await f.client.receive(message); // IPC broadcast and commit reply can duplicate.
  assert.strictEqual(f.batches.length,1);assert.strictEqual(f.saved.length,20);
  assert.deepStrictEqual(f.client.media,after.media);
});

suite.test('revision-gap resynchronization publishes one complete snapshot notification',async()=>{
  const f=await fixture(),before=f.client.getSaveObject();
  const data={...before,media:before.media.map(v=>({...v,title:'Resynced'}))};
  f.setSnapshot({session:'session',revision:5,paths:{},data});
  await f.client.receive({session:'session',revision:5,addresses:['media.0'],delta:{}});
  assert.strictEqual(f.batches.length,1);assert.strictEqual(f.batches[0].revision,5);
  assert.deepStrictEqual(f.batches[0].titles,Array(20).fill('Resynced'));
  assert.deepStrictEqual(f.batches[0].addresses,['media','inactive_media','settings','playlists','recently_watched']);
  assert.deepStrictEqual(f.individual,f.batches[0].addresses);
});

suite.test('a failed batch observer does not suppress record listeners or roll back the library',async()=>{
  const f=await fixture(),before=f.client.getSaveObject();
  f.client.onSavedBatch=()=>{throw Error('Display failed');};
  const after={...before,media:before.media.map(v=>({...v,new:false}))};
  await f.client.receive({session:'session',revision:1,addresses:['media.0','media.1'],delta:makeDelta(before,after)});
  assert.strictEqual(f.errors.length,1);assert.strictEqual(f.client.revision,1);
  assert.deepStrictEqual(f.saved,['media.0','media.1']);assert.deepStrictEqual(f.individual,f.saved);
  assert(f.client.media.every(v=>!v.new));
});

suite.test('rejected responses and empty notifications do not refresh the view',async()=>{
  const f=await fixture();
  await assert.rejects(f.client.receive({error:{message:'Save failed'}}),/Save failed/);
  f.client.notify([]);
  assert.strictEqual(f.client.revision,0);assert.deepStrictEqual(f.batches,[]);
  assert.deepStrictEqual(f.individual,[]);
});

runSuite(suite);
