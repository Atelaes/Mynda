function canceled() {
  const error = new Error('The metadata lookup was canceled.');
  error.code = 'METADATA_CANCELED';
  return error;
}

function waitForCapacity(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(canceled()); return; }
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(canceled()); };
    const timer = setTimeout(finish, milliseconds);
    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
    if (signal) signal.addEventListener('abort', abort, {once:true});
  });
}

// Treat only the explicit, validated capacity contract as a planned wait.
// Ordinary connection failures and arbitrary 429/503 responses remain errors.
function capacityWait(response) {
  const error = response && response.data && response.data.error;
  if (!error || error.code !== 'CAPACITY_WAIT') return null;
  const headers = response.headers || {};
  const header = headers['retry-after'] === undefined ? headers['Retry-After'] : headers['retry-after'];
  if (response.status !== 429 || error.retryable !== true ||
      !Number.isInteger(error.retryAfterSeconds) || error.retryAfterSeconds < 1 || error.retryAfterSeconds > 86400 ||
      !['budget','concurrency','fairness','provider'].includes(error.reason) ||
      String(header) !== String(error.retryAfterSeconds) ||
      (error.ticket !== undefined && (typeof error.ticket !== 'string' || !/^[a-f0-9-]{36}$/.test(error.ticket)))) {
    const invalid = new Error('The metadata server returned invalid capacity instructions.');
    invalid.code = 'METADATA_INVALID_RESPONSE';
    throw invalid;
  }
  return {retryAfterSeconds:error.retryAfterSeconds,reason:error.reason,ticket:error.ticket};
}

function capacityMessage(wait) {
  if (!wait) return '';
  if (wait.reason === 'budget' || wait.reason === 'provider' || wait.retryAfterSeconds >= 60) {
    const time = new Date(wait.retryAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    return `Metadata lookups paused. Retrying at ${time}`;
  }
  return 'Waiting for server capacity';
}

module.exports = {canceled,waitForCapacity,capacityWait,capacityMessage};
