// Compatibility data retained from fix78/fix79. These entries describe
// reviewed catalog naming conventions; they never authorize episode offsets.
// New precision policy must work without adding show names to this file.
const SERIES_ALIASES = [
  {names:['MST3K', 'Mystery Science Theater 3000']},
  {names:['SATC', 'Sex and the City']},
  {names:['House MD', 'House M.D.', 'House'], imdbID:'tt0412142', year:'2004'},
  {names:['The Office US', 'The Office USA', 'The Office (US)', 'The Office (USA)'],
    titles:['The Office'], imdbID:'tt0386676', year:'2005'},
  {names:['DanMachi', 'Is It Wrong to Try to Pick Up Girls in a Dungeon?',
    'Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka']},
  {names:['Generation War', 'Unsere Mütter, unsere Väter'], imdbID:'tt1883092', year:'2013'}
];

const EPISODE_TITLE_ALIASES = [
  {series:'Seinfeld',names:['The Clip Show','The Chronicle']}
];

// Existing classic-serial release convention, kept separate from general
// matching. Missing/animated labels and the serial/episode split are evidence
// normalization only, not permission to choose a different catalog position.
const SERIAL_TITLE_RULES = [{
  seriesKeys:['drwho','doctorwho'],
  replacements:[
    [/\s*\[(?:missing|anim)\]\s*$/i, ''],
    [/^.+?\s+Pt\.?\s+\d+\s+(.+)$/i, '$1'],
    [/\s+Pt\.?\s+(\d+)$/i, ': Episode $1']
  ]
}];

// Existing bonus labels classify contrary evidence; they never authorize a match.
const BONUS_TITLE_PATTERNS = [
  /^(?:(?:pilot\s+)?log[ ._-]*lady(?:\s+intro(?:duction)?s?)?|(?:episode\s+)?intro(?:duction)?|deleted scenes?|behind the scenes|making of|surviving clips)$/i,
  /\s[-–—:]\s*surviving clips$/i
];
function equivalentSeriesTitles(title) {
  const {seriesDiscoveryKey:key} = require('./TitleNormalization');
  const alias = SERIES_ALIASES.find(item => item.names.some(name => key(name) === key(title)));
  return alias ? [...alias.names,...(alias.titles || [])] : [title];
}
module.exports = {SERIES_ALIASES,EPISODE_TITLE_ALIASES,SERIAL_TITLE_RULES,BONUS_TITLE_PATTERNS,equivalentSeriesTitles};
