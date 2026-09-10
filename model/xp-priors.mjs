#!/usr/bin/env node
/* xp-priors.mjs — xppri-2026-09-10a
 *
 * Builds the xP priors file for a season from the previous season's FPL data:
 *
 *   node model/xp-priors.mjs 2026-27
 *     → history/fpl/priors/2026-27.json   (built from vaastav 2025-26)
 *
 * Run once a season, after vaastav publishes the finished season, and commit
 * the output. The app loads it to seed every player's rates, and every club's
 * attack and defence, before this season has any data of its own.
 *
 * Keyed by FPL's stable codes (player `code`, team `code`), never by element
 * or team id, which FPL reassigns every season. The arithmetic is
 * XPE.buildPriors — the same function the backtest uses — so the app starts
 * from exactly the priors that were tested.
 */
import fs from 'node:fs'; import vm from 'node:vm';
import { loadSeason, ensureSeason } from './xp-data.mjs';
const XPE = vm.runInThisContext(fs.readFileSync(new URL('./xp-engine.js', import.meta.url), 'utf8') + ';XPE');
const DATA = new URL('./data', import.meta.url).pathname;
const REPO = new URL('..', import.meta.url).pathname;

const target = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(target || '')) { console.error('usage: node model/xp-priors.mjs <season, e.g. 2026-27>'); process.exit(1); }
const y = parseInt(target, 10);
const prev = `${y - 1}-${String(y % 100).padStart(2, '0')}`;

await ensureSeason(DATA, prev);
await ensureSeason(DATA, target, ['teams.csv']);        // this season's clubs, for promotion
const S1 = loadSeason(DATA, prev);
const teams = fs.readFileSync(`${DATA}/${target}/teams.csv`, 'utf8').trim().split('\n');
const head = teams.shift().split(','), ci = head.indexOf('code');
const current = teams.map(l => Number(l.split(',')[ci]));

const P = XPE.buildPriors(S1.rows, Object.values(S1.fixtures), current);

/* Round for size; four significant places is far below the noise. */
const round = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v));
const promoted = current.filter(c => !(new Set(Object.values(S1.fixtures).flatMap(f => [f.home, f.away]))).has(c));
const out = round({
  schema: 'xp-priors/1', stamp: 'xppri-2026-09-10a', engine: (fs.readFileSync(new URL('./xp-engine.js', import.meta.url), 'utf8').match(/xpe-[0-9-]+[a-z]/) || [])[0],
  season: target, from: prev, builtAt: new Date().toISOString(),
  counts: { players: Object.keys(P.pl).length, teams: Object.keys(P.team.att).length, promoted: promoted.length },
  promotedCodes: promoted,
  ...P,
});
const path = `${REPO}history/fpl/priors/${target}.json`;
fs.mkdirSync(`${REPO}history/fpl/priors`, { recursive: true });
fs.writeFileSync(path, JSON.stringify(out) + '\n');
console.log(`wrote ${path.replace(REPO, '')} — ${out.counts.players} players, ${out.counts.teams} clubs (promoted: ${promoted.join(', ')}), ${(fs.statSync(path).size / 1024).toFixed(0)} KB, defcon ${P.hasDC ? 'yes' : 'no'}`);
