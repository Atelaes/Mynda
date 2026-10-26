'use strict';

// Applied only to exported copies. Local troubleshooting logs are unchanged.
const SECRET_KEY = /^(?:[\w-]*(?:authorization|(?:api|license)[ _-]?key|token|password|secret|credentials?)|cookies?|set-cookie|encrypted)$/i;
const SECRET_VALUE = /(["']?\b(?:[\w-]*(?:authorization|(?:api|license)[ _-]?key|token|password|secret|credentials?)|cookies?|set-cookie|encrypted)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]&]+)/gi;
const ESCAPED_SECRET_VALUE = /(\\"(?:[\w-]*(?:authorization|(?:api|license)[ _-]?key|token|password|secret|credentials?)|cookies?|set-cookie|encrypted)\\"\s*:\s*)\\".*?\\"/gi;

function createRedactor({paths = [], secrets = []} = {}) {
  const replacements = [];
  for (const [value, label] of paths) {
    if (typeof value !== 'string' || value.length < 2) continue;
    for (const variant of new Set([value, value.replace(/\\/g, '/'),
      JSON.stringify(value).slice(1, -1), encodeURI(value)])) {
      replacements.push([variant, label, new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')]);
    }
  }
  for (const value of secrets) {
    if (typeof value !== 'string' || !value) continue;
    for (const variant of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) {
      replacements.push([variant, '[REDACTED]']);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  function text(value) {
    let result = String(value);
    result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
      .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]')
      .replace(ESCAPED_SECRET_VALUE, '$1\\"[REDACTED]\\"')
      .replace(SECRET_VALUE, (_match, prefix, value) => prefix +
        (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'))
      .replace(/https?:\/\/[^\s<>"']+/gi, address => {
        try {
          const url = new URL(address);
          if (!url.username && !url.password && !url.search && !url.hash) return address;
          url.username = ''; url.password = '';
          const privateSuffix = Boolean(url.search || url.hash);
          url.search = ''; url.hash = '';
          return url.href + (privateSuffix ? '[QUERY_REDACTED]' : '');
        } catch (_) { return '[URL_REDACTED]'; }
      });
    for (const [value, label, expression] of replacements) result = expression ? result.replace(expression, () => label) : result.split(value).join(label);
    return result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]');
  }
  function object(value, depth = 0) {
    if (depth > 40) return '[DEPTH_LIMIT]';
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(item => object(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [text(key), SECRET_KEY.test(key) ? '[REDACTED]' : object(child, depth + 1)]));
    return value;
  }
  function log(value) {
    return value.split('\n').map(line => {
      const start = line.indexOf(' {');
      if (start >= 0) {
        try {return text(line.slice(0, start)) + ' ' + JSON.stringify(object(JSON.parse(line.slice(start + 1))));}
        catch (_) { /* Older/truncated log formats still receive text redaction. */ }
      }
      return text(line);
    }).join('\n');
  }
  return {text, object, log};
}

module.exports = {createRedactor};
