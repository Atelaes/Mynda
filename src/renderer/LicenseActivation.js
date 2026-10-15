const React = require('react');

const knownErrors = ['STORAGE_LOCKED','STORAGE_READ','STORAGE_WRITE','INVALID_CREDENTIAL',
  'ACCESS_REJECTED','CONNECTION_FAILED','ACCESS_MISSING'];
const errorMessage = error => knownErrors.includes(error.code) ? error.message :
  'Mynda could not update activation. Please try again.';

function activationStatus({status, action, checkFailure}) {
  if (action) return {tone:'pending', label:{load:'Loading activation…',check:'Checking activation…',
    save:'Activating…',remove:'Deactivating…'}[action], description:'Please wait.'};
  if (!status || (!status.hasCredential && status.message)) return {tone:'pending',
    label:'Activation unavailable', description:'Mynda could not read the saved activation details.'};
  if (!status.hasCredential) return {tone:'pending', label:'Not activated',
    description:'Enter your license key to activate Mynda on this computer.'};
  if (checkFailure === 'ACCESS_REJECTED') return {tone:'error', label:'Not activated',
    description:'The activation service did not accept the saved license key.'};
  if (checkFailure) return {tone:'pending', label:'Unable to verify',
    description:'Your license key is still saved. Check your connection and try again.'};
  if (status.verified) return {tone:'active', label:'Activated',
    description:'Mynda is activated on this computer.'};
  return {tone:'pending', label:'Verification needed',
    description:'Your license key is saved. Check activation to verify it.'};
}

class LicenseActivation extends React.Component {
  constructor(props) {
    super(props);
    this.state = {status:null, token:'', url:'', action:'load', error:'', checkFailure:null};
    this.alive = false;
    this.pending = false;
  }
  componentDidMount() { this.alive = true; this.refresh(); }
  componentWillUnmount() { this.alive = false; this.state.token = ''; }

  async refresh() {
    if (this.pending) return;
    this.pending = true;
    this.setState({action:'load', error:'', checkFailure:null});
    let status;
    try {
      status = await window.mynda.metadata.getStatus();
      if (!this.alive) return;
      this.setState({status, url:status.url});
      // Checking capabilities confirms the saved key without a provider lookup.
      // Merely having an encrypted file is never presented as activation.
      if (status.hasCredential) {
        this.setState({action:'check'});
        const verified = await window.mynda.metadata.check();
        if (this.alive) this.setState({status:verified, url:verified.url});
      }
    } catch (error) {
      if (this.alive) this.setState(status && status.hasCredential ? {
        status:{...status, verified:false}, checkFailure:error.code || 'CONNECTION_FAILED', error:errorMessage(error)
      } : {error:'Mynda could not load activation details. Close Settings and try again.'});
    } finally {
      this.pending = false;
      if (this.alive) this.setState({action:null});
    }
  }

  async perform(action, event) {
    if (event) event.preventDefault();
    if (this.pending) return;
    this.pending = true;
    const input = {url:this.state.url, token:this.state.token};
    const previous = this.state.status;
    this.setState({action, error:'', token:''});
    try {
      const status = await window.mynda.metadata[action](...(action === 'save' ? [input] : []));
      if (this.alive) this.setState({status, url:status.url, checkFailure:null});
    } catch (error) {
      if (this.alive) this.setState({
        ...(action === 'check' && previous ? {status:{...previous, verified:false},
          checkFailure:error.code || 'CONNECTION_FAILED'} : {}),
        error:errorMessage(error) + (action === 'save' && previous && previous.hasCredential ?
          ' Your saved license key has not been changed.' : '')
      });
    } finally {
      input.token = '';
      this.pending = false;
      if (this.alive) this.setState({action:null});
    }
  }

  renderKeyForm() {
    const {status, token, url, action} = this.state;
    const busy = Boolean(action);
    return <form onSubmit={event=>this.perform('save', event)}>
      <label htmlFor="license-key">License key</label>
      <input id="license-key" className="no-clear" type="password" autoComplete="off" spellCheck={false}
        value={token} maxLength={256} disabled={busy || !status} placeholder="Paste your license key"
        onChange={event=>this.setState({token:event.target.value})} />
      <div className="license-actions">
        <button type="submit" disabled={busy || !status || !token.trim()}>Activate Mynda</button>
      </div>
      {status && status.allowServerOverride && <details className="license-developer-options">
        <summary>Developer options</summary>
        <label htmlFor="license-server-url">Activation server</label>
        <input id="license-server-url" className="no-clear" type="url" value={url} disabled={busy} maxLength={2048}
          onChange={event=>this.setState({url:event.target.value})} />
        <p>Changing the server requires activating with a license key for that server.</p>
        <button type="button" disabled={busy} onClick={()=>this.setState({url:status.defaultURL})}>Use default server</button>
      </details>}
    </form>;
  }

  render() {
    const {status, action, error} = this.state;
    const display = activationStatus(this.state);
    const saved = status && status.hasCredential;
    const busy = Boolean(action);
    return <section className="license-activation subsection" aria-labelledby="license-activation-title">
      <h2 id="license-activation-title">License activation</h2>
      <div className="license-status" role="status" aria-live="polite" aria-atomic="true">
        <span className={'license-status-badge ' + display.tone}>{display.label}</span>
        <p>{display.description}</p>
      </div>
      {status && status.message && <p className="license-message" role="alert">{status.message}</p>}
      {error && <p className="license-message" role="alert">{error}</p>}
      {saved ? <>
        <div className="license-actions">
          <button type="button" disabled={busy} onClick={()=>this.perform('check')}>Check activation</button>
          <button type="button" disabled={busy} onClick={()=>this.perform('remove')}>Deactivate this computer</button>
        </div>
        <details className="license-key-change">
          <summary>Change license key</summary>
          {this.renderKeyForm()}
        </details>
      </> : this.renderKeyForm()}
      <details className="license-details">
        <summary>Activation details</summary>
        {status && <p><strong>Activation service:</strong> <span className="license-server-address">{status.url}</span></p>}
        <p>Your license key is encrypted in your system user profile, separately from your library and its exports.</p>
        <p>Mynda verifies your key when you open this tab. A temporary connection failure leaves your saved key in place.</p>
        <p>Deactivation removes the saved key from this computer. It does not cancel your purchase or revoke the key on other computers.</p>
      </details>
    </section>;
  }
}
module.exports = {LicenseActivation};
