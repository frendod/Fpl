/* xp-engine.js — xpe-2026-09-10a
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

  return { rulesFor, DEFAULTS, pmf, pAtLeast, eFloorDiv, shrink, teamRatings, lambdas, minutesModel, fixtureXP };
})();
