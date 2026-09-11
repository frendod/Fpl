#!/usr/bin/env node
/* fpl-snapshot.mjs — snapshot-2026-09-11b
 *
 * Captures FPL API state into history/fpl/ as immutable per-gameweek JSON.
 *
 * Two snapshot kinds, and the distinction is the whole point of this script:
 *
 *   pre/gw-N.json   Predictors as they stood BEFORE the deadline. ep_next,
 *                   price, injury flags, form. These expire. FPL revises
 *                   ep_next after matches and keeps no archive of the old
 *                   value, so a snapshot taken after kickoff contains
 *                   information no manager had, and any backtest against it
 *                   flatters the model. Cannot be backfilled.
 *
 *   post/gw-N.json  Outcomes once the gameweek is settled. Minutes, goals,
 *                   xG, bps, bonus. Served indefinitely by the API, so this
 *                   half backfills cleanly at any time.
 *
 * Commands:
 *   node fpl-snapshot.mjs probe                 dump raw API responses, parse nothing
 *   node fpl-snapshot.mjs post                  capture every settled GW not yet on disk
 *   node fpl-snapshot.mjs post --from 1 --to 4  capture a specific range
 *   node fpl-snapshot.mjs pre                   capture predictors for the next GW
 *
 * Flags:
 *   --out <dir>    root output dir (default ./history/fpl)
 *   --season <s>   season folder name (default derived from date)
 *   --force        overwrite files that already exist
 *   --dry          fetch and report, write nothing
 *   --within <m>   pre only: write nothing unless the deadline is between 0 and
 *                  m minutes away. Lets a plain hourly cron hit a moving target:
 *                  deadlines shift by day and time each week, so the script
 *                  decides whether this is the right hour, not the schedule.
 *                  An existing capture taken OUTSIDE the window (a manual run
 *                  days early) is replaced once the window opens; an existing
 *                  in-window capture is never touched. Git keeps the early one.
 *
 * 2026-09-10a — pre snapshots carry enough to REPLAY the model later, not just
 * to describe the week: every bootstrap field build() reads, the season state
 * (events, total_players), and fixtures for the next six gameweeks rather than
 * one, since Score prices three and xP up to five. Schema bumps to fpl-pre/2.
 * Pre-deadline state cannot be backfilled, so anything a future model might
 * want has to be captured now or never.
 *
 * 2026-09-10b — adds `code`, FPL's stable cross-season player id, as the join
 * key to last season's FPL data.
 *
 * 2026-09-11a — `challenge` command: the FPL Challenge game's feed
 * (fplchallenge.premierleague.com/api) carries Opta stats the main feed does
 * not — shots, big chances, key passes, fouls, substitutions off and more —
 * Written to <season>/challenge/gw-N.json. See captureChallenge for how
 * gameweeks are isolated.
 *
 * 2026-09-11b — Challenge files are keyed by player CODE, not element id.
 * The two games share ids only for players who existed at launch; anyone
 * added later (summer signings — ids 554 up in 2026-27) has a different id
 * in each, which the first capture's cross-check against the post snapshots
 * exposed. Code is the same in both. Files written by 11a (keyed by id) are
 * detected and rewritten automatically.
 *
 * RUN probe FIRST. This project has been bitten repeatedly by hand-typed
 * field names. The probe writes untouched responses so the field lists below
 * can be checked against reality before anything trusts them.
 */

const API = 'https://fantasy.premierleague.com/api';
const STAMP = 'snapshot-2026-09-11b';

/* Browser-like headers. Bare fetch gets 403s from this API. */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://fantasy.premierleague.com/',
};

/* ── FIELD LISTS ──────────────────────────────────────────────────────────
 * Single place to correct names after the probe. Anything listed but absent
 * on the response is reported once per run rather than silently dropped —
 * a missing field here means a silently broken model input later.
 */

/* From bootstrap-static elements[]. The predictor set. */
const PRE_FIELDS = [
  'id', 'web_name', 'team', 'element_type',
  'now_cost', 'selected_by_percent', 'form',
  'ep_this', 'ep_next',
  'status', 'news', 'chance_of_playing_this_round', 'chance_of_playing_next_round',
  'minutes', 'starts',
  'expected_goals_per_90', 'expected_assists_per_90',
  'expected_goal_involvements_per_90', 'expected_goals_conceded_per_90',
  'defensive_contribution', 'defensive_contribution_per_90',
  'saves_per_90', 'clean_sheets_per_90', 'goals_conceded_per_90', 'starts_per_90',
  'penalties_order', 'corners_and_indirect_freekicks_order', 'direct_freekicks_order',
  'total_points', 'points_per_game', 'bps', 'ict_index',
  /* Added 2026-09-10a: the rest of what index.html build() reads, so a later
   * model can be re-run on this week's inputs. Names are needed for the
   * Understat match; season xG/xA and transfers feed xg90, xa90 and momentum. */
  'first_name', 'second_name',
  /* FPL's stable player code. Element ids are reassigned every season; code
   * is not, so it is the join key to last season's FPL data (vaastav
   * players_raw carries it too). No name matching. */
  'code',
  'expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded',
  'transfers_in_event', 'transfers_out_event',
  'clearances_blocks_interceptions', 'tackles', 'recoveries',
  'goals_scored', 'assists', 'clean_sheets', 'saves', 'bonus', 'event_points',
];

/* How many gameweeks of fixtures a pre snapshot keeps, counting the next. */
const FIXTURE_HORIZON = 6;

/* From event/{gw}/live/ elements[].stats. The outcome set. */
const POST_FIELDS = [
  'minutes', 'starts',
  'goals_scored', 'assists',
  'clean_sheets', 'goals_conceded', 'own_goals',
  'penalties_saved', 'penalties_missed', 'saves',
  'yellow_cards', 'red_cards',
  'bonus', 'bps', 'total_points',
  'influence', 'creativity', 'threat', 'ict_index',
  'expected_goals', 'expected_assists',
  'expected_goal_involvements', 'expected_goals_conceded',
  /* defcon is a threshold event (10 CBIT for DEF, 12 combined for MID/FWD).
   * Modelling P(threshold) needs the underlying counts, not just whether the
   * 2 points landed — the binary outcome discards every near miss. */
  'defensive_contribution', 'clearances_blocks_interceptions', 'recoveries', 'tackles',
  'played',
];

/* ── PLUMBING ─────────────────────────────────────────────────────────── */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const OUT = flag('out', './history/fpl');
const FORCE = has('force');
const DRY = has('dry');

/* FPL labels a season by its starting year: Aug 2026 onward is 2026-27. */
function currentSeason() {
  const explicit = flag('season');
  if (explicit) return explicit;
  const d = new Date();
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;   // July onward = new season
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function get(path) {
  const url = `${API}/${path}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
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

/* Pick listed fields, and report any that were absent. Absent is not the
 * same as null: a field FPL renamed will show up here, a field FPL left
 * empty will not. */
function pick(src, fields, missingSink) {
  const out = {};
  for (const f of fields) {
    if (f in src) out[f] = src[f];
    else missingSink.add(f);
  }
  return out;
}

function reportMissing(missing, label) {
  if (!missing.size) return;
  console.warn(`  ! ${label}: fields not present on response — ${[...missing].join(', ')}`);
  console.warn('  ! check these against the probe output before trusting the data');
}

/* ── PROBE ────────────────────────────────────────────────────────────── */

async function probe() {
  const dir = join(OUT, '_probe');
  console.log('probe: fetching raw responses, parsing nothing\n');

  const boot = await get('bootstrap-static/');
  await writeJSON(join(dir, 'bootstrap-static.json'), boot);

  const events = boot.events || [];
  const settled = events.filter(e => e.data_checked);
  const gw = settled.length ? settled[settled.length - 1].id : 1;
  console.log(`  most recent settled gameweek: ${gw}`);

  const live = await get(`event/${gw}/live/`);
  await writeJSON(join(dir, `event-${gw}-live.json`), live);

  const fx = await get(`fixtures/?event=${gw}`);
  await writeJSON(join(dir, `fixtures-${gw}.json`), fx);

  /* Field reality check against the lists above. */
  const el = (boot.elements || [])[0] || {};
  const st = ((live.elements || [])[0] || {}).stats || {};
  const missingPre = PRE_FIELDS.filter(f => !(f in el));
  const missingPost = POST_FIELDS.filter(f => !(f in st));

  console.log('\n--- field check ---');
  console.log(`bootstrap element keys: ${Object.keys(el).length}`);
  console.log(`live stats keys:        ${Object.keys(st).length}`);
  console.log(missingPre.length
    ? `PRE_FIELDS missing:  ${missingPre.join(', ')}`
    : 'PRE_FIELDS: all present');
  console.log(missingPost.length
    ? `POST_FIELDS missing: ${missingPost.join(', ')}`
    : 'POST_FIELDS: all present');
  console.log('\nlive stats keys actually returned:');
  console.log('  ' + Object.keys(st).join(', '));
  console.log('\nexplain[0] shape (fixture linkage):');
  console.log('  ' + JSON.stringify(((live.elements || [])[0] || {}).explain?.[0] ?? null).slice(0, 300));
}

/* ── POST ─────────────────────────────────────────────────────────────── */

async function capturePost() {
  const season = currentSeason();
  const boot = await get('bootstrap-static/');
  const events = boot.events || [];

  const from = parseInt(flag('from', ''), 10);
  const to = parseInt(flag('to', ''), 10);

  /* data_checked is FPL's own flag for "gameweek settled, bonus applied".
   * Gating on it rather than a timer is what makes this safe to run hourly. */
  let targets = events.filter(e => e.data_checked).map(e => e.id);
  if (!Number.isNaN(from)) targets = targets.filter(g => g >= from);
  if (!Number.isNaN(to)) targets = targets.filter(g => g <= to);

  if (!targets.length) { console.log('no settled gameweeks in range'); return; }
  console.log(`post: ${targets.length} settled gameweek(s) — ${targets.join(', ')}\n`);

  const teamsById = Object.fromEntries((boot.teams || []).map(t => [t.id, t.short_name]));

  for (const gw of targets) {
    const path = join(OUT, season, 'post', `gw-${gw}.json`);
    if (!FORCE && await exists(path)) { console.log(`gw ${gw}: already on disk, skipping`); continue; }

    console.log(`gw ${gw}:`);
    const live = await get(`event/${gw}/live/`);
    const fixtures = await get(`fixtures/?event=${gw}`);

    /* fixture id -> the two sides, so a player's row can name its opponent */
    const fxById = {};
    for (const f of fixtures) {
      fxById[f.id] = {
        h: f.team_h, a: f.team_a,
        hs: f.team_h_score, as: f.team_a_score,
        hd: f.team_h_difficulty, ad: f.team_a_difficulty,
        kickoff: f.kickoff_time,
      };
    }

    const missing = new Set();
    const players = {};
    let played = 0;

    for (const e of (live.elements || [])) {
      const stats = e.stats || {};
      const row = pick(stats, POST_FIELDS, missing);

      /* A player can appear twice in a double gameweek. explain[] carries one
       * entry per fixture, which is the only link from a stat line to a match. */
      const fxIds = (e.explain || []).map(x => x.fixture).filter(Boolean);
      row.fixtures = fxIds.map(id => {
        const f = fxById[id];
        if (!f) return { fixture: id };
        const el = (boot.elements || []).find(p => p.id === e.id);
        const teamId = el ? el.team : null;
        const home = teamId != null && f.h === teamId;
        return {
          fixture: id,
          opponent: home ? f.a : f.h,
          opponentShort: teamsById[home ? f.a : f.h] || null,
          venue: home ? 'H' : 'A',
          scored: home ? f.hs : f.as,
          conceded: home ? f.as : f.hs,
          difficulty: home ? f.hd : f.ad,
          kickoff: f.kickoff,
        };
      });

      if ((row.minutes || 0) > 0) played++;
      players[e.id] = row;
    }

    reportMissing(missing, `gw ${gw} live stats`);

    await writeJSON(path, {
      schema: 'fpl-post/1',
      stamp: STAMP,
      season, gw,
      capturedAt: new Date().toISOString(),
      dataChecked: true,
      synthetic: false,
      counts: { players: Object.keys(players).length, played, fixtures: fixtures.length },
      missingFields: [...missing],
      fixtures,
      players,
    });
  }
}

/* ── PRE ──────────────────────────────────────────────────────────────── */

async function capturePre() {
  const season = currentSeason();
  const boot = await get('bootstrap-static/');
  const events = boot.events || [];

  /* The gameweek this snapshot predicts: the next one not yet started.
   * ep_next on the current bootstrap refers to exactly this gameweek. */
  const next = events.find(e => e.is_next) || events.find(e => !e.finished);
  if (!next) { console.log('no upcoming gameweek found'); return; }

  const deadline = next.deadline_time ? new Date(next.deadline_time) : null;
  const now = new Date();
  const late = deadline && now > deadline;

  const mins = deadline ? Math.round((deadline - now) / 60000) : null;
  console.log(`pre: gameweek ${next.id}, deadline ${next.deadline_time} (${mins} min away)`);

  /* Window guard. Team news lands in the last 48h before a deadline and moves
   * chance_of_playing, so a snapshot taken days early carries systematically
   * worse availability information than the live model will have. Capturing
   * close to the deadline keeps training and production symmetric. */
  const within = parseInt(flag('within', ''), 10);
  if (!Number.isNaN(within)) {
    if (mins == null) { console.log('  no deadline on this event, skipping'); return; }
    if (mins > within) { console.log(`  outside ${within} min window, skipping`); return; }
    if (mins < 0 && !FORCE) { console.log('  deadline passed, skipping (use --force to override)'); return; }
  }

  if (late) {
    console.warn('  ! deadline has PASSED — ep_next may already be post-match revised');
    console.warn('  ! writing anyway, flagged lookahead:true; do not benchmark on this week');
  }

  const path = join(OUT, season, 'pre', `gw-${next.id}.json`);
  if (!FORCE && await exists(path)) {
    /* An early capture is a worse version of the same file: it predates the
     * team news the live model will have at the deadline. Replace it once,
     * when the window opens. An in-window capture is final. */
    let prev = null;
    try { prev = JSON.parse(await readFile(path, 'utf8')); } catch { /* unreadable: leave it */ }
    const prevMins = prev ? prev.minutesBeforeDeadline : null;
    const inWindow = !Number.isNaN(within) && mins != null && mins >= 0 && mins <= within;
    if (inWindow && prevMins != null && prevMins > within) {
      console.log(`  replacing early capture (${prevMins} min out) with an in-window one`);
    } else {
      console.log('  already on disk, skipping');
      return;
    }
  }

  const missing = new Set();
  const players = {};
  for (const el of (boot.elements || [])) players[el.id] = pick(el, PRE_FIELDS, missing);
  reportMissing(missing, 'bootstrap elements');

  /* One request for the season's fixtures, trimmed to the horizon. FDR values
   * are re-rated by FPL during the season, so the ones in force at the
   * deadline are the ones a replay must use. */
  const allFx = await get('fixtures/');
  const lastFxGW = next.id + FIXTURE_HORIZON - 1;
  const fixtures = allFx.filter(f => f.event != null && f.event >= next.id && f.event <= lastFxGW);

  await writeJSON(path, {
    schema: 'fpl-pre/2',
    stamp: STAMP,
    season, gw: next.id,
    capturedAt: now.toISOString(),
    deadline: next.deadline_time,
    minutesBeforeDeadline: mins,
    lookahead: !!late,
    synthetic: false,
    counts: { players: Object.keys(players).length, fixtures: fixtures.length },
    fixtureHorizon: [next.id, lastFxGW],
    totalPlayers: boot.total_players ?? null,
    events: events.map(e => ({
      id: e.id, deadline_time: e.deadline_time,
      finished: e.finished, data_checked: e.data_checked,
      is_previous: e.is_previous, is_current: e.is_current, is_next: e.is_next,
    })),
    missingFields: [...missing],
    teams: (boot.teams || []).map(t => ({
      id: t.id, short: t.short_name, name: t.name,
      strength_attack_home: t.strength_attack_home,
      strength_attack_away: t.strength_attack_away,
      strength_defence_home: t.strength_defence_home,
      strength_defence_away: t.strength_defence_away,
    })),
    fixtures,
    players,
  });
}

/* ── MAIN ─────────────────────────────────────────────────────────────── */

/* ── CHALLENGE ────────────────────────────────────────────────────────────
 * The Challenge feed's player list holds SEASON TOTALS. To get one
 * gameweek's stats there are two routes, tried in this order:
 *
 *   1. event/N/live/ — if the Challenge feed mirrors the main feed's
 *      per-gameweek endpoint, each gameweek comes out directly and every
 *      settled gameweek can be backfilled. Whether it exists, and what it
 *      carries, is recorded in the file either way.
 *   2. Season totals, saved right after gameweek N settles and before N+1
 *      kicks off. Gameweek N is then this file minus gw-(N-1)'s. A file
 *      saved late would fold part of N+1 in, so it is not written at all.
 *
 * Stored as a column list plus one row per player, keyed by player CODE —
 * the one identifier the Challenge game and main FPL agree on — so a
 * gameweek is ~60KB.
 */
const CAPI = 'https://fplchallenge.premierleague.com/api';
const CH_FIELDS = [
  'minutes', 'starts', 'total_shots', 'shots_on_target', 'attempts_obox', 'total_headed_attempts',
  'big_chances_created', 'big_chances_scored', 'key_passes', 'open_play_crosses', 'dribbles',
  'attempted_passes', 'completed_passes', 'fouls', 'fouls_won', 'interceptions', 'successful_tackles',
  'substitutions_off', 'penalties_won', 'outside_box_goals', 'winning_goals', 'bps',
];
async function cget(path) {
  const res = await fetch(`${CAPI}/${path}`, { headers: { ...HEADERS, Referer: 'https://fplchallenge.premierleague.com/' } });
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json().catch(() => null) : null };
}
async function captureChallenge() {
  const season = currentSeason();
  const main = await get('bootstrap-static/');
  const settled = main.events.filter(e => e.data_checked).map(e => e.id);
  if (!settled.length) { console.log('  no settled gameweek yet'); return; }
  const last = Math.max(...settled);

  /* The Challenge game's own id → code map. Its element ids diverge from
   * main FPL's for late additions, so rows are stored by code. */
  const boot = await cget('bootstrap-static/');
  if (!boot.json || !Array.isArray(boot.json.elements)) throw new Error(`challenge bootstrap-static ${boot.status}`);
  const codeOf = Object.fromEntries(boot.json.elements.map(e => [e.id, e.code]));
  const needsWrite = async path => {
    if (FORCE || !(await exists(path))) return true;
    try { return JSON.parse(await readFile(path, 'utf8')).keyedBy !== 'code'; } catch { return true; }
  };

  /* Route 1: a per-gameweek endpoint. */
  const probeLive = await cget(`event/${last}/live/`);
  const liveEls = probeLive.json && Array.isArray(probeLive.json.elements) ? probeLive.json.elements : null;
  const liveKeys = liveEls && liveEls[0] && liveEls[0].stats ? Object.keys(liveEls[0].stats) : [];
  const liveHasExtras = CH_FIELDS.filter(k => k !== 'minutes' && k !== 'starts' && k !== 'bps').some(k => liveKeys.includes(k));
  console.log(`  event/${last}/live/: ${probeLive.status}${liveEls ? `, ${liveEls.length} players, extra stats ${liveHasExtras ? 'YES' : 'no'}` : ''}`);

  if (liveEls && liveHasExtras) {
    for (const g of settled) {
      const path = join(OUT, season, 'challenge', `gw-${g}.json`);
      if (!(await needsWrite(path))) continue;
      const r = g === last ? probeLive : await cget(`event/${g}/live/`);
      const els = r.json && r.json.elements;
      if (!els) { console.log(`  gw ${g}: ${r.status}, skipped`); continue; }
      const cols = CH_FIELDS.filter(k => k in (els[0].stats || {}));
      const players = {}; let noCode = 0;
      for (const e of els) { const c = codeOf[e.id]; if (c == null) { noCode++; continue; } players[c] = cols.map(k => Number(e.stats[k]) || 0); }
      if (noCode) console.log(`  gw ${g}: ${noCode} players had no code in the Challenge list, dropped`);
      await writeJSON(path, { schema: 'fpl-challenge/2', stamp: STAMP, season, gw: g, kind: 'gameweek', keyedBy: 'code',
        source: `${CAPI}/event/${g}/live/`, capturedAt: new Date().toISOString(), cols, players });
    }
    return;
  }

  /* Route 2: season totals, only while they still stop at `last`. */
  const path = join(OUT, season, 'challenge', `gw-${last}.json`);
  if (!(await needsWrite(path))) { console.log(`  gw ${last} already on disk`); return; }
  const fx = await get(`fixtures/?event=${last + 1}`).catch(() => []);
  if (Array.isArray(fx) && fx.some(f => f.started)) {
    console.log(`  gw ${last + 1} has kicked off — totals now include it, so gw ${last} cannot be isolated; skipping`);
    return;
  }
  const els = boot.json.elements;
  const cols = CH_FIELDS.filter(k => k in els[0]);
  const missing = CH_FIELDS.filter(k => !(k in els[0]));
  const players = {};
  for (const e of els) players[e.code] = cols.map(k => Number(e[k]) || 0);
  await writeJSON(path, { schema: 'fpl-challenge/2', stamp: STAMP, season, gw: last, kind: 'season-totals', keyedBy: 'code',
    note: `totals through gameweek ${last}; gameweek ${last} alone = this minus gw-${last - 1}`,
    source: `${CAPI}/bootstrap-static/`, capturedAt: new Date().toISOString(),
    liveEndpoint: { status: probeLive.status, statKeys: liveKeys },
    cols, missing, players });
  console.log(`  season totals through gw ${last}, ${Object.keys(players).length} players${missing.length ? `, missing: ${missing.join(', ')}` : ''}`);
}

const commands = { probe, post: capturePost, pre: capturePre, challenge: captureChallenge };

if (!commands[cmd]) {
  console.log('usage: node fpl-snapshot.mjs <probe|post|pre|challenge> [--from N] [--to N] [--within M] [--out dir] [--season s] [--force] [--dry]');
  process.exit(1);
}

commands[cmd]().then(
  () => console.log('\ndone'),
  err => { console.error('\nFAILED:', err.message); process.exit(1); }
);
