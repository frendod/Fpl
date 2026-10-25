/* model/planner.js · planner-2026-10-25a
   Transfer planner rules for My Team. Pure functions, no DOM and no fetch, so
   the same file runs in the browser (window.FPLPlanner) and under Node for
   planner-test.mjs.

   What lives here is only the FPL rulebook and the arithmetic that follows
   from it: free transfers, hits, selling prices, bank, chips, formation, club
   cap. index.html owns the screen and supplies prices, positions, clubs and xP
   through `deps`, so nothing here has to know about bootstrap or the xP model.

   THE PLAN STORES INTENT, NEVER RESULTS
   A plan is {gw: {tr:[{out,in}], order, cap, vc, chip}}. Bank, FT, hits and
   validity are recomputed from the base on every call to resolve(). Editing
   GW10 therefore cannot leave GW12 holding stale arithmetic; a later move that
   no longer makes sense (the player was already sold) is dropped and reported.

   RULES ENCODED (2026-27, unchanged from 2025-26 apart from no AFCON top-up)
   - One FT per gameweek, bank up to five. GW1 squad is free; GW2 starts on 1.
   - Each transfer beyond the free ones costs 4 points.
   - Wildcard / Free Hit: unlimited free transfers that week; banked FT are
     kept but no extra one is added.
   - Free Hit: next week the squad, captaincy and bank revert to the week before.
   - Selling price: half of any rise, rounded down to £0.1m; all of any fall.
   - Two chip sets: GW1-19 and GW20-38. One of each per half, no carry-over,
     one chip per gameweek.
   - XI: exactly 1 GKP, 3+ DEF, 2+ MID, 1+ FWD; bench slot 12 is the GKP.
   - Max three players from one club.

   Prices are frozen at today's. A planned week's bank ignores rises and falls
   between now and then; the UI says so. */
(function (g) {
  'use strict';
  const PLANNER_BUILD = 'planner-2026-10-25a';
  const MAX_FT = 5, HIT = 4, CLUB_CAP = 3, FIRST_HALF_END = 19;
  const FREE_CHIPS = { wildcard: 1, freehit: 1 };
  const CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

  /* Selling price in tenths. */
  function sellPrice(now, buy) {
    if (buy == null || now <= buy) return now;
    return buy + Math.floor((now - buy) / 2);
  }

  const half = gw => (gw <= FIRST_HALF_END ? 1 : 2);

  /* Free transfers available for the gameweek after the last row of
     entry/{id}/history/ .current. FPL does not publish the number, so it is
     walked forward from the manager's first gameweek.

     rows:  history.current  [{event, event_transfers, event_transfers_cost}]
     chips: history.chips    [{name, event}]

     A row with a points cost means every free transfer was spent, so the next
     week is 1 whatever the walk believed — that self-corrects any drift from
     a rule the walk does not know about (a one-off top-up, say).
     Returns {next, byEvent} where byEvent[e] is the FT available in week e. */
  function deriveFT(rows, chips) {
    const list = (rows || []).slice().sort((a, b) => a.event - b.event);
    const chipAt = {};
    (chips || []).forEach(c => { chipAt[c.event] = String(c.name || '').toLowerCase(); });
    const byEvent = {};
    let ft = null;
    list.forEach((r, i) => {
      if (i === 0) {                     // first week: squad picked free
        byEvent[r.event] = Infinity;
        ft = 1;
        return;
      }
      byEvent[r.event] = ft;
      const t = r.event_transfers || 0, cost = r.event_transfers_cost || 0;
      if (FREE_CHIPS[chipAt[r.event]]) return;             // kept, no +1
      if (cost > 0) { ft = 1; return; }                    // all spent
      ft = Math.min(MAX_FT, Math.max(0, ft - t) + 1);
    });
    return { next: ft == null ? 1 : ft, byEvent };
  }

  /* Purchase price (tenths) for each player in the squad.
     transfers: entry/{id}/transfers/ [{element_in, element_in_cost, event, time}]
     Latest buy of each player wins. Free Hit weeks are skipped: that squad is
     thrown away, so a price paid there is never the one being sold from.
     Anyone with no transfer in was in the opening squad and cost what FPL
     launched him at: now_cost - cost_change_start. */
  function purchasePrices(squad, transfers, chips, nowCost, startCost) {
    const fh = {};
    (chips || []).forEach(c => { if (String(c.name).toLowerCase() === 'freehit') fh[c.event] = 1; });
    const latest = {};
    (transfers || []).slice()
      .sort((a, b) => (a.event - b.event) || String(a.time || '').localeCompare(String(b.time || '')))
      .forEach(t => { if (!fh[t.event]) latest[t.element_in] = t.element_in_cost; });
    const out = {};
    squad.forEach(id => {
      out[id] = latest[id] != null ? latest[id] : (startCost(id) != null ? startCost(id) : nowCost(id));
    });
    return out;
  }

  function validXI(order, posOf) {
    if (!order || order.length !== 15) return false;
    const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (let i = 0; i < 11; i++) { const p = posOf(order[i]); if (c[p] == null) return false; c[p]++; }
    return c.GKP === 1 && c.DEF >= 3 && c.MID >= 2 && c.FWD >= 1 && posOf(order[11]) === 'GKP';
  }

  /* Where a chip is already spoken for in gw's half: {where:'played'|'planned', gw}
     or null when it is free to use. */
  function chipTaken(chip, gw, played, plan) {
    const p = (played || []).find(x => String(x.name).toLowerCase() === chip && half(x.event) === half(gw));
    if (p) return { where: 'played', gw: p.event };
    const k = Object.keys(plan || {}).map(Number)
      .find(k => k !== gw && plan[k] && plan[k].chip === chip && half(k) === half(gw));
    return k ? { where: 'planned', gw: k } : null;
  }

  /* Walk the plan from fromGw to toGw.
     base:   {order:[15 ids, XI first, slot 12 GKP], cap, vc, bank, buy:{id:tenths}, ft}
     locked: transfers already made on FPL for fromGw [{out,in,sell,cost}]
             (FPL priced them, so their numbers are taken as given)
     played: history.chips
     deps:   {pos(id), club(id), now(id), xp(id,gw)}
     Returns {[gw]: result}. */
  function resolve(o) {
    const { base, plan = {}, fromGw, toGw, locked = [], played = [], deps } = o;
    const out = {};
    let S = { order: base.order.slice(), cap: base.cap, vc: base.vc, bank: base.bank, buy: { ...base.buy }, ft: base.ft };
    for (let gw = fromGw; gw <= toGw; gw++) {
      const gp = plan[gw] || {};
      const st = { order: S.order.slice(), cap: S.cap, vc: S.vc, bank: S.bank, buy: { ...S.buy } };
      const trs = [], dropped = [];
      const apply = (t, isLocked) => {
        if (!st.order.includes(t.out) || st.order.includes(t.in) || deps.pos(t.out) !== deps.pos(t.in)) {
          if (!isLocked) dropped.push(t);
          return;
        }
        const sell = isLocked && t.sell != null ? t.sell : sellPrice(deps.now(t.out), st.buy[t.out]);
        const cost = isLocked && t.cost != null ? t.cost : deps.now(t.in);
        st.bank += sell - cost;
        st.order[st.order.indexOf(t.out)] = t.in;
        delete st.buy[t.out]; st.buy[t.in] = cost;
        if (st.cap === t.out) st.cap = null;
        if (st.vc === t.out) st.vc = null;
        trs.push({ out: t.out, in: t.in, sell, cost, locked: !!isLocked });
      };
      if (gw === fromGw) locked.forEach(t => apply(t, true));
      (gp.tr || []).forEach(t => apply(t, false));

      if (gp.order && gp.order.length === 15 && gp.order.every(id => st.order.includes(id)) && validXI(gp.order, deps.pos))
        st.order = gp.order.slice();
      const xi = st.order.slice(0, 11);
      if (gp.cap && xi.includes(gp.cap)) st.cap = gp.cap;
      if (gp.vc && xi.includes(gp.vc)) st.vc = gp.vc;
      const byXp = ids => ids.slice().sort((a, b) => deps.xp(b, gw) - deps.xp(a, gw));
      // Captain sold or benched: the vice steps up, as FPL does, then best by xP.
      if (!xi.includes(st.cap)) st.cap = xi.includes(st.vc) ? st.vc : byXp(xi)[0];
      if (!xi.includes(st.vc) || st.vc === st.cap) st.vc = byXp(xi.filter(i => i !== st.cap))[0];

      const chip = CHIPS.includes(gp.chip) ? gp.chip : null;
      const free = !!FREE_CHIPS[chip];
      const used = trs.length, avail = S.ft;
      const hits = free ? 0 : Math.max(0, used - avail) * HIT;
      const nextFt = free ? avail : Math.min(MAX_FT, Math.max(0, avail - used) + 1);

      const clubs = {};
      st.order.forEach(id => { const c = deps.club(id); clubs[c] = (clubs[c] || 0) + 1; });
      const overClub = Object.keys(clubs).filter(c => clubs[c] > CLUB_CAP);

      let xp = 0;
      const capMult = chip === '3xc' ? 3 : 2;
      (chip === 'bboost' ? st.order : xi).forEach(id => {
        xp += deps.xp(id, gw) * (id === st.cap ? capMult : 1);
      });
      const chipClash = chip ? chipTaken(chip, gw, played, plan) : null;

      out[gw] = { ...st, trs, dropped, chip, used, avail, hits, nextFt, overClub, chipClash,
        overBudget: st.bank < 0, xp, net: xp - hits,
        valid: st.bank >= 0 && !overClub.length && !chipClash };

      S = chip === 'freehit'
        ? { ...S, ft: nextFt }
        : { order: st.order, cap: st.cap, vc: st.vc, bank: st.bank, buy: st.buy, ft: nextFt };
    }
    return out;
  }

  /* Record a transfer in plan[gw], collapsing pending moves the way FPL's own
     transfer screen does: A->B then B->C is one move A->C, A->B->A is none. */
  function addTransfer(plan, gw, outId, inId) {
    const p = plan[gw] = plan[gw] || { tr: [] };
    p.tr = p.tr || [];
    const prior = p.tr.find(t => t.in === outId);
    if (prior) {
      if (prior.out === inId) p.tr = p.tr.filter(t => t !== prior);
      else prior.in = inId;
    } else p.tr.push({ out: outId, in: inId });
    if (p.order) { const i = p.order.indexOf(outId); if (i >= 0) p.order[i] = inId; }
    if (p.cap === outId) delete p.cap;
    if (p.vc === outId) delete p.vc;
    return plan;
  }

  const API = { PLANNER_BUILD, MAX_FT, HIT, CLUB_CAP, FIRST_HALF_END, CHIPS,
    sellPrice, half, deriveFT, purchasePrices, validXI, chipTaken, resolve, addTransfer };
  g.FPLPlanner = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
