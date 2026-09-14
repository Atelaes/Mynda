// Box-office figures in Mynda are measured in U.S. dollars. A locale changes
// how that USD amount is written, never the currency or the stored value.
const BOX_OFFICE_CURRENCY = 'USD';
const DEFAULT_BOX_OFFICE_LOCALE = 'en-US';

const formatterCache = new Map();
const localeInfoCache = new Map();

function resolveLocale(options) {
  const requested = typeof options === 'string'
    ? options
    : options && options.locale;

  if (typeof requested !== 'string' || requested.trim() === '') {
    return DEFAULT_BOX_OFFICE_LOCALE;
  }

  try {
    const supported = Intl.NumberFormat.supportedLocalesOf([requested]);
    return supported.length > 0 ? supported[0] : DEFAULT_BOX_OFFICE_LOCALE;
  } catch(err) {
    return DEFAULT_BOX_OFFICE_LOCALE;
  }
}

function getFormatter(locale, compact) {
  const key = `${locale}:${compact ? 'compact' : 'full'}`;
  if (!formatterCache.has(key)) {
    const options = {
      style: 'currency',
      currency: BOX_OFFICE_CURRENCY,
      minimumFractionDigits: 0,
      maximumFractionDigits: compact ? 1 : 0
    };
    if (compact) {
      options.notation = 'compact';
      options.compactDisplay = 'short';
    }
    formatterCache.set(key, new Intl.NumberFormat(locale, options));
  }
  return formatterCache.get(key);
}

function replaceEvery(value, search, replacement) {
  if (!search) return value;
  return value.split(search).join(replacement);
}

function getLocaleInfo(locale) {
  if (localeInfoCache.has(locale)) return localeInfoCache.get(locale);

  const numberParts = new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).formatToParts(1234567.8);
  const groupPart = numberParts.find(part => part.type === 'group');
  const decimalPart = numberParts.find(part => part.type === 'decimal');
  const currencyTokens = getFormatter(locale, false)
    .formatToParts(0)
    .filter(part => part.type === 'currency')
    .map(part => part.value);

  // These are common manual spellings in addition to the locale's own token.
  currencyTokens.push('USD', 'usd', 'US$', 'us$', '$');

  const digitFormatter = new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: 0
  });
  const digits = [];
  for (let digit = 0; digit <= 9; digit++) {
    const token = digitFormatter.formatToParts(digit)
      .filter(part => part.type === 'integer')
      .map(part => part.value)
      .join('');
    if (token && token !== String(digit)) digits.push([token, String(digit)]);
  }

  const info = {
    group: groupPart ? groupPart.value : '',
    decimal: decimalPart ? decimalPart.value : '.',
    currencyTokens: Array.from(new Set(currencyTokens)).sort((a, b) => b.length - a.length),
    digits: digits.sort((a, b) => b[0].length - a[0].length)
  };
  localeInfoCache.set(locale, info);
  return info;
}

function parseBoxOffice(value, options) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  let normalized = value.trim();
  if (normalized === '') return null;

  const locale = resolveLocale(options);
  const info = getLocaleInfo(locale);

  for (const token of info.currencyTokens) {
    normalized = replaceEvery(normalized, token, '');
  }
  // Intl may include bidirectional-control marks around Arabic or Hebrew text.
  normalized = normalized.replace(/[\s\u200e\u200f\u061c]/gi, '');

  for (const pair of info.digits) {
    normalized = replaceEvery(normalized, pair[0], pair[1]);
  }
  if (info.group) normalized = replaceEvery(normalized, info.group, '');
  if (info.decimal && info.decimal !== '.') {
    normalized = replaceEvery(normalized, info.decimal, '.');
  }

  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseOmdbBoxOffice(value) {
  if (typeof value === 'string' && value.trim().toUpperCase() === 'N/A') return 0;
  const amount = parseBoxOffice(value, {locale: 'en-US'});
  return amount === null ? 0 : Math.round(amount);
}

function formatBoxOffice(value, options) {
  const locale = resolveLocale(options);
  const amount = parseBoxOffice(value, {locale: locale});
  return amount === null ? '' : getFormatter(locale, false).format(amount);
}

function formatCompactBoxOffice(value, options) {
  const locale = resolveLocale(options);
  const amount = parseBoxOffice(value, {locale: locale});
  return amount === null ? '' : getFormatter(locale, true).format(amount);
}

module.exports = {
  BOX_OFFICE_CURRENCY,
  DEFAULT_BOX_OFFICE_LOCALE,
  parseBoxOffice,
  parseOmdbBoxOffice,
  formatBoxOffice,
  formatCompactBoxOffice
};
