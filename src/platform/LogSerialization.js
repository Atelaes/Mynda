function redactSecrets(value) {
  return String(value)
    .replace(/((?:api[_-]?key|apikey|authorization|password|token|secret)\s*[=:]\s*)(?:Bearer\s+)?[^&\s,;}\]"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|apikey|token|password|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function serialize(value) {
  const seen = new WeakSet();
  try {
    let serialized = JSON.stringify(value, (key, currentValue) => {
      if (/^(?:api[_-]?key|apikey|authorization|password|token|secret)$/i.test(key)) {
        return '[REDACTED]';
      }
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          code: currentValue.code,
          stack: currentValue.stack
        };
      }
      if (typeof currentValue === 'bigint') {
        return currentValue.toString();
      }
      if (currentValue && typeof currentValue === 'object') {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }
      return currentValue;
    });
    return redactSecrets(typeof serialized === 'undefined' ? String(value) : serialized);
  } catch(err) {
    return redactSecrets(`[Could not serialize log data: ${err.message}]`);
  }
}

module.exports = {redactSecrets, serialize};
