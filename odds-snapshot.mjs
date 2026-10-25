#!/usr/bin/env node
/* odds-snapshot.mjs — odds-2026-09-06d
 *
 * Captures betting odds into history/odds/ as immutable per-gameweek JSON.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Odds are as perishable as ep_next, and worse: no free tier sells you the
 * past. Once a match settles, its pre-match prices stop being served and are
 * gone. A gameweek not captured is permanently uncapturable, so this script
 * has to be running long before anything is built on top of it. Capture first,
 * model later.
 *
 * WHY THE RESPONSE IS STORED RAW
 *
 * The parse is not settled. The sample response carries ~50 markets per
 * bookmaker and it is not yet known which ones earn their place — anytime
 * goalscorer and clean sheet look most useful, but goalkeeper saves, team
 * totals and the multi-scorer ladders may all end up in the model. Reparsing
 * frozen JSON is free. Refetching it is impossible. So the whole response body
 * goes to disk untouched, and every parsing decision happens downstream.
 *
 * Cost of that choice: roughly 400KB per gameweek at two bookmakers, so on the
 * order of 15MB across a season. Acceptable in a repo. Revisit if it isn't.
 *
 * WHAT IS ACTUALLY HARD HERE
 *
 * Joining odds events to FPL fixtures. The two sources name clubs differently
 * ("Wolverhampton Wanderers" vs "Wolves", "Spurs" vs "Tottenham Hotspur") and
 * there is no shared identifier. TEAM_ALIASES below is the bridge. It is
 * hand-written, which this project has learned to distrust, so unmatched
 * fixtures are reported loudly and recorded in the output file rather than
 * silently dropped. RUN probe FIRST and check the join before trusting a
 * single capture.
 *
 * TWO CAPTURE POINTS
 *
 * Odds are captured twice per gameweek, and the pair is the point:
 *
 *   early   ~24h before the deadline
 *   late    ~1.5h before the deadline
 *
 * The movement between them is the market repricing on team news, which is an
 * independent read on who is actually starting — often ahead of FPL's own
 * chance_of_playing, which lags press conferences. That delta is the feature.
 *
 * The early capture is NOT a substitute for the late one. The live model runs
 * at the deadline, so a backtest fed early prices is testing against
 * information production will not have. Same trap as a post-deadline ep_next,
 * in a different coat. Use late as the input and the delta as a signal.
 *
 * Commands:
 *   node odds-snapshot.mjs probe    dump raw responses, confirm slugs and the join
 *   node odds-snapshot.mjs pre      capture whichever point the clock is in
 *
 * Flags:
 *   --out <dir>       root output dir (default ./history/odds)
 *   --season <s>      season folder name (default derived from date)
 *   --bookmakers <l>  comma-separated (default Bet365,Unibet)
 *   --point <p>       force a capture point (early|late), bypassing the clock
 *   --any             capture regardless of the clock, tagged 'adhoc'
 *   --force           overwrite files that already exist
 *   --dry             fetch and report, write nothing
 *
 * The API key is read from the ODDS_API_KEY environment variable, never a
 * flag. Flags land in shell history and in Actions logs.
 */

const ODDS_API = 'https://api.odds-api.io/v3';
const FPL_API = 'https://fantasy.premierleague.com/api';

/* Confirmed by probe. If the API renames it, probe will say so. */
const PL_SLUG = 'england-premier-league';
const SPORT_SLUG = 'football';

/* Free tier allocates two recreational books. Bet365 carries much the deeper
 * prop coverage; Unibet is a genuinely independent price rather than a
 * regional skin of the same operator, which several other options on the list
 * are. The response may also contain keys that were not requested — the sample
 * returned a "Bet365 (no latency)" feed carrying three markets. Those are kept
 * as captured and dealt with at parse time. */
const DEFAULT_BOOKMAKERS = 'Bet365,Unibet';

/* Capture points, as bands of minutes before the deadline.
 *
 * Bands rather than ceilings, because the cron fires hourly and each point
 * must be hit exactly once. A ceiling ("within 150 minutes") would fire on
 * every run from there down to the deadline; a band fires only while the clock
 * is inside it, and the idempotent write handles the rest.
 *
 * The bands are wider than they look like they need to be, deliberately.
 * GitHub's scheduler is best-effort: a cron can be delayed ten minutes or
 * skipped entirely under load, so each band spans enough hours that several
 * runs can hit it and any one suffices. A simulation across on-the-hour,
 * half-past and quarter-past deadlines showed a 60-150m late band firing only
 * once for on-the-hour deadlines — one skipped run and the capture was gone.
 * 55-175m always fires at least twice.
 *
 * Widening `late` costs nothing, because nothing arrives during it. The FPL
 * deadline sits 90 minutes before the first kickoff and confirmed lineups are
 * published 60 minutes before kickoff — after the deadline has passed. So no
 * capture on either side of this band ever sees a confirmed lineup. What the
 * early-to-late delta actually measures is the market repricing on press
 * conference news from the preceding day or two, and a 24h span brackets that
 * comfortably regardless of where inside the band the late capture lands. */
const CAPTURES = [
  { point: 'early', minMins: 22 * 60, maxMins: 26 * 60 },
  { point: 'late',  minMins: 55,      maxMins: 175 },
];

/* Odds-API club names on the left, FPL bootstrap `name` on the right.
 * Only entries that normalisation alone cannot reconcile.
 *
 * Confirmed against a live probe. Note what is NOT here: FPL spells several
 * clubs in full ("Ipswich Town", "Hull City", "Coventry City", "Leeds United"
 * is not — it is "Leeds"), so an alias that shortens "Ipswich Town" to
 * "Ipswich" moves the odds name AWAY from the FPL name and breaks a join that
 * would otherwise have worked untouched. Every entry below earns its place by
 * bridging a real difference. Add nothing on the assumption that a club has a
 * short name — check the probe output instead. */
const TEAM_ALIASES = {
  'manchester city': 'man city',
  'manchester united': 'man utd',
  'tottenham hotspur': 'spurs',
  'tottenham': 'spurs',
  'wolverhampton wanderers': 'wolves',
  'nottingham forest': "nott'm forest",
  'newcastle united': 'newcastle',
  'west ham united': 'west ham',
  'brighton and hove albion': 'brighton',
  'brighton hove albion': 'brighton',
  'leeds united': 'leeds',
};

/* ── PLUMBING ─────────────────────────────────────────────────────────── */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const OUT = flag('out', './history/odds');
const FORCE = has('force');
const DRY = has('dry');
const BOOKMAKERS = flag('bookmakers', DEFAULT_BOOKMAKERS);
const KEY = process.env.ODDS_API_KEY;

/* Browser-like headers. The FPL API 403s a bare fetch. */
const FPL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://fantasy.premierleague.com/',
};

/* FPL labels a season by its starting year: Aug 2026 onward is 2026-27. */
function currentSeason() {
  const explicit = flag('season');
  if (explicit) return explicit;
  const d = new Date();
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function fplGet(path) {
  const url = `${FPL_API}/${path}`;
  const res = await fetch(url, { headers: FPL_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/* Auth is a query parameter on this API. The key is redacted from any error
 * message so it cannot reach a log. */
async function oddsGet(path, params = {}, needsKey = true) {
  const qs = new URLSearchParams(params);
  if (needsKey) {
    if (!KEY) throw new Error('ODDS_API_KEY is not set');
    qs.set('apiKey', KEY);
  }
  const url = `${ODDS_API}/${path}?${qs}`;
  const safe = url.replace(/apiKey=[^&]*/, 'apiKey=REDACTED');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${safe}`);
  const body = await res.json();
  if (body && body.error) throw new Error(`API error for ${safe}: ${body.error}`);
  return body;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function writeJSON(path, obj) {
  if (DRY) { console.log(`  [dry] would write ${path}`); return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 0) + '\n', 'utf8');
  console.log(`  wrote ${path}`);
}

/* Strip accents, lowercase, drop club-type suffixes and prefixes. Bet365
 * strips diacritics and Unibet keeps them, so this runs on every name from
 * every source before comparison. */
function normName(s) {
  if (!s) return '';
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(fc|afc|cf|sc)\b/g, '')
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Odds-API club name -> FPL bootstrap `name`, via alias table then plain
 * normalisation. */
function toFplName(oddsName) {
  const n = normName(oddsName);
  return TEAM_ALIASES[n] || n;
}

/* Index odds events by club pair. Deliberately a list per pair rather than a
 * single event: the events endpoint returns months of fixtures, not the next
 * gameweek, and a last-write-wins map would silently bind a fixture in
 * December to a gameweek in September. An ordered pair is unique within one
 * season, so today this list is always length one — but "always" here rests on
 * the API's window never crossing a season boundary, which is not a promise
 * anyone made. */
function indexEvents(events) {
  const idx = new Map();
  for (const ev of (events || [])) {
    const key = `${toFplName(ev.home)}|${toFplName(ev.away)}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(ev);
  }
  return idx;
}

/* Resolve one FPL fixture to one odds event, nearest kickoff wins. Returns the
 * event plus how far apart the two sources think the match is, so a bad match
 * is visible rather than assumed good. */
function matchEvent(idx, home, away, kickoff) {
  const candidates = idx.get(`${home}|${away}`) || [];
  if (!candidates.length) return null;
  const k = kickoff ? new Date(kickoff).getTime() : null;
  if (k == null) return { event: candidates[0], hoursApart: null, ambiguous: candidates.length > 1 };
  let best = null, bestGap = Infinity;
  for (const ev of candidates) {
    const gap = Math.abs(new Date(ev.date).getTime() - k);
    if (gap < bestGap) { bestGap = gap; best = ev; }
  }
  return {
    event: best,
    hoursApart: Math.round(bestGap / 3600000 * 10) / 10,
    ambiguous: candidates.length > 1,
  };
}

/* Kickoff times can legitimately differ a little between sources, but not by
 * much. Beyond this the two are describing different fixtures. */
const MAX_KICKOFF_GAP_HOURS = 36;

/* ── PROBE ────────────────────────────────────────────────────────────── */

async function probe() {
  const dir = join(OUT, '_probe');
  console.log('probe: fetching raw responses, parsing nothing\n');

  /* No auth on these two — they work even with a broken key, which makes them
   * a useful first check that the endpoint itself is reachable. */
  const sports = await oddsGet('sports', {}, false);
  await writeJSON(join(dir, 'sports.json'), sports);
  const hasFootball = Array.isArray(sports) &&
    sports.some(s => (s.slug || s.name || '').toLowerCase().includes('football'));
  console.log(`  sport slug "${SPORT_SLUG}" present: ${hasFootball}`);

  const books = await oddsGet('bookmakers', {}, false);
  await writeJSON(join(dir, 'bookmakers.json'), books);
  const wanted = BOOKMAKERS.split(',').map(s => s.trim());
  const names = new Set((books || []).map(b => b.name));
  for (const w of wanted) {
    console.log(`  bookmaker "${w}": ${names.has(w) ? 'valid' : 'NOT A VALID NAME'}`);
  }

  const selected = await oddsGet('bookmakers/selected');
  console.log(`  selected on this key: ${JSON.stringify(selected)}`);

  const leagues = await oddsGet('leagues', { sport: SPORT_SLUG });
  await writeJSON(join(dir, 'leagues.json'), leagues);
  const pl = (leagues || []).find(l => (l.slug || '') === PL_SLUG);
  console.log(`  league slug "${PL_SLUG}": ${pl ? 'confirmed' : 'NOT FOUND'}`);
  if (!pl) {
    const candidates = (leagues || [])
      .filter(l => /premier/i.test(l.name || '') && /england/i.test(l.name || ''))
      .map(l => l.slug);
    console.log(`  candidates: ${candidates.join(', ') || 'none matched england+premier'}`);
  }

  const events = await oddsGet('events', { sport: SPORT_SLUG, league: PL_SLUG });
  await writeJSON(join(dir, 'events.json'), events);
  console.log(`  events returned: ${Array.isArray(events) ? events.length : 'not an array'}`);

  /* The join. This is the part most likely to be wrong. */
  const boot = await fplGet('bootstrap-static/');
  const next = (boot.events || []).find(e => e.is_next) || (boot.events || []).find(e => !e.finished);
  const fixtures = next ? await fplGet(`fixtures/?event=${next.id}`) : [];
  const fplNames = Object.fromEntries((boot.teams || []).map(t => [t.id, t.name]));

  console.log(`\n--- fixture join, FPL gameweek ${next ? next.id : '?'} ---`);
  const idx = indexEvents(events);
  let matched = 0;
  const matchedEvents = [];
  for (const f of fixtures) {
    const h = normName(fplNames[f.team_h]);
    const a = normName(fplNames[f.team_a]);
    const m = matchEvent(idx, h, a, f.kickoff_time);
    if (m) {
      matched++; matchedEvents.push(m.event);
      const warn = m.hoursApart != null && m.hoursApart > MAX_KICKOFF_GAP_HOURS ? '  ** KICKOFF MISMATCH' : '';
      const amb = m.ambiguous ? '  ** AMBIGUOUS, several events share this pair' : '';
      console.log(`  OK   ${h} v ${a} -> event ${m.event.id}  (${m.hoursApart}h apart)${warn}${amb}`);
    } else {
      console.log(`  MISS ${h} v ${a}  (no odds event matched)`);
    }
  }
  console.log(`  matched ${matched}/${fixtures.length}`);
  if (matched < fixtures.length) {
    console.log('\n  unmatched odds events in this window (left side of the join):');
    for (const ev of (events || []).slice(0, 20)) {
      console.log(`    "${ev.home}" -> "${toFplName(ev.home)}"   |   "${ev.away}" -> "${toFplName(ev.away)}"`);
    }
    console.log('  ^ correct TEAM_ALIASES against these before capturing');
  }

  /* The event count should be roughly one gameweek per week. Anything much
   * larger means the league filter is not applying and foreign fixtures are
   * being pulled in, which would waste the /odds/multi budget and could match
   * the wrong game. Report the leagues actually present rather than trusting
   * the filter. */
  const leagueCount = {};
  for (const ev of (events || [])) {
    const s = (ev.league && ev.league.slug) || 'unknown';
    leagueCount[s] = (leagueCount[s] || 0) + 1;
  }
  const leagueKeys = Object.keys(leagueCount);
  console.log(`\n--- event window ---`);
  console.log(`  ${(events || []).length} events across ${leagueKeys.length} league(s)`);
  for (const [s, n] of Object.entries(leagueCount).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${n.toString().padStart(4)}  ${s}`);
  }
  if (leagueKeys.length > 1) {
    console.log('  ! more than one league returned — the league filter is not applying');
  }
  const dates = (events || []).map(e => e.date).filter(Boolean).sort();
  if (dates.length) console.log(`  date span: ${dates[0]} .. ${dates[dates.length - 1]}`);

  /* One full odds body, so the market names and label shapes can be read
   * against reality rather than remembered.
   *
   * Sample a MATCHED event, not events[0]. The event list spans a wider window
   * than the current gameweek and its first entry may be a fixture far enough
   * out that no bookmaker has posted a market yet — which reads as "the API is
   * broken" when it only means "nothing priced this one". */
  const sample = matchedEvents[0] || (events || [])[0];
  if (sample) {
    const odds = await oddsGet('odds', { eventId: sample.id, bookmakers: BOOKMAKERS });
    await writeJSON(join(dir, `odds-${sample.id}.json`), odds);
    console.log(`\n--- markets on event ${sample.id} (${sample.home} v ${sample.away}) ---`);
    const books = Object.entries(odds.bookmakers || {});
    if (!books.length) {
      console.log('  ! no bookmaker keys at all — nothing priced on this fixture yet');
    }
    for (const w of BOOKMAKERS.split(',').map(s => s.trim())) {
      if (!books.some(([b]) => b === w)) console.log(`  ! "${w}" absent from the response`);
    }
    for (const [book, markets] of books) {
      console.log(`  ${book}: ${(markets || []).length} markets`);
      if (!(markets || []).length) continue;
      const scorer = markets.find(m => m.name === 'Anytime Goalscorer');
      console.log(`    Anytime Goalscorer: ${scorer ? scorer.odds.length + ' entries' : 'ABSENT'}`);
      if (scorer) {
        console.log(`    sample row: ${JSON.stringify(scorer.odds[0])}`);
        console.log(`    updatedAt:  ${scorer.updatedAt}`);
      }
      const cs = markets.filter(m => /Clean Sheet/i.test(m.name)).map(m => m.name);
      console.log(`    clean sheet markets: ${cs.join(', ') || 'none'}`);
    }
  }
}

/* ── PRE ──────────────────────────────────────────────────────────────── */

async function capturePre() {
  const season = currentSeason();
  const boot = await fplGet('bootstrap-static/');
  const events = boot.events || [];

  const next = events.find(e => e.is_next) || events.find(e => !e.finished);
  if (!next) { console.log('no upcoming gameweek found'); return; }

  const deadline = next.deadline_time ? new Date(next.deadline_time) : null;
  const now = new Date();
  const mins = deadline ? Math.round((deadline - now) / 60000) : null;
  console.log(`pre: gameweek ${next.id}, deadline ${next.deadline_time} (${mins} min away)`);

  /* Which capture point does the clock put us in? Same reasoning as the FPL
   * pre snapshot: the schedule cannot track a moving deadline, so the script
   * decides whether this is the right hour, not the cron. Most runs land in no
   * band at all and exit having written nothing. That is the common case. */
  let point = flag('point');
  if (point) {
    if (!CAPTURES.some(c => c.point === point) && point !== 'adhoc') {
      console.log(`  unknown --point "${point}" (expected early|late)`);
      return;
    }
    console.log(`  forced capture point: ${point}`);
  } else if (has('any')) {
    point = 'adhoc';
    console.log('  --any: capturing regardless of clock, tagged adhoc');
  } else {
    if (mins == null) { console.log('  no deadline on this event, skipping'); return; }
    const band = CAPTURES.find(c => mins >= c.minMins && mins <= c.maxMins);
    if (!band) {
      const bands = CAPTURES.map(c => `${c.point} ${c.minMins}-${c.maxMins}m`).join(', ');
      console.log(`  ${mins}m out, in no capture band (${bands}) — skipping`);
      return;
    }
    point = band.point;
    console.log(`  in "${point}" band (${band.minMins}-${band.maxMins}m out)`);
  }

  if (mins != null && mins < 0 && !FORCE) {
    console.log('  deadline passed, skipping (use --force to override)');
    return;
  }

  const path = join(OUT, season, 'pre', `gw-${next.id}-${point}.json`);
  if (!FORCE && await exists(path)) { console.log('  already on disk, skipping'); return; }

  const fixtures = await fplGet(`fixtures/?event=${next.id}`);
  const fplNames = Object.fromEntries((boot.teams || []).map(t => [t.id, t.name]));
  console.log(`  ${fixtures.length} FPL fixtures this gameweek`);

  const oddsEvents = await oddsGet('events', { sport: SPORT_SLUG, league: PL_SLUG });
  console.log(`  ${(oddsEvents || []).length} odds events in the league window`);

  /* Join on normalised club pair, disambiguated by kickoff time. */
  const idx = indexEvents(oddsEvents);

  const mapping = [];
  const unmatched = [];
  for (const f of fixtures) {
    const h = normName(fplNames[f.team_h]);
    const a = normName(fplNames[f.team_a]);
    const m = matchEvent(idx, h, a, f.kickoff_time);
    if (!m) { unmatched.push({ fplFixture: f.id, home: h, away: a, reason: 'no event' }); continue; }
    /* A pair that matches but whose kickoff is days out is not this fixture.
     * Better to record no odds than the wrong odds. */
    if (m.hoursApart != null && m.hoursApart > MAX_KICKOFF_GAP_HOURS) {
      unmatched.push({
        fplFixture: f.id, home: h, away: a,
        reason: `kickoff ${m.hoursApart}h apart from event ${m.event.id}`,
      });
      continue;
    }
    mapping.push({
      fplFixture: f.id, fplHome: f.team_h, fplAway: f.team_a,
      oddsEvent: m.event.id, oddsHome: m.event.home, oddsAway: m.event.away,
      kickoff: f.kickoff_time, oddsDate: m.event.date,
      hoursApart: m.hoursApart,
      ambiguous: m.ambiguous,
      bookmakerCount: m.event.bookmakerCount ?? null,
    });
  }

  if (unmatched.length) {
    console.warn(`  ! ${unmatched.length} fixture(s) did not match an odds event:`);
    for (const u of unmatched) console.warn(`  !   ${u.home} v ${u.away} — ${u.reason}`);
    console.warn('  ! check TEAM_ALIASES against probe output — these fixtures have no odds');
  }
  if (!mapping.length) { console.log('  nothing matched, writing nothing'); return; }

  /* /odds/multi takes at most 10 event ids. A double gameweek can exceed that,
   * so chunk rather than assume. */
  const ids = mapping.map(m => m.oddsEvent);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

  const raw = {};
  for (const chunk of chunks) {
    const body = await oddsGet('odds/multi', {
      eventIds: chunk.join(','),
      bookmakers: BOOKMAKERS,
    });
    /* Response shape for multi is not assumed: keyed object or array, both
     * are folded into a map on event id. */
    if (Array.isArray(body)) {
      for (const ev of body) raw[ev.id] = ev;
    } else if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) raw[k] = v;
    }
    console.log(`  fetched odds for ${chunk.length} event(s)`);
  }

  /* Coverage report, computed at capture time so a bad week is visible in the
   * file rather than only on rerun. Counts, not parsed values — parsing stays
   * downstream. */
  const coverage = {};
  for (const [evId, ev] of Object.entries(raw)) {
    const books = {};
    for (const [book, markets] of Object.entries((ev && ev.bookmakers) || {})) {
      const scorer = (markets || []).find(m => m.name === 'Anytime Goalscorer');
      books[book] = {
        markets: (markets || []).length,
        anytimeGoalscorer: scorer ? scorer.odds.length : 0,
        anytimeUpdatedAt: scorer ? scorer.updatedAt : null,
        cleanSheet: (markets || []).some(m => /Clean Sheet/i.test(m.name)),
      };
    }
    coverage[evId] = books;
  }

  await writeJSON(path, {
    schema: 'odds-pre/2',
    stamp: 'odds-2026-09-06d',
    season, gw: next.id,
    capturePoint: point,
    capturedAt: now.toISOString(),
    deadline: next.deadline_time,
    minutesBeforeDeadline: mins,
    bookmakersRequested: BOOKMAKERS.split(',').map(s => s.trim()),
    counts: {
      fplFixtures: fixtures.length,
      matched: mapping.length,
      unmatched: unmatched.length,
      eventsWithOdds: Object.keys(raw).length,
    },
    unmatched,
    mapping,
    coverage,
    /* Untouched response bodies. Every parsing decision happens downstream. */
    odds: raw,
  });
}

/* ── MAIN ─────────────────────────────────────────────────────────────── */

const commands = { probe, pre: capturePre };

/* Check the key before any network call. Without this the first failure is a
 * FPL fetch error, which points at the wrong thing entirely. */
if (commands[cmd] && !KEY) {
  console.error('ODDS_API_KEY is not set in the environment.');
  console.error('  local:   export ODDS_API_KEY=... && node odds-snapshot.mjs ' + cmd);
  console.error('  Actions: repository secret ODDS_API_KEY, passed via env: in the workflow step');
  process.exit(1);
}

if (!commands[cmd]) {
  console.log('usage: node odds-snapshot.mjs <probe|pre> [--point early|late] [--any] [--bookmakers l] [--out dir] [--season s] [--force] [--dry]');
  console.log('       ODDS_API_KEY must be set in the environment');
  process.exit(1);
}

commands[cmd]().then(
  () => console.log('\ndone'),
  err => { console.error('\nFAILED:', err.message); process.exit(1); }
);
