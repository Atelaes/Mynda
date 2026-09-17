// Separate process so the check exercises Babel's persistent startup cache,
// not Node's in-process require cache. Run only from RendererStartup's fixture.
const fs=require('fs'),vm=require('vm');
const React=require('react'),ReactDOMServer=require('react-dom/server');
const {loadFreshWithMocks}=require('./ModuleMocks');
const {buildTaggingReport}=require('../../src/tagging/TaggingReport');
const [htmlFile,reportFile,mode]=process.argv.slice(2);
const script=[...fs.readFileSync(htmlFile,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match=>match[1]).find(body=>body.includes('@babel/register'));
if (!script) throw new Error('Renderer startup script was not found');
const saved={id:'fixture',imdbID:'tt7654321',taggingEvidence:{kind:'episode',
  imdbID:'tt7654321',seriesID:'tt1234567',catalogTitle:'Fixture episode',original:{series:'Fixture series'},
  identities:{record:{origin:'automatic'}},parentEvidence:{confident:true}}};
function startupRequire(request) {
  if (request==='@babel/register' && mode==='legacy-cache') {
    // The previous startup used Babel's default persistent cache. Force that
    // behavior only in the negative control, keeping all other options equal.
    return options=>require('@babel/register')({...options,cache:true});
  }
  if (request==='./Renderer.js') {
    const {MynAutotagReport}=loadFreshWithMocks(reportFile,{
      react:React,electron:{shell:{openExternal:async()=>{}}},
      '../tagging/TaggingReport.js':{buildTaggingReport},
      './SharedComponents.js':{MynParagraphFolder:({paragraph})=>paragraph}
    });
    const markup=ReactDOMServer.renderToStaticMarkup(React.createElement(MynAutotagReport,{video:saved}));
    process.stdout.write(JSON.stringify({markup})+'\n');
    return;
  }
  return require(request);
}
startupRequire.resolve=require.resolve;
vm.compileFunction(script,['require'],{filename:htmlFile})(startupRequire);
