const React = require('react');
const {MynParagraphFolder} = require('./SharedComponents.js');
const {buildTaggingReport} = require('../tagging/TaggingReport.js');
const {shell} = require('electron');

function LinkedReportText({text}) {
  return String(text).split(/(\btt\d+\b)/).map((part,index)=>{
    if (!/^tt\d+$/.test(part)) return part;
    const url=`https://www.imdb.com/title/${part}/`;
    const open=async event=>{
      if (event.type === 'auxclick' && event.button !== 1) return;
      event.preventDefault();event.stopPropagation();
      try { await shell.openExternal(url); }
      catch(error) { alert('Could not open IMDb in your browser.'); }
    };
    return <a key={index} href={url} onClick={open} onAuxClick={open}>{part}</a>;
  });
}

// Receive the saved video, not the editor's working copy. Typing a title or
// previewing a search result must not rewrite the history of the saved attempt.
function MynAutotagReport({video, hasUnsavedChanges = false}) {
  const report = buildTaggingReport(video);
  if (!report) return null;
  const body = (
    <div className="autotag-report-content">
      <p className="autotag-report-summary"><LinkedReportText text={report.summary} /></p>
      {report.notes.map((note,index) => <p className="autotag-report-note" key={index}><LinkedReportText text={note} /></p>)}
      {hasUnsavedChanges && <p className="autotag-report-note">You have unsaved edits. This report describes the saved video’s tagging attempt.</p>}
      {report.facts.length > 0 && <dl>
        {report.facts.map((fact,index) => <React.Fragment key={index}>
          <dt>{fact.label}</dt><dd><LinkedReportText text={fact.value} /></dd>
        </React.Fragment>)}
      </dl>}
      {report.candidates.length > 0 && <div className="autotag-report-candidates">
        <h4>{report.candidateHeading}</h4>
        <ul>{report.candidates.map((candidate,index) => <li key={index}>
          <span><LinkedReportText text={candidate.label} />{candidate.selected ? ' — selected' : ''}</span>
          {candidate.detail && <p><LinkedReportText text={candidate.detail} /></p>}
        </li>)}</ul>
        {report.moreCandidates > 0 && <p>{report.moreCandidates} more candidates were recorded.</p>}
      </div>}
      {report.corrections.length > 0 && <div className="autotag-report-corrections">
        <h4>Correction checks attempted</h4>
        <ul>{report.corrections.map((check,index)=><li key={index}>
          <strong><LinkedReportText text={check.label} /></strong>
          {check.record && <p><LinkedReportText text={check.record} /></p>}
          <p><LinkedReportText text={check.detail} /></p>
        </li>)}</ul>
        {report.moreCorrections > 0 && <p>{report.moreCorrections} earlier correction checks were also recorded.</p>}
      </div>}
      {report.nextStep && <p className="autotag-report-next"><strong>What you can do:</strong> {report.nextStep}</p>}
      <p className="autotag-report-footnote">Based on the saved attempt. Editing fields does not rerun these checks.</p>
    </div>
  );
  return <MynParagraphFolder key={video.id} id="edit-autotag-report" className="autotag-report"
    headerOnly={true} lede={`Autotag report: ${report.label}`} paragraph={body} />;
}

module.exports = {MynAutotagReport,LinkedReportText};
