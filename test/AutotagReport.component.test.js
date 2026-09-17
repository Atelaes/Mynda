const path = require('path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
require('@babel/register')({presets:[require.resolve('@babel/preset-react')],extensions:['.js'],ignore:[/node_modules/],cache:false});
const shared = loadFreshWithMocks(path.join(__dirname,'../src/renderer/SharedComponents.js'),{
  electron:{ipcRenderer:{}},'./RendererRuntime.js':{}
});
const opened=[];
const {MynAutotagReport,LinkedReportText} = loadFreshWithMocks(path.join(__dirname,'../src/renderer/AutotagReport.js'),{
  './SharedComponents.js':shared,electron:{shell:{openExternal:async url=>{opened.push(url);}}}
});
const {MynEditor,MynEditorEdit} = loadFreshWithMocks(path.join(__dirname,'../src/renderer/Editor.js'),{
  electron:{ipcRenderer:{}},'../tagging/OmdbHelper.js':{},'./RendererRuntime.js':{},
  './SharedComponents.js':{...shared,MynOpenablePane:React.Component},'./EditorFields.js':{},
  './AutotagReport.js':{MynAutotagReport}
});
const suite = createSuite('Editor autotag report','component',
  'Real folding component, selectable report body, saved-video binding, navigation and safe React text rendering.');
const video={id:'a',title:'Current title',taggingDecision:{status:'unmatched',reason:{code:'no-results'},
  evidence:{original:{title:'<script>saved title</script>',filename:'/Shows/long filename.mkv'}}}};
const html=element=>ReactDOMServer.renderToStaticMarkup(element);

suite.test('renders a collapsed MynParagraphFolder with a native accessible button',()=>{
  const element=MynAutotagReport({video});
  assert.strictEqual(element.type,shared.MynParagraphFolder);
  const rendered=html(element);
  assert.match(rendered,/Autotag report: Not matched/);
  assert.match(rendered,/type="button"/);assert.match(rendered,/aria-expanded="false"/);
  assert.match(rendered,/aria-controls="edit-autotag-report-body"/);
  assert.match(rendered,/hidden=""/);
});
suite.test('heading toggles the folder, while its body has no collapse click handler',()=>{
  const element=MynAutotagReport({video});const folder=new shared.MynParagraphFolder(element.props);
  folder.setState=patch=>{folder.state={...folder.state,...patch};};
  let tree=folder.render();assert.strictEqual(tree.props.onClick,undefined);
  tree.props.children[0].props.onClick();tree=folder.render();
  assert.strictEqual(tree.props.children[0].props['aria-expanded'],true);
  assert.strictEqual(tree.props.children[1].props.hidden,false);
  assert.strictEqual(tree.props.children[1].props.onClick,undefined);
  tree.props.children[0].props.onClick();assert.strictEqual(folder.state.expanded,false);
});
suite.test('does not change existing click-anywhere folders',()=>{
  const folder=new shared.MynParagraphFolder({lede:'Existing folder',paragraph:'Existing text'});
  assert.strictEqual(typeof folder.render().props.onClick,'function');
  assert.match(html(folder.render()),/Existing folder/);
});
suite.test('escapes saved titles and distinguishes unsaved edits',()=>{
  const rendered=html(MynAutotagReport({video,hasUnsavedChanges:true}));
  assert.match(rendered,/&lt;script&gt;saved title&lt;\/script&gt;/);
  assert(!rendered.includes('<script>'));assert(!rendered.includes('Current title'));
  assert.match(rendered,/unsaved edits/);
});
suite.test('places the report after the form and uses the saved video rather than pending edits',()=>{
  const editor=new MynEditor({video,show:true});
  editor.state={...editor.state,video:{...video,title:'Unsaved different title'}};
  const tree=editor.createContentJSX(),children=React.Children.toArray(tree.props.children);
  const report=children[children.length-1];
  assert.strictEqual(report.type,MynAutotagReport);
  assert.strictEqual(report.props.video,video);
  assert.strictEqual(children[children.length-2].type,MynEditorEdit);
  assert(report.props.hasUnsavedChanges);
});
suite.test('keys the folder by video so navigation starts with a collapsed report',()=>{
  assert.notStrictEqual(MynAutotagReport({video}).key,MynAutotagReport({video:{...video,id:'b'}}).key);
});
suite.test('hides reports for batch editing, never-attempted videos and a hidden editor',()=>{
  assert.strictEqual(MynAutotagReport({video:{id:'batch'}}),null);
  assert.strictEqual(MynAutotagReport({video:{id:'new'}}),null);
  for(const props of [{video:{id:'batch'}},{video,show:false}]) {
    const editor=new MynEditor(props);editor.state={...editor.state,video:props.video};
    const children=React.Children.toArray(editor.createContentJSX().props.children);
    assert(!children.some(child=>child.type===MynAutotagReport));
  }
});
suite.test('IMDb IDs are links and a click opens only the canonical IMDb page externally',async()=>{
  const pieces=LinkedReportText({text:'Candidate tt1234567, series tt7654321'});
  const links=pieces.filter(p=>p && p.type==='a');
  assert.strictEqual(links.length,2);
  assert.strictEqual(links[0].props.href,'https://www.imdb.com/title/tt1234567/');
  let prevented=0,stopped=0;
  await links[0].props.onClick({type:'click',preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.strictEqual(opened.pop(),'https://www.imdb.com/title/tt1234567/');
  assert.strictEqual(prevented,1);assert.strictEqual(stopped,1);
});
suite.test('middle-click opens IMDb, right-click retains the ordinary link context menu',async()=>{
  const link=LinkedReportText({text:'tt1234567'})[1];
  const e={type:'auxclick',button:1,preventDefault(){},stopPropagation(){}};
  await link.props.onAuxClick(e);assert.strictEqual(opened.pop(),'https://www.imdb.com/title/tt1234567/');
  await link.props.onAuxClick({...e,button:2,preventDefault(){throw Error('Right click intercepted');}});
  assert.strictEqual(opened.length,0);
});
suite.test('arbitrary stored URLs and HTML never become executable report links',()=>{
  const rendered=html(React.createElement(LinkedReportText,{text:'javascript:alert(1) <img src=x> tt123ABC'}));
  assert(!rendered.includes('<a'));assert(!rendered.includes('<img'));assert.match(rendered,/&lt;img/);
});
suite.test('renders failed correction details and links the returned record',()=>{
  const sample={...video,taggingDecision:{...video.taggingDecision,evidence:{correctionChecks:[{
    kind:'adjacent-season',seriesID:'tt1000001',probed:{season:'2',episode:'3'},imdbID:'tt2000001',
    catalogTitle:'Returned title',outcome:'title-mismatch',via:'season-list'}]}}};
  const rendered=html(MynAutotagReport({video:sample}));
  assert.match(rendered,/Correction checks attempted/);assert.match(rendered,/did not pass the exact comparison/);
  assert.match(rendered,/https:\/\/www.imdb.com\/title\/tt2000001\//);
});
runSuite(suite);
