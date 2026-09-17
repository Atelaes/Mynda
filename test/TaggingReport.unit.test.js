const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {buildTaggingReport:report} = require('../src/tagging/TaggingReport');
const suite = createSuite('Saved autotag explanations','unit',
  'Historical outcomes, partial evidence, identity provenance, numbering, candidate bounds and safe error explanations.');
const input = {id:'a',kind:'show',series:'Silver Observatory',title:'Arrival',season:'1',episode:'2',filename:'/shows/a.mkv'};
const evidence = {kind:'episode',original:input,input,imdbID:'tt2000001',catalogTitle:'Arrival',seriesID:'tt1000001',
  requested:{season:'1',episode:'2'},matched:{season:'1',episode:'2'},
  parentEvidence:{basis:'series-title-and-year',confident:true,origin:'automatic',catalogYear:'2000'},
  identities:{record:{origin:'automatic'}}};
const success = extra => ({...input,imdbID:'tt2000001',taggingEvidence:evidence,...extra});
const failure = (code,extra={}) => ({...input,taggingDecision:{status:'unmatched',reason:{code},evidence:{original:input}},...extra});
const fact = (r,label) => (r.facts.find(f => f.label === label) || {}).value || '';
const all = r => JSON.stringify(r);

suite.test('hides never-attempted, manually entered ID, parent-only and batch records',()=>{
  for (const v of [null,input,{...input,imdbID:'tt1'},
    {...input,taggingEvidence:{imdbID:'tt1',identities:{record:{origin:'user'}}}},
    {...input,taggingEvidence:{seriesID:'tt1',parentEvidence:{confident:true}}},success({id:'batch'})]) assert.strictEqual(report(v),null);
});
suite.test('reports accepted tags even after the editor resets autotag_tried',()=>{
  const r=report(success({autotag_tried:false}));
  assert.strictEqual(r.status,'matched');
  assert.match(fact(r,'Applied record'),/Arrival.*tt2000001/);
  assert.match(fact(r,'Identified series'),/Silver Observatory.*2000.*tt1000001/);
  assert(!r.nextStep);
});
suite.test('does not convert a saved rejection with a proposed ID into success',()=>{
  const r=report({...success(),taggingDecision:{status:'unmatched',reason:{code:'unverified-episode-title'},evidence}});
  assert.strictEqual(r.status,'unmatched');
  assert.match(fact(r,'Proposed record'),/tt2000001/);
  assert.strictEqual(fact(r,'Applied record'),'');
  assert.match(r.notes.join(' '),/did not apply a new match/);
});
suite.test('separates a confirmed series from an episode failure',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'no-results'},evidence}});
  assert.match(fact(r,'Identified series'),/tt1000001/);
  assert.match(r.summary,/does not establish.*absent/);
});
suite.test('keeps original input separate from an inferred season and corrected result',()=>{
  const r=report(success({taggingEvidence:{...evidence,original:{...input,season:''},
    input:{...input,season:'1'},matched:{season:'1',episode:'3'},titleComparison:{matched:true,title:'Arrival'}}}));
  assert.match(fact(r,'Inferred season'),/Season 1/);
  assert.strictEqual(fact(r,'Input numbering'),'episode 2');
  assert.match(fact(r,'Numbering correction'),/episode 2 → Season 1, episode 3/);
  assert.match(fact(r,'Exact title check'),/matched/);
});
suite.test('a rejected correction is explicitly labeled as not applied',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'episode-mismatch'},
    evidence:{...evidence,matched:{season:'1',episode:'3'}}}});
  assert.match(fact(r,'Numbering correction'),/not applied/);
});
suite.test('represents zero-based release order and supporting corrections',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'unverified-episode-order'},evidence:{...evidence,
    orderAssessment:{accepted:false,reason:'This release starts at zero',numberingEvidence:{local:[0,1,2],catalog:[1,2,3]},
      support:[{originalTitle:'Arrival',localSeason:'1',catalogSeason:'1',localEpisode:'0',catalogEpisode:'1'}]}}}});
  assert.match(fact(r,'Numbering conflict'),/0–2.*1–3/);
  assert.match(fact(r,'Conflicting episodes'),/episode 0 → Season 1, episode 1/);
});
suite.test('explains runtime coverage without asserting an unproven combined episode',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'episode-coverage-mismatch'},
    evidence:{...evidence,runtimeAssessment:{state:'compatible',localMinutes:91.23,omdbMinutes:44}}}});
  assert.match(r.summary,/possible explanation/);
  assert.strictEqual(fact(r,'Runtime'),'File: 91.2 min; OMDb: 44 min.');
});
suite.test('uses final title comparison before an older exact-title flag',()=>{
  const r=report(success({taggingEvidence:{...evidence,exactTitle:true,titleComparison:{matched:false}}}));
  assert.strictEqual(fact(r,'Exact title check'),'');
});
suite.test('shows movie title/year evidence and runtime without episode claims',()=>{
  const r=report(success({kind:'movie',taggingEvidence:{kind:'movie',imdbID:'tt2000001',catalogTitle:'Orchard Signal',
    original:{title:'Orchard.Signal.2000.mkv',kind:'movie'},movieAssessment:{matchKind:'exact',yearDifference:0,
      plausibility:{localRuntimeMinutes:94,omdbRuntimeMinutes:95}}}}));
  assert.strictEqual(fact(r,'Movie year check'),'The years agreed.');
  assert.match(fact(r,'Runtime'),/94 min.*95 min/);
  assert.strictEqual(fact(r,'Episode lookup'),'');
});
suite.test('distinguishes user selection, saved automatic evidence and unknown ID origin',()=>{
  const user=report(success({taggingEvidence:{...evidence,identities:{record:{origin:'user'}}}}));
  assert.match(user.summary,/you selected/);
  const legacy=report(success({taggingEvidence:{...evidence,lookup:{kind:'explicit-id'},identities:{record:{origin:'legacy'}}}}));
  assert.match(legacy.summary,/refreshed/);
  assert.match(legacy.notes.join(' '),/source.*unknown/);
  const reused=report(success({taggingEvidence:{...evidence,parentEvidence:{...evidence.parentEvidence,reuse:'stored'}}}));
  assert.match(fact(reused,'Series evidence'),/automatic identification.*reused/);
});
suite.test('does not infer a historical success from current tags when details are missing',()=>{
  const r=report({...input,autotag_tried:true,imdbID:'tt3'});
  assert.strictEqual(r.status,'unavailable');
  assert.match(r.summary,/no detailed outcome/);
});
suite.test('warns when the saved accepted ID is no longer the current ID',()=>{
  assert.match(report(success({imdbID:'tt999'})).notes.join(' '),/differs/);
});
suite.test('distinguishes service limits, timeouts and malformed catalog records from unmatched',()=>{
  for (const [code,expected] of [['request-budget-exhausted',/lookup limit/],['ECONNABORTED',/timed out/],
    ['malformed-catalog-record',/invalid record/],['network-error',/connection error/]]) {
    const r=report({...input,autotag_tried:false,taggingDecision:{status:'service-error',reason:{code,
      message:'secret https://omdb.example/?apikey=secret\n at internalFunction'},evidence:{original:input}}});
    assert.match(r.summary,expected);assert.match(r.nextStep,/eligible for retry/);
    assert(!all(r).includes('secret'));assert(!all(r).includes('internalFunction'));
  }
});
suite.test('older reason codes fall back to saved text and redact transport details',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'future-code',
    message:'Unable to verify api_key=secret https://example.test/?token=secret\n at privateStack'}}});
  assert.match(r.summary,/Unable to verify/);assert(!all(r).includes('secret'));assert(!all(r).includes('privateStack'));
});
suite.test('ambiguous structural candidates keep unknown totals unknown and duplicates deduplicated',()=>{
  const structure={basis:'ambiguous-season-structure',profile:{inferredSeason:true,seasons:[{season:1,positions:[1,2,2,3,5]}]},
    candidates:[{seriesID:'tt1',title:'Silver Observatory',year:'2000',seasons:[{season:1,count:5}],exactCounts:[1]},
      {seriesID:'tt2',title:'Silver Observatory',year:'2020',seasons:[{season:1,count:null}]}]};
  const r=report({...input,taggingDecision:{status:'ambiguous',reason:{code:'ambiguous-series'},
    evidence:{original:input,structureAssessment:{structure}}}});
  assert.match(fact(r,'Local season counts'),/1–3, 5/);
  assert.match(r.candidates[1].detail,/total unknown/);
  assert.strictEqual(r.candidates[1].selected,false);
  assert.match(fact(r,'Season inference'),/considered/);
});
suite.test('reports the recorded structural selection without rerunning thresholds',()=>{
  const structure={selectedID:'tt1',basis:'season-structure',comparisons:[{basis:'positive-season-count'}],
    candidates:[{seriesID:'tt1',title:'Silver Observatory'},{seriesID:'tt2',title:'Another show'}]};
  const r=report(success({taggingEvidence:{...evidence,parentEvidence:{basis:'structure-series-selection',confident:true,
    origin:'automatic',support:{structure}}}}));
  assert.strictEqual(r.candidates[0].selected,true);
  assert.match(fact(r,'Season evidence'),/total was unknown/);
});
suite.test('bounds candidate lists and tolerates missing optional evidence',()=>{
  const r=report({...input,taggingDecision:{status:'ambiguous',reason:null,evidence:{discovery:{candidates:
    Array.from({length:25},(_,n)=>({Title:'Film '+n,Year:'2000',imdbID:'tt'+n}))}}}});
  assert.strictEqual(r.candidates.length,20);assert.strictEqual(r.moreCandidates,5);
  assert.doesNotThrow(()=>report({...input,taggingDecision:{status:'unmatched',evidence:null}}));
});
suite.test('does not alter the saved video or its evidence',()=>{
  const v=success();const before=JSON.stringify(v);
  const freeze=o=>{if(o && typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o);}};
  freeze(v);assert.doesNotThrow(()=>report(v));assert.strictEqual(JSON.stringify(v),before);
});

suite.test('describes every saved correction outcome without calling a proposal an applied tag',()=>{
  for (const [outcome,expected] of [['not-found',/No episode record/],['title-mismatch',/exact comparison/],
    ['ambiguous-title',/More than one/],['service-error',/prevented/],['invalid-record',/did not identify/],
    ['selected',/remaining episode checks/],['proposed',/normal title and runtime/]]) {
    const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'no-results'},evidence:{correctionChecks:[{
      kind:'adjacent-season',seriesID:'tt123',probed:{season:'2',episode:'4'},outcome,via:'season-list'}]}}});
    assert.match(r.corrections[0].detail,expected);assert.match(r.corrections[0].detail,/fallback/);
    assert.strictEqual(r.status,'unmatched');
  }
});
suite.test('older request traces show that a probe ran without inventing its title result',()=>{
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'episode-mismatch'},evidence:{requests:[
    {stage:'adjacent season title probe',parameters:{i:'tt123',Season:'2',Episode:'4'},outcome:'response'},
    {stage:'nearby episode title probe',parameters:{i:'tt123',Season:'1',Episode:'5'},outcome:'not-found'}]}}});
  assert.match(r.corrections[0].detail,/not saved/);assert.match(r.corrections[1].detail,/No episode record/);
});
suite.test('long histories keep the latest correction visible and state the omitted count',()=>{
  const checks=Array.from({length:50},(_,i)=>({kind:'nearby-episode',probed:{season:'1',episode:String(i)},outcome:'title-mismatch'}));
  checks.push({kind:'sibling-numbering',probed:{season:'2',episode:'3'},outcome:'proposed'});
  const r=report({...input,taggingDecision:{status:'unmatched',reason:{code:'no-results'},evidence:{correctionChecks:checks}}});
  assert.strictEqual(r.corrections.length,40);assert.strictEqual(r.moreCorrections,11);
  assert.match(r.corrections[39].label,/Sibling-supported/);
});
runSuite(suite);
