#!/usr/bin/env node
/* xp-backtest.mjs — xpbt-2026-09-10a
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
const band = p => Math.max(4, Math.min(12, Math.floor(p)));
const RATE_KEYS = ['xg', 'xa', 'bn', 'yc', 'sv', 'dc'];
const DCTHR = { DEF: 10, MID: 12, FWD: 12 };
OPT.hitP = OPT.hitP ?? 6;

/* ── PRIORS FROM LAST SEASON ─────────────────────────────────────────── */
function buildPriors(S1, S) {
  const pl = {};
  for (const r of S1.rows) {
    const p = pl[r.code] || (pl[r.code] = { rows: 0, mins: 0, starts: 0, st60: 0, stMins: 0, subApps: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0, priceSum: 0, pos: r.pos });
    p.rows++; p.mins += r.min; p.xg += r.xg; p.xa += r.xa; p.bn += r.bn; p.yc += r.yc; p.sv += r.sv; p.priceSum += r.price; p.pos = r.pos;
    if (r.st >= 1) { p.starts++; p.stMins += r.min; if (r.min >= 60) p.st60++; } else if (r.min > 0) p.subApps++;
    if (r.dc != null) { p.dc += r.dc; p.dcMins += r.min; if (r.st >= 1) p.dcSt++; if (r.dc >= (DCTHR[r.pos] ?? Infinity)) p.dcHit++; }
  }
  /* position × price-band means: the prior for anyone without a last season */
  const bandT = {};
  for (const p of Object.values(pl)) {
    const k = p.pos + band(p.priceSum / p.rows);
    const b = bandT[k] || (bandT[k] = { rows: 0, mins: 0, starts: 0, st60: 0, stMins: 0, subApps: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0 });
    for (const f in b) b[f] += p[f] || 0;
  }
  const posT = {};
  for (const [k, b] of Object.entries(bandT)) {
    const pos = k.slice(0, 3); const t = posT[pos] || (posT[pos] = { rows: 0, mins: 0, starts: 0, st60: 0, stMins: 0, subApps: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0 });
    for (const f in t) t[f] += b[f];
  }
  /* teams, keyed by FPL team code (ids are reassigned each season) */
  const tm = {}; let tot = 0, cnt = 0, hx = 0, ax = 0;
  const byFx = {};
  for (const r of S1.rows) { const k = r.fx + ':' + r.team; byFx[k] = (byFx[k] || 0) + r.xg; }
  for (const f of Object.values(S1.fixtures)) {
    const h = byFx[f.id + ':' + f.home], a = byFx[f.id + ':' + f.away]; if (h == null || a == null) continue;
    for (const [t, xf, xa] of [[f.home, h, a], [f.away, a, h]]) { const o = tm[t] || (tm[t] = { f: 0, a: 0, n: 0 }); o.f += xf; o.a += xa; o.n++; }
    tot += h + a; cnt += 2; hx += h; ax += a;
  }
  const avg = tot / cnt, reg = OPT.teamRegress;
  const att = {}, def = {};
  for (const [t, o] of Object.entries(tm)) { att[t] = 1 + reg * (o.f / o.n / avg - 1); def[t] = 1 + reg * (o.a / o.n / avg - 1); }
  /* Promoted clubs: the relegated clubs' ratings are the usual stand-in. */
  const now = new Set(Object.values(S.fixtures).flatMap(f => [f.home, f.away]));
  const relegated = Object.keys(tm).filter(t => !now.has(Number(t)));
  const mean = (o, ks) => ks.reduce((s, k) => s + o[k], 0) / ks.length;
  for (const t of now) if (!(t in att)) { att[t] = mean(att, relegated); def[t] = mean(def, relegated); }
  const aSum = S1.rows.reduce((s, r) => s + r.a, 0), xaSum = S1.rows.reduce((s, r) => s + r.xa, 0);
  return { pl, bandT, posT, team: { avg, home: Math.sqrt(hx / ax), att, def }, assistRatio: aSum / xaSum, hasDC: S1.hasDC };
}

const rateOf = (t, k) => (k === 'dc' ? (t.dcMins ? t.dc / t.dcMins : 0) : (t.mins ? t[k] / t.mins : 0));
function bandRate(P, pos, price, k) {
  const b = P.bandT[pos + band(price)], t = P.posT[pos];
  const bm = b ? (k === 'dc' ? b.dcMins : b.mins) : 0;
  const pr = t ? rateOf(t, k) : 0;
  return b ? (rateOf(b, k) * bm + pr * 3000) / (bm + 3000) : pr;
}
function bandMinutes(P, pos, price) {
  const b = P.bandT[pos + band(price)] || P.posT[pos];
  return { pStart: b.starts / b.rows, q60: b.st60 / Math.max(1, b.starts), mStart: b.stMins / Math.max(1, b.starts), pSub: b.subApps / Math.max(1, b.rows - b.starts) };
}

/* ── WALK FORWARD ──────────────────────────────────────────────────────── */
function runSeason(S1, S) {
  const P = buildPriors(S1, S), R = XPE.rulesFor(S.season);
  const deadline = {};
  for (const f of Object.values(S.fixtures)) { const t = Date.parse(f.kickoff) - 90 * 60000; if (!(f.gw in deadline) || t < deadline[f.gw]) deadline[f.gw] = t; }
  const byGW = {}; for (const r of S.rows) (byGW[r.gw] || (byGW[r.gw] = [])).push(r);

  const st = {};           // this-season accumulators by element
  const matches = []; const fxXG = {};
  let aThis = 0, xaThis = 0;
  const out = [];

  for (let g = 1; g <= 38; g++) {
    const rowsG = byGW[g] || [];
    const T = XPE.teamRatings(matches, P.team, OPT);
    const assistRatio = (aThis + OPT.assistP * P.assistRatio) / (xaThis + OPT.assistP);
    /* A defcon prior when last season had no defcon field: this season's own
     * position/price means so far. */
    let dcBand = null;
    if (!P.hasDC && R.defcon) {
      dcBand = {};
      for (const s of Object.values(st)) for (const k of [s.pos + band(s.price), s.pos]) { const b = dcBand[k] || (dcBand[k] = { dc: 0, dcMins: 0, dcSt: 0, dcHit: 0 }); b.dc += s.dc; b.dcMins += s.dcMins; b.dcSt += s.dcSt; b.dcHit += s.dcHit; }
    }
    const players = {};
    for (const r of rowsG) (players[r.el] || (players[r.el] = [])).push(r);

    for (const [el, fxs] of Object.entries(players)) {
      const r0 = fxs[0], pos = r0.pos, price = r0.price;
      const me = st[el] || { mins: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0, win: [], pts: {}, pos, price };
      const p1 = P.pl[r0.code];
      const rates = {};
      for (const k of RATE_KEYS) {
        let bandR = bandRate(P, pos, price, k);
        if (k === 'dc' && dcBand) { const b = dcBand[pos + band(price)], q = dcBand[pos]; const qr = q && q.dcMins ? q.dc / q.dcMins : 0; bandR = b && b.dcMins ? (b.dc + qr * 3000) / (b.dcMins + 3000) : qr; }
        const hasPrior = p1 && (k !== 'dc' || P.hasDC);
        const priorR = hasPrior ? XPE.shrink(p1[k], k === 'dc' ? p1.dcMins : p1.mins, bandR, OPT.priorP) : bandR;
        const thisMins = k === 'dc' ? me.dcMins : me.mins;
        rates[k + '90'] = XPE.shrink(me[k], thisMins, priorR, OPT.rateP) * 90;
      }
      if (R.defcon && pos !== 'GKP') {
        const hitOf = b => (b && b.dcSt ? b.dcHit / b.dcSt : null);
        let bandH;
        if (dcBand) { const q = hitOf(dcBand[pos]); const b = dcBand[pos + band(price)]; bandH = b && b.dcSt ? (b.dcHit + (q ?? 0) * 20) / (b.dcSt + 20) : q; }
        else { const b = P.bandT[pos + band(price)], q = hitOf(P.posT[pos]); bandH = b && b.dcSt ? (b.dcHit + (q ?? 0) * 20) / (b.dcSt + 20) : q; }
        if (bandH != null) {
          const priorH = p1 && P.hasDC ? XPE.shrink(p1.dcHit, p1.dcSt, bandH, OPT.hitP) : bandH;
          rates.dcHit = XPE.shrink(me.dcHit, me.dcSt, priorH, OPT.hitP);
        }
      }
      const bm = bandMinutes(P, pos, price);
      const minPrior = p1 && p1.rows >= 5 ? {
        pStart: XPE.shrink(p1.starts, p1.rows, bm.pStart, 5), q60: XPE.shrink(p1.st60, p1.starts, bm.q60, 5),
        mStart: XPE.shrink(p1.stMins, p1.starts, bm.mStart, 5), pSub: XPE.shrink(p1.subApps, p1.rows - p1.starts, bm.pSub, 5),
      } : bm;
      const m = XPE.minutesModel(me.win.slice(-OPT.minWin), minPrior, pos, OPT);

      let xp = 0; const parts = {}; let act = 0; const aparts = {};
      for (const r of fxs) {
        const f = S.fixtures[r.fx], L = XPE.lambdas(T, f.home, f.away);
        const lamFor = r.home ? L.home : L.away, lamAgainst = r.home ? L.away : L.home;
        const ctx = { rules: R, lamFor, lamAgainst, lamForAvg: T.avg * (T.att[r.team] ?? 1), lamAgainstAvg: T.avg * (T.def[r.team] ?? 1),
          pCSAvg: Math.exp(-T.avg * (T.def[r.team] ?? 1)), assistRatio };
        const o = XPE.fixtureXP({ pos, rates, mins: m }, ctx);
        xp += o.total; for (const k in o.parts) parts[k] = (parts[k] || 0) + o.parts[k];
        act += r.pts; const ap = actualParts(r, R); for (const k in ap) aparts[k] = (aparts[k] || 0) + ap[k];
      }
      /* FPL ep_next as FPL builds it: form over the last 30 days */
      let fs30 = 0, fn30 = 0;
      for (let h = 1; h < g; h++) if (deadline[h] >= deadline[g] - 30 * 864e5) { fs30 += me.pts[h] || 0; fn30++; }
      const fplep = fn30 ? fs30 / fn30 : 0;
      let seasSum = 0; for (let h = 1; h < g; h++) seasSum += me.pts[h] || 0;
      const seas = g > 1 ? seasSum / (g - 1) : 0;
      const recent = me.win.slice(-4).some(w => w.min > 0);
      const active = g > 4 ? recent : (me.mins > 0 || (p1 && p1.mins >= 900));
      out.push({ g, el: +el, pos, price, act, xp, fplep, seas, parts, aparts, active, xMins: m.xMins, pStart: m.pStart, p60: m.p60, nfx: fxs.length, started: fxs.reduce((t, r) => t + (r.st >= 1 ? 1 : 0), 0), got60: fxs.reduce((t, r) => t + (r.min >= 60 ? 1 : 0), 0), played: fxs.reduce((t, r) => t + (r.min > 0 ? 1 : 0), 0), winN: me.win.slice(-OPT.minWin).length, winSt: me.win.slice(-OPT.minWin).filter(w => w.starts >= 1).length, name: r0.name });
    }

    /* fold gameweek g into the state only after it has been predicted */
    for (const r of rowsG) {
      const me = st[r.el] || (st[r.el] = { mins: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0, win: [], pts: {}, pos: r.pos, price: r.price });
      me.mins += r.min; me.xg += r.xg; me.xa += r.xa; me.bn += r.bn; me.yc += r.yc; me.sv += r.sv;
      if (r.dc != null) { me.dc += r.dc; me.dcMins += r.min; if (r.st >= 1) me.dcSt++; if (r.dc >= (DCTHR[r.pos] ?? Infinity)) me.dcHit++; }
      me.win.push({ minutes: r.min, starts: r.st, min: r.min }); me.pts[g] = (me.pts[g] || 0) + r.pts; me.pos = r.pos; me.price = r.price;
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
