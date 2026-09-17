// Shared text mechanics. Identity and discovery deliberately select different
// profiles: discovering a spelling is never permission to accept an identity.
function fold(value,ligatures = false) {
  const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  return ligatures ? text.replace(/Æ/g,'AE').replace(/æ/g,'ae').replace(/Œ/g,'OE').replace(/œ/g,'oe') : text;
}
function leadingArticle(value) { return value.replace(/^(.+),\s*(The|An|A)$/i,'$2 $1'); }
function collapseInitials(value) {
  const words = value.match(/[a-z0-9]+/gi) || [];
  return words.length > 1 && words.every(word => word.length === 1) ?
    words.filter((word,i) => i === 0 || word.toLowerCase() !== words[i-1].toLowerCase()).join('') : value;
}
function seriesKey(value,discovery = false) {
  return collapseInitials(leadingArticle(fold(value,discovery))).toLowerCase()
    .replace(/&/g,' and ').replace(/\bdr\.?\b/g,'doctor')
    .replace(discovery ? /^\s*(?:the|an|a)\s+/ : /^\s*(?:the|an|a)(?:\s+|[._-]+)/,'')
    .replace(/[^a-z0-9]+/g,'');
}
function editDistance(a,b) {
  let previous = Array.from({length:b.length+1},(_,i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j-1]+1,
      previous[j]+1,previous[j-1]+(a[i-1] === b[j-1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
const PART_NUMBERS = Object.freeze({one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10});
module.exports = {fold,leadingArticle,editDistance,PART_NUMBERS,
  seriesIdentityKey:value => seriesKey(value),seriesDiscoveryKey:value => seriesKey(value,true)};
