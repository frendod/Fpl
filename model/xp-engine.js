/* xp-engine.js — xpe-2026-09-10c
 *
 * Expected points, built from FPL's own scoring rules. Pure functions only:
 * no DOM, no fetch, no globals read. The same text runs in the node backtest
 * and will be inlined into index.html, so there is one copy of the model.
 *
 * Per fixture:
 *   appearance   P(1-59)·1 + P(60+)·2
 *   goals        xG rate · expected minutes · fixture factor · points per goal
 *   assists      xA rate · expected minutes · fixture factor · 3 · assist ratio
 *   clean sheet  P(60+) · P(opponent scores 0) · points (GKP/DEF 4, MID 1)
 *   conceded     −1 per 2 goals conceded while on the pitch (GKP/DEF)
 *   saves        1 per 3 saves (GKP)
 *   defcon       P(start) · P(count ≥ threshold) · 2   (2025-26 rules on)
 *   bonus        bonus rate · expected minutes · fixture factor
 *   cards        yellow rate · expected minutes · −1
 *
 * Every rate is a shrinkage estimate: this season's data pulled toward a
 * prior, which is the player's own last season where it exists, and the
 * position-and-price average where it does not. All inputs are FPL data.
 *
 * 2026-09-10b — priors and per-player setup moved in from the backtest
 * (buildPriors, playerInputs), so the backtest and the app assemble a
 * player's inputs with the same code. Backtest output unchanged.
 *
 * 2026-09-10c — availability(): FPL's injury flags as a multiplier on the
 * minutes model, for the app. The backtest has no flags, so its output is
 * unchanged; the live app gains the one input the backtest never had.
 */
const XPE = (() => {

  /* ── RULES ─────────────────────────────────────────────────────────── */
  const BASE_RULES = {
    app1: 1, app60: 2,
    goal: { GKP: 6, DEF: 6, MID: 5, FWD: 4 },
    assist: 3,
    cs: { GKP: 4, DEF: 4, MID: 1, FWD: 0 },
    gcPer2: { GKP: -1, DEF: -1, MID: 0, FWD: 0 },
    savesPer3: 1,
    yellow: -1,
    defcon: null,
  };
  const DEFCON_2025 = { pts: 2, thr: { GKP: Infinity, DEF: 10, MID: 12, FWD: 12 } };
  function rulesFor(season) {
    const start = parseInt(String(season).slice(0, 4), 10);
    return start >= 2025 ? { ...BASE_RULES, defcon: DEFCON_2025 } : { ...BASE_RULES };
  }

  /* ── PARAMETERS ─────────────────────────────────────────────────────
   * Defaults, overridable per call. The backtest tunes these on one season
   * and reports them on the other; nothing here is fitted to the test set. */
  const DEFAULTS = {
    rateP: 1200,        // pseudo-minutes of prior behind a player's rates
    priorP: 900,        // pseudo-minutes of position/price mean behind last season
    teamP: 8,           // pseudo-matches of prior behind team ratings
    minWin: 4,          // gameweeks in the minutes window (backtested earlier)
    minPrior: 2,        // pseudo-gameweeks of prior in the minutes window
    cold: 1.5,          // expected minutes for present-but-never-played
    subMins: 18,
    base: { GKP: 88, DEF: 76, MID: 67, FWD: 72 },   // minutes when starting, fallback
  };

  /* ── POISSON HELPERS ────────────────────────────────────────────────── */
  function pmf(l, k) {
    if (l <= 0) return k === 0 ? 1 : 0;
    let p = Math.exp(-l);
    for (let i = 1; i <= k; i++) p *= l / i;
    return p;
  }
  function pAtLeast(l, k) {
    if (k <= 0) return 1;
    if (!isFinite(k)) return 0;
    let c = 0;
    for (let i = 0; i < k; i++) c += pmf(l, i);
    return Math.max(0, 1 - c);
  }
  /* E[floor(X/d)] for X ~ Poisson(l): the sum over j of P(X ≥ j·d). */
  function eFloorDiv(l, d) {
    let s = 0;
    for (let j = 1; j < 12; j++) { const p = pAtLeast(l, j * d); s += p; if (p < 1e-6) break; }
    return s;
  }
  const shrink = (num, den, prior, pseudo) => (num + prior * pseudo) / (den + pseudo);

  /* ── TEAM RATINGS ───────────────────────────────────────────────────
   * Multiplicative attack and defence on xG, relative to the league mean.
   *   λ(home team) = avg · home · att[home] · def[away]
   * matches: [{home, away, hxg, axg}] from this season so far.
   * prior:   {avg, home, att:{}, def:{}} from last season, promoted teams
   *          already filled in by the caller. */
  function teamRatings(matches, prior, opt = {}) {
    const P = opt.teamP ?? DEFAULTS.teamP;
    const f = {}, a = {}, n = {};
    let tot = 0, cnt = 0, hx = 0, ax = 0;
    for (const m of matches) {
      for (const [t, xf, xa] of [[m.home, m.hxg, m.axg], [m.away, m.axg, m.hxg]]) {
        f[t] = (f[t] || 0) + xf; a[t] = (a[t] || 0) + xa; n[t] = (n[t] || 0) + 1;
      }
      tot += m.hxg + m.axg; cnt += 2; hx += m.hxg; ax += m.axg;
    }
    /* League mean and home edge, both leaning on last season until this one
     * has enough matches to speak for itself. */
    const w = cnt / (cnt + 40);
    const avg = w * (cnt ? tot / cnt : prior.avg) + (1 - w) * prior.avg;
    const homeObs = ax > 0 ? Math.sqrt(hx / ax) : prior.home;
    const home = w * homeObs + (1 - w) * prior.home;
    const teams = new Set([...Object.keys(prior.att || {}), ...Object.keys(n)]);
    const att = {}, def = {};
    for (const t of teams) {
      const k = n[t] || 0;
      const pa = (prior.att && prior.att[t]) || 1, pd = (prior.def && prior.def[t]) || 1;
      att[t] = ((f[t] || 0) / avg + P * pa) / (k + P);
      def[t] = ((a[t] || 0) / avg + P * pd) / (k + P);
    }
    return { avg, home, att, def };
  }
  function lambdas(R, homeTeam, awayTeam) {
    const at = t => R.att[t] ?? 1, df = t => R.def[t] ?? 1;
    return {
      home: R.avg * R.home * at(homeTeam) * df(awayTeam),
      away: R.avg / R.home * at(awayTeam) * df(homeTeam),
    };
  }

  /* ── MINUTES ─────────────────────────────────────────────────────────
   * win:   the player's last few team gameweeks, [{minutes, starts}]
   * prior: {pStart, q60, mStart} from last season or the price-band mean
   * Separates P(start) from minutes-given-start, as the earlier xMins work
   * found necessary; a 60-minute threshold scores a reliable sub as zero. */
  function minutesModel(win, prior, pos, opt = {}) {
    const W = opt.minPrior ?? DEFAULTS.minPrior;
    const base = (opt.base || DEFAULTS.base)[pos] ?? 70;
    const k = win.length;
    const started = win.filter(h => h.starts >= 1);
    const subbed = win.filter(h => !(h.starts >= 1) && h.minutes > 0);
    if (k >= 2 && !started.length && !subbed.length) {
      const xm = opt.cold ?? DEFAULTS.cold;
      return { pStart: 0.01, pSub: 0.02, p60: 0.01, p1: 0.02, mStart: base, xMins: xm, cold: true };
    }
    const pr = prior || { pStart: 0.3, q60: 0.8, mStart: base, pSub: 0.2 };
    const pStart = (started.length + W * pr.pStart) / (k + W);
    /* subbed.length / k is already an unconditional per-gameweek rate, so
     * only the PRIOR (a rate conditional on not starting) is discounted by
     * the chance of not starting. Discounting the whole thing again was the
     * appearance-points shortfall in the first backtest. */
    const pSubPrior = (pr.pSub ?? 0.15) * (1 - (pr.pStart ?? 0.3));
    const pSub = Math.min(1 - pStart, (subbed.length + W * pSubPrior) / (k + W));
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const sm = started.map(h => h.minutes);
    const mStart = (sm.reduce((s, x) => s + x, 0) + W * (pr.mStart || base)) / (sm.length + W);
    const q60 = (sm.filter(m => m >= 60).length + W * (pr.q60 ?? 0.8)) / (sm.length + W);
    const mSub = subbed.length ? mean(subbed.map(h => h.minutes)) : (opt.subMins ?? DEFAULTS.subMins);
    const p60 = pStart * q60;
    const p1 = pStart * (1 - q60) + pSub;
    return { pStart, pSub, p60, p1, mStart, xMins: Math.min(90, pStart * mStart + pSub * mSub), cold: false };
  }

  /* ── ONE FIXTURE ─────────────────────────────────────────────────────
   * pl:  {pos, rates:{xg90, xa90, dc90, sv90, bn90, yc90}, mins}
   * ctx: {lamFor, lamAgainst, lamForAvg, lamAgainstAvg, rules, assistRatio}
   *      lamForAvg is the player's team's λ against an average opponent at
   *      a neutral venue — the context his rates were earned in. The fixture
   *      factor is this fixture's λ over that, so a striker's rate rises
   *      against a leaky defence and falls away at a strong one. */
  function fixtureXP(pl, ctx) {
    const R = ctx.rules, pos = pl.pos, m = pl.mins, r = pl.rates;
    const xmFrac = m.xMins / 90;
    const attF = ctx.lamForAvg > 0 ? ctx.lamFor / ctx.lamForAvg : 1;
    const defF = ctx.lamAgainstAvg > 0 ? ctx.lamAgainst / ctx.lamAgainstAvg : 1;

    const app = m.p1 * R.app1 + m.p60 * R.app60;
    const xg = r.xg90 * xmFrac * attF;
    const xa = r.xa90 * xmFrac * attF * (ctx.assistRatio || 1);
    const goals = xg * R.goal[pos];
    const assists = xa * R.assist;

    /* Clean sheet needs 60 minutes and nothing conceded. Conceded is scaled
     * to the share of the match he is on for. */
    const onFrac = Math.min(1, m.mStart / 90);           // share of the match a starter is on for
    const pCS = Math.exp(-ctx.lamAgainst);               // team clean sheet, full match
    const cs = m.p60 * Math.exp(-ctx.lamAgainst * onFrac) * R.cs[pos];
    const gc = R.gcPer2[pos] ? R.gcPer2[pos] * m.pStart * eFloorDiv(ctx.lamAgainst * onFrac, 2) : 0;

    const saves = pos === 'GKP'
      ? R.savesPer3 * eFloorDiv(r.sv90 * (m.mStart / 90) * defF, 3) * m.pStart : 0;

    /* Defcon is a threshold, so the thing to estimate is how often he
     * clears it, not his average count. Counts are overdispersed, and a
     * Poisson on the mean understated hits by about a third in 2025-26. A
     * per-start hit rate needs no distributional assumption; the Poisson
     * form remains only as the fallback when no hit rate is supplied. */
    let defcon = 0;
    if (R.defcon && pos !== 'GKP') {
      const pHit = r.dcHit != null ? r.dcHit : pAtLeast(r.dc90 * m.mStart / 90, R.defcon.thr[pos]);
      defcon = R.defcon.pts * m.pStart * pHit;
    }

    /* Bonus follows returns: scale the player's bonus rate by how this
     * fixture's attacking and defensive outlook compare with his average. */
    const bonus = r.bn90 * xmFrac * (0.5 * attF + 0.5 * (pos === 'GKP' || pos === 'DEF' ? pCS / Math.max(ctx.pCSAvg || pCS, 1e-6) : attF));
    const cards = r.yc90 * xmFrac * R.yellow;

    const parts = { app, goals, assists, cs, gc, saves, defcon, bonus, cards };
    let total = 0; for (const k in parts) total += parts[k];
    return { total, parts, xg, xa, pCS, xMins: m.xMins };
  }

  /* ── PRIORS FROM LAST SEASON ────────────────────────────────────────
   * rows:     last season's player-matches, {code, pos, min, st, xg, xa, a,
   *           bn, yc, sv, dc (null before 2025-26), price, fx, team}
   * fixtures: last season's fixtures, {id, home, away} by team code
   * current:  this season's team codes — any not in last season's league
   *           are promoted, and take the relegated clubs' average ratings.
   * Output is plain data, so it can be written to a JSON file once a season
   * and loaded by the app. */
  const DCTHR = { DEF: 10, MID: 12, FWD: 12 };
  const band = p => Math.max(4, Math.min(12, Math.floor(p)));
  const blank = () => ({ rows: 0, mins: 0, starts: 0, st60: 0, stMins: 0, subApps: 0, xg: 0, xa: 0, bn: 0, yc: 0, sv: 0, dc: 0, dcMins: 0, dcSt: 0, dcHit: 0 });
  function buildPriors(rows, fixtures, current, opt = {}) {
    const reg = opt.teamRegress ?? 0.8;
    const pl = {}; let hasDC = false;
    for (const r of rows) {
      const p = pl[r.code] || (pl[r.code] = { ...blank(), priceSum: 0, pos: r.pos });
      p.rows++; p.mins += r.min; p.xg += r.xg; p.xa += r.xa; p.bn += r.bn; p.yc += r.yc; p.sv += r.sv; p.priceSum += r.price; p.pos = r.pos;
      if (r.st >= 1) { p.starts++; p.stMins += r.min; if (r.min >= 60) p.st60++; } else if (r.min > 0) p.subApps++;
      if (r.dc != null) { hasDC = true; p.dc += r.dc; p.dcMins += r.min; if (r.st >= 1) p.dcSt++; if (r.dc >= (DCTHR[r.pos] ?? Infinity)) p.dcHit++; }
    }
    const bandT = {}, posT = {};
    for (const p of Object.values(pl)) {
      p.price = p.priceSum / p.rows; delete p.priceSum;
      for (const [T, k] of [[bandT, p.pos + band(p.price)], [posT, p.pos]]) {
        const b = T[k] || (T[k] = blank()); for (const f in b) b[f] += p[f] || 0;
      }
    }
    const byFx = {}, tm = {}; let tot = 0, cnt = 0, hx = 0, ax = 0;
    for (const r of rows) { const k = r.fx + ':' + r.team; byFx[k] = (byFx[k] || 0) + r.xg; }
    for (const f of fixtures) {
      const h = byFx[f.id + ':' + f.home], a = byFx[f.id + ':' + f.away]; if (h == null || a == null) continue;
      for (const [t, xf, xa] of [[f.home, h, a], [f.away, a, h]]) { const o = tm[t] || (tm[t] = { f: 0, a: 0, n: 0 }); o.f += xf; o.a += xa; o.n++; }
      tot += h + a; cnt += 2; hx += h; ax += a;
    }
    const avg = tot / cnt, att = {}, def = {};
    for (const [t, o] of Object.entries(tm)) { att[t] = 1 + reg * (o.f / o.n / avg - 1); def[t] = 1 + reg * (o.a / o.n / avg - 1); }
    const now = new Set((current || []).map(Number));
    const relegated = Object.keys(tm).filter(t => !now.has(Number(t)));
    const mean = (o, ks) => ks.length ? ks.reduce((s, k) => s + o[k], 0) / ks.length : 1;
    const promoted = { att: mean(att, relegated), def: mean(def, relegated) };
    for (const t of now) if (!(t in att)) { att[t] = promoted.att; def[t] = promoted.def; }
    const aSum = rows.reduce((s, r) => s + (r.a || 0), 0), xaSum = rows.reduce((s, r) => s + r.xa, 0);
    return { pl, bandT, posT, team: { avg, home: Math.sqrt(hx / ax), att, def, promoted }, assistRatio: aSum / xaSum, hasDC };
  }

  const rateOf = (t, k) => (k === 'dc' ? (t.dcMins ? t.dc / t.dcMins : 0) : (t.mins ? t[k] / t.mins : 0));
  function bandRate(P, pos, price, k) {
    const b = P.bandT[pos + band(price)], t = P.posT[pos];
    const bm = b ? (k === 'dc' ? b.dcMins : b.mins) : 0, pr = t ? rateOf(t, k) : 0;
    return b ? (rateOf(b, k) * bm + pr * 3000) / (bm + 3000) : pr;
  }
  function bandMinutes(P, pos, price) {
    const b = P.bandT[pos + band(price)] || P.posT[pos];
    return { pStart: b.starts / b.rows, q60: b.st60 / Math.max(1, b.starts), mStart: b.stMins / Math.max(1, b.starts), pSub: b.subApps / Math.max(1, b.rows - b.starts) };
  }
  /* This season's own position/price defcon table, for when last season had
   * no defcon field (backtest of 2025-26). Built from the state list. */
  function dcBandFrom(states) {
    const T = {};
    for (const s of states) for (const k of [s.pos + band(s.price), s.pos]) {
      const b = T[k] || (T[k] = { dc: 0, dcMins: 0, dcSt: 0, dcHit: 0 }); b.dc += s.dc; b.dcMins += s.dcMins; b.dcSt += s.dcSt; b.dcHit += s.dcHit;
    }
    return T;
  }

  /* ── ONE PLAYER'S INPUTS ──────────────────────────────────────────────
   * me:  this season so far, {mins, xg, xa, bn, yc, sv, dc, dcMins, dcSt,
   *      dcHit, win:[{minutes, starts}]}
   * p1:  his entry in the priors (by code), or null
   * Returns the rates and minutes that fixtureXP consumes. */
  const RATE_KEYS = ['xg', 'xa', 'bn', 'yc', 'sv', 'dc'];
  function playerInputs(pos, price, me, p1, P, rules, opt = {}, dcBand = null) {
    const o = { ...DEFAULTS, ...opt };
    const rates = {};
    for (const k of RATE_KEYS) {
      let bandR = bandRate(P, pos, price, k);
      if (k === 'dc' && dcBand) { const b = dcBand[pos + band(price)], q = dcBand[pos]; const qr = q && q.dcMins ? q.dc / q.dcMins : 0; bandR = b && b.dcMins ? (b.dc + qr * 3000) / (b.dcMins + 3000) : qr; }
      const hasPrior = p1 && (k !== 'dc' || P.hasDC);
      const priorR = hasPrior ? shrink(p1[k], k === 'dc' ? p1.dcMins : p1.mins, bandR, o.priorP) : bandR;
      rates[k + '90'] = shrink(me[k], k === 'dc' ? me.dcMins : me.mins, priorR, o.rateP) * 90;
    }
    if (rules.defcon && pos !== 'GKP') {
      const hitOf = b => (b && b.dcSt ? b.dcHit / b.dcSt : null);
      const src = dcBand || P.bandT, q = hitOf((dcBand || P.posT)[pos]), b = src[pos + band(price)];
      const bandH = b && b.dcSt ? (b.dcHit + (q ?? 0) * 20) / (b.dcSt + 20) : q;
      if (bandH != null) {
        const priorH = p1 && P.hasDC ? shrink(p1.dcHit, p1.dcSt, bandH, o.hitP ?? 6) : bandH;
        rates.dcHit = shrink(me.dcHit, me.dcSt, priorH, o.hitP ?? 6);
      }
    }
    const bm = bandMinutes(P, pos, price);
    const minPrior = p1 && p1.rows >= 5 ? {
      pStart: shrink(p1.starts, p1.rows, bm.pStart, 5), q60: shrink(p1.st60, p1.starts, bm.q60, 5),
      mStart: shrink(p1.stMins, p1.starts, bm.mStart, 5), pSub: shrink(p1.subApps, p1.rows - p1.starts, bm.pSub, 5),
    } : bm;
    const mins = minutesModel(me.win.slice(-o.minWin), minPrior, pos, o);
    return { rates, mins };
  }

  /* ── AVAILABILITY ─────────────────────────────────────────────────────
   * FPL's flags as a multiplier on playing time. chance_of_playing_next_round
   * is a percentage when a player is flagged and null when he is not; status
   * is a (available), d (doubtful), i (injured), s (suspended), u (left the
   * club), n (not eligible). When the percentage exists it is the whole
   * story — the earlier Score gate multiplied status AND percentage and so
   * penalised every doubt twice.
   *
   * Flags describe the next gameweek. For later ones the penalty fades over
   * four weeks, because most knocks clear; a long injury is caught anyway by
   * the minutes window going cold once he misses matches. */
  function availability(status, cop, ahead = 0) {
    const pct = cop === null || cop === undefined || cop === '' ? null : Number(cop);
    const a = pct != null && isFinite(pct) ? Math.min(1, Math.max(0, pct / 100))
      : ({ a: 1, d: 0.75, i: 0, s: 0, u: 0, n: 0 }[status] ?? 1);
    if (status === 'u' || status === 'n') return a;
    return 1 - (1 - a) * Math.max(0, 1 - ahead * 0.25);
  }
  function scaleMinutes(m, a) {
    if (a >= 1) return m;
    return { ...m, pStart: m.pStart * a, pSub: m.pSub * a, p60: m.p60 * a, p1: m.p1 * a, xMins: m.xMins * a, avail: a };
  }

  /* Team context for one fixture, from the player's side. */
  function fixtureContext(T, rules, homeTeam, awayTeam, isHome, assistRatio) {
    const L = lambdas(T, homeTeam, awayTeam), team = isHome ? homeTeam : awayTeam;
    return { rules, assistRatio,
      lamFor: isHome ? L.home : L.away, lamAgainst: isHome ? L.away : L.home,
      lamForAvg: T.avg * (T.att[team] ?? 1), lamAgainstAvg: T.avg * (T.def[team] ?? 1),
      pCSAvg: Math.exp(-T.avg * (T.def[team] ?? 1)) };
  }

  return { rulesFor, DEFAULTS, DCTHR, pmf, pAtLeast, eFloorDiv, shrink, teamRatings, lambdas, minutesModel, fixtureXP,
    buildPriors, bandRate, bandMinutes, dcBandFrom, playerInputs, fixtureContext, band, availability, scaleMinutes,
    STAMP: 'xpe-2026-09-10c' };
})();
