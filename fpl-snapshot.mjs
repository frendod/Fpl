#!/usr/bin/env node
/* fpl-snapshot.mjs — snapshot-2026-09-05c
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
 *
 * RUN probe FIRST. This project has been bitten repeatedly by hand-typed
 * field names. The probe writes untouched responses so the field lists below
 * can be checked against reality before anything trusts them.
 */

const API = 'https://fantasy.premierleague.com/api';

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
];

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

import { mkdir, writeFile, access } from 'node:fs/promises';
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
      stamp: 'snapshot-2026-09-05c',
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
  if (!FORCE && await exists(path)) { console.log('  already on disk, skipping'); return; }

  const missing = new Set();
  const players = {};
  for (const el of (boot.elements || [])) players[el.id] = pick(el, PRE_FIELDS, missing);
  reportMissing(missing, 'bootstrap elements');

  const fixtures = await get(`fixtures/?event=${next.id}`);

  await writeJSON(path, {
    schema: 'fpl-pre/1',
    stamp: 'snapshot-2026-09-05c',
    season, gw: next.id,
    capturedAt: now.toISOString(),
    deadline: next.deadline_time,
    minutesBeforeDeadline: mins,
    lookahead: !!late,
    synthetic: false,
    counts: { players: Object.keys(players).length, fixtures: fixtures.length },
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

const commands = { probe, post: capturePost, pre: capturePre };

if (!commands[cmd]) {
  console.log('usage: node fpl-snapshot.mjs <probe|post|pre> [--from N] [--to N] [--within M] [--out dir] [--season s] [--force] [--dry]');
  process.exit(1);
}

commands[cmd]().then(
  () => console.log('\ndone'),
  err => { console.error('\nFAILED:', err.message); process.exit(1); }
);
