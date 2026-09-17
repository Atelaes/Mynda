# Auto-tagging regression inventory — fix78

This inventory accompanies the actual automated tests. It identifies the
individual historical examples as well as the behaviors they protect. A
recorded successful result is not automatically a correct result: reviewed
wrong matches are explicitly expected to fail.

## Run the checks

`npm test` runs the complete fast suite: **45 suites / 2,475 named cases**.
`npm run test:core` runs **43 suites / 2,468 cases** without native media tools.
All tagging tests are offline and use the application's actual modules. They
do not modify either user's library or download artwork. No dependency install,
media rebuild, or migration is required for fix78.

```bash
node test/HistoricalTagging.integration.test.js
node test/HistoricalMovies.integration.test.js
node test/OmdbHistoricalBehaviors.integration.test.js
node test/OmdbSeries.integration.test.js
node test/SeriesSearch.unit.test.js
node test/OmdbEpisodes.integration.test.js
node test/EpisodeMatch.unit.test.js
node test/ShowDetection.unit.test.js
node test/MovieSearch.unit.test.js
```

Each R/M/C case below produces its own named PASS/FAIL line. Search for that ID
in this inventory to identify the expected outcome. The fixture entry is at the
same one-based position in its JSON array. A failure does not modify real data.

## Evidence and scope

- **R0001–R1921:** original search tags and recorded OMDb response summaries
  recovered from the historical project logs. Successful IMDb IDs were checked
  against Torgo's supplied reference library. These include **1,116 movie** and
  **805 show** searches. The JSON fixture retains the source-log name.
- **C001–C063:** individually logged title-proven episode/season corrections.
  The tests supply controlled catalog responses containing those recorded
  titles, IDs and numbers, and check that local numbering remains unchanged.
- **M001–M073:** all newly changed or corrected movie matches recovered by
  comparing the saved fix03, fix04 and fix05 libraries. Original tags and final
  identities are historical; catalog rows, votes and rounded runtimes in these
  tests are controlled inputs, not claimed historical API replies.
- **Artwork/workflow examples:** named cases from the saved logs are exercised
  with controlled download failures, batch selections and catalog responses.
- **Existing fix76 corpus:** 2,657 title comparisons remain in the unit suite:
  2,573 from Torgo's supplied library and 84 reviewed Atelaes warning pairs.
  Atelaes' 16 logged Lost/Dead Like Me corrections remain integration checks.

The 1,921-search replay restores explicitly recorded process-cache state using
a previously resolved series ID where necessary. One Wizards of Waverly Place
case supplies the recorded 2007 result under the year-constrained query that
fix76 introduced. The fixture records this adjustment. The First Blood movie
case uses the recorded retry after its wrong sequel IMDb ID was cleared;
auto-tagging is still not allowed to silently override an authoritative ID.
Personal root paths, library video IDs, artwork URLs, media bytes and credentials
are absent from these fixtures. Relative media/folder labels remain where they
are actual search inputs.

**Twenty-six old reported successes stay rejected:** 22 Loglady clips, two
Kung Fu title swaps, ER's incorrect Make of Two Hearts match, and one generic
Twin Peaks episode under an unconfirmed parent. Their R rows say REJECT, and
the fixture has a review note. They are not treated as desirable prior behavior.

The updated historical replay passes **1,984/1,984** cases. The same reviewed
fixtures against fix77 passed **1,914/1,984**. The 70 newly protected recoveries
include release-only title tags and same-name series disambiguation that needs
an already-supported adjacent-number correction. This comparison is an offline
regression measurement, not a fresh success-rate estimate for either library.

The original 1,153 Atelaes “Series not found” results require a real retry to
measure current recovery. Tests establish how Mynda handles specified catalog
responses; they cannot establish that OMDb currently returns every record.

## Behavior map

| Behavior | Individual examples | Checks |
| --- | --- | --- |
| Punctuation, articles, spelling and movie query variants | 3:10 to Yuma; A Knight's Tale; apostrophe/ampersand entries in the 73-movie table | HistoricalMovies; HistoricalTagging; MovieSearch |
| Franchise prefixes, sequels and corrected wrong movie IDs | First Blood; Spider-Man: No Way Home; Revenge of the Nerds III: The Next Generation | HistoricalMovies checks final IMDb IDs and rejects previously wrong IDs |
| Movie confidence, runtime, release-year tolerance and ambiguity | Recorded individual movie searches below, plus exact/article/canonical confidence tiers | HistoricalTagging; MovieSearch; original movie qualification code retained |
| Artwork fallback and failed-download caching | Elfen Lied, The Wire, Dexter and all 15 named series below | OmdbHistoricalBehaviors: episode poster fails, parent poster succeeds, HTTP 404 not retried |
| Successful metadata without artwork | Elfen Lied / Encounter | Both artwork URLs fail; episode tag is still returned |
| Series ID pasted into episode IMDb field | Party of Five / Pilot | Fetch requested episode and store its actual parent ID |
| Batch representative selection | Band of Brothers / Currahee; bonus first representative; incomplete selection prefix | OmdbHistoricalBehaviors; OmdbEpisodes; no preflight mutation/artwork |
| Series spelling, abbreviations, articles and years | Law and Order SVU; E.R..R; Prisoner, The (2009) | Named full-workflow integration tests |
| Series-remake disambiguation | Kung Fu; Heroes; The Prisoner; MST3K | Preserved current-title evidence and exact-title correction; no cached rejected parent |
| Title punctuation, release flags and chapter/date prefixes | ER; Heroes; Quantum Leap; compact MST3K titles | 2,657-pair corpus plus individual R/C cases |
| Reviewed episode title alternate | Seinfeld / The Clip Show ↔ The Chronicle | Series-specific acceptance, outside strict numbering correction |
| Missing direct episode lookup | Season index contains an exact ID even when series+number lookup is missing | OmdbEpisodes checks returned ID, parent, season and episode |
| Episode zero, shifted episodes, shifted seasons | The Prisoner; MST3K; ER; Heroes; Return of Sherlock Holmes; TNG; SVU; Lost; Dead Like Me | 63 individual C cases plus 16 Atelaes corrections and episode-zero test |
| Release-only title tags | WandaVision; Friends; Better Call Saul; Band of Brothers; Heroes; DanMachi | Current tag contains known series+number+release details; meaningful edited titles stay authoritative |
| Wrong episode / bonus / generic parent rejection | Sherlock Holmes; Loglady; Kung Fu; ER; Ghost in the Shell; numbered extras | Historical rejection cases; Atelaes corpus; OmdbEpisodes; ShowDetection |
| Runtime safeguard | Extreme short-clip/regular-episode mismatch; unavailable technical duration | EpisodeMatch; OmdbEpisodes: gross mismatch veto, optional cached probe, retry handling |
| User edits and explicit identity | Changed title or series label; saved exact IMDb ID; supplied parent ID | Full-workflow checks do not substitute filename text for existing tags |
| Transient failures and request reuse | Network/quota/circular errors; repeated successful or no-result series query | OmdbSeries: within-batch reuse, failures retryable, no poisoned parent cache |

## New discovery cases

Fallback discovery first preserves the established search path. It may try at
most six query variants, twelve fallback series requests, and three pages per
query. These bounds concern series discovery; episode validation has its own
existing bounded checks. It refuses to infer uniqueness from a truncated result
list, and probes at most three ambiguous fallback parents. Matching still needs
the complete identity or a reviewed alias. Queries never rewrite stored labels.

| Input series | Discovery covered |
| --- | --- |
| News Radio | NewsRadio; title spacing |
| SATC | Sex and the City; explicit alias |
| House MD | House; reviewed 2004 identity |
| The Office US / USA / (US) / (USA) | The Office; reviewed 2005 US identity, rejecting UK/adaptations |
| DanMachi | English and romanized titles; rejects Sword Oratoria as a substitute |
| Generation War | Unsere Mütter, unsere Väter; reviewed 2013 identity |
| MST3K | Mystery Science Theater 3000; same-name releases still need disambiguation |
| Family Guy - season's 1-9 | Recognized collection suffix in the series tag |
| The Sopranos - The Complete Series + Extras | Collection suffix removal for queries |
| Wonder Showzen Complete (640x480) | Collection/release annotation |
| AEON FLUX | Æon Flux; equivalent ligature |
| Seaquest DSV | Bounded distinctive-word search with complete returned-title verification |
| E.R..R | Dotted initials and repeated terminal-letter typo |

Query API: [OMDb's documented search, title and page parameters](https://www.omdbapi.com/).
Reviewed identity references include [The Office (US)](https://www.imdb.com/title/tt0386676/),
[House](https://www.imdb.com/title/tt0412142/),
[Generation War / original title](https://www.imdb.com/title/tt1883092/releaseinfo/),
and [DanMachi's distributor catalog](https://www.sentaifilmworks.com/blogs/catalog/is-it-wrong-to-try-to-pick-up-girls-in-a-dungeon).

## Individual fix03–fix05 movie improvements

The expected ID is the final saved reference, not merely the first row returned
by a query. “Earlier wrong ID” is present where fix05 corrected a prior tag.

| Case | Expected movie | Year | Expected IMDb ID | Earlier wrong ID |
| --- | --- | --- | --- | --- |
| M001 | 3:10 to Yuma | 2007 | tt0381849 |  |
| M002 | A Knight's Tale | 2001 | tt0183790 |  |
| M003 | All the President's Men | 1976 | tt0074119 |  |
| M004 | Winter Light | 1963 | tt0057358 |  |
| M005 | Black Hawk Down | 2002 | tt0265086 |  |
| M006 | Breakfast at Tiffany's | 1961 | tt0054698 |  |
| M007 | Catch Me If You Can | 2002 | tt0264464 |  |
| M008 | Con Air | 1997 | tt0118880 |  |
| M009 | 2 Fast 2 Furious | 2003 | tt0322259 |  |
| M010 | Fast & Furious | 2009 | tt1013752 |  |
| M011 | Fast Five | 2011 | tt1596343 |  |
| M012 | The Fate of the Furious | 2017 | tt4630562 |  |
| M013 | La Dolce Vita | 1960 | tt0053779 |  |
| M014 | First Man | 2018 | tt1213641 |  |
| M015 | Ghost in the Shell 2.0 | 2008 | tt1260502 |  |
| M016 | Guardians of the Galaxy | 2014 | tt2015381 |  |
| M017 | Harry Potter and the Sorcerer's Stone | 2001 | tt0241527 |  |
| M018 | It's a Wonderful Life | 1946 | tt0038650 |  |
| M019 | Ivan's Childhood | 1962 | tt0056111 |  |
| M020 | Jack Reacher | 2012 | tt0790724 |  |
| M021 | Jennifer's Body | 2009 | tt1131734 |  |
| M022 | John Wick | 2014 | tt2911666 |  |
| M023 | K-19: The Widowmaker | 2002 | tt0267626 |  |
| M024 | K-19: The Widowmaker | 2002 | tt0267626 |  |
| M025 | L'Age d'Or | 1930 | tt0021577 |  |
| M026 | Legally Blonde | 2001 | tt0250494 |  |
| M027 | Les Misérables | 2012 | tt1707386 |  |
| M028 | Logan's Run | 1976 | tt0074812 |  |
| M029 | Miller's Crossing | 1990 | tt0100150 |  |
| M030 | Ocean's Eleven | 2001 | tt0240772 |  |
| M031 | Ocean's Thirteen | 2007 | tt0496806 |  |
| M032 | Ocean's Twelve | 2004 | tt0349903 |  |
| M033 | Ocean's Twelve | 2004 | tt0349903 |  |
| M034 | Olympus Has Fallen | 2013 | tt2302755 |  |
| M035 | Pirates of the Caribbean: At World's End | 2007 | tt0449088 |  |
| M036 | Reservoir Dogs | 1992 | tt0105236 |  |
| M037 | Rosemary's Baby | 1968 | tt0063522 |  |
| M038 | Rush Hour | 1998 | tt0120812 |  |
| M039 | Saving Private Ryan | 1998 | tt0120815 |  |
| M040 | She's All That | 1999 | tt0160862 |  |
| M041 | Spider-Man: No Way Home | 2021 | tt10872600 | tt0117194 |
| M042 | The Dark Knight | 2008 | tt0468569 |  |
| M043 | The Hitchhiker's Guide to the Galaxy | 2005 | tt0371724 |  |
| M044 | The Emperor's New Groove | 2000 | tt0120917 |  |
| M045 | The King's Speech | 2010 | tt1504320 |  |
| M046 | The Man from U.N.C.L.E. | 2015 | tt1638355 |  |
| M047 | The Serpent's Egg | 1977 | tt0076686 |  |
| M048 | The Time Traveler's Wife | 2009 | tt0452694 |  |
| M049 | Three Kings | 1999 | tt0120188 |  |
| M050 | Training Day | 2001 | tt0139654 |  |
| M051 | Troll Hunter | 2010 | tt1740707 |  |
| M052 | Troll Hunter | 2010 | tt1740707 |  |
| M053 | U.S. Marshals | 1998 | tt0120873 |  |
| M054 | You've Got Mail | 1998 | tt0128853 |  |
| M055 | Ocean's Eleven | 1960 | tt0054135 |  |
| M056 | Batman Begins | 2005 | tt0372784 |  |
| M057 | Black Panther | 2018 | tt1825683 |  |
| M058 | Dog Day Afternoon | 1975 | tt0072890 |  |
| M059 | Furious 7 | 2015 | tt2820852 |  |
| M060 | In the Line of Fire | 1993 | tt0107206 |  |
| M061 | Independence Day | 1996 | tt0116629 |  |
| M062 | Iron Man 2 | 2010 | tt1228705 |  |
| M063 | Notting Hill | 1999 | tt0125439 |  |
| M064 | Predator | 1987 | tt0093773 |  |
| M065 | First Blood | 1982 | tt0083944 |  |
| M066 | Revenge of the Nerds III: The Next Generation | 1992 | tt0105251 |  |
| M067 | Revenge of the Nerds | 1984 | tt0088000 |  |
| M068 | The Silence of the Lambs | 1991 | tt0102926 |  |
| M069 | Spider-Man: Homecoming | 2017 | tt2250912 |  |
| M070 | The Emperor's New Groove | 2000 | tt0120917 |  |
| M071 | The Hunger Games | 2012 | tt1392170 |  |
| M072 | The Mighty Ducks | 1992 | tt0104868 |  |
| M073 | Weird Science | 1985 | tt0090305 |  |

## Individual logged numbering corrections

“Catalog lookup” is the OMDb location used to get the intended episode's ID.
The video's local season and episode remain the numbers in “Local numbering”.
Repeated titles with different local numbers are separate regression cases.

| Series | Cases |
| --- | --- |
| E.R. | 23 |
| Heroes | 3 |
| Law and Order SVU | 5 |
| Mystery Science Theater 3000 | 3 |
| Star Trek - 02 - The Next Generation | 1 |
| The Prisoner | 17 |
| The Return of Sherlock Holmes | 11 |

| Case | Series | Local title | Local numbering | Catalog lookup | Expected IMDb ID |
| --- | --- | --- | --- | --- | --- |
| C001 | The Return of Sherlock Holmes | The Devil's Foot | S2E2 | S2E1 | tt0685621 |
| C002 | The Return of Sherlock Holmes | Silver Blaze | S2E3 | S2E2 | tt0685618 |
| C003 | The Return of Sherlock Holmes | Wisteria Lodge | S2E4 | S2E3 | tt0685630 |
| C004 | The Return of Sherlock Holmes | The Bruce Partington Plans | S2E5 | S2E4 | tt0685620 |
| C005 | The Return of Sherlock Holmes | The Hound of the Baskervilles | S2E6 | S2E5 | tt27646178 |
| C006 | The Return of Sherlock Holmes | The Devils Foot | S2E2 | S2E1 | tt0685621 |
| C007 | The Return of Sherlock Holmes | The Hound Of The Baskervilles | S2E6 | S2E5 | tt27646178 |
| C008 | The Return of Sherlock Holmes | The Musgrave Ritual | S1E3 | S1E4 | tt0685625 |
| C009 | The Return of Sherlock Holmes | The Second Stain | S1E4 | S1E3 | tt0210968 |
| C010 | The Return of Sherlock Holmes | The Man with the Twisted Lip | S1E5 | S1E6 | tt0685624 |
| C011 | The Return of Sherlock Holmes | The Man With The Twisted Lip | S1E5 | S1E6 | tt0685624 |
| C012 | The Prisoner | Arrival | S1E0 | S1E1 | tt0679174 |
| C013 | Mystery Science Theater 3000 | Invaders from the Deep (1981) | S0E1 | S1E1 | tt0756959 |
| C014 | Mystery Science Theater 3000 | The Brute Man | S9E2 | S8E2 | tt0655457 |
| C015 | Mystery Science Theater 3000 | Deathstalker and the Warriors from Hell | S9E3 | S8E3 | tt0762886 |
| C016 | Star Trek - 02 - The Next Generation | Where No One Has Gone Before | S1E6 | S1E5 | tt0708842 |
| C017 | The Prisoner | The General | S1E5 | S1E6 | tt0679186 |
| C018 | The Prisoner | The Chimes Of Big Ben | S1E1 | S1E2 | tt0679185 |
| C019 | The Prisoner | A B And C | S1E2 | S1E3 | tt0679173 |
| C020 | The Prisoner | Free For All | S1E3 | S1E4 | tt0679179 |
| C021 | The Prisoner | The Schizoid Man | S1E4 | S1E5 | tt0679188 |
| C022 | The Prisoner | Many Happy Returns | S1E6 | S1E7 | tt0679183 |
| C023 | The Prisoner | Dance Of The Dead | S1E7 | S1E8 | tt0679176 |
| C024 | The Prisoner | Checkmate | S1E8 | S1E9 | tt0679175 |
| C025 | The Prisoner | Hammer Into Anvil | S1E9 | S1E10 | tt0679180 |
| C026 | The Prisoner | It's Your Funeral | S1E10 | S1E11 | tt0679181 |
| C027 | The Prisoner | A Change Of Mind | S1E11 | S1E12 | tt0679172 |
| C028 | The Prisoner | Do Not Forsake Me Oh My Darling | S1E12 | S1E13 | tt0679177 |
| C029 | The Prisoner | Living In Harmony | S1E13 | S1E14 | tt0679182 |
| C030 | The Prisoner | The Girl Who Was Death | S1E14 | S1E15 | tt0679187 |
| C031 | The Prisoner | Once Upon A Time | S1E15 | S1E16 | tt0679184 |
| C032 | The Prisoner | Fall Out | S1E16 | S1E17 | tt0679178 |
| C033 | E.R. | Day One fs | S1E3 | S1E2 | tt0567951 |
| C034 | E.R. | Going Home FS AC3 | S1E4 | S1E3 | tt0567992 |
| C035 | E.R. | 9 1 2 Hours FS SFM-DVD | S1E9 | S1E8 | tt0567906 |
| C036 | E.R. | ER Confidential WS | S1E10 | S1E9 | tt0567965 |
| C037 | E.R. | Hit and Run FS | S1E5 | S1E4 | tt0568004 |
| C038 | E.R. | Into That Good Night FS AC3 | S1E6 | S1E5 | tt0568018 |
| C039 | E.R. | Chicago Heat ws | S1E7 | S1E6 | tt0567947 |
| C040 | E.R. | Another Perfect Day FS DVD-SFM | S1E8 | S1E7 | tt0567926 |
| C041 | E.R. | Blizzard WS | S1E11 | S1E10 | tt0567936 |
| C042 | E.R. | The Gift FS | S1E12 | S1E11 | tt0568115 |
| C043 | E.R. | Happy New Year FS AC3 | S1E13 | S1E12 | tt0567999 |
| C044 | E.R. | Luck of the Draw FS AC3 | S1E14 | S1E13 | tt0568034 |
| C045 | E.R. | Long Days Journey FS AC3 | S1E15 | S1E14 | tt0568030 |
| C046 | E.R. | Feb 5 95 ws dvd | S1E16 | S1E15 | tt0567975 |
| C047 | E.R. | The Birthday Party WS | S1E18 | S1E17 | tt0568110 |
| C048 | E.R. | Sleepless in Chicago FS AC3 | S1E19 | S1E18 | tt0568094 |
| C049 | E.R. | Loves Labor Lost ws | S1E20 | S1E19 | tt0568033 |
| C050 | E.R. | Full Moon Saturday Night FS AC3 | S1E21 | S1E20 | tt0567988 |
| C051 | E.R. | House of Cards WS | S1E22 | S1E21 | tt0568008 |
| C052 | E.R. | Men Plan God Laughs FS AC3 | S1E23 | S1E22 | tt0568043 |
| C053 | E.R. | Love Among the Ruins FS AC3 | S1E24 | S1E23 | tt0568032 |
| C054 | E.R. | Motherhood FS AC3 | S1E25 | S1E24 | tt0568048 |
| C055 | E.R. | Everything Old Is New Again FS AC3 | S1E26 | S1E25 | tt0567966 |
| C056 | Heroes | Brothers Keeper | S4E10 | S4E9 | tt1510002 |
| C057 | Heroes | Thanksgiving | S4E11 | S4E10 | tt1510003 |
| C058 | Heroes | Upon This Rock | S4E13 | S4E12 | tt1510005 |
| C059 | Law and Order SVU | Closure | S1E9 | S1E10 | tt0629626 |
| C060 | Law and Order SVU | Bad Blood | S1E10 | S1E11 | tt0629614 |
| C061 | Law and Order SVU | Closure | S1E9 | S1E10 | tt0629626 |
| C062 | Law and Order SVU | Bad Blood | S1E10 | S1E11 | tt0629614 |
| C063 | Law and Order SVU | Stocks And Bondage | S1E11 | S1E9 | tt0629739 |

## Individual artwork fallback cases

| Series | Episode | Parent ID | Episode ID |
| --- | --- | --- | --- |
| Elfen Lied | Encounter | tt0480489 | tt0909536 |
| The Wire | Sentencing | tt0306414 | tt0749441 |
| Dexter | Popping Cherry | tt0773262 | tt0828745 |
| Adventure Time | It Came from the Nightosphere | tt1305826 | tt1748406 |
| The West Wing | Evidence of Things Not Seen | tt0200276 | tt0745618 |
| The White Lotus | Departures | tt13406094 | tt13868058 |
| The Prisoner | A. B. and C. | tt0061287 | tt0679173 |
| Twin Peaks | Laura's Secret Diary | tt0098936 | tt0734823 |
| Vikings | Trial | tt2306299 | tt2245920 |
| 11.22.63 | Other Voices, Other Rooms | tt2879552 | tt4587208 |
| Kung Fu | King of the Mountain | tt0068093 | tt0623166 |
| ER | The Birthday Party | tt0108757 | tt0568110 |
| Heroes | Chapter Nineteen '.07%' | tt0813715 | tt0969430 |
| Law & Order: Special Victims Unit | Lime Chaser | tt0203259 | tt27135026 |
| Party of Five | Homework | tt0108894 | tt0670310 |

## Recorded search inventory

Every row below is replayed through `OmdbHelper.search()`. The fixture includes
the original current tags and recorded responses. A successful show case also
checks preservation of the user's series label and local numbering. REJECT
means a later safeguard must continue to block an old bad or unconfirmed match.
The table groups cases for browsing; R identifiers retain fixture order.

### Movies (1116)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0009 | The.Quick.And.The.Dead.1995.1080p.BluRay.x265: The Quick and the Dead |  | tt0114214 |
| R0010 | 10.Cloverfield.Lane.2016.720p.BluRay.x264-[YTS.AG]: 10 Cloverfield Lane |  | tt1179933 |
| R0011 | 10.Things.I.Hate.About.You.1999.1080p.BluRay.x264.VPPV: 10 Things I Hate About You |  | tt0147800 |
| R0012 | 10000.BC.2008.1080p.Bluray.AC3.x264-ETRG: 10,000 BC |  | tt0443649 |
| R0013 | 12.Angry.Men.1957.720p.BRrip.x264.YIFY: 12 Angry Men |  | tt0050083 |
| R0014 | 12.Monkeys.1995.1080p.BluRay.x264.anoXmous_: 12 Monkeys |  | tt0114746 |
| R0015 | M (1931): M |  | tt0022100 |
| R0016 | 2.Fast.2.Furious.2003.2160p.UHD.BluRay.x265-TERMiNAL: 2 Fast 2 Furious |  | tt0322259 |
| R0017 | 2001.A.Space.Odyssey.1968.1080p.BluRay.x264-[YTS.AM]: 2001: A Space Odyssey |  | tt0062622 |
| R0018 | 2001.A.Space.Odyssey.1968.2160p.10bit.HDR.BluRay.6CH.x265.HEVC-PSA: 2001: A Space Odyssey |  | tt0062622 |
| R0019 | 2012.2009.BluRay.720p.x264.YIFY: 2012 |  | tt1190080 |
| R0020 | 2012.2009.2160p.HDR.WEBRip.DTS-HD.MA.5.1.EN.FR.x265-GASMASK: 2012 |  | tt1190080 |
| R0021 | 2046.2004.1080p.Bluray.10bit.x265.AAC.5.1-HazMatt: 2046 |  | tt0212712 |
| R0022 | 28 Days Later (2002) 1080p BrRip 5.1 x264 aac [TuGAZx]: 28 Days Later |  | tt0289043 |
| R0023 | 300.2006.BluRay.1080p.x264.YIFY: 300 |  | tt0416449 |
| R0024 | 48 Hrs 1982 Remastered 720p BluRay HEVC H265 BONE: 48 Hrs. |  | tt0083511 |
| R0025 | Another 48 Hrs 1990 Remastered 720p BluRay HEVC H265 BONE: Another 48 Hrs. |  | tt0099044 |
| R0026 | 48.Hrs.1982.x264.AC3.9.subs: 48 Hrs. |  | tt0083511 |
| R0027 | 50.First.Dates.2004.1080p.BrRip.x264.YIFY: 50 First Dates |  | tt0343660 |
| R0028 | 8Mile(2002) BrRip 600MB.YIFY: 8 Mile |  | tt0298203 |
| R0029 | A.Beautiful.Day.In.The.Neighborhood.2019.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: A Beautiful Day in the Neighborhood |  | tt3224458 |
| R0030 | A.Bugs.Life.1998.1080p.BluRay.x264.YIFY: A Bug's Life |  | tt0120623 |
| R0031 | A.Clockwork.Orange.1971.1080p.BrRip.x264.YIFY: A Clockwork Orange |  | tt0066921 |
| R0032 | A.Few.Good.Me.1992.BrRip.720p.x264.YIFY: A Few Good Men |  | tt0104257 |
| R0033 | A Fish Called Wanda: A Fish Called Wanda |  | tt0095159 |
| R0034 | A.League.of.Their.Own.1992.720p.BluRay.x264.YIFY: A League of Their Own |  | tt0104694 |
| R0035 | A New Leaf  (1971)  Walter Matthau, Elaine May & Jack Weston  (BR): A New Leaf |  | tt0067482 |
| R0036 | A.Nightmare.On.Elm.Street.1984.720p.BrRip.x264.bitloks.YIFY: A Nightmare on Elm Street |  | tt0087800 |
| R0037 | A.Quiet.Place.Part.II.2020.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: A Quiet Place Part II |  | tt8332922 |
| R0038 | A Royal Christmas.2014.720p.HDTV.x264_TTL: A Royal Christmas |  | tt2838678 |
| R0039 | A Streetcar Named Desire - Marlon Brando 1951 Eng Subs 720p [H264-mp4]: A Streetcar Named Desire |  | tt0044081 |
| R0040 | A.Christmas.Carol.1951.1080p.BluRay.H264.AAC-RARBG: A Christmas Carol |  | tt0044008 |
| R0041 | A.Christmas.Carol.1984.1080p.BluRay.H264.AAC-RARBG: A Christmas Carol |  | tt0087056 |
| R0042 | A.Christmas.Story.1983.1080p.BluRay.H264.AAC-RARBG: A Christmas Story |  | tt0085334 |
| R0043 | A.Few.Good.Men.1992.1080p.BluRay.AC3.x264-ETRG: A Few Good Men |  | tt0104257 |
| R0044 | A.Quiet.Place.2018.1080p.10bit.BluRay.8CH.x265.HEVC-PSA: A Quiet Place |  | tt6644200 |
| R0045 | A.Royal.Affair.2012.1080p.BluRay.x264.anoXmous: A Royal Affair |  | tt1276419 |
| R0046 | A.Serious.Man.2009.LIMITED.1080p.BluRay.x264.anoXmous_: A Serious Man |  | tt1019452 |
| R0047 | About.Time.2013.1080p.BluRay.x264.YIFY: About Time |  | tt2194499 |
| R0048 | Absolutely Anything 2015 1080p BluRay x264 DTS-JYK: Absolutely Anything |  | tt1727770 |
| R0049 | Across.the.Universe.2007.1080p.BrRip.x264.YIFY: Across the Universe |  | tt0445922 |
| R0050 | besthd-agora-720p: Agora |  | tt1186830 |
| R0051 | Air.Force.One.1997.720p.BRrip.x264.YIFY: Air Force One |  | tt0118571 |
| R0052 | Air.Force.One.1997.Multi.UHD.2160p.Bluray.x265.HDR.DTS..5.1-DTOne: Air Force One |  | tt0118571 |
| R0053 | Air.Force.One.Down.2024.2160p.AMZN.WEB-DL.DDP5.1.H.265-FLUX: Air Force One Down |  | tt27708700 |
| R0054 | www.HDSector.com -  Airport.1970.BluRay.1080p.x264.AAC.5.1.-.Hon3y: Airport |  | tt0065377 |
| R0055 | akira.1988.2160p.uhd.bluray.x265-jrp: Akira |  | tt0094625 |
| R0056 | Akira.1988.25th.Anniversary.Edition.1080p.BluRay.x264.anoXmous_: Akira |  | tt0094625 |
| R0057 | Aladdin 1992.MULTi.UHD.Blu-Ray.2160p.Atmos.7.1.HEVC-DDR[EtHD]: Aladdin |  | tt0103639 |
| R0058 | Aladdin.2019.UHD.HDR.BluRay.2160p.TrueHD.Atmos.7.1.HEVC-DDR[EtHD]: Aladdin |  | tt6139732 |
| R0059 | Alexander.[Revisited.The.Final.Cut](2004).BrRip.720p.x264.YIFY: Alexander |  | tt0346491 |
| R0060 | Alice in Wonderland 1966 DVDRip x264: Alice in Wonderland |  | tt0060089 |
| R0061 | Alien.Directors.Cut.1979.1080p.BRrip.x264.GAZ.YIFY: Alien |  | tt0078748 |
| R0062 | Aliens.Directors.Cut.1986.1080p.BRrip.x264.GAZ.YIFY: Aliens |  | tt0090605 |
| R0063 | Alpha.2018.1080p.WEBRip.x264-[YTS.AM]: Alpha |  | tt4244998 |
| R0064 | Alphaville.1965.(Jean-Luc Godard).720p.BRRip.x264-Classics: Alphaville |  | tt0058898 |
| R0065 | Amadeus 1984 Director Cut 1080p BluRay x264 AAC - Ozlem: Amadeus |  | tt0086879 |
| R0066 | American.Beauty.1999.1080p.BrRip.x264.BOKUTOX.YIFY: American Beauty |  | tt0169547 |
| R0067 | American.Made.2017.720p.BluRay.x264-[YTS.AG]: American Made |  | tt3532216 |
| R0068 | American.Psycho.2000.1080p.BrRip.x264.YIFY: American Psycho |  | tt0144084 |
| R0069 | American.Sniper.2014.1080p.BluRay.x264.YIFY: American Sniper |  | tt2179136 |
| R0070 | American.History.X.1998.1080p.BluRay.x264.anoXmous_: American History X |  | tt0120586 |
| R0071 | Amistad.1997.1080p.BluRay.x264.YIFY: Amistad |  | tt0118607 |
| R0072 | amistad.1997.2160p.web.h265-naisu: Amistad |  | tt0118607 |
| R0073 | An Affair to Remember (1957) 720p BRrip.x264 SUJAIDR: An Affair to Remember |  | tt0050105 |
| R0074 | An American Tail 1986 1080p BluRay x264 AAC - Ozlem: An American Tail |  | tt0090633 |
| R0075 | An American Tail Fievel Goes West: An American Tail: Fievel Goes West |  | tt0101329 |
| R0076 | Anchorman.The.Legend.Of.Ron.Burgundy.2004.1080p.BrRip.x264.BOKUTOX.YIFY: Anchorman: The Legend of Ron Burgundy |  | tt0357413 |
| R0077 | Annie.Hall.1977.1080p.BluRay.x264.YIFY: Annie Hall |  | tt0075686 |
| R0078 | Annihilation.2018.1080p.NF.WEB-DL.DD5.1.x264-NTG[N1C]: Annihilation |  | tt2798920 |
| R0079 | Anomalisa.2016.1080p.BRRip.x264.AAC-ETRG: Anomalisa |  | tt2401878 |
| R0080 | Ant.Man.2015.720p.HDRip.x264.AAC-ETRG: Ant-Man |  | tt0478970 |
| R0081 | Ant-Man 2015 1080p BluRay x264 DTS-JYK: Ant-Man |  | tt0478970 |
| R0082 | Ant-Man.And.The.Wasp.2018.1080p.BluRay.x264-[YTS.AM]: Ant-Man and the Wasp |  | tt5095030 |
| R0083 | Apocalypse.Now.1979.1080p.BluRay.x264-[YTS.AM]: Apocalypse Now |  | tt0078788 |
| R0084 | Apollo.13.1995.1080p.BluRay.x264.YIFY: Apollo 13 |  | tt0112384 |
| R0085 | Apollo.13.1995.2160p.UHD.BluRay.x265-DEPTH: Apollo 13 |  | tt0112384 |
| R0086 | Appleseed.2004.1080p.BluRay.AAC.x264-tomcat12[ETRG]: Appleseed |  | tt0401233 |
| R0087 | Appleseed.Alpha.2014.1080p.BluRay.AAC.x264-tomcat12[ETRG]: Appleseed Alpha |  | tt3638012 |
| R0088 | Appleseed.Ex.Machina.2007.1080p.BluRay.AAC.x264-tomcat12[ETRG]: Appleseed: Ex Machina |  | tt1043842 |
| R0089 | Aquaman.2018.1080p.WEBRip.x264-[YTS.AM]: Aquaman |  | tt1477834 |
| R0090 | Aquaman.2018.2160p.MAX.WEB-DL.DDPA.5.1.DV.HDR.H.265-PiRaTeS: Aquaman |  | tt1477834 |
| R0091 | Aquaman.and.the.Lost.Kingdom.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX: Aquaman and the Lost Kingdom |  | tt9663764 |
| R0092 | Argo.Extended.Cut.2012.1080p.BRrip.x264.GAZ: Argo |  | tt1024648 |
| R0093 | Armageddon_1998: Armageddon |  | tt0120591 |
| R0094 | Armageddon.1998.1080p.BrRip.x264.YIFY: Armageddon |  | tt0120591 |
| R0095 | Arrival 2016 1080p BluRay x264 DTS-JYK: Arrival |  | tt2543164 |
| R0096 | Cary Grant - 1944 - Arsenic And Old Lace: Arsenic and Old Lace |  | tt0036613 |
| R0097 | Asteroid.City.2023.1080p.WEB-DL.DDP5.1.Atmos.H.264-XEBEC: Asteroid City |  | tt14230388 |
| R0098 | Asteroid.City.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.HEVC-XEBEC: Asteroid City |  | tt14230388 |
| R0099 | Atlantis.The.Lost.Empire.2001.720p.BRrip.x264.GAZ.YIFY: Atlantis: The Lost Empire |  | tt0230011 |
| R0100 | Autumn Sonata [1978] 720p BRRip H264 AC3 - CODY: Autumn Sonata |  | tt0077711 |
| R0101 | Avatar.2009.EXTENDED.1080p.BluRay.x264.DTS-ETRG: Avatar |  | tt0499549 |
| R0102 | Avatar.ECE.2009.720p.BrRip.x264.bitloks.YIFY: Avatar |  | tt0499549 |
| R0103 | Avatar.The.Way.of.Water.2022.2160p.UHD.Bluray.REMUX.HDR10.HEVC.TrueHD.Atmos.7.1-GHD: Avatar: The Way of Water |  | tt1630029 |
| R0104 | Avengers Age of Ultron: Avengers: Age of Ultron |  | tt2395427 |
| R0105 | Avengers.Age.of.Ultron.2015.1080p.BluRay.x264.YIFY: Avengers: Age of Ultron |  | tt2395427 |
| R0106 | Avengers.Endgame.2019.1080p.BluRay.x264-[YTS.LT]: Avengers: Endgame |  | tt4154796 |
| R0107 | Avengers.Infinity.War.2018.1080p.WEBRip.x264-[YTS.AM]: Avengers: Infinity War |  | tt4154756 |
| R0108 | Avengers.Infinity.War.2018.1080p.WEBRip.x265.HEVC.6CH-MRN: Avengers: Infinity War |  | tt4154756 |
| R0109 | Baby Driver 2017 1080p WEB-DL DD5.1 X264-CPG: Baby Driver |  | tt3890160 |
| R0110 | Back.to.the.Future.1985.1080p.Brrip.x264.Deceit.YIFY: Back to the Future |  | tt0088763 |
| R0111 | Bad.Lieutenant.1992.1080p.BluRay.x264.YIFY: Bad Lieutenant |  | tt0103759 |
| R0112 | Bambi.1942.720p.BRrip.x264.GAZ.YIFY: Bambi |  | tt0034492 |
| R0113 | Barbie 2023 AMZN 4K WEBRip 2160p DD+5.1 Atmos DoVi HDR H.265-MgB: Barbie |  | tt1517268 |
| R0114 | Barry Lyndon (1975) 1080p BluRay 5.1Ch x265 HEVC SUJAIDR: Barry Lyndon |  | tt0072684 |
| R0115 | Batman.Forever.1995.1080p.BluRay.x264.YIFY: Batman Forever |  | tt0112462 |
| R0116 | Batteries.Not.Included.1987.HDRip.H264-BONE: *batteries not included |  | tt0092494 |
| R0117 | battle.los.angeles.2011.720p.bluray.x264.YIFY: Battle Los Angeles |  | tt1217613 |
| R0118 | Battle of Los Angeles[2011]DVDRip-MXMG: Battle of Los Angeles |  | tt1758570 |
| R0119 | Battleship.2012.BluRay.1080p.x264.YIFY: Battleship |  | tt1440129 |
| R0120 | Baywatch.2017.720p.BluRay.x264.VPPV: Baywatch |  | tt1469304 |
| R0121 | Beauty.And.The.Beast.1991.1080p.BluRay.x264.anoXmous_: Beauty and the Beast |  | tt0101414 |
| R0122 | Bedtime for Bonzo ~TCM-TV~  (1951): Bedtime for Bonzo |  | tt0043325 |
| R0123 | Beetlejuice.1988.1080p.BluRay.x264.anoXmous_: Beetlejuice |  | tt0094721 |
| R0124 | Being.There.1979.1080p.BluRay.x264.YIFY: Being There |  | tt0078841 |
| R0125 | Being.John.Malkovich.1999.1080p.BluRay.H264.AAC-RARBG: Being John Malkovich |  | tt0120601 |
| R0126 | Ben-Hur.1959.1080p.bLURaY.x264.anoXmous_: Ben-Hur |  | tt0052618 |
| R0127 | Best.In.Show.2000.1080p.BRRip.AAC.5.1.x265.HEVC-etsyt: Best in Show |  | tt0218839 |
| R0128 | Beverly.Hills.Cop.1984.720p.BrRip.x264.YIFY: Beverly Hills Cop |  | tt0086960 |
| R0129 | Beverly.Hills.Cop.1984.REMASTERED.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265: Beverly Hills Cop |  | tt0086960 |
| R0130 | Bicentennial.Man.1999.720p.WEBDL.{Obit11}.【ThumperDC】: Bicentennial Man |  | tt0182789 |
| R0131 | Big.1988.Extended.Edition.720p.BluRay.x264.YIFY: Big |  | tt0094737 |
| R0132 | bigtroublelittlechina: Big Trouble in Little China |  | tt0090728 |
| R0133 | Big.Fish.2003.1080p.BluRay.x264.anoXmous_: Big Fish |  | tt0319061 |
| R0134 | Bill & Ted's Bogus Journey (1080p HD: Bill & Ted's Bogus Journey |  | tt0101452 |
| R0135 | Bill.And.Ted's.Excellent.Adventure.1989.720p.BluRay.x264.VPPV: Bill & Ted's Excellent Adventure |  | tt0096928 |
| R0136 | Biutiful (2010) BDrip x264 SPA-ITA sub ENG -Shiv@: Biutiful |  | tt1164999 |
| R0137 | Black.Christmas.1974.1080p.BluRay.x264-[YTS.LT]: Black Christmas |  | tt0071222 |
| R0138 | Black.Dynamite.2009.1080p.BluRay.x264.VPPV: Black Dynamite |  | tt1190536 |
| R0139 | Black.Panther.2018.1080p.BluRay.x264-[YTS.AM]: Black Panther |  | tt1825683 |
| R0140 | Black.Panther.Wakanda.Forever.2022.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Black Panther: Wakanda Forever |  | tt9114286 |
| R0141 | Black.Widow.2021.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Black Widow |  | tt3480822 |
| R0142 | Black.Hawk.Down.2001.REMASTERED.EXTENDED.720p.BluRay.999MB.HQ.x265.10bit-GalaxyRG: Black Hawk Down |  | tt0265086 |
| R0143 | Black.Swan.2010.1080p.BluRay.x264.anoXmous_: Black Swan |  | tt0947798 |
| R0144 | Blade Runner (1982) Final Cut 1080p BluRay.x264 SUJAIDR: Blade Runner |  | tt0083658 |
| R0145 | Blade Runner 2049 2017: Blade Runner 2049 |  | tt1856101 |
| R0146 | Blade.Runner.1982.The.Final.Cut.PROPER.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT: Blade Runner |  | tt0083658 |
| R0147 | Blade.Runner.2049.2017.2160p.MAX.WEB-DL.DDPA.5.1.DV.HDR.H.265-PiRaTeS: Blade Runner 2049 |  | tt1856101 |
| R0148 | Blast.from.the.Past.1999.720p.BluRay.x264.YIFY: Blast from the Past |  | tt0124298 |
| R0149 | Blazing.Saddles.1974.1080p.BluRay.x264.YIFY: Blazing Saddles |  | tt0071230 |
| R0150 | Blood.And.Bone.2009.1080p.BRrip.x264.YIFY: Blood and Bone |  | tt0346631 |
| R0151 | Blow.2001.1080p.BrRip.x264.BOKUTOX.YIFY: Blow |  | tt0221027 |
| R0152 | Blow-Up.1966.(Michelangelo.Antonioni).1080p.BRRip.x264-Classics: Blow-Up |  | tt0060176 |
| R0153 | The Dreamers.2003.720p.BrRip.x264.YIFY: The Dreamers |  | tt0309987 |
| R0154 | Blue.Crush.2002.DVDRip.x264-mMx: Blue Crush |  | tt0300532 |
| R0155 | Blue.Velvet.1986.1080p.BluRay.x264.anoXmous_: Blue Velvet |  | tt0090756 |
| R0156 | ewdp-bodysong.xvid: Bodysong |  | tt0349154 |
| R0157 | Boogie.Nights.1997.720p.BluRay.x264.YIFY: Boogie Nights |  | tt0118749 |
| R0158 | Boondock.Saints.Director's.Cut.1999.1080p.BrRip.x264.YIFY: The Boondock Saints |  | tt0144117 |
| R0159 | Borat.2006.720p.BrRip.x264.YIFY: Borat |  | tt0443453 |
| R0160 | Bottle Rocket (1996) 720p.BRrip.Sujaidr (pimprg): Bottle Rocket |  | tt0115734 |
| R0161 | Boyz.n.The.Hood.1991.720p.BRrip.x264.YIFY: Boyz n the Hood |  | tt0101507 |
| R0162 | Braveheart.1995.1080p.BrRip.x264.YIFY+HI: Braveheart |  | tt0112573 |
| R0163 | Braveheart.1995.2160p.UHD.BluRay.X265-IAMABLE: Braveheart |  | tt0112573 |
| R0164 | Brazil.1985.DC.1080p.BluRay.H264.AAC-RARBG: Brazil |  | tt0088846 |
| R0165 | Brick.2005.1080p.BluRay.x264.YIFY: Brick |  | tt0393109 |
| R0166 | Bridesmaids.2011.1080p.BluRay.x264.VPPV: Bridesmaids |  | tt1478338 |
| R0167 | Bringing Up Baby (1938): Bringing Up Baby |  | tt0029947 |
| R0168 | Broken.Arrow.1996.720p.BrRip.x264.YIFY: Broken Arrow |  | tt0115759 |
| R0169 | Brother (1997) (Brat) Russia 1080p H.264 (moviesbyrizzo upload): Brother |  | tt0118767 |
| R0170 | [ www.UsaBit.com ] - Brother Bear 2003 720p BRRip x264-PLAYNOW: Brother Bear |  | tt0328880 |
| R0171 | Burn.After.Reading.2008.1080p.BrRip.x264.YIFY: Burn After Reading |  | tt0887883 |
| R0172 | Camp.Rock.2008.1080p.BluRay.x264-OFT: Camp Rock |  | tt1055366 |
| R0173 | Can't.Hardly.Wait.1998.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Can't Hardly Wait |  | tt0127723 |
| R0174 | Captain.America.The.First.Avenger.1080p.BrRip.x264.YIFY: Captain America: The First Avenger |  | tt0458339 |
| R0175 | Captain America Civil War 2016 1080p BluRay x264 DTS-JYK: Captain America: Civil War |  | tt3498820 |
| R0176 | Captain.America.The.Winter.Soldier.2014.1080p.BluRay.x264.YIFY: Captain America: The Winter Soldier |  | tt1843866 |
| R0177 | Captain.Marvel.2019.1080p.BRRip.x264-MkvCage.ws: Captain Marvel |  | tt4154664 |
| R0178 | Captain Phillips: Captain Phillips |  | tt1535109 |
| R0179 | Captain.Blood.1935.1080p.WEB-DL.AAC2.0.h.264-fiend: Captain Blood |  | tt0026174 |
| R0180 | Captain.Marvel.2019.1080p.WEB-DL.DD5.1.H264-FGT: Captain Marvel |  | tt4154664 |
| R0181 | Carrie.1976.1080p.BluRay.x264.YIFY: Carrie |  | tt0074285 |
| R0182 | Casablanca [Ultimate Collector's Edition].1942.BRRip.XviD-VLiS: Casablanca |  | tt0034583 |
| R0183 | Casablanca.1942.720.x264.YIFY: Casablanca |  | tt0034583 |
| R0184 | Casino 1995 1080p BluRay x264 ACC - Ozlem: Casino |  | tt0112641 |
| R0185 | Cast.Away.2000.1080p.BrRip.x264.YIFY: Cast Away |  | tt0162222 |
| R0186 | Catch.Me.If.You.Can.2002.1080p.BluRay.x264.AC3-ETRG: Catch Me If You Can |  | tt0264464 |
| R0187 | Charlie.and.the.Chocolate.Factory.2005.1080p.BrRip.x264.BOKUTOX.YIFY: Charlie and the Chocolate Factory |  | tt0367594 |
| R0188 | Children.of.Men.2006.1080p.BrRip.x264.BOKUTOX.YIFY: Children of Men |  | tt0206634 |
| R0189 | Chinatown.1974.1080p.BluRay.x264.anoXmous_: Chinatown |  | tt0071315 |
| R0190 | Cinderella.1950.720p.BluRay.x264.YIFY: Cinderella |  | tt0042332 |
| R0191 | Cinderella.1950.1080p.BluRay.x264.YIFY: Cinderella |  | tt0042332 |
| R0192 | Cinderella Man (2005) 720p 600MB: Cinderella Man |  | tt0352248 |
| R0193 | Citizen Kane (1941) 720p BRRiP x264 AAC [Team Nanban]: Citizen Kane |  | tt0033467 |
| R0194 | Clear and Present Danger: Clear and Present Danger |  | tt0109444 |
| R0195 | Cleopatra.1963.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Cleopatra |  | tt0056937 |
| R0196 | Cloud.Atlas.2012.1080p.BrRip.x264.YIFY: Cloud Atlas |  | tt1371111 |
| R0197 | Cloverfield.2008.1080p.BrRip.x264.YIFY: Cloverfield |  | tt1060277 |
| R0198 | Cocoon 1985 720p  BRRip x264 AAC - Ozlem: Cocoon |  | tt0088933 |
| R0199 | Collateral.2004.720p.BrRip.x264.YIFY: Collateral |  | tt0369339 |
| R0200 | Collateral.2004.1080p.BluRay.x264.anoXmous_: Collateral |  | tt0369339 |
| R0201 | Colossus - The Forbin Project (1970) WIDESCREEN x264 MP4: Colossus: The Forbin Project |  | tt0064177 |
| R0202 | ConAir.1997.1080p.BrRip.x264.BOKUTOX.YIFY: Con Air |  | tt0118880 |
| R0203 | Confessions.of.a.Dangerous.Mind.2002.720p.BrRip.x264.YIFY: Confessions of a Dangerous Mind |  | tt0270288 |
| R0204 | Contact.1997.1080p.BluRay.x264.YIFY: Contact |  | tt0118884 |
| R0205 | Contagion.2011.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Contagion |  | tt1598778 |
| R0206 | Contagion.2011.1080p.BluRay.H264.AAC-RARBG: Contagion |  | tt1598778 |
| R0207 | Cool Hand Luke - zeberzee: Cool Hand Luke |  | tt0061512 |
| R0208 | Corpse.Bride.2005.1080p.BrRip.x264.BOKUTOX.YIFY: Corpse Bride |  | tt0121164 |
| R0209 | Coyote Ugly Unrated [2000]: Coyote Ugly |  | tt0200550 |
| R0210 | Crash.2004.720p.BluRay.x264.YIFY: Crash |  | tt0375679 |
| R0211 | Crazy.Stupid.Love.2011.1080p.BluRay.x264.AAC-ETRG: Crazy, Stupid, Love. |  | tt1570728 |
| R0212 | Crimson Tide: Crimson Tide |  | tt0112740 |
| R0213 | Crimson.Tide.1995.1080p.BrRip.x264.YIFY: Crimson Tide |  | tt0112740 |
| R0214 | Crocodile.Dundee.1986.720p.BluRay.x264.YIFY: Crocodile Dundee |  | tt0090555 |
| R0215 | Crocodile.Dundee.II.1988.1080p.BluRay.x264.YIFY: Crocodile Dundee II |  | tt0092493 |
| R0216 | Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264.AC3-DDL: Crouching Tiger, Hidden Dragon |  | tt0190332 |
| R0217 | Cuties.2020.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Cuties |  | tt9196192 |
| R0218 | Daryl: D.A.R.Y.L. |  | tt0088979 |
| R0219 | Dances.with.Wolves.DC.1990.1080p.x264.BrRip.YIFY: Dances with Wolves |  | tt0099348 |
| R0220 | Dante's.Peak.1997.720p.BrRip.x264.bitloks.YIFY: Dante's Peak |  | tt0118928 |
| R0221 | Das Boot Director's Cut (1981) [1080p] x264 - Jalucian: Das Boot |  | tt0082096 |
| R0222 | Dave.1993.1080p.BRrip.x264.YIFY: Dave |  | tt0106673 |
| R0223 | Dawn.of.the.Planet.of.the.Apes.2014.2160p.UHD.BluRay.x265-DEPTH: Dawn of the Planet of the Apes |  | tt2103281 |
| R0224 | Dead Snow 2009 Eng Audio  DVDR Xvid-aTLas: Dead Snow |  | tt1278340 |
| R0225 | Deadpool: Deadpool |  | tt1431045 |
| R0226 | Deadpool.2.2018.1080p.BluRay.x264-[YTS.AM]: Deadpool 2 |  | tt5463162 |
| R0227 | Death.Proof.2007.1080p.BluRay.x264.YIFY: Death Proof |  | tt1028528 |
| R0228 | Deep.Impact.1998.1080p.BrRip.x264.YIFY: Deep Impact |  | tt0120647 |
| R0229 | Deliverance.1972.1080p.BluRay.x264.YIFY: Deliverance |  | tt0068473 |
| R0230 | Desperado.1995.1080p.BluRay.x264.YIFY: Desperado |  | tt0112851 |
| R0231 | die.hard.1988.720p.bluray.x264-nezu: Die Hard |  | tt0095016 |
| R0232 | Die.Hard.1988.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX]: Die Hard |  | tt0095016 |
| R0233 | Die.Hard.2.1990.720p.BrRip.x264.bitloks.YIFY: Die Hard 2 |  | tt0099423 |
| R0234 | Dirty.Dancing.1987.1080p.BrRip.x264.YIFY: Dirty Dancing |  | tt0092890 |
| R0235 | Dirty.Harry.1971.1080p.BRrip.x264.YIFY: Dirty Harry |  | tt0066999 |
| R0236 | Dirty.Grandpa.2016.720p.WEBRip.x264.AAC-ETRG: Dirty Grandpa |  | tt1860213 |
| R0237 | Divergent.2014: Divergent |  | tt1840309 |
| R0238 | Django Unchained: Django Unchained |  | tt1853728 |
| R0239 | Doctor Strange 2016 1080p BluRay x264 DTS-JYK: Doctor Strange |  | tt1211837 |
| R0240 | Doctor.Strange.In.The.Multiverse.Of.Madness.2022.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Doctor Strange in the Multiverse of Madness |  | tt9419884 |
| R0241 | doctor.strange.2016.2160p.uhd.bluray.x265-terminal: Doctor Strange |  | tt1211837 |
| R0242 | Donnie.Darko.DIRECTORS.CUT.2001.1080p.BrRip.x264.YIFY: Donnie Darko |  | tt0246578 |
| R0243 | Double.Indemnity.1944.1080p.BluRay.10Bit.HEVC.EAC3-SARTRE: Double Indemnity |  | tt0036775 |
| R0244 | Downsizing.2017.2160p.UHD.BluRay.X265-IAMABLE: Downsizing |  | tt1389072 |
| R0245 | Dracula.1992.1080p.BluRay.x264.YIFY: Dracula |  | tt0103874 |
| R0246 | Draft.Day.2014.1080p.BluRay.x264.YIFY: Draft Day |  | tt2223990 |
| R0247 | Drive.2011.720p.BrRip.x264.YIFY: Drive |  | tt0780504 |
| R0248 | Dune.1984.1080p.BRrip.x264.YIFY: Dune |  | tt0087182 |
| R0249 | Dune.Part.Two.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR: Dune: Part Two |  | tt15239678 |
| R0250 | Dunkirk.2017.720p.BluRay.999MB.HQ.x265.10bit-GalaxyRG: Dunkirk |  | tt5013056 |
| R0251 | ET_The Extra Terrestrial (1982) 1080p BRRip x264 {inyd}: E.T. the Extra-Terrestrial |  | tt0083866 |
| R0252 | Easy.A.2010.BrRip.1080p.x264.YIFY: Easy A |  | tt1282140 |
| R0253 | Edward.Scissorhands.1990.1080p.BrRip.x264.YIFY: Edward Scissorhands |  | tt0099487 |
| R0254 | 8½ (1963) 720p (Melifilm): 8½ |  | tt0056801 |
| R0255 | Elf.2003.1080p.BluRay.H264.AAC-RARBG: Elf |  | tt0319343 |
| R0256 | Elizabeth.1998.1080p.BluRay.H264.AAC-RARBG: Elizabeth |  | tt0127536 |
| R0257 | Elle.2016.1080p.BluRay.x264.VPPV: Elle |  | tt3716530 |
| R0258 | Emma (1996) 720p BRrip_sujaidr: Emma |  | tt0116191 |
| R0259 | Emma.2020.BDRip.XviD.AC3-EVO: Emma. |  | tt9214832 |
| R0260 | Empire.Records.1995.1080p.BluRay.x264.YIFY: Empire Records |  | tt0112950 |
| R0261 | Enemy.At.The.Gates.2001.1080p.BrRip.x264.YIFY: Enemy at the Gates |  | tt0215750 |
| R0262 | Epidemic (1987): Epidemic |  | tt0092972 |
| R0263 | Equilibrium 2002 1080p BDRip AAC x264-tomcat12: Equilibrium |  | tt0238380 |
| R0264 | equus.1977.1080p.bluray.x264-psychd: Equus |  | tt0075995 |
| R0265 | Eraserhead.1977.720p.BluRay.X264.YIFY: Eraserhead |  | tt0074486 |
| R0266 | Eternal.Sunshine.of.the.Spotless.Mind.2004.1080p.BrRip.x264.BOKUTOX.YIFY: Eternal Sunshine of the Spotless Mind |  | tt0338013 |
| R0267 | Eternals.2021.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Eternals |  | tt9032400 |
| R0268 | Ex.Machina.2015.1080p.BluRay.x264.YIFY: Ex Machina |  | tt0470752 |
| R0269 | Excalibur.1981.1080p.BluRay.x264.YIFY: Excalibur |  | tt0082348 |
| R0270 | Executive.Decision.1996.720p.BluRay.x264.YIFY: Executive Decision |  | tt0116253 |
| R0271 | Experimenter.2015.1080p.BRRip.x264.AAC-ETRG: Experimenter |  | tt3726704 |
| R0272 | extraction.2020.2160p.web.h265-slot: Extraction |  | tt8936646 |
| R0273 | Eyes.Wide.Shut.1999.1080p.BluRay.x264.YIFY: Eyes Wide Shut |  | tt0120663 |
| R0274 | FATF - 02 - 2 Fast 2 Furious: 2 Fast 2 Furious |  | tt0322259 |
| R0275 | FATF - 03 - The Fast and the Furious Tokyo Drift: The Fast and the Furious: Tokyo Drift |  | tt0463985 |
| R0276 | FATF - 05 - Fast Five: Fast Five |  | tt1596343 |
| R0277 | Fast.and.Furious.Presents.Hobbs.and.Shaw.2019.1080p.HC.HDRip.X264.AC3-EVO: Fast & Furious Presents: Hobbs & Shaw |  | tt6806448 |
| R0278 | fast.five.2011.extended.2160p.uhd.bluray.x265-terminal: Fast Five |  | tt1596343 |
| R0279 | Fast.X.2023.2160p.AMZN.WEB-DL.DDP5.1.HDR.H.265-FAMiLYFOREVER: Fast X |  | tt5433140 |
| R0280 | fast.and.furious.2009.2160p.uhd.bluray.x265-terminal: Fast & Furious |  | tt1013752 |
| R0281 | Fast.and.Furious.6.2013.EXTENDED.2160p.UHD.BluRay.X265-IAMABLE: Fast & Furious 6 |  | tt1905041 |
| R0282 | Furious.7.2015.EXTENDED.2160p.UHD.BluRay.x265-TERMiNAL: Furious 7 |  | tt2820852 |
| R0283 | The.Fast.and.the.Furious.2001.Multi.UHD.2160p.BluRay.HEVC.HDR.DTSXLL.5.1-DTOne: The Fast and the Furious |  | tt0232500 |
| R0284 | The.Fast.and.the.Furious.Tokyo.Drift.2006.UHD.2160p.BluRay.HEVC.HDR.DTS-XLL.7.1-DTOne: The Fast and the Furious: Tokyo Drift |  | tt0463985 |
| R0285 | The Fate of the Furious: The Fate of the Furious |  | tt4630562 |
| R0286 | Face Off: Face/Off |  | tt0119094 |
| R0287 | Family.Guy.The.Movie.-.Stewie.Griffin.The.Untold.Story.2005.STV.DVDrip.XviD.INTERNAL.(697mb): Stewie Griffin: The Untold Story |  | tt0385690 |
| R0288 | Fantasia.1940.720p.BrRip.x264.YIFY: Fantasia |  | tt0032455 |
| R0289 | Fantasia.2000.1999.720p.BrRip.x264.YIFY: Fantasia 2000 |  | tt0120910 |
| R0290 | Fantastic.Beasts.The.Crimes.of.Grindelwald.2018.1080p.BluRay.10bit.HEVC.6CH.MkvCage.ws: Fantastic Beasts: The Crimes of Grindelwald |  | tt4123430 |
| R0291 | Fantastic.Beasts.And.Where.To.Find.Them.2016.720p.BluRay.x264-[YTS.AG]: Fantastic Beasts and Where to Find Them |  | tt3183660 |
| R0292 | Fantastic.Beasts.The.Secrets.Of.Dumbledore.2022.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Fantastic Beasts: The Secrets of Dumbledore |  | tt4123432 |
| R0293 | Fantastic.Mr.Fox.2009.1080p.BrRip.x264.YIFY: Fantastic Mr. Fox |  | tt0432283 |
| R0294 | Fantastic.Voyage.1966.1080p.BluRay.x264.VPPV: Fantastic Voyage |  | tt0060397 |
| R0295 | Fantastic.Beasts.and.Where.to.Find.Them.2016.1080p.BluRay.x264.DTS-JYK: Fantastic Beasts and Where to Find Them |  | tt3183660 |
| R0296 | Fantastic.Beasts.and.Where.to.Find.Them.2016.2160p.UHD.BluRay.x265-DEPTH: Fantastic Beasts and Where to Find Them |  | tt3183660 |
| R0297 | Faust.1926.720p.BluRay.x264-x0r: Faust |  | tt0016847 |
| R0298 | La Dolce Vita : La Dolce Vita |  | tt0053779 |
| R0299 | Fellini - Satyricon (1969).x264.Ita.Spa.Fra.Ger.multisub: Satyricon |  | tt0064940 |
| R0300 | FernGully The Last Rainforest 1992 1080p BluRay x264 AC3 - Ozlem: FernGully: The Last Rainforest |  | tt0104254 |
| R0301 | Fidel la storia di un mito (2002) [ITA]: Fidel |  | tt0258351 |
| R0302 | Fight.Club.10th.Anniversary.Edition.1999.1080p.BrRip.x264.YIFY: Fight Club |  | tt0137523 |
| R0303 | First.Man.2018.720p.WEBRip.x264-[YTS.AM]: First Man |  | tt1213641 |
| R0304 | First Man: First Man |  | tt1213641 |
| R0305 | Five.Easy.Pieces.1970.1080p.BluRay.x264.anoXmous_: Five Easy Pieces |  | tt0065724 |
| R0306 | Flight of the Intruder (John Milius, 1991): Flight of the Intruder |  | tt0099587 |
| R0307 | For Your Consideration (2006) DVDR(xvid) NL Subs DMT: For Your Consideration |  | tt0470765 |
| R0308 | Ford.V.Ferrari.2019.1080p.BluRay.x264.AAC5.1-[YTS.LT]: Ford v Ferrari |  | tt1950186 |
| R0309 | Forgetting Sarah Marshall 2008.Unrated.1040p.BluRay.5.1.x264 . NVEE: Forgetting Sarah Marshall |  | tt0800039 |
| R0310 | Forrest.Gump.1994.1080p.BrRip.x264.YIFY: Forrest Gump |  | tt0109830 |
| R0311 | Freaky.Friday.2003.720p.BluRay.x264-[YTS.AM]: Freaky Friday |  | tt0322330 |
| R0312 | Freeway (1996)[DVDRip][big_dad_e™]: Freeway |  | tt0116361 |
| R0313 | Friday.the.13th.1980.720p.BluRay.x264.YIFY: Friday the 13th |  | tt0080761 |
| R0314 | Friday.the.13th.2009.1080p.BluRay.x264.YIFY: Friday the 13th |  | tt0758746 |
| R0315 | Lang, Fritz - M (1931): M |  | tt0022100 |
| R0316 | Frozen.2013.1080p.BluRay.x264.YIFY: Frozen |  | tt2294629 |
| R0317 | Full.Metal.Jacket.1987.1080p.BluRay.x264-[YTS.AM]: Full Metal Jacket |  | tt0093058 |
| R0318 | 1a. Ghost in the Shell - The Movie (1995 - 1080p DUAL Audio): Ghost in the Shell |  | tt0113568 |
| R0319 | 2a. Ghost in the Shell 2 - Innocence (2004 - 1080p DUAL Audio): Ghost in the Shell 2: Innocence |  | tt0347246 |
| R0320 | Galaxy.Quest.1999.1080p.BrRip.x264.YIFY: Galaxy Quest |  | tt0177789 |
| R0321 | Game.Night.2018.1080p.WEBRip.x264-[YTS.AM]: Game Night |  | tt2704998 |
| R0322 | Gangs.Of.New.York.2002.REMASTERED.2002.1080p.BrRip.x264.BOKUTOX.YIFY: Gangs of New York |  | tt0217505 |
| R0323 | Garden.State.720pHDTV.x264.YIFY: Garden State |  | tt0333766 |
| R0324 | Gattaca.1997.1080p.BrRip.x264.bitloks.YIFY: Gattaca |  | tt0119177 |
| R0325 | Get Out: Get Out |  | tt5052448 |
| R0326 | Get.Shorty.1995.720p.BluRay.x264-[YTS.AM]: Get Shorty |  | tt0113161 |
| R0327 | Ghost.World.2001.1080p.BluRay.x264.YIFY: Ghost World |  | tt0162346 |
| R0328 | ghost.in.the.shell.1995.2160p.uhd.bluray.x265-haiku: Ghost in the Shell |  | tt0113568 |
| R0329 | Ghosts.of.Girlfriends.Past.2009.BluRay.1080p.x264.YIFY: Ghosts of Girlfriends Past |  | tt0821640 |
| R0330 | Gladiator.EXTENDED.2000.1080.BrRip.264.YIFY: Gladiator |  | tt0172495 |
| R0331 | Glass.2019.1080p.WEBRip.x264-[YTS.AM]: Glass |  | tt6823368 |
| R0332 | Glengarry.Glen.Ross.1992.720p.HDTV.x264.YIFY: Glengarry Glen Ross |  | tt0104348 |
| R0333 | Godzilla.1998.1080p.BrRip.x264.YIFY: Godzilla |  | tt0120685 |
| R0334 | Godzilla.2014.1080p.BluRay.x264.YIFY: Godzilla |  | tt0831387 |
| R0335 | Godzilla King of the Monsters 2019.MULTi.UHD.BluRay.2160p.Atmos.7.1.HEVC.-DDR[EtHD]: Godzilla: King of the Monsters |  | tt3741700 |
| R0336 | Godzilla.vs.Kong.2021.2160p.MAX.WEB-DL.DDPA.5.1.DV.HDR.H.265-PiRaTeS: Godzilla vs. Kong |  | tt5034838 |
| R0337 | Gone in 60 seconds(1974): Gone in 60 Seconds |  | tt0071571 |
| R0338 | Gone In Sixty Seconds (2000) BRRip 550mb: Gone in 60 Seconds |  | tt0187078 |
| R0339 | Gone.With.The.Wind.1939.720p.BluRay.x264.YIFY: Gone with the Wind |  | tt0031381 |
| R0340 | Good Bye, Lenin! : Good Bye Lenin! |  | tt0301357 |
| R0341 | Good.Will.Hunting.1997.1080p.BrRip.x264.YIFY: Good Will Hunting |  | tt0119217 |
| R0342 | Goodfellas.1990.720p.BrRip.264.YIFY: GoodFellas |  | tt0099685 |
| R0343 | Grave of the Fireflies (1988) 720p BRRiP x264 AAC [Team Nanban]: Grave of the Fireflies |  | tt0095327 |
| R0344 | Great.Expectations.1946.720p.Bluray.x264.anoXmous: Great Expectations |  | tt0038574 |
| R0345 | Greyhound.2020.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Greyhound |  | tt6048922 |
| R0346 | Groundhog.Day.1993.REMASTERED.1080p.BluRay.6CH.ShAaNiG: Groundhog Day |  | tt0107048 |
| R0347 | Grown.Ups.2010.1080p.BrRip.x264.BOKUTOX.YIFY: Grown Ups |  | tt1375670 |
| R0348 | Grown.Ups.2.2013.1080p.BluRay.x264.YIFY: Grown Ups 2 |  | tt2191701 |
| R0349 | Guardians.Of.The.Galaxy.Vol..3.2023.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Guardians of the Galaxy Vol. 3 |  | tt6791350 |
| R0350 | Guardians of the Galaxy: Guardians of the Galaxy |  | tt2015381 |
| R0351 | Guardians of the Galaxy Vol. 2: Guardians of the Galaxy: Vol. 2 |  | tt3896198 |
| R0352 | Gummo.1997.DVDRip.x264: Gummo |  | tt0119237 |
| R0353 | Halloween.1978.REMASTERED.1080p.BluRay.H264.AAC-RARBG: Halloween |  | tt0077651 |
| R0354 | Hannibal.2001.1080p.BluRay.x264.YIFY: Hannibal |  | tt0212985 |
| R0355 | happiest.season.2020.1080p.web.h264-naisu: Happiest Season |  | tt8522006 |
| R0356 | [ www.UsaBit.com ] - Happy Gilmore 1996 720p BRRip x264-PLAYNOW: Happy Gilmore |  | tt0116483 |
| R0357 | Hard.Candy.2005.1080p.BluRay.x264.YIFY: Hard Candy |  | tt0424136 |
| R0358 | Harold.and.Kumar.Escape.From.Guantanamo.Bay.2008.UNRATED.BrRip.720p.x264.YIFY: Harold & Kumar Escape from Guantanamo Bay |  | tt0481536 |
| R0359 | Harold.and.Kumar.Go.To.White.Castle.2004.UNRATED.BrRip.x264.YIFY: Harold & Kumar Go to White Castle |  | tt0366551 |
| R0360 | Harry_Potter_and_the_Half_Blood_Prince_2009: Harry Potter and the Half-Blood Prince |  | tt0417741 |
| R0361 | HP7.2010.BRRip.720p.Bluray.YIFY: Harry Potter and the Deathly Hallows: Part 1 |  | tt0926084 |
| R0362 | Harry.Potter.And.The.Deathly.Hallows.Part.2.2011.720p.BrRip.264.YIFY.mkv-muxed: Harry Potter and the Deathly Hallows: Part 2 |  | tt1201607 |
| R0363 | Harry_Potter_and_the_Chamber_of_Secrets_2002: Harry Potter and the Chamber of Secrets |  | tt0295297 |
| R0364 | Harry_Potter_and_the_Goblet_of_Fire_2005: Harry Potter and the Goblet of Fire |  | tt0330373 |
| R0365 | Harry_Potter_and_the_Order_of_the_Phoenix_2007: Harry Potter and the Order of the Phoenix |  | tt0373889 |
| R0366 | Harry_Potter_and_the_Prisoner_of_Azkaban_2004: Harry Potter and the Prisoner of Azkaban |  | tt0304141 |
| R0367 | Harvey.1950.BluRay.720p.H264: Harvey |  | tt0042546 |
| R0368 | Heat.1995.BrRip.720p.x264.YIFY: Heat |  | tt0113277 |
| R0369 | Heist.2001.720p.AC3.HDTV: Heist |  | tt0252503 |
| R0370 | Henry.Fool.1997.720p.Webrip.x264.AAC-pong: Henry Fool |  | tt0122529 |
| R0371 | Her.2013.1080p.BluRay.x264.YIFY: Her |  | tt1798709 |
| R0372 | Hidden.Figures.2016.1080p.BRRiP.6CH.ShAaNiG: Hidden Figures |  | tt4846340 |
| R0373 | Honey.I.Shrunk.the.Kids.1989.720p.BluRay.X264.850MB-Mkvking: Honey, I Shrunk the Kids |  | tt0097523 |
| R0374 | Hook.1991.1080p.BRrip.x264.YIFY: Hook |  | tt0102057 |
| R0375 | Hot.Fuzz.2007.1080p.BRrip.x264.GAZ.YIFY: Hot Fuzz |  | tt0425112 |
| R0376 | House.of.Sand.and.Fog.720p.HDTV.YIFY: House of Sand and Fog |  | tt0315983 |
| R0377 | House.of.Flying.Daggers.2004.720p.BluRay.x264.anoXmous: House of Flying Daggers |  | tt0385004 |
| R0378 | How.To.Train.Your.Dragon.2010.1080p.BrRip.x264.YIFY: How to Train Your Dragon |  | tt0892769 |
| R0379 | How to Marry a Millionaire 1953 BDRip 1080p DTS multisub HighCode: How to Marry a Millionaire |  | tt0045891 |
| R0380 | How.to.Train.Your.Dragon.2.2014.720p.BluRay.x264.YIFY: How to Train Your Dragon 2 |  | tt1646971 |
| R0381 | Howls.Moving.Castle.2004.720.DualAudio.x264.YIFY : Howl's Moving Castle |  | tt0347149 |
| R0382 | I.Am.Number.Four.2011.720p.BRRip.x264.YIFY: I Am Number Four |  | tt1464540 |
| R0383 | I.Tonya.2017.1080p.10bit.BluRay.6CH.x265.HEVC-PSA: I, Tonya |  | tt5580036 |
| R0384 | Idiocracy.2006.HDTV.720p.x264.YIFY: Idiocracy |  | tt0387808 |
| R0385 | If.... (1968) Criterion BDRip 720p AAC multisub HighCode: If.... |  | tt0063850 |
| R0386 | Immortal.Beloved.1994.720p.BluRay.x264-[YTS.AG]: Immortal Beloved |  | tt0110116 |
| R0387 | Inception.2010.1080p.BrRip.x264.YIFY: Inception |  | tt1375666 |
| R0388 | Independence.Day.Resurgence.2016.720p.BluRay.x264-[YTS.AG]: Independence Day: Resurgence |  | tt1628841 |
| R0389 | independence.day.resurgence.2016.2160p.uhd.bluray.x265-terminal: Independence Day: Resurgence |  | tt1628841 |
| R0390 | Indiana.Jones.And.The.Temple.Of.Doom.1984.1080p.BluRay.x264.YIFY: Indiana Jones and the Temple of Doom |  | tt0087469 |
| R0391 | Indiana.Jones.And.The.Kingdom.of.the.Crystal.Skull.2008.1080p.BrRip.x264.YIFY: Indiana Jones and the Kingdom of the Crystal Skull |  | tt0367882 |
| R0392 | Indiana.Jones.And.The.Last.Crusade.1989.1080p.BluRay.x264.YIFY: Indiana Jones and the Last Crusade |  | tt0097576 |
| R0393 | Infernal Affairs 2002 BRRip 720p x264 RmD (HDScene Release): Infernal Affairs |  | tt0338564 |
| R0394 | Inglourious.Basterds.2009.1080p.BluRay.x264.AC3-ETRG: Inglourious Basterds |  | tt0361748 |
| R0395 | Inglourious Basterds 2009 x264 aac: Inglourious Basterds |  | tt0361748 |
| R0396 | Ink.2009.BRRIP.720P.H264-ZEKTORM: Ink |  | tt1071804 |
| R0397 | Insomnia.1997.1080p.BluRay.H264.AAC-RARBG: Insomnia |  | tt0119375 |
| R0398 | Interstellar.2014.2014.1080p.BluRay.x264.YIFY: Interstellar |  | tt0816692 |
| R0399 | Interview.with.the.Vampire.1994.1080p.BluRay.x264.YIFY: Interview with the Vampire |  | tt0110148 |
| R0400 | Into.The.Blue.2005.1080p.BluRay.H264.AAC-RARBG: Into the Blue |  | tt0378109 |
| R0401 | Invasion of the Body Snatchers (1956) (1080p BluRay x265 10bit Tigole): Invasion of the Body Snatchers |  | tt0049366 |
| R0402 | Iron.Man.2.2010.1080p.BrRip.x264.YIFY: Iron Man 2 |  | tt1228705 |
| R0403 | Iron Man 3: Iron Man 3 |  | tt1300854 |
| R0404 | Iron.Man.3.2013.1080p.BluRay.x264.YIFY: Iron Man 3 |  | tt1300854 |
| R0405 | Iron.Man.2008.1080p.BrRip.x264.YIFY: Iron Man |  | tt0371746 |
| R0406 | It.Follows.2014.1080p.BluRay.x264.YIFY: It Follows |  | tt3235888 |
| R0407 | Jack Reacher: Jack Reacher |  | tt0790724 |
| R0408 | Jack.Reacher.Never.Go.Back.2016.720p.BRRip.x264.AAC-ETRG: Jack Reacher: Never Go Back |  | tt3393786 |
| R0409 | Casino.Royale.2006.1080p.BRrip.x264.YIFY: Casino Royale |  | tt0381061 |
| R0410 | James and the Giant Peach (1996): James and the Giant Peach |  | tt0116683 |
| R0411 | Jingle.All.The.Way.1996.EXTENDED.720p.BrRip.x264.YIFY: Jingle All the Way |  | tt0116705 |
| R0412 | John Wick: John Wick |  | tt2911666 |
| R0413 | John Wick Chapter 2: John Wick: Chapter 2 |  | tt4425200 |
| R0414 | Journey.to.the.Center.of.the.Earth.1959.720p.BluRay.x264.YIFY: Journey to the Center of the Earth |  | tt0052948 |
| R0415 | Julius.Caesar.1953.1080p.WEB-DL.DD5.1.h.264-fiend: Julius Caesar |  | tt0045943 |
| R0416 | Jumanji.1995.720p.BrRip.x264.BOKUTOX.YIFY: Jumanji |  | tt0113497 |
| R0417 | Juno.2007.720p.x264.BrRip.YIFY: Juno |  | tt0467406 |
| R0418 | Jurassic.Park.1993.1080p.BRrip.x264.YIFY: Jurassic Park |  | tt0107290 |
| R0419 | Jurassic Park 1993 UHD 2160p Blu-ray Remux HDR Multi DTS-X 7.1-DTOne: Jurassic Park |  | tt0107290 |
| R0420 | Jurassic.Park.III.2001.1080p.BRrip.x264.YIFY: Jurassic Park III |  | tt0163025 |
| R0421 | Jurassic World 2015 1080p BRRip x264 DTS-JYK: Jurassic World |  | tt0369610 |
| R0422 | Jurassic.World.Dominion.2022.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Jurassic World: Dominion |  | tt8041270 |
| R0423 | Jurassic.World.Fallen.Kingdom.2018.1080p.BluRay.x264-[YTS.AM]: Jurassic World: Fallen Kingdom |  | tt4881806 |
| R0424 | Jurassic.World.Dominion.2022.1080p.WEB-DL.DDP5.1.Atmos.H.264-CM: Jurassic World: Dominion |  | tt8041270 |
| R0425 | K-PAX.2001.720p.HDTV.x264.YIFY: K-PAX |  | tt0272152 |
| R0426 | Keoma [1976] - BluRay 720p Dual Áudio: Keoma |  | tt0074740 |
| R0427 | Key.Largo.1948.1080p.BluRay.H264.AAC-RARBG: Key Largo |  | tt0040506 |
| R0428 | Kill.Bill.Vol.1.2003.1080p.BrRIp.x264.YIFY: Kill Bill: Vol. 1 |  | tt0266697 |
| R0429 | Kill.Bill.Vol.2.2004.720p.BrRip.x264.YIFY: Kill Bill: Vol. 2 |  | tt0378194 |
| R0430 | Kindergarten.Cop.1990.720p.BluRay.x264.YIFY: Kindergarten Cop |  | tt0099938 |
| R0431 | King.Kong.2005.1080p.Extended.Cut.BRRip.x264.AAC-ETRG: King Kong |  | tt0360717 |
| R0432 | King.Kong.2005.EXTENDED.4K.HDR.2160p.BDRemux Ita Eng x265-NAHOM: King Kong |  | tt0360717 |
| R0433 | Kingdom of Heaven 2005.Director's.Cut.1080p.BluRay.x264 . NVEE: Kingdom of Heaven |  | tt0320661 |
| R0434 | Kiss Kiss Bang Bang 2005 (1080p x265 10bit Tigole): Kiss Kiss Bang Bang |  | tt0373469 |
| R0435 | Kiss.Kiss.Bang.Bang.2005.720p.BluRay.999MB.HQ.x265.10bit-GalaxyRG: Kiss Kiss Bang Bang |  | tt0373469 |
| R0436 | Knives.Out.2019.1080p.BluRay.x264.AAC-[YTS.MX]: Knives Out |  | tt8946378 |
| R0437 | Knives Out: Knives Out |  | tt8946378 |
| R0438 | Kong.Skull.Island.2017.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265: Kong: Skull Island |  | tt3731562 |
| R0439 | Kong.Skull.Island.2017.2160p.UHD.BluRay.x265-TERMiNAL: Kong: Skull Island |  | tt3731562 |
| R0440 | Kung.Fu.Panda.2008.720p.BrRip.x264.YIFY: Kung Fu Panda |  | tt0441773 |
| R0441 | La.Strada.1954.Criterion.DVDRip.x264: La Strada |  | tt0047528 |
| R0442 | Labyrinth.1986.720p.BluRay.x264.YIFY: Labyrinth |  | tt0091369 |
| R0443 | [ www.UsaBit.com ] - The.LadyKillers.2004.720p.iNTERNAL.HDTV.x264-DEADPOOL: The Ladykillers |  | tt0335245 |
| R0444 | Laura (1944) DVDRip (SiRiUs sHaRe): Laura |  | tt0037008 |
| R0445 | Layer.Cake.2004.1080p.BluRay.x264.YIFY: Layer Cake |  | tt0375912 |
| R0446 | Legally Blonde: Legally Blonde |  | tt0250494 |
| R0447 | Legally.Blonde.2001.1080p.BrRip.x264.YIFY: Legally Blonde |  | tt0250494 |
| R0448 | Legend.of.the.Guardians.The.Owls.of.Ga.Hoole.2010.720p.BluRay.x264.YIFY: Legend of the Guardians: The Owls of Ga'Hoole |  | tt1219342 |
| R0449 | The Triplets of Belleville (2003) 720p BRRiP x264 AAC [Team Nanban]: The Triplets of Belleville |  | tt0286244 |
| R0450 | Les.Miserables[1998]DvDrip[Eng]-Toxic3: Les Misérables |  | tt0119683 |
| R0451 | Let.Me.In.2011.1080p.BluRay.x264.YIFY: Let Me In |  | tt1228987 |
| R0452 | Lethal.Weapon.1987.1080p.BrRip.x264.BOKUTOX.YIFY: Lethal Weapon |  | tt0093409 |
| R0453 | Lethal.Weapon.2.1989.1080p.BrRip.x264.BOKUTOX.YIFY: Lethal Weapon 2 |  | tt0097733 |
| R0454 | Lethal.Weapon.3.1992.1080p.BrRip.x264.BOKUTOX.YIFY: Lethal Weapon 3 |  | tt0104714 |
| R0455 | Liar Liar 1997 Remastered 1080p BluRay HEVC x265 5.1 BONE: Liar Liar |  | tt0119528 |
| R0456 | Lifeboat (1944) (1080p BluRay x265 afm72): Lifeboat |  | tt0037017 |
| R0457 | Lifeboat.1944.720p.BluRay.x264.anoXmous: Lifeboat |  | tt0037017 |
| R0458 | Lincoln.2012.1080p.Bluray.x264.YIFY: Lincoln |  | tt0443272 |
| R0459 | Lion.2016.720p.BRRip.x264.AAC-ETRG: Lion |  | tt3741834 |
| R0460 | Little Lord Fauntleroy (1980): Little Lord Fauntleroy |  | tt0081062 |
| R0461 | The.Little.Mermaid.1989.720p.BRrip.x264.GAZ.YIFY: The Little Mermaid |  | tt0097757 |
| R0462 | Little.Miss.Sunshine.2006.720p.BluRay.x264.YIFY: Little Miss Sunshine |  | tt0449059 |
| R0463 | Little.Women.2019.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Little Women |  | tt3281548 |
| R0464 | Night.Of.The.Living.Dead.1968.720p.BRRip.x264-x0r: Night of the Living Dead |  | tt0063350 |
| R0465 | Night Of The Living Dead (1968 - Colorized - George A. Romero): Night of the Living Dead |  | tt0063350 |
| R0466 | Dawn Of The Dead (1978 - George A. Romero): Dawn of the Dead |  | tt0077402 |
| R0467 | Day Of The Dead (1985 - George A. Romero): Day of the Dead |  | tt0088993 |
| R0468 | Night Of The Living Dead (1990 - Tom Savini): Night of the Living Dead |  | tt0100258 |
| R0469 | Lock,.Stock.and.Two.Smoking.Barrels.1998.1080p.BluRay.x264.YIFY: Lock, Stock and Two Smoking Barrels |  | tt0120735 |
| R0470 | Lolita.1997.1080p.BluRay.x264.YIFY: Lolita |  | tt0119558 |
| R0471 | [ www.UsaBit.com ] - Lone Wolf McQuade (1983) BluRay 720p 800MB Ganool: Lone Wolf McQuade |  | tt0085862 |
| R0472 | Looper.2012.1080p.BluRay.x264.YIFY: Looper |  | tt1276104 |
| R0473 | Lost.Girls.and.Love.Hotels.1080p.WEB-DL.DD5.1.H.264-EVO: Lost Girls and Love Hotels |  | tt0920462 |
| R0474 | Lost.Highway.1997.BrRip.720p.x264.YIFY: Lost Highway |  | tt0116922 |
| R0475 | Lost.in.Space.1998.720p.BluRay.x264.VPPV: Lost in Space |  | tt0120738 |
| R0476 | Love Actually (2003) (2160p BluRay x265 10bit HDR Tigole): Love Actually |  | tt0314331 |
| R0477 | Love.Actually.2003.1080p.BluRay.x264.YIFY: Love Actually |  | tt0314331 |
| R0478 | Love.and.Friendship.2016.720p.WEBRip.x264.AAC-ETRG: Love & Friendship |  | tt3068194 |
| R0479 | Lucky.Number.Slevin.2006.1080p.BrRip.x264.BOKUTOX.YIFY: Lucky Number Slevin |  | tt0425210 |
| R0480 | Lust.Caution.2007.720p.BluRay.x264.anoXmous_: Lust, Caution |  | tt0808357 |
| R0481 | M.1931.720p.BluRay.x264-EbP: M |  | tt0022100 |
| R0482 | Macbeth.1971.1080p.BluRay.x264.YIFY: Macbeth |  | tt0067372 |
| R0483 | Macbeth.1948.1080p.BluRay.H264.AAC-RARBG: Macbeth |  | tt0040558 |
| R0484 | Machete.2010.720p.PROPER.x264.aac: Machete |  | tt0985694 |
| R0485 | Machete.Kills.2013.1080p.BluRay.x264.YIFY: Machete Kills |  | tt2002718 |
| R0486 | Mad.Max.1979.1080p.BRrip.x264.YIFY: Mad Max |  | tt0079501 |
| R0487 | The.Magnificent.Seven.2016.720p.BRRip.x264.AAC-ETRG: The Magnificent Seven |  | tt2404435 |
| R0488 | Malcolm.X.1992.720p.BrRip.x264.BOKUTOX.YIFY: Malcolm X |  | tt0104797 |
| R0489 | Man.Of.Steel.2013.1080p.BluRay.x264.AC3-ETRG: Man of Steel |  | tt0770828 |
| R0490 | Mansfield.Park.1999.1080p.BluRay.x264.YIFY: Mansfield Park |  | tt0178737 |
| R0491 | Mars.Attacks.1996.1080p.BrRip.x264.YIFY: Mars Attacks! |  | tt0116996 |
| R0492 | Mary.Poppins.Returns.2018.720p.BluRay.x264-[YTS.AM]: Mary Poppins Returns |  | tt5028340 |
| R0493 | Mary.Poppins.1964.1080p.BluRay.x264.anoXmous_: Mary Poppins |  | tt0058331 |
| R0494 | Master.and.Commander.The.Far.Side.of.the.World.2003.1080p.BrRip.x264.YIFY: Master and Commander: The Far Side of the World |  | tt0311113 |
| R0495 | Match.Point.2005.1080p.BRRip.x264.AAC-ETRG: Match Point |  | tt0416320 |
| R0496 | Meet.Joe.Black.1998.1080p.BrRip.x264.YIFY: Meet Joe Black |  | tt0119643 |
| R0497 | Memphis.Belle.1990.1080p.BluRay.x264.YIFY: Memphis Belle |  | tt0100133 |
| R0498 | Men.In.Black.1997.1080p.BluRay.x264.YIFY: Men in Black |  | tt0119654 |
| R0499 | Men.In.Black.II.2002.1080p.BluRay.x264.YIFY: Men in Black II |  | tt0120912 |
| R0500 | Midway.2019.READNFO.1080p.HDRip.X264-EVO: Midway |  | tt6924650 |
| R0501 | Minority.Report.2002.1080p.BluRay.x264.YIFY: Minority Report |  | tt0181689 |
| R0502 | Miracle.On.34th.Street.1947.1080p.BluRay.H264.AAC-RARBG: Miracle on 34th Street |  | tt0039628 |
| R0503 | Miss.Congeniality.2000.720p.BluRay.x264-[YTS.AM]: Miss Congeniality |  | tt0212346 |
| R0504 | Mission.Impossible.1996.720p.BluRay.x264.YIFY: Mission: Impossible |  | tt0117060 |
| R0505 | Mission.Impossible.II.2000.720p.BrRip.x264-YIFY: Mission: Impossible II |  | tt0120755 |
| R0506 | Mission.Impossible.III.2006.720p.BrRip.x264-YIFY: Mission: Impossible III |  | tt0317919 |
| R0507 | Mission.Impossible.Ghost.Protocol.2011.720p.BrRip.x264.YIFY: Mission: Impossible - Ghost Protocol |  | tt1229238 |
| R0508 | Mission.Impossible.Rogue.Nation.2015.720p.BRRip.x264.AAC-ETRG: Mission: Impossible - Rogue Nation |  | tt2381249 |
| R0509 | Mission.Impossible.-.Fallout.2018.1080p.WEBRip.x264-[YTS.AM]: Mission: Impossible - Fallout |  | tt4912910 |
| R0510 | Moana: Moana |  | tt3521164 |
| R0511 | Moneyball.2011.720p.BrRip.x264.YIFY: Moneyball |  | tt1210166 |
| R0512 | Mononoke.hime.[Princess.Mononoke].[DUAL.AUDIO]1997.HDTVRip.x264.YIFY: Princess Mononoke |  | tt0119698 |
| R0513 | Monsters.Inc.2001.1080p.BrRip.x264.YIFY: Monsters, Inc. |  | tt0198781 |
| R0514 | Monty Python's Life of Brian (1979).DVDRip.XviD.Ekolb: Monty Python's Life of Brian |  | tt0079470 |
| R0515 | Monty.Python.and.the.Holy.Grail.1975.1080p.BluRay.x264.anoXmous_: Monty Python and the Holy Grail |  | tt0071853 |
| R0516 | Moon: Moon |  | tt1182345 |
| R0517 | Moon.2009.1080p.BluRay.x264.YIFY: Moon |  | tt1182345 |
| R0518 | Moonrise.Kingdom.2012.1080p.BluRay.x264.YIFY: Moonrise Kingdom |  | tt1748122 |
| R0519 | Moulin.Rouge.2001.1080p.BrRip.x264.BOKUTOX.YIFY: Moulin Rouge! |  | tt0203009 |
| R0520 | Mr.and.Mrs.Smith.2005.BluRay.1080p.x264.YIFY: Mr. & Mrs. Smith |  | tt0356910 |
| R0521 | Mr..Holland's.Opus.1995.1080p.BluRay.x264-[YTS.AG]: Mr. Holland's Opus |  | tt0113862 |
| R0522 | Mrs.Doubtfire.1993.2160p.WEB-DL.DTS-HD.MA.5.1.HEVC-WELP: Mrs. Doubtfire |  | tt0107614 |
| R0523 | Mulholland.Drive.2001.1080p.BluRay.H264.AAC-RARBG: Mulholland Drive |  | tt0166924 |
| R0524 | murder.by.death.1976.1080p.bluray.x264-hd4u: Murder by Death |  | tt0074937 |
| R0525 | My.Big.Fat.Greek.Wedding.2002.720p.BluRay.x264.YIFY: My Big Fat Greek Wedding |  | tt0259446 |
| R0526 | My.Days.Of.Mercy.2017.1080p.BluRay.x264-[YTS.LT]: My Days of Mercy |  | tt5978724 |
| R0527 | My.Girl.1991.1080P.Bluray.x265.10bit.h3llg0d: My Girl |  | tt0102492 |
| R0528 | My Dinner With Andre 1981 720p WEB-DL AAC 2.0 H.264-HDStar: My Dinner with Andre |  | tt0082783 |
| R0529 | Mystic.River.2003.1080p.BluRay.x264.YIFY: Mystic River |  | tt0327056 |
| R0530 | [ www.UsaBit.com ] - Naked Lunch 1991 720p BRRip x264-PLAYNOW: Naked Lunch |  | tt0102511 |
| R0531 | Next.2007.1080p.BrRip.x264.YIFY: Next |  | tt0435705 |
| R0532 | No.Country.For.Old.Men.2007.1080p.BrRip.x264.YIFY: No Country for Old Men |  | tt0477348 |
| R0533 | No.Way.Out.1987.720p.BluRay.x264-[YTS.AG]: No Way Out |  | tt0093640 |
| R0534 | Noah.2014.1080p.BluRay.x264.YIFY: Noah |  | tt1959490 |
| R0535 | Nobody.2021.2160p.AMZN.WEB-DL.x265.10bit.HDR10Plus.DDP5.1-SWTYBLZ: Nobody |  | tt7888964 |
| R0536 | North.By.Northwest.1959.720p.BluRay.x264-[YTS.AM]: North by Northwest |  | tt0053125 |
| R0537 | Notorious 1946 1080p BluRay x264 AAC - Ozlem: Notorious |  | tt0038787 |
| R0538 | Now.You.See.Me.2013.1080p.BluRay.x264.YIFY: Now You See Me |  | tt1670345 |
| R0539 | Nymphomaniac.Vol..II.2013.720p.BluRay.x264.YIFY: Nymphomaniac: Vol. II |  | tt2382009 |
| R0540 | Nymphomaniac.Vol.I.2013.Directors.Cut.BRRip.x264-RARBG: Nymphomaniac: Vol. I |  | tt1937390 |
| R0541 | O.Brother.Where.Art.Thou.2000.1080p.BrRip.x264.YIFY: O Brother, Where Art Thou? |  | tt0190590 |
| R0542 | Oblivion.2013.1080p.BluRay.x264.YIFY: Oblivion |  | tt1483013 |
| R0543 | Ocean's.Eight.2018.720p.WEBRip.x264-[YTS.AM]: Ocean's Eight |  | tt5164214 |
| R0544 | Ocean's.Eight.2018.1080p.WEBRip.x264-[YTS.AM]: Ocean's Eight |  | tt5164214 |
| R0545 | Office.Space.1999.1080p.BluRay.x264.GSFTX: Office Space |  | tt0151804 |
| R0546 | Oldboy (2003): Oldboy |  | tt0364569 |
| R0547 | Oldboy.2003.REMASTERED.KOREAN.1080p.BluRay.H264.AAC-VXT: Oldboy |  | tt0364569 |
| R0548 | Olympus Has Fallen: Olympus Has Fallen |  | tt2302755 |
| R0549 | On.the.Waterfront.1954.CRITERION.1080p.BluRay.x264.anoXmous_: On the Waterfront |  | tt0047296 |
| R0550 | Once Upon A Time In Hollywood.2019.HDRip.XviD-EVO: Once Upon a Time... in Hollywood |  | tt7131622 |
| R0551 | Once.Upon.a.Time.in.the.West.1968.720p.BluRay.x264.YIFY: Once Upon a Time in the West |  | tt0064116 |
| R0552 | One.Wild.Moment.2015.BluRay.720p.700MB.Ganool.uk: One Wild Moment |  | tt2191765 |
| R0553 | Open.Grave.2013.1080p.BluRay.x264.YIFY: Open Grave |  | tt2071550 |
| R0554 | Open.Your.Eyes.1997.720p.WEB-DL.950MB.MkvCage: Open Your Eyes |  | tt0125659 |
| R0555 | Ordinary.People.1980.720p.WEB-DL.AAC2.0.H.264-BS: Ordinary People |  | tt0081283 |
| R0556 | Outbreak.1995.1080p.BrRip.x264.YIFY: Outbreak |  | tt0114069 |
| R0557 | Papillon.1973.1080p.BluRay.x264.YIFY: Papillon |  | tt0070511 |
| R0558 | Paradise (1982) BRRip Oldies Dual-Áudio: Paradise |  | tt0084469 |
| R0559 | Paradise.1982.DVDRip.x264-HANDJOB: Paradise |  | tt0084469 |
| R0560 | Parasite.2019.1080p.HDRip.X264.AC3-EVO: Parasite |  | tt6751668 |
| R0561 | Passengers 2016 1080p BluRay x264 DTS-JYK: Passengers |  | tt1355644 |
| R0562 | Patriot.Games.1992.1080p.BRrip.x264.YIFY: Patriot Games |  | tt0105112 |
| R0563 | Pearl.Harbor.2001.1080p.BluRay.x264.anoXmous_: Pearl Harbor |  | tt0213149 |
| R0564 | Percy.Jackson.And.The.Olympians.The.Lightning.Thief.2010.1080p.BrRip.x264.YIFY+HI: Percy Jackson & the Olympians: The Lightning Thief |  | tt0814255 |
| R0565 | Percy.Jackson.Sea.of.Monsters.2013.1080p.BluRay.x264.YIFY: Percy Jackson: Sea of Monsters |  | tt1854564 |
| R0566 | Perfume.The.Story.Of.A.Murderer.2006.720p.x264.YIFY: Perfume: The Story of a Murderer |  | tt0396171 |
| R0567 | Persuasion (1995): Persuasion |  | tt0114117 |
| R0568 | Peter.Pan.1953.1080p.BluRay.x264.YIFY: Peter Pan |  | tt0046183 |
| R0569 | Peter: Peter Pan |  | tt0316396 |
| R0570 | Peter Pan 2003 720p Dublado ramonTPB: Peter Pan |  | tt0316396 |
| R0571 | Pi.1998.720p.BluRay.x264.YIFY: Pi |  | tt0138704 |
| R0572 | Pickpocket: Pickpocket |  | tt0053168 |
| R0573 | Pirates of Silicon Valley: Pirates of Silicon Valley |  | tt0168122 |
| R0574 | Pirates.of.the.Caribbean.Dead.Man's.Chest.2006.1080p.BrRip.x264.Deceit.YIFY: Pirates of the Caribbean: Dead Man's Chest |  | tt0383574 |
| R0575 | Pirates of The Caribbean - 04 - On Stranger Tides 2011.2160p.HDR.WebRip.DDP.5.1.HEVC-DDR: Pirates of the Caribbean: On Stranger Tides |  | tt1298650 |
| R0576 | Pirates.Of.The.Caribbean.Dead.Men.Tell.No.Tales.2017.1080p.BluRay.x264-[YTS.AG]: Pirates of the Caribbean: Dead Men Tell No Tales |  | tt1790809 |
| R0577 | Pitch.Perfect.2012.720p.BRrip.264.YIFY: Pitch Perfect |  | tt1981677 |
| R0578 | Pitch Perfect 3 2017.MULTi.UHD.Blu-ray.2160p.HDR.DTS-HDMA.7.1.HEVC-DDR: Pitch Perfect 3 |  | tt4765284 |
| R0579 | Pitch.Perfect.2.2015.2160p.UHD.BluRay.X265-IAMABLE: Pitch Perfect 2 |  | tt2848292 |
| R0580 | pitch.perfect.2012.2160p.uhd.bluray.x265-terminal: Pitch Perfect |  | tt1981677 |
| R0581 | Planet Terror.2007.720p.BrRip.x264.YIFY: Planet Terror |  | tt1077258 |
| R0582 | Planet.of.the.Apes.2001.1080p.BrRip.x264.YIFY: Planet of the Apes |  | tt0133152 |
| R0583 | Pleasantville.1998.720p.BR.850MB.ShAaNiG.com: Pleasantville |  | tt0120789 |
| R0584 | Pocketful.of.Miracles.1961.1080p.BluRay.x264.YIFY: Pocketful of Miracles |  | tt0055312 |
| R0585 | Ponyo 2008 720p BRRip x264-MgB: Ponyo |  | tt0876563 |
| R0586 | Poor.Things.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX: Poor Things |  | tt14230458 |
| R0587 | 8ballrips-pracmagic: Practical Magic |  | tt0120791 |
| R0588 | Predator 2: Predator 2 |  | tt0100403 |
| R0589 | Pretty.Woman.1990.720p.BluRay.x264.YIFY: Pretty Woman |  | tt0100405 |
| R0590 | Pride.And.Prejudice.2005.1080p.BluRay.x264.anoXmous_: Pride & Prejudice |  | tt0414387 |
| R0591 | Primer - Thriller Sci-Fi 2004 Eng Subs 720p [H264-mp4]: Primer |  | tt0390384 |
| R0592 | Princess.Protection.Program.2009.1080p.WEBRip.DD5.1.x264-TrollHD: Princess Protection Program |  | tt1196339 |
| R0593 | Prometheus.2012.1080p.BrRip.x264.YIFY: Prometheus |  | tt1446714 |
| R0594 | Psycho.1960.1080p.BrRip.x264.YIFY: Psycho |  | tt0054215 |
| R0595 | Pulp.Fiction.1994.1080p.BrRip.x264.YIFY: Pulp Fiction |  | tt0110912 |
| R0596 | 7s-qff-1080p: Quest for Fire |  | tt0082484 |
| R0597 | Raging.Bull.1980.1080p.BluRay.x264.YIFY: Raging Bull |  | tt0081398 |
| R0598 | Rain Man 1988 REMASTERED 1080p BluRay x264 AAC - Ozlem: Rain Man |  | tt0095953 |
| R0599 | Raising.Arizona.1987.1080p.BluRay.x264.anoXmous_: Raising Arizona |  | tt0093822 |
| R0600 | [TorrentCounter.to].Ralph.Breaks.The.Internet.2018.1080p.WEB-DL.x264.[1.7GB].[Wreck-It.Ralph.2]: Ralph Breaks the Internet |  | tt5848272 |
| R0601 | Rambo - 02 - First Blood Part II: Rambo: First Blood Part II |  | tt0089880 |
| R0602 | Rashomon 1950 720p BRRip x264 AAC-BeLLBoY (Kingdom-Release): Rashomon |  | tt0042876 |
| R0603 | Ratatouille.2007.1080p.BrRip.x264.YIFY: Ratatouille |  | tt0382932 |
| R0604 | Ready.Player.One.2018.1080p.BluRay.x264-[YTS.AM]: Ready Player One |  | tt1677720 |
| R0605 | Red.2010.720p.BrRip.x264.YIFY: RED |  | tt1245526 |
| R0606 | Red Dawn (1984): Red Dawn |  | tt0087985 |
| R0607 | Red Dawn (2012): Red Dawn |  | tt1234719 |
| R0608 | Remember.Me.2010.720p.BrRip.x264.YIFY: Remember Me |  | tt1403981 |
| R0609 | Rent (2005) BluRay 720p x264 950MB (Ganool)-XpoZ: Rent |  | tt0294870 |
| R0610 | Requiem.For.A.Dream.DIRECTORS.CUT.2000.1080p.BrRip.x264.YIFY: Requiem for a Dream |  | tt0180093 |
| R0611 | Reservoir Dogs: Reservoir Dogs |  | tt0105236 |
| R0612 | restrepo.2010.limited.docu.dvdrip.xvid-nodlabs.cd2: Restrepo |  | tt1559549 |
| R0613 | Return to Oz (1985): Return to Oz |  | tt0089908 |
| R0614 | Revolver (2005) 1080p-H264-AC 3 (DolbyDigital-5.1) & nickarad: Revolver |  | tt0365686 |
| R0615 | Revolver.2005.720p.BluRay.999MB.HQ.x265.10bit-GalaxyRG: Revolver |  | tt0365686 |
| R0616 | Rise.of.the.Planet.of.the.Apes.2011.2160p.UHD.BluRay.x265-DEPTH: Rise of the Planet of the Apes |  | tt1318514 |
| R0617 | Road.to.Predition.2002.1080p.BrRip.x264.YIFY: Road to Perdition |  | tt0257044 |
| R0618 | Robin.Hood.1973.480p.x264.YIFY: Robin Hood |  | tt0070608 |
| R0619 | RbnHud.2010.BRRip.Unrated.DC_mediafiremoviez.com: Robin Hood |  | tt0955308 |
| R0620 | Robin.Hood.Prince.of.Thieves.1991.1080p.BluRay.x264.anoXmous_: Robin Hood: Prince of Thieves |  | tt0102798 |
| R0621 | RoboCop.1987.720p.BrRip.x264.YIFY: RoboCop |  | tt0093870 |
| R0622 | RoboCop.1987.DC.2160p.BluRay.HDR.DDP5.1.x265-GalaxyUHD: RoboCop |  | tt0093870 |
| R0623 | RocknRolla [2008] 720p BRRip H264 AAC - CODY: RocknRolla |  | tt1032755 |
| R0624 | RocknRolla.2008.BluRay.1080p.x264.AAC.5.1.-.Hon3y: RocknRolla |  | tt1032755 |
| R0625 | Roller.Town.2012.720p.WEB-DL.H264-WEBiOS: Roller Town |  | tt1732730 |
| R0626 | Roman.Holiday.1953.1080p.BluRay.x264.AAC-[YTS.MX]: Roman Holiday |  | tt0046250 |
| R0627 | Romeo.And.Juliet.[1996].DVDRip.XviD-BLiTZKRiEG: Romeo + Juliet |  | tt0117509 |
| R0628 | Romeo.and.Juliet.1968.720p.BrRip.EN-SUB.x264-[MULVAcoded]: Romeo and Juliet |  | tt0063518 |
| R0629 | Rosencrantz.and.Guildenstern.Are.Undead.2009.Limited.720p.BRRip.H264.Feel-Free: Rosencrantz and Guildenstern Are Undead |  | tt1122775 |
| R0630 | Rounders.1998.1080p.BluRay.H264.AAC-RARBG: Rounders |  | tt0128442 |
| R0631 | Run.Lola.Run.1998.720p.x264.YIFY: Run Lola Run |  | tt0130827 |
| R0632 | Rushmore.1998.1080p.BluRay.x264.YIFY: Rushmore |  | tt0128445 |
| R0633 | Russian.Ark.2002.720p.BluRay.x264.anoXmous_: Russian Ark |  | tt0318034 |
| R0634 | SLC Punk - Comedy 1998 Eng Subs [H264-mp4]: SLC Punk! |  | tt0133189 |
| R0635 | San.Andreas.2015.720p.BluRay.x264.YIFY: San Andreas |  | tt2126355 |
| R0636 | San.Andreas.2015.2160p.UHD.BluRay.x265-TERMiNAL: San Andreas |  | tt2126355 |
| R0637 | Saving Private Ryan: Saving Private Ryan |  | tt0120815 |
| R0638 | Saw: Saw |  | tt0387564 |
| R0639 | Saw II: Saw II |  | tt0432348 |
| R0640 | Scary.Movie.2000.BrRip.720p.x264.YIFY: Scary Movie |  | tt0175142 |
| R0641 | Scary.Movie.2.BrRip.720p.x264.YIFY: Scary Movie 2 |  | tt0257106 |
| R0642 | Scary.Movie.3.BrRip.720p.x264.YIFY: Scary Movie 3 |  | tt0306047 |
| R0643 | Scary.Movie.4.UNRATED.DVDRip.x264.YIFY: Scary Movie 4 |  | tt0362120 |
| R0644 | Schindlers List 1993 (1080p x265 10bit Joy): Schindler's List |  | tt0108052 |
| R0645 | Scoop[2006]DvDrip[Eng]-aXXo: Scoop |  | tt0457513 |
| R0646 | Scott.Pilgrim.vs.the.World.2010.Bluray.720p.x264.YIFY: Scott Pilgrim vs. the World |  | tt0446029 |
| R0647 | Scream 1996.720p.BrRip.x264.YIFY: Scream |  | tt0117571 |
| R0648 | Secretary.2002.1080p.BluRay.x264.AAC-ETRG: Secretary |  | tt0274812 |
| R0649 | Secretary.2002.720p.BluRay.x264.AAC-ETRG: Secretary |  | tt0274812 |
| R0650 | Sense.and.Sensibility.1995.720p.HDTV.x264.anoXmous: Sense and Sensibility |  | tt0114388 |
| R0651 | Serenity.2005.1080p.BrRip.x264.YIFY.bitloks: Serenity |  | tt0379786 |
| R0652 | Akira Kurosawa - Seven.Samurai.1954.MULTi.CRITERION.BluRay.1080p.LPCM.1.0.HEVC-DDR[EtHD]: Seven Samurai |  | tt0047478 |
| R0653 | Shang-Chi.And.The.Legend.Of.The.Ten.Rings.2021.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Shang-Chi and the Legend of the Ten Rings |  | tt9376612 |
| R0654 | Sherlock.Holms.2009.1080p.BrRip.x264.YIFY: Sherlock Holmes |  | tt0988045 |
| R0655 | Shooter.2007.1080p.BluRay.x264.YIFY: Shooter |  | tt0822854 |
| R0656 | Short.Circuit.1986.1080p.BrRip.x264.YIFY: Short Circuit |  | tt0091949 |
| R0657 | SHORTBUS: Shortbus |  | tt0367027 |
| R0658 | Showgirls.1995.720p.BluRay.x264.YIFY: Showgirls |  | tt0114436 |
| R0659 | Shrek.2001.720p.BluRay.x264.YIFY: Shrek |  | tt0126029 |
| R0660 | Sicario.2015.720p.BRRip.x264-ETRG: Sicario |  | tt3397884 |
| R0661 | Sicario.Day.Of.The.Soldado.2018.720p.WEBRip.x264-[YTS.AM]: Sicario: Day of the Soldado |  | tt5052474 |
| R0662 | Sideways.2004.1080p.BrRip.x264.YIFY: Sideways |  | tt0375063 |
| R0663 | The.Silence.of.the.Lambs.1991.1080p.Bluray.x264.AC3-ETRG: The Silence of the Lambs |  | tt0102926 |
| R0664 | Sin.City.A.Dame.to.Kill.For.2014.1080p.BluRay.x264.YIFY: Sin City: A Dame to Kill For |  | tt0458481 |
| R0665 | Sister.Act.1992.720p.BluRay.x264.YIFY: Sister Act |  | tt0105417 |
| R0666 | Sister.Act.2:.Back.in.the.Habit.1993.720p.BluRay.x264.YIFY: Sister Act 2: Back in the Habit |  | tt0108147 |
| R0667 | Sleepers.1996.720p.BrRip.x264.YIFY: Sleepers |  | tt0117665 |
| R0668 | Sleeping.Beauty.1959.720p.BRrip.x264.GAZ.YIFY: Sleeping Beauty |  | tt0053285 |
| R0669 | Sleeping.Beauty.2011.720p.BRRip.x264-x0r: Sleeping Beauty |  | tt1588398 |
| R0670 | Sleepy.Hollow.1999.720p.BrRip.x264.YIFY: Sleepy Hollow |  | tt0162661 |
| R0671 | Slumdog.Millionaire.2008.1080p.BluRay.x264.YIFY: Slumdog Millionaire |  | tt1010048 |
| R0672 | Smiles.of.a.Summer.Night.{Sommarnattens.Leende}.[Ingmar.Bergman].(1955): Smiles of a Summer Night |  | tt0048641 |
| R0673 | Snatch.2000.1080p.BluRay.x264.anoXmous_: Snatch |  | tt0208092 |
| R0674 | Snow.White.And.The.Seven.Dwarfs.1937.1080p.BluRay.x264.anoXmous_: Snow White and the Seven Dwarfs |  | tt0029583 |
| R0675 | Snowden.2016.1080p.BluRay.x264-[YTS.AG]: Snowden |  | tt3774114 |
| R0676 | Solaris.1972.720p.BrRip.EN-SUB.x264-[MULVAcoded]: Solaris |  | tt0069293 |
| R0677 | Solo.A.Star.Wars.Story.2018.720p.BluRay.x264-[YTS.AM]: Solo: A Star Wars Story |  | tt3778644 |
| R0678 | Some.Like.It.Hot.1959.BluRay.720p.H264: Some Like It Hot |  | tt0053291 |
| R0679 | Song.of.the.Sea.2014.1080p.BluRay.x264.YIFY: Song of the Sea |  | tt1865505 |
| R0680 | Sorry.to.Bother.You.2018.1080p.WEB-DL.DD5.1.H264-CMRG[EtHD]: Sorry to Bother You |  | tt5688932 |
| R0681 | The.Sound.of.Music.1965.1080p.BRrip.x264.YIFY: The Sound of Music |  | tt0059742 |
| R0682 | Soylent.Green.1973.1080p.BluRay.x265-RARBG: Soylent Green |  | tt0070723 |
| R0683 | SpaceCamp 1986 DVDRip: SpaceCamp |  | tt0091993 |
| R0684 | Spartan.2004.DVDRip.XviD-BRUTUS: Spartan |  | tt0360009 |
| R0685 | Speed.1994.720p.BrRip.x264.BOKUTOX.YIFY: Speed |  | tt0111257 |
| R0686 | Speed.2.Cruise.Control.1997.1080p.BluRay.x264.YIFY: Speed 2: Cruise Control |  | tt0120179 |
| R0687 | Spider.Man.2002.1080p.BluRay.x264.YIFY: Spider-Man |  | tt0145487 |
| R0688 | Spider.Man.2.2004.1080p.BluRay.x264.YIFY: Spider-Man 2 |  | tt0316654 |
| R0689 | Spider.Man.3.2007.1080p.BluRay.x264.YIFY: Spider-Man 3 |  | tt0413300 |
| R0690 | Spider-Man.No.Way.Home.2021.1080p.BluRay.x264.AAC5.1-[YTS.MX]: Spider-Man: No Way Home |  | tt10872600 |
| R0691 | Spider-Man.Homecoming.2017.2160p.UHD.BluRay.x265-TERMiNAL: Spider-Man: Homecoming |  | tt2250912 |
| R0692 | Spring.Breakers.2012.1080p.BluRay.x264.YIFY: Spring Breakers |  | tt2101441 |
| R0693 | Spy.2015.720p.BluRay.x264.YIFY: Spy |  | tt3079380 |
| R0694 | Star.Trek.First.Contact.1996.720p.BRrip.x264.YIFY: Star Trek: First Contact |  | tt0117731 |
| R0695 | Star.Trek.III.The.Search.For.Spock.1984.720p.BRrip.x264.YIFY: Star Trek III: The Search for Spock |  | tt0088170 |
| R0696 | Star Trek IV The Voyage Home (1080p x265 Joy): Star Trek IV: The Voyage Home |  | tt0092007 |
| R0697 | Star.Trek.Insurrection.1998.720p.BRrip.x264.YIFY: Star Trek: Insurrection |  | tt0120844 |
| R0698 | Star.Trek.Nemesis.2002.720p.BRrip.x264.YIFY: Star Trek: Nemesis |  | tt0253754 |
| R0699 | Star.Trek.The.Motion.Picture.1979.720p.BRrip.x264.YIFY: Star Trek: The Motion Picture |  | tt0079945 |
| R0700 | Star.Trek.V.The.Final.Frontier.1989.720p.BRrip.x264.YIFY: Star Trek V: The Final Frontier |  | tt0098382 |
| R0701 | Star.Trek.VI.The.Undiscovered.Country.1991.720p.BRrip.x264.YIFY: Star Trek VI: The Undiscovered Country |  | tt0102975 |
| R0702 | Star.Wars.Episode.1.The.Phantom.Menace.1999.1080p.BrRip.x264.BOKUTOX.YIFY: Star Wars: Episode I - The Phantom Menace |  | tt0120915 |
| R0703 | Star.Wars.Episode.3.Revenge.of.the.Sith.2005.1080p.BrRip.x264.BOKUTOX.YIFY: Star Wars: Episode III - Revenge of the Sith |  | tt0121766 |
| R0704 | Star.Wars.Episode.4.A.New.Hope.1977.1080p.BrRip.x264.BOKUTOX.YIFY: Star Wars: Episode IV - A New Hope |  | tt0076759 |
| R0705 | Star Wars Episode IX The Rise of Skywalker 2019 1080p BluRay 10bit HEVC Hindi English x265 AC3 MSubs - LOKiHD - Telly: Star Wars: Episode IX - The Rise of Skywalker |  | tt2527338 |
| R0706 | Star.Wars.Episode.5.The.Empire.Strikes.Back.1980.1080p.BrRip.x264.BOKUTOX.YIFY: Star Wars: Episode V - The Empire Strikes Back |  | tt0080684 |
| R0707 | Star.Wars.Episode.6.Return.of.the.Jedi.1983.1080p.BrRip.x264.BOKUTOX.YIFY: Star Wars: Episode VI - Return of the Jedi |  | tt0086190 |
| R0708 | Star.Trek.Generations.1994.1080p.BluRay.x264.AAC-ETRG: Star Trek: Generations |  | tt0111280 |
| R0709 | Star.Trek.II.The.Wrath.of.Khan.1982.1080p.BRRip.x264.AAC-ETRG: Star Trek II: The Wrath of Khan |  | tt0084726 |
| R0710 | star.wars.episode.II.attack.of.the.clones.2002.720p.bluray.x264-nezu: Star Wars: Episode II - Attack of the Clones |  | tt0121765 |
| R0711 | Star.Wars.Episode.VII.The.Force.Awakens.2015.1080p.BluRay.x264.DTS-JYK: Star Wars: Episode VII - The Force Awakens |  | tt2488496 |
| R0712 | Starship.Troopers.1997.1080p.BluRay.x264.YIFY: Starship Troopers |  | tt0120201 |
| R0713 | Strange.Days.1995.1080p.BluRay.x264-HANGOVER: Strange Days |  | tt0114558 |
| R0714 | Stranger.Than.Fiction.2006.1080p.BrRip.x264.BOKUTOX.YIFY: Stranger Than Fiction |  | tt0420223 |
| R0715 | Striptease.1996.1080p.BluRay.x264-[YTS.AG]: Striptease |  | tt0117765 |
| R0716 | Striptease.1996.BRRip.XviD.MP3-XVID: Striptease |  | tt0117765 |
| R0717 | Sucker.Punch.2011.720p.BluRay.x264.YIFY: Sucker Punch |  | tt0978764 |
| R0718 | Sunset Boulevard - Film Noir 1950 Eng Subs 1080p [H264-mp4]: Sunset Boulevard |  | tt0043014 |
| R0719 | Sunshine.2007.1080p.BrRip.x264.BOKUTOX.YIFY: Sunshine |  | tt0448134 |
| R0720 | Sunshine.2007.1080p.PROPER.BluRay.x264-MOOVEE: Sunshine |  | tt0448134 |
| R0721 | Super.Troopers.2001.1080p.BrRip.x264.YIFY: Super Troopers |  | tt0247745 |
| R0722 | Super.Troopers.2.2018.HDRip.AC3.X264-CMRG[EtMovies]: Super Troopers 2 |  | tt0859635 |
| R0723 | Superbad.2007.Unrated.BrRip.720p.264.YIFY: Superbad |  | tt0829482 |
| R0724 | Superman.1978.720.BrRip.264.YIFY: Superman |  | tt0078346 |
| R0725 | Sweet Home Alabama (2002) 720p BRrip_sujaidr: Sweet Home Alabama |  | tt0256415 |
| R0726 | Swimming.Pool.2003.720p.BluRay.X264-AMIABLE: Swimming Pool |  | tt0324133 |
| R0727 | Swiss.Family.Robinson.1960.1080p.BluRay.x264.YIFY: Swiss Family Robinson |  | tt0054357 |
| R0728 | Sword Art Online-The Movie Ordinal Scale (2017) BluRay 720p x264 800MB (nItRo)-XpoZ: Sword Art Online the Movie: Ordinal Scale |  | tt5544384 |
| R0729 | Syriana.2005.720p.BrRip.x264.YIFY: Syriana |  | tt0365737 |
| R0730 | THX 1138 (1971) DC 720p BRrip.x264 SUJAIDR: THX 1138 |  | tt0066434 |
| R0731 | Taken.2008.1080pBrRip.x264.YIFY: Taken |  | tt0936501 |
| R0732 | Taken.2.2012.UNRATED.EXTENDED.1080p.BluRay.x264.YIFY: Taken 2 |  | tt1397280 |
| R0733 | Taking.Woodstock.2009.BRRip.XviD.MP3-XVID: Taking Woodstock |  | tt1127896 |
| R0734 | Tales.of.Terror.1962.720p.BluRay.x264.YIFY: Tales of Terror |  | tt0056552 |
| R0735 | Ted.2012.BluRay.1080p.x264.YIFY: Ted |  | tt1637725 |
| R0736 | Teenage.Mutant.Ninja.Turtles.1990.1080p.BluRay.H264.AAC-RARBG: Teenage Mutant Ninja Turtles |  | tt0100758 |
| R0737 | Terminator.2.Judgment.Day.1991.DC.1080p.BRrip.x264.GAZ.YIFY: Terminator 2: Judgment Day |  | tt0103064 |
| R0738 | Terminator.3.Rise.of.The.Machines.2003.1080p.BRrip.x264.GAZ.YIFY: Terminator 3: Rise of the Machines |  | tt0181852 |
| R0739 | Terminator.Genisys.2015.720p.BluRay.x264.YIFY: Terminator Genisys |  | tt1340138 |
| R0740 | Terminator.Salvation.DIRECTORS.CUT.2009.1080p.BrRip.x264.YIFY: Terminator Salvation |  | tt0438488 |
| R0741 | Terminator.Dark.Fate.2019.1080p.BluRay.1600MB.DD5.1.x264-GalaxyRG: Terminator: Dark Fate |  | tt6450804 |
| R0742 | That.Thing.You.Do!1996.DC.720p.BluRay.x264-x0r: That Thing You Do! |  | tt0117887 |
| R0743 | The Absent Minded Professor (1961) Xvid: The Absent Minded Professor |  | tt0054594 |
| R0744 | The.Addams.Family.1991.720p.BluRay.x264.YIFY: The Addams Family |  | tt0101272 |
| R0745 | The Adventures of Robin Hood - (1938) - Errol Flynn: The Adventures of Robin Hood |  | tt0029843 |
| R0746 | The.Amazing.Spider.Man.2.2014.720p.BluRay.x264.YIFY: The Amazing Spider-Man 2 |  | tt1872181 |
| R0747 | The American President: The American President |  | tt0112346 |
| R0748 | The.Andromeda.Strain.1971.1080p.BluRay.x264.YIFY: The Andromeda Strain |  | tt0066769 |
| R0749 | The.Apartment.1960.720p.BRRip.x264-x0r: The Apartment |  | tt0053604 |
| R0750 | The Avengers: The Avengers |  | tt0848228 |
| R0751 | The.Babadook.2014.1080p.BluRay.x264.YIFY: The Babadook |  | tt2321549 |
| R0752 | The.Bank.Job.2008.1080p.BluRay.x264.YIFY: The Bank Job |  | tt0200465 |
| R0753 | The Battle of Algiers (1966) 720p BRrip_sujaidr: The Battle of Algiers |  | tt0058946 |
| R0754 | The.Beach.2000.720p.BrRip.x264.YIFY: The Beach |  | tt0163978 |
| R0755 | The.Big.Lebowski.1998.720p.BrRip.x264.YIFY: The Big Lebowski |  | tt0118715 |
| R0756 | The.Big.Short.2015.720p.BRRip.x264.AAC-ETRG: The Big Short |  | tt1596363 |
| R0757 | The Big Short 2015 1080p BluRay x264 DTS-JYK: The Big Short |  | tt1596363 |
| R0758 | The Big Sleep (1946) 720p BluRay x265 HEVC SUJAIDR: The Big Sleep |  | tt0038355 |
| R0759 | The.Black.Stallion.1979.1080p.BluRay.x264.YIFY: The Black Stallion |  | tt0078872 |
| R0760 | The.Bling.Ring.2013.720p.BluRay.x264.YIFY: The Bling Ring |  | tt2132285 |
| R0761 | The.Boondock.Saints.II.All.Saints.Day.2009.BluRay.1080p.YIFY: The Boondock Saints II: All Saints Day |  | tt1300851 |
| R0762 | The.Bourne.Identity.2002.1080p.BrRip.x264.YIFY: The Bourne Identity |  | tt0258463 |
| R0763 | The.Bourne.Legacy.2012.1080p.BluRay.x264: The Bourne Legacy |  | tt1194173 |
| R0764 | Jason Bourne (2016) 2160p H.264 (moviesbyrizzo): Jason Bourne |  | tt4196776 |
| R0765 | The Bourne Identity (2002) 2160p H.264 (moviesbyrizzo): The Bourne Identity |  | tt0258463 |
| R0766 | The Bourne Legacy (2012) 2160p H.264 (moviesbyrizzo): The Bourne Legacy |  | tt1194173 |
| R0767 | The Bourne Supremacy (2004) 2160p H.264 (moviesbyrizzo): The Bourne Supremacy |  | tt0372183 |
| R0768 | The Bourne Ultimatum (2007) 2160p H.264 (moviesbyrizzo): The Bourne Ultimatum |  | tt0440963 |
| R0769 | The.Bourne.Supremacy.2004.1080p.BrRip.x264.YIFY: The Bourne Supremacy |  | tt0372183 |
| R0770 | The.Bourne.Ultimatum.2007.1080p.BrRip.x264.YIFY: The Bourne Ultimatum |  | tt0440963 |
| R0771 | The Brave Little Toaster (1987): The Brave Little Toaster |  | tt0092695 |
| R0772 | The.Breakfast.Club.1985.1080p.BluRay.x264.YIFY: The Breakfast Club |  | tt0088847 |
| R0773 | The.Butterfly.Effect.2004.720p.BluRay.x264-SiNNERS.mkv-muxed_old: The Butterfly Effect |  | tt0289879 |
| R0774 | The.Cabin.In.The.Woods.1080p.BluRay.x264.YIFY: The Cabin in the Woods |  | tt1259521 |
| R0775 | The.Chronicles.of.Narnia.The.Lion.The Witch.And.The.Wardrobe.2005.720p.Brrip.x264.Deceit.YIFY: The Chronicles of Narnia: The Lion, the Witch and the Wardrobe |  | tt0363771 |
| R0776 | The Color Purple 1985 720p BluRay HEVC H265 BONE: The Color Purple |  | tt0088939 |
| R0777 | The.Constant.Gardener.2005.BRRip.720P.x264.YIFY: The Constant Gardener |  | tt0387131 |
| R0778 | The Conversation: The Conversation |  | tt0071360 |
| R0779 | The.Count.Of.Monte.Cristo.2002.1080p.BRrip.x264.YIFY: The Count of Monte Cristo |  | tt0245844 |
| R0780 | The.Craft.1996.720p.BrRip.x264.YIFY: The Craft |  | tt0115963 |
| R0781 | The Darjeeling Limited 2007.1080p.BluRay.x264 . NVEE: The Darjeeling Limited |  | tt0838221 |
| R0782 | The.Dark.Crystal.BluRay.1080p.x264.5.1.Judas: The Dark Crystal |  | tt0083791 |
| R0783 | The Dark Knight: The Dark Knight |  | tt0468569 |
| R0784 | The Day After Tomorrow (2004) 1080p: The Day After Tomorrow |  | tt0319262 |
| R0785 | The.Deer.Hunter.1978.BRRip: The Deer Hunter |  | tt0077416 |
| R0786 | The.Departed.2006.BluRay.1080p.x264.YIFY: The Departed |  | tt0407887 |
| R0787 | The.Devil.Wears.Prada.2006.720p.BrRip.x264.YIFY: The Devil Wears Prada |  | tt0458352 |
| R0788 | The Doors: The Doors |  | tt0101761 |
| R0789 | The.Emerald.Forest.1985.720p.BluRay.x264.YIFY: The Emerald Forest |  | tt0089087 |
| R0790 | The.Equalizer.2014.1080p.BluRay.x264.YIFY: The Equalizer |  | tt0455944 |
| R0791 | The.Evil.Dead.1981.1080p.BRrip.x264.GAZ.YIFY: The Evil Dead |  | tt0083907 |
| R0792 | The.Exorcist.1973.1080p.BrRip.x264.bitloks.YIFY: The Exorcist |  | tt0070047 |
| R0793 | The.Expendables.2010.1080p.BrRip.x264.YIFY: The Expendables |  | tt1320253 |
| R0794 | The.Family.Man.2000.720p.BrRip.x264.BOKUTOX.YIFY: The Family Man |  | tt0218967 |
| R0795 | The.Fifth.Element.Remastered.1997.1080p.BrRip.x264.YIFY: The Fifth Element |  | tt0119116 |
| R0796 | The.Final.Countdown.1980.BluRay.720p.H264: The Final Countdown |  | tt0080736 |
| R0797 | The.Final.Destination.2009.720p.BrRip.x264.YIFY: The Final Destination |  | tt1144884 |
| R0798 | The.Girl.Next.Door.UNRATED.2004.1080p.BrRip.x264.BOKUTOX.YIFY: The Girl Next Door |  | tt0265208 |
| R0799 | The Girl on the Bridge (1999) DVDRip XviD: Girl on the Bridge |  | tt0144201 |
| R0800 | The.Godfather.1972.1080p.BrRip.x264.BOKUTOX.YIFY: The Godfather |  | tt0068646 |
| R0801 | The.Gods.Must.Be.Crazy.[1980].DVDRip.XviD-BLiTZKRiEG: The Gods Must Be Crazy |  | tt0080801 |
| R0802 | The.Good.the.Bad.and.the.Ugly.1966.1080p.BrRip.x264.YIFY: The Good, the Bad and the Ugly |  | tt0060196 |
| R0803 | The.Graduate.1967.REMASTERED.720p.BluRay.900MB.ShAaNiG: The Graduate |  | tt0061722 |
| R0804 | The.Great.Escape.1963.HDTVRip.x264.YIFY: The Great Escape |  | tt0057115 |
| R0805 | The.Green.Mile.1999.1080p.BrRip.x264.YIFY: The Green Mile |  | tt0120689 |
| R0806 | The.Hobbit.An.Unexpected.Journey.2012.EXTENDED.1080p.BluRay.10bit.HEVC.6CH.MkvCage.ws: The Hobbit: An Unexpected Journey |  | tt0903624 |
| R0807 | The Hobbit (1977)   [DarkDream]: The Hobbit |  | tt0077687 |
| R0808 | The.Hobbit.The.Desolation.of.Smaug.2013.1080p.BluRay.x264.YIFY: The Hobbit: The Desolation of Smaug |  | tt1170358 |
| R0809 | The.Hobbit.1977.720p.WEB-DL.x264.AAC-ETRG: The Hobbit |  | tt0077687 |
| R0810 | The.Hunger.Games.1080p.BluRay.x264.YIFY: The Hunger Games |  | tt1392170 |
| R0811 | The.Hunger.Games.Catching.Fire.2013.1080p.BluRay.x264.YIFY: The Hunger Games: Catching Fire |  | tt1951264 |
| R0812 | The.Hunger.Games.Mockingjay...Part.1.2014.1080p.BluRay.x264.YIFY: The Hunger Games: Mockingjay - Part 1 |  | tt1951265 |
| R0813 | The Hunt for Red October: The Hunt for Red October |  | tt0099810 |
| R0814 | The.Hurt.Locker.2008.720pBrRip.x.264.YIFY: The Hurt Locker |  | tt0887912 |
| R0815 | The.Ides.of.March.2011.BluRay.720p.x264.YIFY: The Ides of March |  | tt1124035 |
| R0816 | The Incredible Hulk (2008): The Incredible Hulk |  | tt0800080 |
| R0817 | The.Incredible.Hulk.2008.1080p.BluRay.x264.YIFY: The Incredible Hulk |  | tt0800080 |
| R0818 | The Intouchables 2011 1080p BluRay x264 French AAC - Ozlem: The Intouchables |  | tt1675434 |
| R0819 | The.Invention.of.Lying.2009.1080p.BrRip.x264.YIFY: The Invention of Lying |  | tt1058017 |
| R0820 | The.Island.2005.1080p.BrRip.x264.YIFY: The Island |  | tt0399201 |
| R0821 | The Italian Job 1969 BRrip 720p H264 Bezauk: The Italian Job |  | tt0064505 |
| R0822 | The.Italian.Job.2003.1080p.BrRip.x264.YIFY: The Italian Job |  | tt0317740 |
| R0823 | The Jungle Book 2016 1080p BluRay x264 DTS-JYK: The Jungle Book |  | tt3040964 |
| R0824 | The.Land.Before.Time.1988.1080p.BluRay.x264.YIFY: The Land Before Time |  | tt0095489 |
| R0825 | The.Last.Song.2010.BrRip.720p.x264.YIFY: The Last Song |  | tt1294226 |
| R0826 | The.Last.Starfighter.1984.1080p.BluRay.x264.YIFY: The Last Starfighter |  | tt0087597 |
| R0827 | The.Last.Temptation.Of.Christ.1988.720p.BluRay.x264-[YTS.LT]: The Last Temptation of Christ |  | tt0095497 |
| R0828 | The Last of the Mohicans: The Last of the Mohicans |  | tt0104691 |
| R0829 | The.Lego.Movie.2014.720p.BluRay.x264.YIFY: The Lego Movie |  | tt1490017 |
| R0830 | The.Lego.Movie.2.The.Second.Part.2019.720p.WEBRip.x264-[YTS.AM]: The Lego Movie 2: The Second Part |  | tt3513498 |
| R0831 | The.Life.Aquatic.with.Steve.Zissou.2004.1080p.BluRay.x264.YIFY: The Life Aquatic with Steve Zissou |  | tt0362270 |
| R0832 | The.Lion.King.2019.1080p.BluRay.x264-[YTS.LT]: The Lion King |  | tt6105098 |
| R0833 | The.Little.Mermaid.1989.720p.BRrip.x264.GAZ.YIFY: The Little Mermaid |  | tt0097757 |
| R0834 | The.Lord.of.the.Rings.the.Fellowship.of.the.Ring.EXTENDED.2001.720p.BrRip.x264.BOKUTOX.YIFY: The Lord of the Rings: The Fellowship of the Ring |  | tt0120737 |
| R0835 | The.Lord.of.the.Rings.The.Return.of.the.King.EXTENDED.2003.1080p.BrRip.x264.YIFY: The Lord of the Rings: The Return of the King |  | tt0167260 |
| R0836 | The.Lord.of.the.Rings.The.Two.Towers.2002.ExD.1080p.BrRip.x264.YIFY: The Lord of the Rings: The Two Towers |  | tt0167261 |
| R0837 | The.Magnificent.Seven.1960.720p.BluRay.x264.YIFY: The Magnificent Seven |  | tt0054047 |
| R0838 | The Magnificent Seven 2016 1080p BluRay x264 DTS-JYK: The Magnificent Seven |  | tt2404435 |
| R0839 | The.Man.From.Earth.2007.1080p.x264.YIFY: The Man from Earth |  | tt0756683 |
| R0840 | The.Man.from.Earth.Holocene.2017.720p.BluRay.x264-UNiVEARTH: The Man from Earth: Holocene |  | tt5770864 |
| R0841 | The.Martian.2015.EXTENDED.1080p.BRRip.x264.AAC-ETRG: The Martian |  | tt3659388 |
| R0842 | The.Matrix.1999.1080p.BrRip.x264.YIFY: The Matrix |  | tt0133093 |
| R0843 | The.Matrix.Reloaded.2003.1080p.BrRip.x264.YIFY: The Matrix Reloaded |  | tt0234215 |
| R0844 | The.Matrix.Revolutions.2003.1080p.BrRip.x264.YIFY: The Matrix Revolutions |  | tt0242653 |
| R0845 | The.Neverending.Story.II.The.Next.Chapter.1990.1080p.BluRay.x264.YIFY: The NeverEnding Story II: The Next Chapter |  | tt0100240 |
| R0846 | The.Notebook.2004.1080p.BluRay.x264.YIFY: The Notebook |  | tt0332280 |
| R0847 | The Perfect Storm 2000.720p.BrRip.x264.YIFY: The Perfect Storm |  | tt0177971 |
| R0848 | The Philadelphia Story 1940 1080p BRRip x264 AAC ESub-Hon3y: The Philadelphia Story |  | tt0032904 |
| R0849 | The Poseidon Adventure [1972] BRRip XviD - CODY: The Poseidon Adventure |  | tt0069113 |
| R0850 | The Princess Bride .1987.720p.BRRip.x264.YIFY: The Princess Bride |  | tt0093779 |
| R0851 | The.Producers.1967.1080p.BluRay.x264-[YTS.AM]: The Producers |  | tt0063462 |
| R0852 | The Return of the King (1980) DVDRip Xvid-Anarchy: The Return of the King |  | tt0079802 |
| R0853 | The Revenant 2015 1080p WEB-DL x264 AC3-JYK: The Revenant |  | tt1663202 |
| R0854 | The.Right.Stuff.1983.720p.BluRay.x264-[YTS.AG]: The Right Stuff |  | tt0086197 |
| R0855 | The.Ring.2002.720p.BluRay.800MB.ShAaNiG.com: The Ring |  | tt0298130 |
| R0856 | The Ring (2002) 1080p BluRay x264 aac [TuGAZx]: The Ring |  | tt0298130 |
| R0857 | The.Rock.1996.720p.BrRip.x264.YIFY: The Rock |  | tt0117500 |
| R0858 | The.Rocky.Horror.Picture.Show.1975.1080p.BluRay.x264.VPPV: The Rocky Horror Picture Show |  | tt0073629 |
| R0859 | The.Room.2003.720p.BluRay.x264.YIFY: The Room |  | tt0368226 |
| R0860 | The.Room.2003.1080p.BluRay.x264.YIFY: The Room |  | tt0368226 |
| R0861 | The.Royal.Tenenbaums.2001.1080p.BluRay.x264.YIFY: The Royal Tenenbaums |  | tt0265666 |
| R0862 | The.Sandlot.1993.BluRay.1080p.x264.YIFY: The Sandlot |  | tt0108037 |
| R0863 | The.Seventh.Seal.1957.Criterion.1080p.BluRay.x264.anoXmous: The Seventh Seal |  | tt0050976 |
| R0864 | The.Shawshank.Redemption.1994.1080p.x264.YIFY: The Shawshank Redemption |  | tt0111161 |
| R0865 | 1. Six Men Getting Sick (1968): Six Men Getting Sick |  | tt0060984 |
| R0866 | 2. The Alphabet (1968): The Alphabet |  | tt0062653 |
| R0867 | 3. The Grandmother (1970): The Grandmother |  | tt0065794 |
| R0868 | 4. The Amputee (1974): The Amputee |  | tt0193716 |
| R0869 | The.Sound.of.Music.1965.720p.BRrip.x264.YIFY: The Sound of Music |  | tt0059742 |
| R0870 | The Stepford Wives (2004) DVDRip Xvid LKRG: The Stepford Wives |  | tt0327162 |
| R0871 | The.Sting.1973.1080p.BluRay.x264.anoXmous_: The Sting |  | tt0070735 |
| R0872 | The Sum Of All Fears (2002)1080p.BluRay: The Sum of All Fears |  | tt0164184 |
| R0873 | The.Sum.of.All.Fears.2002.720p.BrRip.x264YIFY: The Sum of All Fears |  | tt0164184 |
| R0874 | The.Terminator.1984.1080p.BRrip.x264.GAZ.YIFY: The Terminator |  | tt0088247 |
| R0875 | The.Thing.1982.BluRay.720p.x264.YIFY: The Thing |  | tt0084787 |
| R0876 | The Thomas Crown Affair (1968) 720p.BRrip.Sujaidr: The Thomas Crown Affair |  | tt0063688 |
| R0877 | The Treasure of the Sierra Madre 1948 1080p BluRay x264 AAC - Ozlem: The Treasure of the Sierra Madre |  | tt0040897 |
| R0878 | The.Tree.of.Life.2011.720p.BrRip.x264.YIFY: The Tree of Life |  | tt0478304 |
| R0879 | The.Truman.Show.1998.1080p.BluRay.x264.YIFY: The Truman Show |  | tt0120382 |
| R0880 | The.Twilight.Saga.Breaking.Dawn.Part.1.2011.1080p.BRrip.x264.GAZ.YIFY: The Twilight Saga: Breaking Dawn - Part 1 |  | tt1324999 |
| R0881 | The.Twilight.Saga.Breaking.Dawn.Part.2.2012.1080p.BRrip.x264.GAZ.YIFY: The Twilight Saga: Breaking Dawn - Part 2 |  | tt1673434 |
| R0882 | The.Usual.Suspects.1995.m720p: The Usual Suspects |  | tt0114814 |
| R0883 | The.Vindicator.1986.TVRip.XviD.WhaleD: The Vindicator |  | tt0092172 |
| R0884 | The Wave 2015 NORWEGIAN 1080p BluRay x264 DTS-JYK: The Wave |  | tt3616916 |
| R0885 | The.Wizard.of.Oz.1939.1080p.BrRip.x264.BOKUTOX.YIFY: The Wizard of Oz |  | tt0032138 |
| R0886 | 400MB the wrestler - BRRIP: The Wrestler |  | tt1125849 |
| R0887 | The.African.Queen.1951.1080p.Bluray.x264.anoXmous: The African Queen |  | tt0043265 |
| R0888 | The.Amazing.Spider-Man.2012.1080p.BluRay.H264.AAC-RARBG: The Amazing Spider-Man |  | tt0948470 |
| R0889 | The.Cabinet.of.Dr.Caligari.1920.1080p.BRRip.x264-Classics: The Cabinet of Dr. Caligari |  | tt0010323 |
| R0890 | The.Candidate.1972.1080p.WEBRip.DD2.0.x264-NTb: The Candidate |  | tt0068334 |
| R0891 | The.Cell.2000.1080p.BluRay.H264.AAC-RARBG: The Cell |  | tt0209958 |
| R0892 | The.Chronicles.of.Narnia.The.Lion.the.Witch.and.the.Wardrobe.2005.1080p.BluRay.DDP.5.1.H.265-EDGE2020: The Chronicles of Narnia: The Lion, the Witch and the Wardrobe |  | tt0363771 |
| R0893 | The.Color.of.Money.1986.25th.Anniversary.1080p.BluRay.x264.anoXmous_: The Color of Money |  | tt0090863 |
| R0894 | The.Creator.2023.2160p.AMZN.WEB-DL.DDP5.1.HDR.H.265.YG: The Creator |  | tt11858890 |
| R0895 | The.Cutting.Edge.1992.BluRay.720p.H264: The Cutting Edge |  | tt0104040 |
| R0896 | The.Discreet.Charm.Of.The.Bourgeoisie.1972.1080p.BRRip-Classics: The Discreet Charm of the Bourgeoisie |  | tt0068361 |
| R0897 | The.End.of.the.Tour.2015.HDRip.XViD-ETRG: The End of the Tour |  | tt3416744 |
| R0898 | daa-exp2-1080p-proper: The Expendables 2 |  | tt1764651 |
| R0899 | The.Fly.1958.1080p.BluRay.x264.anoXmous_: The Fly |  | tt0051622 |
| R0900 | The.Fox.And.The.Hound.1981.720p.Bluray.x264.anoXmous_: The Fox and the Hound |  | tt0082406 |
| R0901 | The.French.Connection.1971.REMASTERED.1080p.BluRay.H264.AAC-RARBG: The French Connection |  | tt0067116 |
| R0902 | The.Fugitive.1993.720p.BRRip.x264-x0r: The Fugitive |  | tt0106977 |
| R0903 | The.Funhouse.1981.720p.BluRay.x264-x0r[N1C]: The Funhouse |  | tt0082427 |
| R0904 | The.Game.1997.1080p.BluRay.x264.AAC-ETRG: The Game |  | tt0119174 |
| R0905 | The.Girl.With.The.Dragon.Tattoo.2009.EXTENDED.720p.Bluray.x264.anoXmous: The Girl with the Dragon Tattoo |  | tt1132620 |
| R0906 | The.Girl.with.All.the.Gifts.2016.1080p.BluRay.x264.DTS-JYK: The Girl with All the Gifts |  | tt4547056 |
| R0907 | The.Good.the.Bad.and.the.Ugly.1966.2160p.BluRay.REMUX.SDR.HEVC.DTS-HD.MA.5.1-FGT: The Good, the Bad and the Ugly |  | tt0060196 |
| R0908 | The.Handmaiden.2016.EXTENDED.KOREAN.1080p.BluRay.H264.AAC-VXT: The Handmaiden |  | tt4016934 |
| R0909 | the.holdovers.2023.hdr.2160p.web.h265-mauveskunkofstereotypedaptitude: The Holdovers |  | tt14849194 |
| R0910 | The.Hot.Spot.1990.REMASTERED.1080p.BluRay.x264.DTS-FGT: The Hot Spot |  | tt0099797 |
| R0911 | The.Hunger.Games.Mockingjay.Part.2.2015.1080p.BluRay.H264.AAC-RARBG: The Hunger Games: Mockingjay - Part 2 |  | tt1951266 |
| R0912 | The.Hunt.for.Red.October.1990.Multi.UHD.2160p.Blu-ray.x265.HDR.TrueHD.5.1-DTOne: The Hunt for Red October |  | tt0099810 |
| R0913 | The.Hustler.1961.50th.Anniversary.1080p.BluRay.x264.anoXmous_: The Hustler |  | tt0054997 |
| R0914 | The.Incredibles.2004.1080p.BRRip.5.1.HEVC.x265-GIRAYS: The Incredibles |  | tt0317705 |
| R0915 | The.Invisible.Man.1933.1080p.BRRip.x264-Classics: The Invisible Man |  | tt0024184 |
| R0916 | The.Invisible.Man.2020.1080p.BluRay.1400MB.DD5.1.x264-GalaxyRG: The Invisible Man |  | tt1051906 |
| R0917 | The.Jungle.Book.2016.2160p.UHD.BluRay.x265-AAAUHD: The Jungle Book |  | tt3040964 |
| R0918 | The.King.2019.HDRip.XviD.AC3-EVO: The King |  | tt7984766 |
| R0919 | The.Knight.Before.Christmas.2019.1080p.NF.WEB-DL.DDP5.1.Atmos.H264-CMRG: The Knight Before Christmas |  | tt10060094 |
| R0920 | The.Last.Unicorn.1982.720p.BRRip.x264-x0r: The Last Unicorn |  | tt0084237 |
| R0921 | The.Lord.of.the.Rings.1978.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265: The Lord of the Rings |  | tt0077869 |
| R0922 | The.Maltese.Falcon.1941.1080p.Bluray.x264.anoXmous: The Maltese Falcon |  | tt0033870 |
| R0923 | The.Man.Who.Knew.Infinity.2015.1080p.BluRay.x264.DTS-JYK: The Man Who Knew Infinity |  | tt0787524 |
| R0924 | The.Man.Who.Knew.Too.Much.1956.720p.BluRay.999MB.HQ.x265.10bit-GalaxyRG: The Man Who Knew Too Much |  | tt0049470 |
| R0925 | The.Martian.2015.EXTENDED.2160p.UHD.BluRay.x265-TERMiNAL: The Martian |  | tt3659388 |
| R0926 | the.mountain.between.us.2017.2160p.uhd.bluray.x265-terminal: The Mountain Between Us |  | tt2226597 |
| R0927 | kaka-tmcc-1080p: The Muppet Christmas Carol |  | tt0104940 |
| R0928 | The.NeverEnding.Story.1984.1080p.BluRay.x264.AAC-ETRG: The NeverEnding Story |  | tt0088323 |
| R0929 | The.Nightmare.Before.Christmas.1993.1080p.BluRay.x264.anoXmous_: The Nightmare Before Christmas |  | tt0107688 |
| R0930 | The.Orphanage.2007.1080p.BluRay.x264.anoXmous_: The Orphanage |  | tt0464141 |
| R0931 | The.People.vs.Larry.Flynt.1996.720p.BRRip.x264.AAC-ETRG: The People vs. Larry Flynt |  | tt0117318 |
| R0932 | The.Princess.Bride.1987.REMASTERED.1080p.BluRay.H264.AAC-RARBG: The Princess Bride |  | tt0093779 |
| R0933 | The.Princess.Diaries.2001.BluRay.720p.H264: The Princess Diaries |  | tt0247638 |
| R0934 | The.Saragossa.Manuscript.1965.(Drama).1080p.BRRip.x264-Classics: The Saragossa Manuscript |  | tt0059643 |
| R0935 | The.Sea.Hawk.1940.1080p.BluRay.H264.AAC-RARBG: The Sea Hawk |  | tt0033028 |
| R0936 | The.Shape.of.Water.2017.720p.10bit.BluRay.6CH.x265.HEVC-PSA: The Shape of Water |  | tt5580390 |
| R0937 | The.Third.Man.1949.CRITERION.1080p.Bluray.x264.anoXmous_: The Third Man |  | tt0041959 |
| R0938 | The.Thomas.Crown.Affair[1999]DvDrip[Eng][Multi-Sub]-Vex: The Thomas Crown Affair |  | tt0155267 |
| R0939 | The.Wedding.Veil.Legacy.2022.1080p.BluRay.1400MB.DD5.1.x264-GalaxyRG: The Wedding Veil Legacy |  | tt17524492 |
| R0940 | The.Wonderful.Story.of.Henry.Sugar.2023.2160p.NF.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX: The Wonderful Story of Henry Sugar |  | tt16968450 |
| R0941 | The_Girl_Who_Leapt_Through_Time_(2006)_[720p,Dual-Audio]_-_THORA_E-D: The Girl Who Leapt Through Time |  | tt0808506 |
| R0942 | Thelma.and.Louise.1991.BluRay.720p.H264: Thelma & Louise |  | tt0103074 |
| R0943 | There.Will.Be.Blood.720p 600MB.YIFY: There Will Be Blood |  | tt0469494 |
| R0944 | They.Shall.Not.Grow.Old.2018.1080p.BluRay.H264.AAC-RARBG: They Shall Not Grow Old |  | tt7905466 |
| R0945 | Thirteen.Days.2000.1080p.BluRay.x264-[YTS.AM]: Thirteen Days |  | tt0146309 |
| R0946 | This.Is.Spinal.Tap.1984.1080p.BluRay.x264-[YTS.AM]: This Is Spinal Tap |  | tt0088258 |
| R0947 | Thor: Thor |  | tt0800369 |
| R0948 | Thor.Love.And.Thunder.2022.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Thor: Love and Thunder |  | tt10648342 |
| R0949 | Thor.The.Dark.World.2013.1080p.BluRay.x264.YIFY: Thor: The Dark World |  | tt1981115 |
| R0950 | Thor.The.Dark.World.2013.PROPER.REMASTERED.1080p.BluRay.x265-RARBG: Thor: The Dark World |  | tt1981115 |
| R0951 | Three Days Of The Condor.1975.BRRip.XviD.AC3[5.1]-VLiS: Three Days of the Condor |  | tt0073802 |
| R0952 | Tinker.Tailor.Soldier.Spy.2011.720p.BluRay.x264.YIFY: Tinker Tailor Soldier Spy |  | tt1340800 |
| R0953 | Titan.AE.720p.HDTV.x264.2CH.stero: Titan A.E. |  | tt0120913 |
| R0954 | Titanic.1997.REPACK.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR: Titanic |  | tt0120338 |
| R0955 | To.Catch.A.Thief.1955.720p.BluRay.x264-[YTS.AM]: To Catch a Thief |  | tt0048728 |
| R0956 | To.Have.and.Have.Not.1944.1080p.BluRay.H264.AAC-RARBG: To Have and Have Not |  | tt0037382 |
| R0957 | Tombstone.1993.1080p.BrRip.x264.YIFY: Tombstone |  | tt0108358 |
| R0958 | Tombstone - 1993 - Kurt Russell 2160p HDR DTS: Tombstone |  | tt0108358 |
| R0959 | Top Gun (1986) 1080p BrRip x264 1.29GB YIFY: Top Gun |  | tt0092099 |
| R0960 | Top.Gun.Maverick.2022.IMAX.REPACK.1080p.WEBRip.x264.AAC5.1-[YTS.MX]: Top Gun: Maverick |  | tt1745960 |
| R0961 | Top.Gun.Maverick.2022.2160p.WEB-DL.DDP5.1.Atmos.HDR.H.265-EVO: Top Gun: Maverick |  | tt1745960 |
| R0962 | Tora.Tora.Tora.1970.EXTENDED.720p.BluRay.H264.AAC-RARBG: Tora! Tora! Tora! |  | tt0066473 |
| R0963 | Total.Recall.Mind.Bending.Edition.1990.1080p.BluRay.x264.YIFY: Total Recall |  | tt0100802 |
| R0964 | Tower.Heist.2011.720p.BluRay.X264.YIFY: Tower Heist |  | tt0471042 |
| R0965 | Toy.Story.1995.1080p.BRrip.x264.YIFY: Toy Story |  | tt0114709 |
| R0966 | Trading.Places.1983.1080p.BluRay.x264.YIFY: Trading Places |  | tt0086465 |
| R0967 | Train To Busan 2016 HDRip ENG SUB x264-CPG: Train to Busan |  | tt5700672 |
| R0968 | Trainspotting.1996.1080p.BrRip.x264.BOKUTOX.YIFY: Trainspotting |  | tt0117951 |
| R0969 | Transcendence.2014.1080p.BluRay.x264.YIFY: Transcendence |  | tt2209764 |
| R0970 | Transformers.2007.1080p.BrRip.x264.YIFY: Transformers |  | tt0418279 |
| R0971 | Tremors.1990.1080p.BrRip.x264.YIFY: Tremors |  | tt0100814 |
| R0972 | Triple Frontier (2019) (1080p NF WEB-DL x265 Ghost): Triple Frontier |  | tt1488606 |
| R0973 | Tron.1982.1080p.BrRip.x264.bitloks.YIFY: Tron |  | tt0084827 |
| R0974 | Tron.Legacy.2010.Br.720p.YIFY: Tron: Legacy |  | tt1104001 |
| R0975 | Tron.Ares.2025.2160p.UHD.BluRay.REMUX.DV.P7.HDR.MULTi[Ben The Men]: Tron: Ares |  | tt6604188 |
| R0976 | Tropic Thunder 2008 Unrated DC 1080p BluRay HEVC H265 5.1 BONE: Tropic Thunder |  | tt0942385 |
| R0977 | Troy.DC.2004.HD.720p.x264: Troy |  | tt0332452 |
| R0978 | True Lies 1994.816p.BluRay.5.1.x264 . NVEE: True Lies |  | tt0111503 |
| R0979 | Twice-Told.Tales.1963.1080p.BluRay.H264.AAC-RARBG: Twice-Told Tales |  | tt0057608 |
| R0980 | Twilight.Saga.2008.BrRip.720p.X264.YIFY: Twilight |  | tt1099212 |
| R0981 | Twilight.Saga.the.2009.720p.BrRip.x264.YIFY: The Twilight Saga: New Moon |  | tt1259571 |
| R0982 | Twilight.Saga.Eclipse.2010.720p.BrRip.x264.YIFY: The Twilight Saga: Eclipse |  | tt1325004 |
| R0983 | The.Twilight.Saga.Breaking.Dawn.Part 1.2011.720p.BrRip.x264.YIFY: The Twilight Saga: Breaking Dawn - Part 1 |  | tt1324999 |
| R0984 | The.Twilight.Saga.Breaking.Dawn.Part.2.2012.720p.BRrip.x264.GAZ.YIFY: The Twilight Saga: Breaking Dawn - Part 2 |  | tt1673434 |
| R0985 | Twin Peaks Fire Walk with Me - David Lynch Remastered 1992 Eng Subs 720p [H264-mp4]: Twin Peaks: Fire Walk with Me |  | tt0105665 |
| R0986 | Twister.1996.1080p.BrRip.x264.YIFY: Twister |  | tt0117998 |
| R0987 | Twisters 2024 2160p WEB-DL DDP5 1 Atmos DV HDR H 265-FLUX: Twisters |  | tt12584954 |
| R0988 | Ultraviolet.2006.BluRay.1080p.x264.YIFY: Ultraviolet |  | tt0370032 |
| R0989 | Unbreakable (2000) RM4K (1080p BluRay x265 10bit Tigole): Unbreakable |  | tt0217869 |
| R0990 | Unbreakable.2000.1080p.BrRip.x264.YIFY: Unbreakable |  | tt0217869 |
| R0991 | Uncharted.2022.1080p.BluRay.H264.AAC-RARBG: Uncharted |  | tt1464335 |
| R0992 | Uncharted.2022.2160p.WEB-DL.DD5.1.HDR.H.265-EVO: Uncharted |  | tt1464335 |
| R0993 | Under.Siege.1992.720p.BrRip.x264.YIFY: Under Siege |  | tt0105690 |
| R0994 | Under.the.Skin.2013.1080p.BluRay.x264.YIFY: Under the Skin |  | tt1441395 |
| R0995 | Underworld.EXTENDED.2003.1080p.BrRip.x264.YIFY: Underworld |  | tt0320691 |
| R0996 | United.93.2006.720p.BrRip.x264.YIFY: United 93 |  | tt0475276 |
| R0997 | Up.2009.1080p.BluRay.x264.YIFY: Up |  | tt1049413 |
| R0998 | Us.2019.HC.HDRip.XviD.AC3-EVO: Us |  | tt6857112 |
| R0999 | V.For.Vendetta.2006.1080p.BrRip.x264.YIFY: V for Vendetta |  | tt0434409 |
| R1000 | Vicky Cristina Barcelona 2008  1080p  BDRip AAC x264 (multisubs)-tomcat12: Vicky Cristina Barcelona |  | tt0497465 |
| R1001 | Viridiana.1961.(Luis.Bunuel).1080p.BRRip.x264-Classics: Viridiana |  | tt0055601 |
| R1002 | Volcano.1997.1080p.BluRay.x264.anoXmous_: Volcano |  | tt0120461 |
| R1003 | W. (2008): W. |  | tt1175491 |
| R1004 | WALL-E.2008.1080p.BrRip.x264.YIFY: WALL·E |  | tt0910970 |
| R1005 | Wag.the.Dog.1997.1080p.WEBRip.x264.AAC.5.1-POOP: Wag the Dog |  | tt0120885 |
| R1006 | Waiting.for.Guffman.1996.REMASTERED.BDRip.x264-FRAGMENT: Waiting for Guffman |  | tt0118111 |
| R1007 | Walk.the.Line.EXTENDED.2005.1080p.BrRip.x264.YIFY: Walk the Line |  | tt0358273 |
| R1008 | Waltz.with.Bashir.2008.1080p.BluRay.H264.AAC-RARBG: Waltz with Bashir |  | tt1185616 |
| R1009 | Wanted.2008.720p.BrRip.x264.YIFY: Wanted |  | tt0493464 |
| R1010 | War.Of.The.Worlds.2005.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX]: War of the Worlds |  | tt0407304 |
| R1011 | emd-warfortheplanetoftheapes.2160p: War for the Planet of the Apes |  | tt3450958 |
| R1012 | Watchmen.Ultimate.Cut.2009.1080p.BrRip.x264.YIFY: Watchmen |  | tt0409459 |
| R1013 | Waterworld.1995.1080p.BrRip.x264.YIFY: Waterworld |  | tt0114898 |
| R1014 | What.Dreams.May.Come.1998.1080p.BluRay.x264.YIFY: What Dreams May Come |  | tt0120889 |
| R1015 | What.We.Do.In.The.Shadows.2014.1080p.BluRay.H264.AC3.5.1.BADASSMEDIA: What We Do in the Shadows |  | tt3416742 |
| R1016 | When a man loves a woman 720p DivX HD H.264 (moviesbyrizzo): When a Man Loves a Woman |  | tt0111693 |
| R1017 | Wild.Things.1998.UNRATED.1080p.BluRay.H264.AAC-RARBG: Wild Things |  | tt0120890 |
| R1018 | Willow.1988.1080p.BluRay.x264.anoXmous_: Willow |  | tt0096446 |
| R1019 | Wittgenstein (1993) [1of4]: Wittgenstein |  | tt0108583 |
| R1020 | Wittgenstein (1993) [2of4]: Wittgenstein |  | tt0108583 |
| R1021 | Wittgenstein (1993) [3of4]: Wittgenstein |  | tt0108583 |
| R1022 | Wonder Woman (2017): Wonder Woman |  | tt0451279 |
| R1023 | Wonder.Woman.2017.720p.BluRay.x264.VPPV: Wonder Woman |  | tt0451279 |
| R1024 | Wreck.it.Ralph.2012.1080p.BrRip.x264.BOKUTOX.YIFY: Wreck-It Ralph |  | tt1772341 |
| R1025 | Yellowbeard.1983.1080p.BluRay.x264.YIFY: Yellowbeard |  | tt0086618 |
| R1026 | YsMn.Br: Yes Man |  | tt1068680 |
| R1027 | The Road Home: The Road Home |  | tt0235060 |
| R1028 | Yojimbo.1961.1080p.CRITERION.BluRay.x264.anoXmous_: Yojimbo |  | tt0055630 |
| R1029 | Young.Frankenstein.1974.1080p.BRrip.x264.YIFY: Young Frankenstein |  | tt0072431 |
| R1030 | Your.Highness.2011.UNRATED.720p.BluRay.X264.YIFY: Your Highness |  | tt1240982 |
| R1031 | kimi-no-na-wa-2016-hdrip-720p-hc-eng-sub-aac-x264: Your Name. |  | tt5311514 |
| R1032 | Zero.Dark.Thirty.2012.1080p.BrRip.x264.BOKUTOX.YIFY: Zero Dark Thirty |  | tt1790885 |
| R1033 | Zodiac.2007.DC.1080p.BluRay.10Bit.HEVC.EAC3-SARTRE: Zodiac |  | tt0443706 |
| R1034 | Zombieland.2009.720p.BrRip.x264-YIFY: Zombieland |  | tt1156398 |
| R1035 | Zombieland.BluRay.1080p.x264.5.1.Judas: Zombieland |  | tt1156398 |
| R1036 | Zombieland.Double.Tap.2019.1080p.BluRay.1400MB.DD5.1.x264-GalaxyRG: Zombieland: Double Tap |  | tt1560220 |
| R1037 | zoolander.2001.720p.bluray.x264-nezu: Zoolander |  | tt0196229 |
| R1038 | Zulu (1964): Zulu |  | tt0058777 |
| R1039 | Kids 1995 DVDRiP x264 AC3-BadMeetsEvil: Kids |  | tt0113540 |
| R1040 | eXistenZ.1999.1080p.BluRay.H264.AAC-RARBG: eXistenZ |  | tt0120907 |
| R1041 | the.wedding.veil.unveiled.2022.1080p.bluray.dd5.1.hevc.x265: The Wedding Veil Unveiled |  | tt17524476 |
| R1042 | sr-the.return.of.jafar.1994.multi.1080p.bluray.x264: The Return of Jafar |  | tt0107952 |
| R1043 | Paradise 1982 UNCUT 1080p BluRay DDP 2 0 x265-SM737: Paradise |  | tt0084469 |
| R1044 | Aladdin And The King Of Thieves 1996 1080p BluRay x264-OB1: Aladdin and the King of Thieves |  | tt0115491 |
| R1045 | Cinderella 1977 1080p BluRay REMUX AVC DD 5 1-TintoBrASS: Cinderella |  | tt0075849 |
| R1046 | the.trumpet.of.the.swan.2001.dvdrip.x264-sprinter: The Trumpet of the Swan |  | tt0206367 |
| R1047 | Peter.Pan.1960.DVDRip.x264-HANDJOB: Peter Pan |  | tt0054176 |
| R1048 | 2010 The Year We Make Contact (1984) BDrip x265 ENG-ITA Aac subs - L'anno Del Contatto -Shiv@: 2010: The Year We Make Contact |  | tt0086837 |
| R1049 | A Star Is Born (2018): A Star Is Born |  | tt1517451 |
| R1050 | Aladdin.2019.1080p.BluRay.10bit.HEVC.6CH-MkvCage.com: Aladdin |  | tt6139732 |
| R1051 | All The Right Moves: All the Right Moves |  | tt0085154 |
| R1052 | Back To The Future Part II (1989): Back to the Future Part II |  | tt0096874 |
| R1053 | Back To The Future Part III (1990): Back to the Future Part III |  | tt0099088 |
| R1054 | Batman Begins: Batman Begins |  | tt0372784 |
| R1055 | Black Panther (cam): Black Panther |  | tt1825683 |
| R1056 | Buffy The Vampire Slayer: Buffy the Vampire Slayer |  | tt0103893 |
| R1057 | Captain America The Winter Soldier: Captain America: The Winter Soldier |  | tt1843866 |
| R1058 | Cheetah: Cheetah |  | tt0097053 |
| R1059 | Deepwater.Horizon.2016.1080p.WEB.DL.HEVC.2CH.x265: Deepwater Horizon |  | tt1860357 |
| R1060 | Divergent - 01 - Divergent: Divergent |  | tt1840309 |
| R1061 | Dog Day Afternoon: Dog Day Afternoon |  | tt0072890 |
| R1062 | El Topo 1970 720p SPA-ENG Multisub: El Topo |  | tt0067866 |
| R1063 | Emanuelle and the Last Cannibals: Emanuelle and the Last Cannibals |  | tt0075984 |
| R1064 | Ernest Scared Stupid: Ernest Scared Stupid |  | tt0101821 |
| R1065 | FATF - 06 - Fast and Furious 6: Fast & Furious 6 |  | tt1905041 |
| R1066 | FATF - 07 - Furious 7: Furious 7 |  | tt2820852 |
| R1067 | FATF - 08 - the.fate.of.the.furious.2017.1080p.web.dl.6ch.hevc.x265.rmteam: The Fate of the Furious |  | tt4630562 |
| R1068 | Fargo: Fargo |  | tt0116282 |
| R1069 | Flight of the Navigator: Flight of the Navigator |  | tt0091059 |
| R1070 | In The Line Of Fire: In the Line of Fire |  | tt0107206 |
| R1071 | Iron Man 2: Iron Man 2 |  | tt1228705 |
| R1072 | Isle of Dogs: Isle of Dogs |  | tt5104604 |
| R1073 | Jurassic Park - 05 - Jurassic World Fallen Kingdom (Cam): Jurassic World: Fallen Kingdom |  | tt4881806 |
| R1074 | King.Kong.2005.2160p.10bit.HDR.BluRay.5.1.x265.HEVC-MZABI: King Kong |  | tt0360717 |
| R1075 | Lucy: Lucy |  | tt2872732 |
| R1076 | Madagascar: Madagascar |  | tt0351283 |
| R1077 | Meet The Fockers: Meet the Fockers |  | tt0290002 |
| R1078 | Mission.Impossible.Dead.Reckoning.Part.One.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX: Mission: Impossible - Dead Reckoning Part One |  | tt9603212 |
| R1079 | Moana: Moana |  | tt3521164 |
| R1080 | My Cousin Vinny: My Cousin Vinny |  | tt0104952 |
| R1081 | Notting Hill: Notting Hill |  | tt0125439 |
| R1082 | One Million Years BC 1966 1080p BluRay HEVC x265 BONE: One Million Years B.C. |  | tt0060782 |
| R1083 | Planes Trains And Automobiles 1987 720p BluRay x264 BONE: Planes, Trains & Automobiles |  | tt0093748 |
| R1084 | Planet of the Apes (1968): Planet of the Apes |  | tt0063442 |
| R1085 | Point Break (1991): Point Break |  | tt0102685 |
| R1086 | Pretty in Pink: Pretty in Pink |  | tt0091790 |
| R1087 | Rambo - 01 - First Blood: First Blood |  | tt0083944 |
| R1088 | Real Genius: Real Genius |  | tt0089886 |
| R1089 | Road House 1989 Remastered 1080p BluRay HEVC x265 5.1 BONE: Road House |  | tt0098206 |
| R1090 | Rudolph The Red-Nosed Reindeer (1964): Rudolph the Red-Nosed Reindeer |  | tt0058536 |
| R1091 | Shaun of the Dead 2004  (1080p x265 q22 FS78 Joy): Shaun of the Dead |  | tt0365748 |
| R1092 | Silence of the Lambs: The Silence of the Lambs |  | tt0102926 |
| R1093 | Sixteen Candles: Sixteen Candles |  | tt0088128 |
| R1094 | Spider-Man Homecoming: Spider-Man: Homecoming |  | tt2250912 |
| R1095 | Spider-Man.Far.from.Home.2019.1080p.BluRay.x264.AC3-MkvCage: Spider-Man: Far from Home |  | tt6320628 |
| R1096 | Spider-Man.Into.the.Spider-Verse.2018.1080p.BRRip.x264-MkvCage.ws: Spider-Man: Into the Spider-Verse |  | tt4633694 |
| R1097 | Sully: Sully |  | tt3263904 |
| R1098 | Taken 3: Taken 3 |  | tt2446042 |
| R1099 | The Blue Lagoon (1980): The Blue Lagoon |  | tt0080453 |
| R1100 | The Bodyguard (1992): The Bodyguard |  | tt0103855 |
| R1101 | The Boss Baby: The Boss Baby |  | tt3874544 |
| R1102 | The Dark Knight Rises (2012): The Dark Knight Rises |  | tt1345836 |
| R1103 | The Fifth Estate: The Fifth Estate |  | tt1837703 |
| R1104 | The Hunger Games - 01: The Hunger Games |  | tt1392170 |
| R1105 | The Hunger Games - 02 - Catching Fire: The Hunger Games: Catching Fire |  | tt1951264 |
| R1106 | The Hunger Games - 03 - Mockingjay Part 1: The Hunger Games: Mockingjay - Part 1 |  | tt1951265 |
| R1107 | The Hunger Games - 04 - Mockingjay Part 2: The Hunger Games: Mockingjay - Part 2 |  | tt1951266 |
| R1108 | The Mighty Ducks: The Mighty Ducks |  | tt0104868 |
| R1109 | The Parent Trap (1998): The Parent Trap |  | tt0120783 |
| R1110 | The Pelican Brief: The Pelican Brief |  | tt0107798 |
| R1111 | The Prestige: The Prestige |  | tt0482571 |
| R1112 | The Trotsky: The Trotsky |  | tt1295072 |
| R1113 | The Wedding Veil 2022 Hallmark 720p HDTV X264 Solar: The Wedding Veil |  | tt16287754 |
| R1114 | Thor Ragnarok: Thor: Ragnarok |  | tt3501632 |
| R1115 | Three Billboards Outside Ebbing, Missouri: Three Billboards Outside Ebbing, Missouri |  | tt5027774 |
| R1116 | Treasure Island (1950): Treasure Island |  | tt0043067 |
| R1117 | Trolls: Trolls |  | tt1679335 |
| R1118 | True Grit (2010): True Grit |  | tt1403865 |
| R1119 | Weird Science: Weird Science |  | tt0090305 |
| R1120 | White House Down: White House Down |  | tt2334879 |
| R1121 | [ www.UsaBit.com ] - Misery (1990) BluRay 720p 750MB Ganool: Misery |  | tt0100157 |
| R1122 | [ www.UsaBit.com ] - The Jungle Book 1967 720p BRRip x264-PLAYNOW: The Jungle Book |  | tt0061852 |
| R1123 | iceman.2017.1080p.bluray.x264-worldmkv: Iceman |  | tt5907748 |
| R1124 | seven.days.in.may.1964.720p.bluray.hevc.x265.rmteam: Seven Days in May |  | tt0058576 |

### Shows — 11.22.63 (10)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1521 | 11.22.63: The Rabbit Hole | S1E1 | tt4460418 |
| R1527 | 11.22.63: The Rabbit Hole | S1E1 | tt4460418 |
| R1528 | 11.22.63: The Rabbit Hole | S1E1 | tt4460418 |
| R1529 | 11.22.63: The Kill Floor | S1E2 | tt5426278 |
| R1530 | 11.22.63: Other Voices, Other Rooms | S1E3 | tt4587208 |
| R1531 | 11.22.63: The Eyes of Texas | S1E4 | tt5432594 |
| R1532 | 11.22.63: The Truth | S1E5 | tt5432602 |
| R1533 | 11.22.63: Happy Birthday, Lee Harvey Oswald | S1E6 | tt5432604 |
| R1534 | 11.22.63: Soldier Boy | S1E7 | tt5432610 |
| R1535 | 11.22.63: The Day in Question | S1E8 | tt5432614 |

### Shows — Adventure Time (135)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1144 | Adventure Time: It Came from the Nightosphere | S2E1 | tt1748406 |
| R1145 | Adventure Time: The Eyes | S2E2 | tt1886798 |
| R1146 | Adventure Time: Loyalty to the King | S2E3 | tt1886799 |
| R1147 | Adventure Time: Blood Under the Skin | S2E4 | tt1761052 |
| R1148 | Adventure Time: Storytelling | S2E5 | tt1886801 |
| R1149 | Adventure Time: Slow Love | S2E6 | tt1886802 |
| R1150 | Adventure Time: Power Animal | S2E7 | tt1886803 |
| R1151 | Adventure Time: Crystals Have Power | S2E8 | tt1805579 |
| R1152 | Adventure Time: The Other Tarts | S2E9 | tt1819780 |
| R1153 | Adventure Time: To Cut a Woman's Hair | S2E10 | tt1821733 |
| R1154 | Adventure Time: The Chamber of Frozen Blades | S2E11 | tt1880431 |
| R1155 | Adventure Time: Her Parents | S2E12 | tt1833240 |
| R1156 | Adventure Time: The Pods | S2E13 | tt1831849 |
| R1157 | Adventure Time: The Silent King | S2E14 | tt1854417 |
| R1158 | Adventure Time: The Real You | S2E15 | tt1853820 |
| R1159 | Adventure Time: Guardians of Sunshine | S2E16 | tt1853819 |
| R1160 | Adventure Time: Death in Bloom | S2E17 | tt1853818 |
| R1161 | Adventure Time: Susan Strong | S2E18 | tt1868123 |
| R1162 | Adventure Time: Mystery Train | S2E19 | tt1868122 |
| R1163 | Adventure Time: Go with Me | S2E20 | tt1885473 |
| R1164 | Adventure Time: Belly of the Beast | S2E21 | tt1885472 |
| R1165 | Adventure Time: The Limit | S2E22 | tt1916786 |
| R1166 | Adventure Time: Video Makers | S2E23 | tt1916787 |
| R1167 | Adventure Time: Mortal Folly | S2E24 | tt1912555 |
| R1168 | Adventure Time: Mortal Recoil | S2E25 | tt2332046 |
| R1169 | Adventure Time: Heat Signature | S2E26 | tt1916785 |
| R1170 | Adventure Time: Conquest of Cuteness | S3E1 | tt1989733 |
| R1171 | Adventure Time: Morituri Te Salutamus | S3E2 | tt1991301 |
| R1172 | Adventure Time: Memory of a Memory | S3E3 | tt2006936 |
| R1173 | Adventure Time: Hitman | S3E4 | tt2017067 |
| R1174 | Adventure Time: Too Young | S3E5 | tt2017068 |
| R1175 | Adventure Time: The Monster | S3E6 | tt2040620 |
| R1176 | Adventure Time: Still | S3E7 | tt2036509 |
| R1177 | Adventure Time: Wizard Battle | S3E8 | tt2040621 |
| R1178 | Adventure Time: Fionna and Cake | S3E9 | tt2004450 |
| R1179 | Adventure Time: What Was Missing | S3E10 | tt2042741 |
| R1180 | Adventure Time: Apple Thief | S3E11 | tt2113842 |
| R1181 | Adventure Time: The Creeps | S3E12 | tt2113846 |
| R1182 | Adventure Time: From Bad to Worse | S3E13 | tt2113844 |
| R1183 | Adventure Time: Beautopia | S3E14 | tt2100698 |
| R1184 | Adventure Time: No One Can Hear You | S3E15 | tt2113845 |
| R1185 | Adventure Time: Jake vs. Me-Mow | S3E16 | tt2133419 |
| R1186 | Adventure Time: Thank You | S3E17 | tt2137517 |
| R1187 | Adventure Time: The New Frontier | S3E18 | tt2211271 |
| R1188 | Adventure Time: Holly Jolly Secrets | S3E19 | tt2119588 |
| R1189 | Adventure Time: Marceline's Closet | S3E21 | tt2149303 |
| R1190 | Adventure Time: Paper Pete | S3E22 | tt2211269 |
| R1191 | Adventure Time: Another Way | S3E23 | tt2211261 |
| R1192 | Adventure Time: Ghost Princess | S3E24 | tt2211265 |
| R1193 | Adventure Time: Dad's Dungeon | S3E25 | tt2211263 |
| R1194 | Adventure Time: Incendium | S3E26 | tt2211267 |
| R1195 | Adventure Time: Hot to the Touch | S4E1 | tt2320185 |
| R1196 | Adventure Time: Five Short Graybles | S4E2 | tt2357553 |
| R1197 | Adventure Time: Web Weirdos | S4E3 | tt2357555 |
| R1198 | Adventure Time: Dream of Love | S4E4 | tt2383079 |
| R1199 | Adventure Time: Return to the Nightosphere | S4E5 | tt2319774 |
| R1200 | Adventure Time: Daddy's Little Monster | S4E6 | tt2301420 |
| R1201 | Adventure Time: In Your Footsteps | S4E7 | tt2382051 |
| R1202 | Adventure Time: Hug Wolf | S4E8 | tt2386441 |
| R1203 | Adventure Time: Princess Monster Wife | S4E9 | tt2310690 |
| R1204 | Adventure Time: Goliad | S4E10 | tt2185414 |
| R1205 | Adventure Time: Beyond This Earthly Realm | S4E11 | tt2311108 |
| R1206 | Adventure Time: Gotcha! | S4E12 | tt2195216 |
| R1207 | Adventure Time: Princess Cookie | S4E13 | tt2258518 |
| R1208 | Adventure Time: Card Wars | S4E14 | tt2248316 |
| R1209 | Adventure Time: Sons of Mars | S4E15 | tt2259192 |
| R1210 | Adventure Time: Burning Low | S4E16 | tt2275824 |
| R1211 | Adventure Time: BMO Noire | S4E17 | tt2311110 |
| R1212 | Adventure Time: King Worm | S4E18 | tt2333836 |
| R1213 | Adventure Time: Lady & Peebles | S4E19 | tt2323656 |
| R1214 | Adventure Time: You Made Me | S4E20 | tt2333862 |
| R1215 | Adventure Time: Who Would Win | S4E21 | tt2365224 |
| R1216 | Adventure Time: Ignition Point | S4E22 | tt2375154 |
| R1217 | Adventure Time: The Hard Easy | S4E23 | tt2401576 |
| R1218 | Adventure Time: Reign of Gunters | S4E24 | tt2401582 |
| R1219 | Adventure Time: I Remember You | S4E25 | tt2401584 |
| R1220 | Adventure Time: The Lich | S4E26 | tt2401636 |
| R1221 | Adventure Time: Finn the Human | S5E1 | tt2459530 |
| R1222 | Adventure Time: Jake the Dog | S5E2 | tt2459528 |
| R1223 | Adventure Time: Five More Short Graybles | S5E3 | tt2506708 |
| R1224 | Adventure Time: Up a Tree | S5E4 | tt2510956 |
| R1225 | Adventure Time: All the Little People | S5E5 | tt2539922 |
| R1226 | Adventure Time: Jake the Dad | S5E6 | tt2597414 |
| R1227 | Adventure Time: Davey | S5E7 | tt2606674 |
| R1228 | Adventure Time: Mystery Dungeon | S5E8 | tt2617736 |
| R1229 | Adventure Time: All Your Fault | S5E9 | tt2620058 |
| R1230 | Adventure Time: Little Dude | S5E10 | tt2620066 |
| R1231 | Adventure Time: Bad Little Boy | S5E11 | tt2459526 |
| R1232 | Adventure Time: Vault of Bones | S5E12 | tt2620072 |
| R1233 | Adventure Time: The Great Bird Man | S5E13 | tt2620078 |
| R1234 | Adventure Time: Simon & Marcy | S5E14 | tt2620082 |
| R1235 | Adventure Time: A Glitch Is a Glitch | S5E15 | tt2620092 |
| R1236 | Adventure Time: Puhoy | S5E16 | tt2620086 |
| R1237 | Adventure Time: BMO Lost | S5E17 | tt2620102 |
| R1238 | Adventure Time: Princess Potluck | S5E18 | tt2620098 |
| R1239 | Adventure Time: James Baxter the Horse | S5E19 | tt2620106 |
| R1240 | Adventure Time: Shh! | S5E20 | tt2620116 |
| R1241 | Adventure Time: The Suitor | S5E21 | tt2620118 |
| R1242 | Adventure Time: The Party's Over, Isla de Señorita | S5E22 | tt2620122 |
| R1243 | Adventure Time: One Last Job | S5E23 | tt2620096 |
| R1244 | Adventure Time: Another Five More Short Graybles | S5E24 | tt2620126 |
| R1245 | Adventure Time: Candy Streets | S5E25 | tt2620128 |
| R1246 | Adventure Time: Wizards Only, Fools | S5E26 | tt2620130 |
| R1247 | Adventure Time: Jakesuit | S5E27 | tt3021416 |
| R1248 | Adventure Time: Be More | S5E28 | tt3021418 |
| R1249 | Adventure Time: Sky Witch | S5E29 | tt3021422 |
| R1250 | Adventure Time: Frost & Fire | S5E30 | tt3084366 |
| R1251 | Adventure Time: Too Old | S5E31 | tt3116518 |
| R1252 | Adventure Time: Earth & Water | S5E32 | tt3146612 |
| R1253 | Adventure Time: Time Sandwich | S5E33 | tt3094552 |
| R1254 | Adventure Time: The Vault | S5E34 | tt3156934 |
| R1255 | Adventure Time: Love Games | S5E35 | tt3156938 |
| R1256 | Adventure Time: Dungeon Train | S5E36 | tt3156936 |
| R1257 | Adventure Time: Box Prince | S5E37 | tt3238508 |
| R1258 | Adventure Time: Red Starved | S5E38 | tt3238506 |
| R1259 | Adventure Time: We Fixed a Truck | S5E39 | tt3245274 |
| R1260 | Adventure Time: Play Date | S5E40 | tt3313438 |
| R1261 | Adventure Time: The Pit | S5E41 | tt3316440 |
| R1262 | Adventure Time: James | S5E42 | tt3307028 |
| R1263 | Adventure Time: Root Beer Guy | S5E43 | tt3394982 |
| R1264 | Adventure Time: Apple Wedding | S5E44 | tt3472104 |
| R1265 | Adventure Time: Blade of Grass | S5E45 | tt3452502 |
| R1266 | Adventure Time: Rattleballs | S5E46 | tt3468222 |
| R1267 | Adventure Time: The Red Throne | S5E47 | tt3529740 |
| R1268 | Adventure Time: Betty | S5E48 | tt3551386 |
| R1269 | Adventure Time: Bad Timing | S5E49 | tt3551388 |
| R1270 | Adventure Time: Lemonhope Part One | S5E50 | tt3551390 |
| R1271 | Adventure Time: Billy's Bucket List | S5E52 | tt3551396 |
| R1272 | Adventure Time: Wake Up | S6E1 | tt3621758 |
| R1273 | Adventure Time: Escape from the Citadel | S6E2 | tt3621760 |
| R1274 | Adventure Time: The Tower | S6E4 | tt3703172 |
| R1275 | Adventure Time: Sad Face | S6E5 | tt3703170 |
| R1276 | Adventure Time: Breezy | S6E6 | tt3762400 |
| R1277 | Adventure Time: Food Chain | S6E7 | tt3683222 |
| R1278 | Adventure Time: Furniture & Meat | S6E8 | tt3782940 |

### Shows — Band of Brothers (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1526 | Band of Brothers: Currahee | S1E1 | tt1245384 |

### Shows — Better Call Saul (2)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0001 | Better Call Saul: Switch | S2E1 | tt3824148 |
| R1130 | Better Call Saul: Rebecca | S2E5 | tt4462682 |

### Shows — Dexter (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1143 | Dexter: Popping Cherry | S1E3 | tt0828745 |

### Shows — E.R. (160)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1522 | E.R.: Day One | S1E3 | tt0567951 |
| R1523 | E.R.: Going Home | S1E4 | tt0567992 |
| R1524 | E.R.: 9 1/2 Hours | S1E9 | tt0567906 |
| R1525 | E.R.: ER Confidential | S1E10 | tt0567965 |
| R1572 | E.R.: 24 Hours | S1E1 | tt0295222 |
| R1573 | E.R.: Day One | S1E3 | tt0567951 |
| R1574 | E.R.: Going Home | S1E4 | tt0567992 |
| R1575 | E.R.: Hit and Run | S1E5 | tt0568004 |
| R1576 | E.R.: Into That Good Night | S1E6 | tt0568018 |
| R1577 | E.R.: Chicago Heat | S1E7 | tt0567947 |
| R1578 | E.R.: Another Perfect Day | S1E8 | tt0567926 |
| R1579 | E.R.: 9 1/2 Hours | S1E9 | tt0567906 |
| R1580 | E.R.: ER Confidential | S1E10 | tt0567965 |
| R1581 | E.R.: Blizzard | S1E11 | tt0567936 |
| R1582 | E.R.: The Gift | S1E12 | tt0568115 |
| R1583 | E.R.: Happy New Year | S1E13 | tt0567999 |
| R1584 | E.R.: Luck of the Draw | S1E14 | tt0568034 |
| R1585 | E.R.: Long Day's Journey | S1E15 | tt0568030 |
| R1586 | E.R.: Feb 5, '95 | S1E16 | tt0567975 |
| R1587 | E.R.: The Birthday Party | S1E17 | REJECT: Episode mismatch |
| R1588 | E.R.: The Birthday Party | S1E18 | tt0568110 |
| R1589 | E.R.: Sleepless in Chicago | S1E19 | tt0568094 |
| R1590 | E.R.: Love's Labor Lost | S1E20 | tt0568033 |
| R1591 | E.R.: Full Moon, Saturday Night | S1E21 | tt0567988 |
| R1592 | E.R.: House of Cards | S1E22 | tt0568008 |
| R1593 | E.R.: Men Plan, God Laughs | S1E23 | tt0568043 |
| R1594 | E.R.: Love Among the Ruins | S1E24 | tt0568032 |
| R1595 | E.R.: Motherhood | S1E25 | tt0568048 |
| R1596 | E.R.: Everything Old Is New Again | S1E26 | tt0567966 |
| R1597 | E.R.: Welcome Back Carter! | S2E1 | tt0568154 |
| R1598 | E.R.: Summer Run | S2E2 | tt0568103 |
| R1599 | E.R.: Do One, Teach One, Kill One | S2E3 | tt0567958 |
| R1600 | E.R.: What Life? | S2E4 | tt0568155 |
| R1601 | E.R.: And Baby Makes Two | S2E5 | tt0567925 |
| R1602 | E.R.: Days Like This | S2E6 | tt0567953 |
| R1603 | E.R.: Hell and High Water | S2E7 | tt0568001 |
| R1604 | E.R.: The Secret Sharer | S2E8 | tt0568130 |
| R1605 | E.R.: Home | S2E9 | tt0568005 |
| R1606 | E.R.: A Miracle Happens Here | S2E10 | tt0567912 |
| R1607 | E.R.: Dead of Winter | S2E11 | tt0567955 |
| R1608 | E.R.: True Lies | S2E12 | tt0568143 |
| R1609 | E.R.: It's Not Easy Being Greene | S2E13 | tt0568020 |
| R1610 | E.R.: The Right Thing | S2E14 | tt0568129 |
| R1611 | E.R.: Baby Shower | S2E15 | tt0567929 |
| R1612 | E.R.: The Healers | S2E16 | tt0568119 |
| R1613 | E.R.: The Match Game | S2E17 | tt0568125 |
| R1614 | E.R.: A Shift in the Night | S2E18 | tt0567915 |
| R1615 | E.R.: Fire in the Belly | S2E19 | tt0567978 |
| R1616 | E.R.: Fevers of Unknown Origin | S2E20 | tt0567976 |
| R1617 | E.R.: Take These Broken Wings | S2E21 | tt0568107 |
| R1618 | E.R.: John Carter, M.D. | S2E22 | tt0568021 |
| R1619 | E.R.: Doctor Carter, I Presume | S3E1 | tt0567960 |
| R1620 | E.R.: Let the Games Begin | S3E2 | tt0568028 |
| R1621 | E.R.: Don't Ask, Don't Tell | S3E3 | tt0567961 |
| R1622 | E.R.: Last Call | S3E4 | tt0568025 |
| R1623 | E.R.: Ghosts | S3E5 | tt0567991 |
| R1624 | E.R.: Fear of Flying | S3E6 | tt0567974 |
| R1625 | E.R.: No Brain, No Gain | S3E7 | tt0568054 |
| R1626 | E.R.: Union Station | S3E8 | tt0568149 |
| R1627 | E.R.: Ask Me No Questions, I'll Tell You No Lies | S3E9 | tt0567928 |
| R1628 | E.R.: Homeless for the Holidays | S3E10 | tt0568007 |
| R1629 | E.R.: Night Shift | S3E11 | tt0568053 |
| R1630 | E.R.: Post Mortem | S3E12 | tt0568073 |
| R1631 | E.R.: Fortune's Fools | S3E13 | tt0567983 |
| R1632 | E.R.: Whose Appy Now? | S3E14 | tt0568161 |
| R1633 | E.R.: The Long Way Around | S3E15 | tt0568122 |
| R1634 | E.R.: Faith | S3E16 | tt0567968 |
| R1635 | E.R.: Tribes | S3E17 | tt0568142 |
| R1636 | E.R.: You Bet Your Life | S3E18 | tt0568164 |
| R1637 | E.R.: Calling Dr. Hathaway | S3E19 | tt0567942 |
| R1638 | E.R.: Random Acts | S3E20 | tt0568078 |
| R1639 | E.R.: Make a Wish | S3E21 | tt0568035 |
| R1640 | E.R.: One More for the Road | S3E22 | tt0568064 |
| R1641 | E.R.: Ambush | S4E1 | tt0567924 |
| R1642 | E.R.: Something New | S4E2 | tt0568095 |
| R1643 | E.R.: Friendly Fire | S4E3 | tt0567987 |
| R1644 | E.R.: When the Bough Breaks | S4E4 | tt0568157 |
| R1645 | E.R.: Good Touch, Bad Touch | S4E5 | tt0567994 |
| R1646 | E.R.: Ground Zero | S4E6 | tt0567997 |
| R1647 | E.R.: Fathers and Sons | S4E7 | tt0567971 |
| R1648 | E.R.: Freak Show | S4E8 | tt0567985 |
| R1649 | E.R.: Obstruction of Justice | S4E9 | tt0568060 |
| R1650 | E.R.: Do You See What I See? | S4E10 | tt0567959 |
| R1651 | E.R.: Think Warm Thoughts | S4E11 | tt0568138 |
| R1652 | E.R.: Sharp Relief | S4E12 | tt0568089 |
| R1653 | E.R.: Carter's Choice | S4E13 | tt0567944 |
| R1654 | E.R.: Family Practice | S4E14 | tt0567970 |
| R1655 | E.R.: Exodus | S4E15 | tt0567967 |
| R1656 | E.R.: My Brother's Keeper | S4E16 | tt0568049 |
| R1657 | E.R.: A Bloody Mess | S4E17 | tt0567907 |
| R1658 | E.R.: Gut Reaction | S4E18 | tt0567998 |
| R1659 | E.R.: Shades of Gray | S4E19 | tt0568088 |
| R1660 | E.R.: Of Past Regret and Future Fear | S4E20 | tt0568061 |
| R1661 | E.R.: Suffer the Little Children | S4E21 | tt0568102 |
| R1662 | E.R.: A Hole in the Heart | S4E22 | tt0567909 |
| R1663 | E.R.: Day for Knight | S5E1 | tt0567952 |
| R1664 | E.R.: Split Second | S5E2 | tt0568097 |
| R1665 | E.R.: They Treat Horses, Don't They? | S5E3 | tt0568136 |
| R1666 | E.R.: Vanishing Act | S5E4 | tt0568150 |
| R1667 | E.R.: Masquerade | S5E5 | tt0568040 |
| R1668 | E.R.: Stuck on You | S5E6 | tt0568100 |
| R1669 | E.R.: Hazed and Confused | S5E7 | tt0568000 |
| R1670 | E.R.: The Good Fight | S5E8 | tt0568116 |
| R1671 | E.R.: Good Luck, Ruth Johnson | S5E9 | tt0567993 |
| R1672 | E.R.: The Miracle Worker | S5E10 | tt0568126 |
| R1673 | E.R.: Nobody Doesn't Like Amanda Lee | S5E11 | tt0568057 |
| R1674 | E.R.: Double Blind | S5E12 | tt0567962 |
| R1675 | E.R.: Choosing Joi | S5E13 | tt0567948 |
| R1676 | E.R.: The Storm: Part 1 | S5E14 | tt0568132 |
| R1677 | E.R.: The Storm: Part 2 | S5E15 | tt0568133 |
| R1678 | E.R.: Middle of Nowhere | S5E16 | tt0568044 |
| R1679 | E.R.: Sticks and Stones | S5E17 | tt0568099 |
| R1680 | E.R.: Point of Origin | S5E18 | tt0568072 |
| R1681 | E.R.: Rites of Spring | S5E19 | tt0568082 |
| R1682 | E.R.: Power | S5E20 | tt0568074 |
| R1683 | E.R.: Responsible Parties | S5E21 | tt0568081 |
| R1684 | E.R.: Getting to Know You | S5E22 | tt0567990 |
| R1685 | E.R.: Leave It to Weaver | S6E1 | tt0568027 |
| R1686 | E.R.: Last Rites | S6E2 | tt0568026 |
| R1687 | E.R.: Greene with Envy | S6E3 | tt0567996 |
| R1688 | E.R.: Sins of the Fathers | S6E4 | tt0568092 |
| R1689 | E.R.: Truth & Consequences | S6E5 | tt0568144 |
| R1690 | E.R.: The Peace of Wild Things | S6E6 | tt0568127 |
| R1691 | E.R.: Humpty Dumpty | S6E7 | tt0568010 |
| R1692 | E.R.: Great Expectations | S6E8 | tt0567995 |
| R1693 | E.R.: How the Finch Stole Christmas | S6E9 | tt0568009 |
| R1694 | E.R.: Family Matters | S6E10 | tt0567969 |
| R1695 | E.R.: The Domino Heart | S6E11 | tt0568113 |
| R1696 | E.R.: Abby Road | S6E12 | tt0567920 |
| R1697 | E.R.: Be Still My Heart | S6E13 | tt0567932 |
| R1698 | E.R.: All in the Family | S6E14 | tt0567922 |
| R1699 | E.R.: Be Patient | S6E15 | tt0567931 |
| R1700 | E.R.: Under Control | S6E16 | tt0568148 |
| R1701 | E.R.: Viable Options | S6E17 | tt0568151 |
| R1702 | E.R.: Match Made in Heaven | S6E18 | tt0568041 |
| R1703 | E.R.: The Fastest Year | S6E19 | tt0568114 |
| R1704 | E.R.: Loose Ends | S6E20 | tt0568031 |
| R1705 | E.R.: Such Sweet Sorrow | S6E21 | tt0568101 |
| R1706 | E.R.: May Day | S6E22 | tt0568042 |
| R1707 | E.R.: Homecoming | S7E1 | tt0568006 |
| R1708 | E.R.: Sand and Water | S7E2 | tt0568086 |
| R1709 | E.R.: Mars Attacks | S7E3 | tt0568039 |
| R1710 | E.R.: Benton Backwards | S7E4 | tt0567933 |
| R1711 | E.R.: Flight of Fancy | S7E5 | tt0567980 |
| R1712 | E.R.: The Visit | S7E6 | tt0568135 |
| R1713 | E.R.: Rescue Me | S7E7 | tt0568080 |
| R1714 | E.R.: The Dance We Do | S7E8 | tt0568112 |
| R1715 | E.R.: The Greatest of Gifts | S7E9 | tt0568118 |
| R1716 | E.R.: Rock, Paper, Scissors | S7E11 | tt0568083 |
| R1717 | E.R.: Surrender | S7E12 | tt0568105 |
| R1718 | E.R.: Thy Will Be Done | S7E13 | tt0568139 |
| R1719 | E.R.: A Walk in the Woods | S7E14 | tt0567918 |
| R1720 | E.R.: The Crossing | S7E15 | tt0568111 |
| R1721 | E.R.: Witch Hunt | S7E16 | tt0568162 |
| R1722 | E.R.: Survival of the Fittest | S7E17 | tt0568106 |
| R1723 | E.R.: April Showers | S7E18 | tt0567927 |
| R1724 | E.R.: Sailing Away | S7E19 | tt0568085 |
| R1725 | E.R.: Fear of Commitment | S7E20 | tt0567973 |
| R1726 | E.R.: Where the Heart Is | S7E21 | tt0568159 |
| R1727 | E.R.: Rampage | S7E22 | tt0568077 |

### Shows — Elfen Lied (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1125 | Elfen Lied: Encounter | S1E1 | tt0909536 |

### Shows — Euphoria (4)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1536 | Euphoria: Pilot | S1E1 | tt8135530 |
| R1537 | Euphoria: Stuntin' Like My Daddy | S1E2 | tt8806264 |
| R1538 | Euphoria: Pilot | S1E1 | tt8135530 |
| R1539 | Euphoria: Stuntin' Like My Daddy | S1E2 | tt8806264 |

### Shows — Friends (2)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0002 | Friends: The One with the Sonogram at the End | S1E2 | tt0583647 |
| R1126 | Friends: The One with the East German Laundry Detergent | S1E5 | tt0583599 |

### Shows — Game of Thrones (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1127 | Game of Thrones: Lord Snow | S1E3 | tt1829962 |

### Shows — Heroes (99)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1728 | Heroes: Chapter One 'Genesis' | S1E1 | tt0759572 |
| R1729 | Heroes: Chapter Two 'Don't Look Back' | S1E2 | tt0849980 |
| R1730 | Heroes: Chapter Three 'One Giant Leap' | S1E3 | tt0840551 |
| R1731 | Heroes: Chapter Four 'Collision' | S1E4 | tt0853635 |
| R1732 | Heroes: Chapter Five 'Hiros' | S1E5 | tt0853636 |
| R1733 | Heroes: Chapter Six 'Better Halves' | S1E6 | tt0861136 |
| R1734 | Heroes: Chapter Seven 'Nothing to Hide' | S1E7 | tt0860036 |
| R1735 | Heroes: Chapter Eight 'Seven Minutes to Midnight' | S1E8 | tt0879074 |
| R1736 | Heroes: Chapter Nine 'Homecoming' | S1E9 | tt0875355 |
| R1737 | Heroes: Chapter Ten 'Six Months Ago' | S1E10 | tt0879577 |
| R1738 | Heroes: Chapter Eleven 'Fallout' | S1E11 | tt0902012 |
| R1739 | Heroes: Chapter Twelve 'Godsend' | S1E12 | tt0893453 |
| R1740 | Heroes: Chapter Thirteen 'The Fix' | S1E13 | tt0901193 |
| R1741 | Heroes: Chapter Fourteen 'Distractions' | S1E14 | tt0917146 |
| R1742 | Heroes: Chapter Fifteen 'Run!' | S1E15 | tt0928267 |
| R1743 | Heroes: Chapter Sixteen 'Unexpected' | S1E16 | tt0942525 |
| R1744 | Heroes: Chapter Seventeen 'Company Man' | S1E17 | tt0950189 |
| R1745 | Heroes: Chapter Eighteen 'Parasite' | S1E18 | tt0966897 |
| R1746 | Heroes: Chapter Nineteen '.07%' | S1E19 | tt0969430 |
| R1747 | Heroes: Chapter Twenty 'Five Years Gone' | S1E20 | tt0988309 |
| R1748 | Heroes: Chapter Twenty-One 'The Hard Part' | S1E21 | tt1000400 |
| R1749 | Heroes: Chapter Twenty-Two 'Landslide' | S1E22 | tt0988308 |
| R1750 | Heroes: Chapter Twenty-Three 'How to Stop an Exploding Man' | S1E23 | tt0988307 |
| R1751 | Heroes: Chapter One 'Genesis' | S1E1 | tt0759572 |
| R1752 | Heroes: Chapter Two 'Don't Look Back' | S1E2 | tt0849980 |
| R1753 | Heroes: Chapter Three 'One Giant Leap' | S1E3 | tt0840551 |
| R1754 | Heroes: Chapter Four 'Collision' | S1E4 | tt0853635 |
| R1755 | Heroes: Chapter Five 'Hiros' | S1E5 | tt0853636 |
| R1756 | Heroes: Chapter Six 'Better Halves' | S1E6 | tt0861136 |
| R1757 | Heroes: Chapter Seven 'Nothing to Hide' | S1E7 | tt0860036 |
| R1758 | Heroes: Chapter Eight 'Seven Minutes to Midnight' | S1E8 | tt0879074 |
| R1759 | Heroes: Chapter Nine 'Homecoming' | S1E9 | tt0875355 |
| R1760 | Heroes: Chapter Ten 'Six Months Ago' | S1E10 | tt0879577 |
| R1761 | Heroes: Chapter Eleven 'Fallout' | S1E11 | tt0902012 |
| R1762 | Heroes: Chapter Twelve 'Godsend' | S1E12 | tt0893453 |
| R1763 | Heroes: Chapter Thirteen 'The Fix' | S1E13 | tt0901193 |
| R1764 | Heroes: Chapter Fourteen 'Distractions' | S1E14 | tt0917146 |
| R1765 | Heroes: Chapter Fifteen 'Run!' | S1E15 | tt0928267 |
| R1766 | Heroes: Chapter Sixteen 'Unexpected' | S1E16 | tt0942525 |
| R1767 | Heroes: Chapter Seventeen 'Company Man' | S1E17 | tt0950189 |
| R1768 | Heroes: Chapter Eighteen 'Parasite' | S1E18 | tt0966897 |
| R1769 | Heroes: Chapter Nineteen '.07%' | S1E19 | tt0969430 |
| R1770 | Heroes: Chapter Twenty 'Five Years Gone' | S1E20 | tt0988309 |
| R1771 | Heroes: Chapter Twenty-One 'The Hard Part' | S1E21 | tt1000400 |
| R1772 | Heroes: Chapter Twenty-Two 'Landslide' | S1E22 | tt0988308 |
| R1773 | Heroes: Chapter Twenty-Three 'How to Stop an Exploding Man' | S1E23 | tt0988307 |
| R1774 | Heroes: Chapter One 'Four Months Later...' | S2E1 | tt1041277 |
| R1775 | Heroes: Chapter Two 'Lizards' | S2E2 | tt1054841 |
| R1776 | Heroes: Chapter Three 'Kindred' | S2E3 | tt1054846 |
| R1777 | Heroes: Chapter Four 'The Kindness of Strangers' | S2E4 | tt1054847 |
| R1778 | Heroes: Chapter Five 'Fight or Flight' | S2E5 | tt1054848 |
| R1779 | Heroes: Chapter Six 'The Line' | S2E6 | tt1054849 |
| R1780 | Heroes: Chapter Seven 'Out of Time' | S2E7 | tt1054850 |
| R1781 | Heroes: Chapter Eight 'Four Months Ago...' | S2E8 | tt1054851 |
| R1782 | Heroes: Chapter Nine: Cautionary Tales | S2E9 | tt1054852 |
| R1783 | Heroes: Chapter Ten 'Truth & Consequences' | S2E10 | tt1054831 |
| R1784 | Heroes: Chapter Eleven 'Powerless' | S2E11 | tt1054832 |
| R1785 | Heroes: Chapter One 'The Second Coming' | S3E1 | tt1185907 |
| R1786 | Heroes: Chapter Two 'The Butterfly Effect' | S3E2 | tt1185912 |
| R1787 | Heroes: Chapter Three 'One of Us, One of Them' | S3E3 | tt1185913 |
| R1788 | Heroes: Chapter Four 'I Am Become Death' | S3E4 | tt1185914 |
| R1789 | Heroes: Chapter Five 'Angels and Monsters' | S3E5 | tt1185915 |
| R1790 | Heroes: Chapter Six 'Dying of the Light' | S3E6 | tt1185916 |
| R1791 | Heroes: Chapter Seven 'Eris Quod Sum' | S3E7 | tt1185917 |
| R1792 | Heroes: Chapter Eight 'Villains' | S3E8 | tt1185918 |
| R1793 | Heroes: Chapter Nine 'It's Coming' | S3E9 | tt1185919 |
| R1794 | Heroes: Chapter Ten 'The Eclipse Part 1' | S3E10 | tt1185908 |
| R1795 | Heroes: Chapter Eleven 'The Eclipse - Part 2' | S3E11 | tt1185909 |
| R1796 | Heroes: Chapter Twelve 'Our Father' | S3E12 | tt1054833 |
| R1797 | Heroes: Chapter Thirteen 'Dual' | S3E13 | tt1054834 |
| R1798 | Heroes: Chapter One 'A Clear and Present Danger' | S3E14 | tt1054835 |
| R1799 | Heroes: Chapter Two 'Trust and Blood' | S3E15 | tt1054836 |
| R1800 | Heroes: Chapter Three 'Building 26' | S3E16 | tt1054837 |
| R1801 | Heroes: Chapter Four 'Cold Wars' | S3E17 | tt1054838 |
| R1802 | Heroes: Chapter Five 'Exposed' | S3E18 | tt1054839 |
| R1803 | Heroes: Chapter Six 'Shades of Gray' | S3E19 | tt1054840 |
| R1804 | Heroes: Chapter Seven 'Cold Snap' | S3E20 | tt1054842 |
| R1805 | Heroes: Chapter Eight 'Into Asylum' | S3E21 | tt1054843 |
| R1806 | Heroes: Chapter Nine 'Turn and Face the Strange' | S3E22 | tt1054844 |
| R1807 | Heroes: Chapter Ten '1961' | S3E23 | tt1054845 |
| R1808 | Heroes: Chapter Eleven 'I Am Sylar' | S3E24 | tt1385195 |
| R1809 | Heroes: Chapter Twelve 'An Invisible Thread' | S3E25 | tt1394706 |
| R1810 | Heroes: Chapter One 'Orientation/Jump, Push, Fall' | S4E1 | tt1486301 |
| R1811 | Heroes: Chapter Three 'Acceptance' | S4E3 | tt1510011 |
| R1812 | Heroes: Chapter Six 'Strange Attractors' | S4E6 | tt1510014 |
| R1813 | Heroes: Chapter Seven 'Once Upon a Time in Texas' | S4E7 | tt1510015 |
| R1814 | Heroes: Chapter Eight 'Shadowboxing' | S4E8 | tt1510016 |
| R1815 | Heroes: Chapter Nine 'Brother's Keeper' | S4E9 | tt1510002 |
| R1816 | Heroes: Chapter Nine 'Brother's Keeper' | S4E10 | tt1510002 |
| R1817 | Heroes: Chapter Ten 'Thanksgiving' | S4E11 | tt1510003 |
| R1818 | Heroes: Chapter Twelve 'Upon This Rock' | S4E12 | tt1510005 |
| R1819 | Heroes: Chapter Twelve 'Upon This Rock' | S4E13 | tt1510005 |
| R1820 | Heroes: Chapter Fourteen 'Close to You' | S4E14 | tt1510007 |
| R1821 | Heroes: Chapter Sixteen 'The Art of Deception' | S4E16 | tt1510009 |
| R1822 | Heroes: Chapter Seventeen 'The Wall' | S4E17 | tt1510010 |
| R1823 | Heroes: Chapter Eighteen 'Brave New World' | S4E18 | tt1582860 |
| R1824 | Heroes: Chapter Four 'Hysterical Blindness' | S4E4 | tt1510012 |
| R1825 | Heroes: Chapter Five 'Tabula Rasa' | S4E5 | tt1510013 |
| R1826 | Heroes: Chapter Fifteen 'Pass/Fail' | S4E15 | tt1510008 |

### Shows — Kung Fu (32)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1540 | Kung Fu: King of the Mountain | S1E1 | tt0623166 |
| R1541 | Kung Fu: Dark Angel | S1E2 | tt0623161 |
| R1542 | Kung Fu: Blood Brother | S1E3 | tt0623155 |
| R1543 | Kung Fu: An Eye for an Eye | S1E4 | tt0623149 |
| R1544 | Kung Fu: The Tide | S1E5 | tt0623200 |
| R1545 | Kung Fu: Nine Lives | S1E7 | tt0623169 |
| R1546 | Kung Fu: Sun and Cloud Shadow | S1E8 | tt0623171 |
| R1547 | Kung Fu: The Praying Mantis Kills | S1E9 | REJECT: Episode mismatch |
| R1548 | Kung Fu: Alethea | S1E10 | tt0623147 |
| R1549 | Kung Fu: Chains | S1E11 | REJECT: Episode mismatch |
| R1550 | Kung Fu: Superstition | S1E12 | tt0623172 |
| R1551 | Kung Fu: The Ancient Warrior | S1E15 | tt0623173 |
| R1552 | Kung Fu: The Well | S2E1 | tt0623204 |
| R1553 | Kung Fu: The Assassin | S2E2 | tt0623174 |
| R1554 | Kung Fu: The Chalice | S2E3 | tt0623179 |
| R1555 | Kung Fu: The Brujo | S2E4 | tt0623176 |
| R1556 | Kung Fu: The Squawman | S2E5 | tt0623196 |
| R1557 | Kung Fu: The Salamander | S2E9 | tt0623192 |
| R1558 | Kung Fu: The Cenotaph: Part I | S2E22 | tt0623177 |
| R1559 | Kung Fu: Blood of the Dragon: Part 1 | S3E1 | tt0623156 |
| R1560 | Kung Fu: Blood of the Dragon: Part 2 | S3E2 | tt1688547 |
| R1561 | Kung Fu: A Small Beheading | S3E3 | tt0623146 |
| R1562 | Kung Fu: The Predators | S3E5 | tt0623191 |
| R1563 | Kung Fu: My Brother, My Executioner | S3E6 | tt0623167 |
| R1564 | Kung Fu: The Garments of Rage | S3E9 | tt0623184 |
| R1565 | Kung Fu: Besieged: Death on Cold Mountain | S3E10 | tt0623154 |
| R1566 | Kung Fu: The Vanishing Image | S3E13 | tt0623202 |
| R1567 | Kung Fu: Battle Hymn | S3E17 | tt0623152 |
| R1568 | Kung Fu: Barbary House | S3E18 | tt0623151 |
| R1569 | Kung Fu: Flight to Orion | S3E19 | tt0623163 |
| R1570 | Kung Fu: Full Circle | S3E21 | tt0623164 |
| R1571 | Kung Fu: The Thief of Chendo | S3E22 | tt0623198 |

### Shows — Law & Order (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1139 | Law & Order: Confession | S2E1 | tt0629213 |

### Shows — Law and Order (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1140 | Law and Order: Out of Control | S2E8 | tt0629361 |

### Shows — Law and Order SVU (24)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1827 | Law and Order SVU: Payback | S1E1 | tt0629700 |
| R1828 | Law and Order SVU: A Single Life | S1E2 | tt0629606 |
| R1829 | Law and Order SVU: ...Or Just Look Like One | S1E3 | tt0629693 |
| R1830 | Law and Order SVU: Hysteria | S1E4 | tt0629669 |
| R1831 | Law and Order SVU: Wanderlust | S1E5 | tt0629753 |
| R1832 | Law and Order SVU: Sophomore Jinx | S1E6 | tt0629735 |
| R1833 | Law and Order SVU: Uncivilized | S1E7 | tt0629750 |
| R1834 | Law and Order SVU: Stalked | S1E8 | tt0629737 |
| R1835 | Law and Order SVU: Closure | S1E9 | tt0629626 |
| R1836 | Law and Order SVU: Bad Blood | S1E10 | tt0629614 |
| R1837 | Law and Order SVU: Russian Love Poem | S1E12 | tt0629725 |
| R1838 | Law and Order SVU: Disrobed | S1E13 | tt0629646 |
| R1839 | Law and Order SVU: Limitations | S1E14 | tt0629677 |
| R1840 | Law and Order SVU: Entitled | S1E15 | tt0629650 |
| R1841 | Law and Order SVU: The Third Guy | S1E16 | tt0629747 |
| R1842 | Law and Order SVU: Misleader | S1E17 | tt0629685 |
| R1843 | Law and Order SVU: Chat Room | S1E18 | tt0629624 |
| R1844 | Law and Order SVU: Contact | S1E19 | tt0629632 |
| R1845 | Law and Order SVU: Remorse | S1E20 | tt0629714 |
| R1846 | Law and Order SVU: Nocturne | S1E21 | tt0629690 |
| R1847 | Law and Order SVU: Slaves | S1E22 | tt0629734 |
| R1848 | Law and Order SVU: Lime Chaser | S24E17 | tt27135026 |
| R1849 | Law and Order SVU: King of the Moon | S24E15 | tt26347412 |
| R1850 | Law and Order SVU: Stocks & Bondage | S1E11 | tt0629739 |

### Shows — Party of Five (73)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0003 | Party of Five: Pilot | S1E1 | tt0670343 |
| R0004 | Party of Five: Thanksgiving | S1E10 | tt0670365 |
| R1851 | Party of Five: Pilot | S1E1 | tt0670343 |
| R1852 | Party of Five: Homework | S1E2 | tt0670310 |
| R1853 | Party of Five: Good Sports | S1E3 | tt0670299 |
| R1854 | Party of Five: Worth Waiting For | S1E4 | tt0670388 |
| R1855 | Party of Five: All's Fair | S1E5 | tt0670255 |
| R1856 | Party of Five: Fathers and Sons | S1E6 | tt0670282 |
| R1857 | Party of Five: Much Ado | S1E7 | tt0670328 |
| R1858 | Party of Five: Kiss Me Kate | S1E8 | tt0670320 |
| R1859 | Party of Five: Something Out of Nothing | S1E9 | tt0670356 |
| R1860 | Party of Five: Thanksgiving | S1E10 | tt0670365 |
| R1861 | Party of Five: Private Lives | S1E11 | tt0670347 |
| R1862 | Party of Five: Games People Play | S1E12 | tt0670291 |
| R1863 | Party of Five: Grownups | S1E13 | tt0670302 |
| R1864 | Party of Five: It's Not Easy Being Green | S1E15 | tt0670318 |
| R1865 | Party of Five: Aftershocks | S1E16 | tt0670254 |
| R1866 | Party of Five: Brother's Keeper | S1E19 | tt0670265 |
| R1867 | Party of Five: The Trouble with Charlie | S1E20 | tt0670371 |
| R1868 | Party of Five: The Ides of March | S1E22 | tt0670368 |
| R1869 | Party of Five: Ready or Not | S2E1 | tt0670349 |
| R1870 | Party of Five: Falsies | S2E2 | tt0670279 |
| R1871 | Party of Five: Dearly Beloved | S2E3 | tt0670272 |
| R1872 | Party of Five: Have No Fear | S2E4 | tt0670306 |
| R1873 | Party of Five: Change Partners... and Dance | S2E5 | tt0670267 |
| R1874 | Party of Five: Analogies | S2E6 | tt0670259 |
| R1875 | Party of Five: Where There's Smoke | S2E7 | tt0670385 |
| R1876 | Party of Five: Best Laid Plans | S2E8 | tt0670263 |
| R1877 | Party of Five: The Wedding | S2E9 | tt0670372 |
| R1878 | Party of Five: Grand Delusions | S2E10 | tt0670300 |
| R1879 | Party of Five: Unfair Advantage | S2E11 | tt0670379 |
| R1880 | Party of Five: Hold on Tight | S2E12 | tt0670309 |
| R1881 | Party of Five: Poor Substitutes | S2E13 | tt0670345 |
| R1882 | Party of Five: Strange Bedfellows | S2E14 | tt0670361 |
| R1883 | Party of Five: Benefactors | S2E15 | tt0670262 |
| R1884 | Party of Five: Comings and Goings | S2E16 | tt0670270 |
| R1885 | Party of Five: Valentine's Day | S2E17 | tt0670380 |
| R1886 | Party of Five: Before and After | S2E18 | tt0670261 |
| R1887 | Party of Five: Altered States | S2E19 | tt0670258 |
| R1888 | Party of Five: Happily Ever After | S2E20 | tt0670304 |
| R1889 | Party of Five: Spring Breaks: Part 1 | S2E21 | tt0670357 |
| R1890 | Party of Five: Spring Breaks: Part 2 | S2E22 | tt0670358 |
| R1891 | Party of Five: Summer Fun, Summer Not | S3E1 | tt0670362 |
| R1892 | Party of Five: Going, Going, Gone | S3E2 | tt0670298 |
| R1893 | Party of Five: Short Cuts | S3E3 | tt0670353 |
| R1894 | Party of Five: Mixed Signals | S3E5 | tt0670326 |
| R1895 | Party of Five: Going Home | S3E6 | tt0670297 |
| R1896 | Party of Five: Personal Demons | S3E7 | tt0670342 |
| R1897 | Party of Five: Not So Fast | S3E8 | tt0670332 |
| R1898 | Party of Five: Gimme Shelter | S3E9 | tt0670295 |
| R1899 | Party of Five: Close to You | S3E10 | tt0670269 |
| R1900 | Party of Five: I Do | S3E11 | tt0670312 |
| R1901 | Party of Five: Desperate Measures | S3E12 | tt0670273 |
| R1902 | Party of Five: Christmas | S3E13 | tt0670268 |
| R1903 | Party of Five: I Declare | S3E16 | tt0670311 |
| R1904 | Party of Five: Misery Loves Company | S3E17 | tt0670325 |
| R1905 | Party of Five: MYOB | S3E18 | tt0670324 |
| R1906 | Party of Five: Point of No Return | S3E19 | tt0670344 |
| R1907 | Party of Five: Handicaps | S4E3 | tt0670303 |
| R1908 | Party of Five: Fight or Flight | S4E5 | tt0670284 |
| R1909 | Party of Five: Immediate Family | S4E6 | tt0670315 |
| R1910 | Party of Five: Truth Be Told | S4E9 | tt0670378 |
| R1911 | Party of Five: Empty Shoes | S4E12 | tt0670277 |
| R1912 | Party of Five: Parent Trap | S4E13 | tt0670339 |
| R1913 | Party of Five: Of Human Bonding | S4E14 | tt0670333 |
| R1914 | Party of Five: Here and Now | S4E15 | tt0670307 |
| R1915 | Party of Five: I Give Up | S4E16 | tt0670313 |
| R1916 | Party of Five: Of Sound Mind and Body | S4E17 | tt0670334 |
| R1917 | Party of Five: True or False | S4E18 | tt0670377 |
| R1918 | Party of Five: Go Away | S4E19 | tt0670296 |
| R1919 | Party of Five: Moving On | S5E1 | tt0670327 |
| R1920 | Party of Five: Separation Anxiety | S5E2 | tt0670352 |
| R1921 | Party of Five: Forgive and/or Forget | S5E6 | tt0670288 |

### Shows — Rick and Morty (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1135 | Rick and Morty: Something Ricked This Way Comes | S1E9 | tt3333840 |

### Shows — Sopranos, The (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0005 | Sopranos, The: Denial, Anger, Acceptance | S1E3 | tt0705239 |

### Shows — Star Trek - 02 - The Next Generation (2)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0007 | Star Trek - 02 - The Next Generation: The Inner Light | S5E25 | tt0708803 |
| R1129 | Star Trek - 02 - The Next Generation: Where No One Has Gone Before | S1E6 | tt0708842 |

### Shows — Star Trek - 04 - Voyager (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1141 | Star Trek - 04 - Voyager: Heroes and Demons | S1E11 | tt0708906 |

### Shows — Stranger Things (3)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1128 | Stranger Things: Chapter Three: Holly, Jolly | S1E3 | tt4593126 |
| R1138 | Stranger Things: Chapter Six: The Monster | S1E6 | tt4593132 |
| R1142 | Stranger Things: Chapter Four: Will the Wise | S2E4 | tt6020802 |

### Shows — The Mandalorian (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0006 | The Mandalorian: Chapter 4: Sanctuary | S1E4 | tt9121536 |

### Shows — The Orville (1)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1132 | The Orville: Majority Rule | S1E7 | tt6845666 |

### Shows — The Prisoner (17)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1131 | The Prisoner: The General | S1E5 | tt0679186 |
| R1425 | The Prisoner: The Chimes of Big Ben | S1E1 | tt0679185 |
| R1426 | The Prisoner: A. B. and C. | S1E2 | tt0679173 |
| R1427 | The Prisoner: Free for All | S1E3 | tt0679179 |
| R1428 | The Prisoner: The Schizoid Man | S1E4 | tt0679188 |
| R1429 | The Prisoner: The General | S1E5 | tt0679186 |
| R1430 | The Prisoner: Many Happy Returns | S1E6 | tt0679183 |
| R1431 | The Prisoner: Dance of the Dead | S1E7 | tt0679176 |
| R1432 | The Prisoner: Checkmate | S1E8 | tt0679175 |
| R1433 | The Prisoner: Hammer Into Anvil | S1E9 | tt0679180 |
| R1434 | The Prisoner: It's Your Funeral | S1E10 | tt0679181 |
| R1435 | The Prisoner: A Change of Mind | S1E11 | tt0679172 |
| R1436 | The Prisoner: Do Not Forsake Me Oh My Darling | S1E12 | tt0679177 |
| R1437 | The Prisoner: Living in Harmony | S1E13 | tt0679182 |
| R1438 | The Prisoner: The Girl Who Was Death | S1E14 | tt0679187 |
| R1439 | The Prisoner: Once Upon a Time | S1E15 | tt0679184 |
| R1440 | The Prisoner: Fall Out | S1E16 | tt0679178 |

### Shows — The West Wing (82)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R0008 | The West Wing: In the Shadow of Two Gunmen: Part I | S2E1 | tt0745639 |
| R1134 | The West Wing: Mr. Willis of Ohio | S1E6 | tt0745659 |
| R1279 | The West Wing: Arctic Radar | S4E10 | tt0745597 |
| R1280 | The West Wing: Holy Night | S4E11 | tt0745633 |
| R1281 | The West Wing: Guns Not Butter | S4E12 | tt0745627 |
| R1282 | The West Wing: The Long Goodbye | S4E13 | tt0745699 |
| R1283 | The West Wing: Inauguration: Part 1 | S4E14 | tt0745642 |
| R1284 | The West Wing: Inauguration: Part 2 - Over There | S4E15 | tt0745641 |
| R1285 | The West Wing: The California 47th | S4E16 | tt0745601 |
| R1286 | The West Wing: Red Haven's on Fire | S4E17 | tt0745672 |
| R1287 | The West Wing: Privateers | S4E18 | tt0745670 |
| R1288 | The West Wing: Angel Maintenance | S4E19 | tt0745596 |
| R1289 | The West Wing: Evidence of Things Not Seen | S4E20 | tt0745618 |
| R1290 | The West Wing: Life on Mars | S4E21 | tt0745650 |
| R1291 | The West Wing: Commencement | S4E22 | tt0745604 |
| R1292 | The West Wing: Twenty Five | S4E23 | tt0745720 |
| R1293 | The West Wing: 7A WF 83429 | S5E1 | tt0745588 |
| R1294 | The West Wing: The Dogs of War | S5E2 | tt0745609 |
| R1295 | The West Wing: Jefferson Lives | S5E3 | tt0745645 |
| R1296 | The West Wing: Han | S5E4 | tt0745629 |
| R1297 | The West Wing: Constituency of One | S5E5 | tt0745605 |
| R1298 | The West Wing: Disaster Relief | S5E6 | tt0745608 |
| R1299 | The West Wing: Separation of Powers | S5E7 | tt0745674 |
| R1300 | The West Wing: Shutdown | S5E8 | tt0745676 |
| R1301 | The West Wing: Abu el Banat | S5E9 | tt0745592 |
| R1302 | The West Wing: The Stormy Present | S5E10 | tt0745707 |
| R1303 | The West Wing: The Benign Prerogative | S5E11 | tt0745686 |
| R1304 | The West Wing: Slow News Day | S5E12 | tt0745678 |
| R1305 | The West Wing: The Warfare of Genghis Khan | S5E13 | tt0745714 |
| R1306 | The West Wing: An Khe | S5E14 | tt0745594 |
| R1307 | The West Wing: Full Disclosure | S5E15 | tt0745622 |
| R1308 | The West Wing: Eppur Si Muove | S5E16 | tt0745617 |
| R1309 | The West Wing: The Supremes | S5E17 | tt0745708 |
| R1310 | The West Wing: Access | S5E18 | tt0745593 |
| R1311 | The West Wing: Talking Points | S5E19 | tt0745684 |
| R1312 | The West Wing: No Exit | S5E20 | tt0745663 |
| R1313 | The West Wing: Gaza | S5E21 | tt0745625 |
| R1314 | The West Wing: Memorial Day | S5E22 | tt0745656 |
| R1315 | The West Wing: N.S.F. Thurmont | S6E1 | tt0745660 |
| R1316 | The West Wing: The Birnam Wood | S6E2 | tt0745687 |
| R1317 | The West Wing: Third-Day Story | S6E3 | tt0745719 |
| R1318 | The West Wing: Liftoff | S6E4 | tt0745651 |
| R1319 | The West Wing: The Hubbert Peak | S6E5 | tt0745695 |
| R1320 | The West Wing: The Dover Test | S6E6 | tt0745692 |
| R1321 | The West Wing: A Change Is Gonna Come | S6E7 | tt0745589 |
| R1322 | The West Wing: In the Room | S6E8 | tt0745638 |
| R1323 | The West Wing: Impact Winter | S6E9 | tt0745634 |
| R1324 | The West Wing: Faith-Based Initiative | S6E10 | tt0745619 |
| R1325 | The West Wing: Opposition Research | S6E11 | tt0745666 |
| R1326 | The West Wing: 365 Days | S6E12 | tt0745587 |
| R1327 | The West Wing: King Corn | S6E13 | tt0745646 |
| R1328 | The West Wing: The Wake Up Call | S6E14 | tt0745712 |
| R1329 | The West Wing: Freedonia | S6E15 | tt0745621 |
| R1330 | The West Wing: Drought Conditions | S6E16 | tt0745610 |
| R1331 | The West Wing: A Good Day | S6E17 | tt0745590 |
| R1332 | The West Wing: La Palabra | S6E18 | tt0745647 |
| R1333 | The West Wing: Ninety Miles Away | S6E19 | tt0745662 |
| R1334 | The West Wing: In God We Trust | S6E20 | tt0745636 |
| R1335 | The West Wing: Things Fall Apart | S6E21 | tt0745718 |
| R1336 | The West Wing: 2162 Votes | S6E22 | tt0745586 |
| R1337 | The West Wing: The Ticket | S7E1 | tt0745709 |
| R1338 | The West Wing: The Mommy Problem | S7E2 | tt0745701 |
| R1339 | The West Wing: Message of the Week | S7E3 | tt0745657 |
| R1340 | The West Wing: Mr. Frost | S7E4 | tt0745658 |
| R1341 | The West Wing: Here Today | S7E5 | tt0745632 |
| R1342 | The West Wing: The Al Smith Dinner | S7E6 | tt0745685 |
| R1343 | The West Wing: The Debate | S7E7 | tt0745691 |
| R1344 | The West Wing: Undecideds | S7E8 | tt0745723 |
| R1345 | The West Wing: The Wedding | S7E9 | tt0745715 |
| R1346 | The West Wing: Running Mates | S7E10 | tt0745673 |
| R1347 | The West Wing: Internal Displacement | S7E11 | tt0745643 |
| R1348 | The West Wing: Duck and Cover | S7E12 | tt0745611 |
| R1349 | The West Wing: The Cold | S7E13 | tt0745689 |
| R1350 | The West Wing: Two Weeks Out | S7E14 | tt0745722 |
| R1351 | The West Wing: Welcome to Wherever You Are | S7E15 | tt0745727 |
| R1352 | The West Wing: Election Day: Part 1 | S7E16 | tt0745612 |
| R1353 | The West Wing: Election Day: Part 2 | S7E17 | tt0779710 |
| R1354 | The West Wing: Requiem | S7E18 | tt0761559 |
| R1355 | The West Wing: Transition | S7E19 | tt0779711 |
| R1356 | The West Wing: The Last Hurrah | S7E20 | tt0779709 |
| R1357 | The West Wing: Institutional Memory | S7E21 | tt0771575 |
| R1358 | The West Wing: Tomorrow | S7E22 | tt0771576 |

### Shows — The White Lotus (6)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1359 | The White Lotus: Arrivals | S1E1 | tt13868048 |
| R1360 | The White Lotus: New Day | S1E2 | tt13868046 |
| R1361 | The White Lotus: Mysterious Monkeys | S1E3 | tt13868050 |
| R1362 | The White Lotus: Recentering | S1E4 | tt13868052 |
| R1363 | The White Lotus: The Lotus-Eaters | S1E5 | tt13868056 |
| R1364 | The White Lotus: Departures | S1E6 | tt13868058 |

### Shows — The Wire (62)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1133 | The Wire: Sentencing | S1E13 | tt0749441 |
| R1136 | The Wire: The Pager | S1E5 | tt0749450 |
| R1365 | The Wire: The Target | S1E1 | tt0749451 |
| R1366 | The Wire: The Detail | S1E2 | tt0749448 |
| R1367 | The Wire: The Buys | S1E3 | tt0749446 |
| R1368 | The Wire: Old Cases | S1E4 | tt0749437 |
| R1369 | The Wire: The Pager | S1E5 | tt0749450 |
| R1370 | The Wire: The Wire | S1E6 | tt0749452 |
| R1371 | The Wire: One Arrest | S1E7 | tt0749438 |
| R1372 | The Wire: Lessons | S1E8 | tt0749433 |
| R1373 | The Wire: Game Day | S1E9 | tt0749429 |
| R1374 | The Wire: The Cost | S1E10 | tt0749447 |
| R1375 | The Wire: The Hunt | S1E11 | tt0749449 |
| R1376 | The Wire: Cleaning Up | S1E12 | tt0749424 |
| R1377 | The Wire: Sentencing | S1E13 | tt0749441 |
| R1378 | The Wire: Ebb Tide | S2E1 | tt0749428 |
| R1379 | The Wire: Collateral Damage | S2E2 | tt0749425 |
| R1380 | The Wire: Hot Shots | S2E3 | tt0749432 |
| R1381 | The Wire: Hard Cases | S2E4 | tt0749430 |
| R1382 | The Wire: Undertow | S2E5 | tt0749454 |
| R1383 | The Wire: All Prologue | S2E6 | tt0749419 |
| R1384 | The Wire: Backwash | S2E7 | tt0749422 |
| R1385 | The Wire: Duck and Cover | S2E8 | tt0749427 |
| R1386 | The Wire: Stray Rounds | S2E9 | tt0749445 |
| R1387 | The Wire: Storm Warnings | S2E10 | tt0749443 |
| R1388 | The Wire: Bad Dreams | S2E11 | tt0749423 |
| R1389 | The Wire: Port in a Storm | S2E12 | tt0749439 |
| R1390 | The Wire: Time After Time | S3E1 | tt0749453 |
| R1391 | The Wire: All Due Respect | S3E2 | tt0749418 |
| R1392 | The Wire: Dead Soldiers | S3E3 | tt0749426 |
| R1393 | The Wire: Amsterdam | S3E4 | tt0749420 |
| R1394 | The Wire: Straight and True | S3E5 | tt0749444 |
| R1395 | The Wire: Homecoming | S3E6 | tt0749431 |
| R1396 | The Wire: Back Burners | S3E7 | tt0749421 |
| R1397 | The Wire: Moral Midgetry | S3E8 | tt0749436 |
| R1398 | The Wire: Slapstick | S3E9 | tt0749442 |
| R1399 | The Wire: Reformation | S3E10 | tt0749440 |
| R1400 | The Wire: Middle Ground | S3E11 | tt0749434 |
| R1401 | The Wire: Mission Accomplished | S3E12 | tt0749435 |
| R1402 | The Wire: Boys of Summer | S4E1 | tt0763093 |
| R1403 | The Wire: Soft Eyes | S4E2 | tt0763095 |
| R1404 | The Wire: Home Rooms | S4E3 | tt0763096 |
| R1405 | The Wire: Refugees | S4E4 | tt0763097 |
| R1406 | The Wire: Alliances | S4E5 | tt0763098 |
| R1407 | The Wire: Margin of Error | S4E6 | tt0763099 |
| R1408 | The Wire: Unto Others | S4E7 | tt0758650 |
| R1409 | The Wire: Corner Boys | S4E8 | tt0796549 |
| R1410 | The Wire: Know Your Place | S4E9 | tt0763100 |
| R1411 | The Wire: Misgivings | S4E10 | tt0763094 |
| R1412 | The Wire: A New Day | S4E11 | tt0782660 |
| R1413 | The Wire: That's Got His Own | S4E12 | tt0796551 |
| R1414 | The Wire: Final Grades | S4E13 | tt0796550 |
| R1415 | The Wire: More with Less | S5E1 | tt0977178 |
| R1416 | The Wire: Unconfirmed Reports | S5E2 | tt0985516 |
| R1417 | The Wire: Not for Attribution | S5E3 | tt0977180 |
| R1418 | The Wire: Transitions | S5E4 | tt0977181 |
| R1419 | The Wire: React Quotes | S5E5 | tt0977182 |
| R1420 | The Wire: The Dickensian Aspect | S5E6 | tt0977183 |
| R1421 | The Wire: Took | S5E7 | tt0977184 |
| R1422 | The Wire: Clarifications | S5E8 | tt0977185 |
| R1423 | The Wire: Late Editions | S5E9 | tt0977186 |
| R1424 | The Wire: -30- | S5E10 | tt0977179 |

### Shows — Twin Peaks (44)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1441 | Twin Peaks: Episode #2.1 | S2E1 | REJECT: Episode mismatch |
| R1442 | Twin Peaks: Episode #2.1 | S2E1 | REJECT: Episode mismatch |
| R1443 | Twin Peaks: Coma | S2E2 | tt0734817 |
| R1444 | Twin Peaks: Coma | S2E2 | REJECT: Episode mismatch |
| R1445 | Twin Peaks: The Man Behind the Glass | S2E3 | tt0734836 |
| R1446 | Twin Peaks: The Man Behind the Glass | S2E3 | REJECT: Episode mismatch |
| R1447 | Twin Peaks: Laura's Secret Diary | S2E4 | tt0734823 |
| R1448 | Twin Peaks: Laura's Secret Diary | S2E4 | REJECT: Episode mismatch |
| R1449 | Twin Peaks: The Orchid's Curse | S2E5 | tt0734838 |
| R1450 | Twin Peaks: The Orchid's Curse | S2E5 | REJECT: Episode mismatch |
| R1451 | Twin Peaks: Demons | S2E6 | tt0734819 |
| R1452 | Twin Peaks: Demons | S2E6 | REJECT: Episode mismatch |
| R1453 | Twin Peaks: Lonely Souls | S2E7 | tt0734824 |
| R1454 | Twin Peaks: Lonely Souls | S2E7 | REJECT: Episode mismatch |
| R1455 | Twin Peaks: Drive with a Dead Girl | S2E8 | tt0734822 |
| R1456 | Twin Peaks: Drive with a Dead Girl | S2E8 | REJECT: Episode mismatch |
| R1457 | Twin Peaks: Arbitrary Law | S2E9 | tt0734814 |
| R1458 | Twin Peaks: Arbitrary Law | S2E9 | REJECT: Episode mismatch |
| R1459 | Twin Peaks: Dispute Between Brothers | S2E10 | tt0734820 |
| R1460 | Twin Peaks: Dispute Between Brothers | S2E10 | REJECT: Episode mismatch |
| R1461 | Twin Peaks: Masked Ball | S2E11 | tt0734825 |
| R1462 | Twin Peaks: Masked Ball | S2E11 | REJECT: Episode mismatch |
| R1463 | Twin Peaks: The Black Widow | S2E12 | tt0734833 |
| R1464 | Twin Peaks: The Black Widow | S2E12 | REJECT: Episode mismatch |
| R1465 | Twin Peaks: Checkmate | S2E13 | tt0734816 |
| R1466 | Twin Peaks: Checkmate | S2E13 | REJECT: Episode mismatch |
| R1467 | Twin Peaks: Double Play | S2E14 | tt0734821 |
| R1468 | Twin Peaks: Double Play | S2E14 | REJECT: Episode mismatch |
| R1469 | Twin Peaks: Slaves and Masters | S2E15 | tt0734832 |
| R1470 | Twin Peaks: Slaves and Masters | S2E15 | REJECT: Episode mismatch |
| R1471 | Twin Peaks: The Condemned Woman | S2E16 | tt0734834 |
| R1472 | Twin Peaks: The Condemned Woman | S2E16 | REJECT: Episode mismatch |
| R1473 | Twin Peaks: Wounds and Scars | S2E17 | tt0734842 |
| R1474 | Twin Peaks: Wounds and Scars | S2E17 | REJECT: Episode mismatch |
| R1475 | Twin Peaks: On the Wings of Love | S2E18 | tt0734828 |
| R1476 | Twin Peaks: On the Wings of Love | S2E18 | REJECT: Episode mismatch |
| R1477 | Twin Peaks: Variations on Relations | S2E19 | tt0734841 |
| R1478 | Twin Peaks: Variations on Relations | S2E19 | REJECT: Episode mismatch |
| R1479 | Twin Peaks: The Path to the Black Lodge | S2E20 | tt0734839 |
| R1480 | Twin Peaks: The Path to the Black Lodge | S2E20 | REJECT: Episode mismatch |
| R1481 | Twin Peaks: Miss Twin Peaks | S2E21 | tt0734827 |
| R1482 | Twin Peaks: Miss Twin Peaks | S2E21 | REJECT: Episode mismatch |
| R1483 | Twin Peaks: Beyond Life and Death | S2E22 | tt0734815 |
| R1484 | Twin Peaks: Beyond Life and Death | S2E22 | REJECT: Episode mismatch |

### Shows — Vikings (7)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1137 | Vikings: Dispossessed | S1E3 | tt2245918 |
| R1485 | Vikings: Trial | S1E4 | tt2245920 |
| R1486 | Vikings: Raid | S1E5 | tt2245922 |
| R1487 | Vikings: Burial of the Dead | S1E6 | tt2245926 |
| R1488 | Vikings: A King's Ransom | S1E7 | tt2245928 |
| R1489 | Vikings: Sacrifice | S1E8 | tt2245930 |
| R1490 | Vikings: All Change | S1E9 | tt2245932 |

### Shows — WandaVision (9)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1491 | WandaVision: Filmed Before a Live Studio Audience | S1E1 | tt9601584 |
| R1492 | WandaVision: Don't Touch That Dial | S1E2 | tt10161310 |
| R1493 | WandaVision: Now in Color | S1E3 | tt10161312 |
| R1494 | WandaVision: We Interrupt This Program | S1E4 | tt10161316 |
| R1495 | WandaVision: On a Very Special Episode... | S1E5 | tt10161318 |
| R1496 | WandaVision: All-New Halloween Spooktacular! | S1E6 | tt10161320 |
| R1497 | WandaVision: Breaking the Fourth Wall | S1E7 | tt13776690 |
| R1498 | WandaVision: Previously On | S1E8 | tt13776714 |
| R1499 | WandaVision: The Series Finale | S1E9 | tt13778978 |

### Shows — Wizards of Waverly Place (21)

| Case | Recorded result label | Local numbering | Expected outcome |
| --- | --- | --- | --- |
| R1500 | Wizards of Waverly Place: The Crazy 10 Minute Sale | S1E1 | tt0985517 |
| R1501 | Wizards of Waverly Place: First Kiss | S1E2 | tt1027639 |
| R1502 | Wizards of Waverly Place: I Almost Drowned in a Chocolate Fountain | S1E3 | tt1001292 |
| R1503 | Wizards of Waverly Place: New Employee | S1E4 | tt1023854 |
| R1504 | Wizards of Waverly Place: Disenchanted Evening | S1E5 | tt1061988 |
| R1505 | Wizards of Waverly Place: You Can't Always Get What You Carpet | S1E6 | tt1027640 |
| R1506 | Wizards of Waverly Place: Alex's Choice | S1E7 | tt1034000 |
| R1507 | Wizards of Waverly Place: Curb Your Dragon | S1E8 | tt1036983 |
| R1508 | Wizards of Waverly Place: Movies | S1E9 | tt1053189 |
| R1509 | Wizards of Waverly Place: Pop Me and We Both Go Down | S1E10 | tt1084645 |
| R1510 | Wizards of Waverly Place: Potion Commotion | S1E11 | tt1079949 |
| R1511 | Wizards of Waverly Place: Little Sister | S1E12 | tt1075286 |
| R1512 | Wizards of Waverly Place: Wizard School: Part 1 | S1E13 | tt1045552 |
| R1513 | Wizards of Waverly Place: Wizard School: Part 2 | S1E14 | tt1240891 |
| R1514 | Wizards of Waverly Place: The Supernatural | S1E15 | tt1081895 |
| R1515 | Wizards of Waverly Place: Alex in the Middle | S1E16 | tt1027638 |
| R1516 | Wizards of Waverly Place: Report Card | S1E17 | tt1091157 |
| R1517 | Wizards of Waverly Place: Credit Check | S1E18 | tt1088925 |
| R1518 | Wizards of Waverly Place: Alex's Spring Fling | S1E19 | tt1093793 |
| R1519 | Wizards of Waverly Place: Quinceanera | S1E20 | tt1075287 |
| R1520 | Wizards of Waverly Place: Art Museum Piece | S1E21 | tt1093794 |

## Retry and interpret a real run

Use **Auto-Tag Selected** on the affected previously unmatched episodes.
Whole-library Auto-Tag still skips entries already marked attempted. If a saved
IMDb ID is itself wrong, clear it and correct the identifying tags, or use
Reset from Filename before retrying. The patch itself does not reset library
tags or attempt flags.

The INFO file now includes `Series discovery diagnostics` (attempted queries,
returned candidates, rejection reasons), `Recovered series through fallback
discovery`, and `Automatic tagging series discovery summary` (requests, reuse,
fallback activity, recovered parents). Include those entries with the ordinary
completion summary when measuring the next run. Test success does not replace
the remaining live-catalog check.
