const React = require('react');
const {fileManagerName} = require('./RendererUtils');

class DiagnosticExport extends React.Component {
  constructor(props) {
    super(props);
    this.state = {includeLibrary: false, busy: false, filePath: '', message: '', error: false, warnings: []};
    this.exportDiagnostics = this.exportDiagnostics.bind(this);
  }
  componentWillUnmount() { this.unmounted = true; }
  update(patch) { if (!this.unmounted) this.setState(patch); }
  async exportDiagnostics() {
    if (this.exporting) return;
    this.exporting = true;
    this.update({busy: true, filePath: '', message: '', error: false, warnings: []});
    try {
      const response = await window.mynda.diagnostics.export({includeLibrary: this.state.includeLibrary});
      if (!response?.ok) throw new Error(response?.error?.message || 'Mynda could not export diagnostics.');
      if (!response.value.canceled) this.update({filePath: response.value.filePath,
        message: response.value.largeArchive ? 'Diagnostic ZIP saved. Review it, then share it using a file link.' :
          'Diagnostic ZIP saved. Review it, then attach it to your email.', warnings: response.value.warnings || []});
    } catch (error) { this.update({error: true, message: error.message || 'Mynda could not export diagnostics.'}); }
    finally { this.exporting = false; this.update({busy: false}); }
  }
  async reveal() {
    try { await window.mynda.files.revealExport(this.state.filePath); }
    catch (_) { this.update({error: true, message: 'Mynda could not reveal the ZIP. You can open the saved location below.'}); }
  }
  render() {
    return <div className='subsection diagnostic-export-section'>
      <h2>Export Diagnostics</h2>
      <p>Save a ZIP with recent logs, app/system information and library counts to help us investigate a problem. Nothing is sent automatically.</p>
      <p>Credentials, email addresses and configured personal folder prefixes are redacted. Logs can still contain video titles, filenames and other folder names; review the ZIP before sharing it.</p>
      <label className='diagnostic-library-option'><input type='checkbox' checked={this.state.includeLibrary} disabled={this.state.busy}
        onChange={event => this.setState({includeLibrary: event.target.checked})} /> Include a diagnostic library snapshot</label>
      <p className='diagnostic-library-detail'>Adds titles, filenames, metadata and tagging evidence for every active and inactive video. Excludes media, artwork, viewing history and personal ratings. This is not a library backup.</p>
      <button onClick={this.exportDiagnostics} disabled={this.state.busy}>{this.state.busy ? 'Exporting…' : 'Export Diagnostics…'}</button>
      {this.state.message ? <div role='status' className={`library-export-message ${this.state.error ? 'error' : 'success'}`}>
        <div>{this.state.message}</div>
        {this.state.filePath ? <div className='library-export-result'><span className='library-path'>{this.state.filePath}</span>
          <button onClick={() => this.reveal()}>Show in {fileManagerName()}</button></div> : null}
      </div> : null}
      {this.state.warnings.length ? <details className='diagnostic-export-notes'><summary>Export notes ({this.state.warnings.length})</summary>
        <ul>{this.state.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
    </div>;
  }
}
module.exports = {DiagnosticExport};
