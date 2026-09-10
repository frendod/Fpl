#!/usr/bin/env node
/* xp-backtest.mjs — xpbt-2026-09-10b
 *
 * Walk-forward test of the xP engine on vaastav seasons. For every gameweek
 * g of the target season, the model sees only gameweeks before g plus the
 * whole of the previous season, exactly what the app has at a deadline.
 *
 * Baselines, both in points so they compete on the same terms:
 *   fplep   FPL's ep_next as FPL builds it: points per gameweek over the last
 *           30 days. vaastav's stored xP column cannot be used — it is
 *           captured after the gameweek (2024-25) or broken (2025-26).
 *   seas    points per gameweek this season so far.
 * Neither side gets injury flags; vaastav has none. That handicaps both
 * equally; the app has them live.
 *
 * Run from anywhere; data is fetched into model/data/ on first run.
 *
 *   node model/xp-backtest.mjs              both seasons, default parameters
 *   node xp-backtest.mjs --season 2024-25   one season
 *   node xp-backtest.mjs --set rateP=900,teamP=6   override parameters
 *   node xp-backtest.mjs --parts            per-component calibration
 */
import fs from 'node:fs'; import vm from 'node:vm';
import { loadSeason, actualParts, ensureSeason } from './xp-data.mjs';
const DATA = new URL('./data', import.meta.url).pathname;
const XPE = vm.runInThisContext(fs.readFileSync(new URL('./xp-engine.js', import.meta.url), 'utf8') + ';XPE');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OPT = { ...XPE.DEFAULTS, teamRegress: 0.8, assistP: 60 };
for (const kv of (flag('set', '') || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); OPT[k] = Number(v); }
const PAIRS = [['2023-24', '2024-25'], ['2024-25', '2025-26']].filter(([, s]) => !flag('season') || flag('season') === s);
/* All per-player assembly lives in the engine (buildPriors, playerInputs,
 * fixtureContext), so this file only walks the season forward and scores it.
 * The app calls the same engine functions on its own data. */
function runSeason(S1, S) {
  const current = [...new Set(Object.values(S.fixtures).flatMap(f => [f.home, f.away]))];
  const P = XPE.buildPriors(S1.rows, Object.values(S1.fixtures), current, OPT), R = XPE.rulesFor(S.season);
  const deadline = {};
  for (const f of Object.values(S.fixtures)) { const t = Date.parse(f.kickoff) - 90 * 60000; if (!(f.gw in deadline) || t < deadline[f.gw]) deadline[f.gw] = t; }
  const byGW = {}; for (const r of S.rows) (byGW[r.gw] || (byGW[r.gw] = [])).push(r);
  const blankState = (pos, price) => ({ mins: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0, win: [], pts: {}, pos, price });

  const st = {}, matches = [], fxXG = {};
  let aThis = 0, xaThis = 0;
  const out = [];

  for (let g = 1; g <= 38; g++) {
    const rowsG = byGW[g] || [];
    const T = XPE.teamRatings(matches, P.team, OPT);
    const assistRatio = (aThis + OPT.assistP * P.assistRatio) / (xaThis + OPT.assistP);
    const dcBand = !P.hasDC && R.defcon ? XPE.dcBandFrom(Object.values(st)) : null;
    const players = {};
    for (const r of rowsG) (players[r.el] || (players[r.el] = [])).push(r);

    for (const [el, fxs] of Object.entries(players)) {
      const r0 = fxs[0], pos = r0.pos, price = r0.price;
      const me = st[el] || blankState(pos, price);
      const p1 = P.pl[r0.code];
      const { rates, mins: m } = XPE.playerInputs(pos, price, me, p1, P, R, OPT, dcBand);

      let xp = 0; const parts = {}; let act = 0; const aparts = {};
      for (const r of fxs) {
        const f = S.fixtures[r.fx];
        const o = XPE.fixtureXP({ pos, rates, mins: m }, XPE.fixtureContext(T, R, f.home, f.away, r.home, assistRatio));
        xp += o.total; for (const k in o.parts) parts[k] = (parts[k] || 0) + o.parts[k];
        act += r.pts; const ap = actualParts(r, R); for (const k in ap) aparts[k] = (aparts[k] || 0) + ap[k];
      }
      /* FPL ep_next as FPL builds it: form over the last 30 days */
      let fs30 = 0, fn30 = 0;
      for (let h = 1; h < g; h++) if (deadline[h] >= deadline[g] - 30 * 864e5) { fs30 += me.pts[h] || 0; fn30++; }
      const fplep = fn30 ? fs30 / fn30 : 0;
      let seasSum = 0; for (let h = 1; h < g; h++) seasSum += me.pts[h] || 0;
      const seas = g > 1 ? seasSum / (g - 1) : 0;
      const recent = me.win.slice(-4).some(w => w.minutes > 0);
      const active = g > 4 ? recent : (me.mins > 0 || (p1 && p1.mins >= 900));
      out.push({ g, el: +el, pos, price, act, xp, fplep, seas, parts, aparts, active, xMins: m.xMins, pStart: m.pStart, p60: m.p60, nfx: fxs.length,
        started: fxs.reduce((t, r) => t + (r.st >= 1 ? 1 : 0), 0), got60: fxs.reduce((t, r) => t + (r.min >= 60 ? 1 : 0), 0),
        winN: me.win.slice(-OPT.minWin).length, winSt: me.win.slice(-OPT.minWin).filter(w => w.starts >= 1).length, name: r0.name });
    }

    /* fold gameweek g into the state only after it has been predicted */
    for (const r of rowsG) {
      const me = st[r.el] || (st[r.el] = blankState(r.pos, r.price));
      me.mins += r.min; me.xg += r.xg; me.xa += r.xa; me.bn += r.bn; me.yc += r.yc; me.sv += r.sv;
      if (r.dc != null) { me.dc += r.dc; me.dcMins += r.min; if (r.st >= 1) me.dcSt++; if (r.dc >= (XPE.DCTHR[r.pos] ?? Infinity)) me.dcHit++; }
      me.win.push({ minutes: r.min, starts: r.st }); me.pts[g] = (me.pts[g] || 0) + r.pts; me.pos = r.pos; me.price = r.price;
      aThis += r.a; xaThis += r.xa;
      const k = r.fx + ':' + r.team; fxXG[k] = (fxXG[k] || 0) + r.xg;
    }
    for (const f of Object.values(S.fixtures).filter(f => f.gw === g)) {
      const h = fxXG[f.id + ':' + f.home], a = fxXG[f.id + ':' + f.away];
      if (h != null && a != null) matches.push({ home: f.home, away: f.away, hxg: h, axg: a });
    }
  }
  return out;
}

/* ── METRICS ─────────────────────────────────────────────────────────── */
function spearman(x, y) {
  const rk = v => { const s = v.map((a, i) => [a, i]).sort((a, b) => a[0] - b[0]); const r = Array(v.length); let i = 0;
    while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const a = rk(x), b = rk(y), n = a.length, ma = (n - 1) / 2; let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - ma); va += (a[i] - ma) ** 2; vb += (b[i] - ma) ** 2; }
  return c / Math.sqrt(va * vb);
}
function metrics(rows, key) {
  const n = rows.length; let ae = 0, se = 0, bias = 0;
  for (const r of rows) { const e = r[key] - r.act; ae += Math.abs(e); se += e * e; bias += e; }
  const gws = [...new Set(rows.map(r => r.g))]; let sp = 0, top = 0, cap = 0;
  for (const g of gws) {
    const rg = rows.filter(r => r.g === g);
    sp += spearman(rg.map(r => r[key]), rg.map(r => r.act));
    const s = rg.slice().sort((a, b) => b[key] - a[key]);
    top += s.slice(0, 20).reduce((t, r) => t + r.act, 0) / 20; cap += s[0].act;
  }
  return { mae: ae / n, rmse: Math.sqrt(se / n), bias: bias / n, spear: sp / gws.length, top20: top / gws.length, cap: cap / gws.length };
}
function calib(rows, key) {
  const edges = [0, 1, 2, 3, 4, 5, 6, 8, 99];
  return edges.slice(0, -1).map((lo, i) => { const hi = edges[i + 1]; const s = rows.filter(r => r[key] >= lo && r[key] < hi);
    return s.length ? `${lo}-${hi === 99 ? '+' : hi}: n${s.length} ${(s.reduce((t, r) => t + r[key], 0) / s.length).toFixed(2)}→${(s.reduce((t, r) => t + r.act, 0) / s.length).toFixed(2)}` : null; }).filter(Boolean);
}

const fmt = m => `MAE ${m.mae.toFixed(3)}  RMSE ${m.rmse.toFixed(3)}  bias ${m.bias >= 0 ? '+' : ''}${m.bias.toFixed(3)}  rank ${m.spear.toFixed(3)}  top20 ${m.top20.toFixed(2)}  capt ${m.cap.toFixed(2)}`;
const all = [];
for (const [p, s] of PAIRS) {
  await ensureSeason(DATA, p); await ensureSeason(DATA, s);
  const res = runSeason(loadSeason(DATA, p), loadSeason(DATA, s));
  all.push(...res.map(r => ({ ...r, season: s })));
  for (const [lab, lo, hi] of [['GW5-38', 5, 38], ['GW1-4', 1, 4]]) {
    const act = res.filter(r => r.active && r.g >= lo && r.g <= hi);
    console.log(`\n${s} ${lab}  active player-GWs ${act.length}`);
    for (const k of ['xp', 'fplep', 'seas']) console.log(`  ${k.padEnd(6)} ${fmt(metrics(act, k))}`);
  }
  if (args.includes('--calib')) {
    const act = res.filter(r => r.active && r.g >= 5);
    console.log('  calib xp   ', calib(act, 'xp').join(' | '));
    console.log('  calib fplep', calib(act, 'fplep').join(' | '));
  }
  if (args.includes('--parts')) {
    const act = res.filter(r => r.active && r.g >= 5), keys = Object.keys(act[0].parts);
    console.log('  component  pred/GW  actual/GW');
    for (const k of keys) { const p = act.reduce((t, r) => t + r.parts[k], 0) / act.length, a = act.reduce((t, r) => t + (r.aparts[k] || 0), 0) / act.length; console.log(`   ${k.padEnd(8)} ${p.toFixed(3).padStart(7)}  ${a.toFixed(3).padStart(7)}`); }
  }
}
if (flag('dump')) fs.writeFileSync(flag('dump'), JSON.stringify(all));
