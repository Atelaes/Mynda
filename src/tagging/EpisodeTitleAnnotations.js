// Presentation metadata appended to episode titles. Keep the originals and
// recognize only explicit catalog-number labels and separated calendar dates.
// Parts, editions, plain parentheticals and numbers in the title stay intact.
const MONTHS = Object.freeze(['january','february','march','april','may','june',
  'july','august','september','october','november','december']);
const DATE_SUFFIX = new RegExp(`^(.+\\S|\\S)\\s+[-–—]\\s+(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})\\s*$`, 'i');

function parse(value) {
  const original = String(value || '').trim(), annotations = [];
  let core = original;
  for (let i=0;i<2;i++) {
    const numbered = core.match(/^(.+\S|\S)\s+\((?:no\.?|number)\s+(\d{1,7})\)\s*$/i);
    if (numbered) {
      annotations.unshift({kind:'catalog-number',value:String(Number(numbered[2])),text:core.slice(numbered[1].length).trim()});
      core=numbered[1].trim();
      continue;
    }
    const dated = core.match(DATE_SUFFIX);
    if (!dated) break;
    const month=MONTHS.indexOf(dated[2].toLowerCase())+1, day=Number(dated[3]), year=Number(dated[4]);
    const days=[31,year%4===0 && (year%100!==0 || year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
    if (year<1000 || day<1 || day>days[month-1]) break;
    annotations.unshift({kind:'date',value:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
      text:core.slice(dated[1].length).trim()});
    core=dated[1].trim();
  }
  return {original,core,annotations};
}

function compare(localTitle, catalogTitle) {
  const local=parse(localTitle), catalog=parse(catalogTitle);
  const conflicts=[];
  for (const kind of ['catalog-number','date']) {
    const values = title => [...new Set(title.annotations.filter(a=>a.kind===kind).map(a=>a.value))].sort();
    const a=values(local), b=values(catalog);
    if (a.length>1 || b.length>1 || (a.length && b.length && a.join('|')!==b.join('|'))) {
      conflicts.push({kind,local:a,catalog:b});
    }
  }
  return {local,catalog,conflicts,normalized:Boolean(local.annotations.length || catalog.annotations.length)};
}

module.exports = {parse,compare};
