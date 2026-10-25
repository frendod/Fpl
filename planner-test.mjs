#!/usr/bin/env node
/* planner-test.mjs — plantest-2026-10-25a
 *
 * Rules test for the transfer planner in model/planner.js.
 * Run from the repo root:  node planner-test.mjs
 *
 * Loads the shipped module, not a copy. Fixtures are synthetic: this pins the
 * FPL rulebook arithmetic (FT banking, hits, Wildcard / Free Hit, selling
 * prices, chip halves, formation, club cap), not anything about xP.
 *
 * The one thing it cannot prove is that deriveFT agrees with FPL for a real
 * manager. Check that by hand once: load your ID in My Team, open the next
 * gameweek, and compare "Free transfers" with the FPL Transfers page.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('./model/planner.js');

let n = 0, bad = 0;
const ok = (cond, msg) => { n++; if (!cond) { bad++; console.log('FAIL  ' + msg); } else console.log('ok    ' + msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

/* ── selling price ── */
eq(P.sellPrice(80, 75), 77, 'sell: +0.5m rise keeps 0.2m (rounded down)');
eq(P.sellPrice(76, 75), 75, 'sell: +0.1m rise keeps nothing');
eq(P.sellPrice(70, 75), 70, 'sell: a fall is taken in full');

/* ── free transfers from history ── */
const rows = (arr) => arr.map(([event, t, cost]) => ({ event, event_transfers: t, event_transfers_cost: cost || 0 }));
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 0]]), []).next, 3, 'FT: roll twice from GW2 → 3 for GW4');
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]]), []).next, 5, 'FT: banking caps at 5');
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 2]]), []).next, 1, 'FT: spend both → 1 next');
eq(P.deriveFT(rows([[1, 0], [2, 3, 4]]), []).next, 1, 'FT: took a hit → 1 next');
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 0], [4, 9]]), [{ name: 'wildcard', event: 4 }]).next, 3, 'FT: wildcard keeps 3, adds none');
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 7]]), [{ name: 'freehit', event: 3 }]).next, 2, 'FT: free hit keeps 2, adds none');
eq(P.deriveFT(rows([[5, 0], [6, 0]]), []).next, 2, 'FT: late joiner starts counting from first week');
eq(P.deriveFT(rows([[1, 0], [2, 0], [3, 1, 4]]), []).next, 1, 'FT: a cost resets to 1 even if the walk disagreed');

/* ── purchase prices ── */
const buy = P.purchasePrices([1, 2, 3],
  [{ element_in: 2, element_in_cost: 64, event: 3, time: 'a' }, { element_in: 2, element_in_cost: 66, event: 6, time: 'b' },
   { element_in: 3, element_in_cost: 99, event: 7, time: 'c' }],
  [{ name: 'freehit', event: 7 }], id => 70, id => 50);
eq(buy, { 1: 50, 2: 66, 3: 50 }, 'buy: latest transfer wins, free hit buys ignored, opening squad = launch price');

/* ── a small synthetic world ── */
// ids 1-2 GKP, 3-8 DEF, 9-14 MID, 15-18 FWD; clubs A..F
const POS = {}, CLUB = {}, NOW = {}, XP = {};
const mk = (id, pos, club, now, xp) => { POS[id] = pos; CLUB[id] = club; NOW[id] = now; XP[id] = xp; };
mk(1,'GKP','A',50,4); mk(2,'GKP','B',40,3);
mk(3,'DEF','A',60,5); mk(4,'DEF','B',55,4); mk(5,'DEF','C',50,4); mk(6,'DEF','D',45,3); mk(7,'DEF','E',45,3);
mk(8,'DEF','A',60,6);   // not owned
mk(9,'MID','A',100,7); mk(10,'MID','B',80,6); mk(11,'MID','C',70,5); mk(12,'MID','D',60,4); mk(13,'MID','E',50,3);
mk(14,'MID','A',90,8);  // not owned
mk(15,'FWD','F',90,6); mk(16,'FWD','F',70,5); mk(17,'FWD','C',50,3);
mk(18,'FWD','F',80,7);  // not owned
const deps = { pos: i => POS[i], club: i => CLUB[i], now: i => NOW[i], xp: i => XP[i] };
// XI: GK1, DEF 3 4 5 6, MID 9 10 11 12, FWD 15 16 | bench GK2, 13, 7, 17
const order = [1, 3, 4, 5, 6, 9, 10, 11, 12, 15, 16, 2, 13, 7, 17];
const base = { order, cap: 9, vc: 10, bank: 10, buy: Object.fromEntries(order.map(i => [i, NOW[i]])), ft: 2 };
const run = (plan, extra = {}) => P.resolve({ base, plan, fromGw: 10, toGw: 14, deps, ...extra });

let R = run({});
eq([R[10].avail, R[11].avail, R[12].avail, R[13].avail, R[14].avail], [2, 3, 4, 5, 5], 'chain: no moves banks to 5');
ok(Math.abs(R[10].xp - (4+5+4+4+3+7*2+6+5+4+6+5)) < 1e-9, 'xp: XI only, captain doubled');

R = run({ 10: { tr: [{ out: 9, in: 14 }, { out: 15, in: 18 }, { out: 4, in: 8 }] } });
eq([R[10].used, R[10].hits, R[11].avail], [3, 4, 1], 'hits: 3rd move on 2 FT costs 4, next week 1');
ok(Math.abs(R[10].net - (R[10].xp - 4)) < 1e-9, 'net: hit comes off the projection');
R = run({ 10: { tr: [{ out: 9, in: 14 }, { out: 15, in: 18 }, { out: 12, in: 13 }] } });
eq([R[10].used, R[10].hits, R[10].dropped.length], [2, 0, 1], 'dropped: buying an owned player is rejected and not charged');
eq(R[10].bank, 10 + 100 - 90 + 90 - 80, 'bank: sells and buys net through');

R = run({ 10: { tr: [{ out: 3, in: 8 }] } });
eq(R[10].overClub, [], 'club cap: two from A is fine');
R = run({ 10: { tr: [{ out: 10, in: 14 }, { out: 4, in: 8 }] } });
eq(R[10].overClub, ['A'], 'club cap: a fourth from A is flagged');

R = run({ 10: { tr: [{ out: 9, in: 14 }] }, 11: { tr: [{ out: 9, in: 13 }] } });
eq(R[11].dropped.length, 1, 'ripple: selling someone already sold is dropped');

R = run({ 11: { chip: 'wildcard', tr: [{ out: 9, in: 14 }, { out: 15, in: 18 }, { out: 3, in: 8 }] } });
eq([R[11].avail, R[11].hits, R[12].avail], [3, 0, 3], 'wildcard: free moves, FT kept with no +1');

R = run({ 11: { chip: 'freehit', tr: [{ out: 9, in: 14 }] } });
ok(R[11].order.includes(14) && R[12].order.includes(9) && !R[12].order.includes(14), 'free hit: squad reverts next week');
eq([R[11].bank, R[12].bank], [20, 10], 'free hit: bank reverts too');

R = run({ 10: { chip: 'bboost' } });
ok(Math.abs(R[10].xp - (60 + 3 + 3 + 3 + 3)) < 1e-9, 'bench boost: all fifteen counted');
R = run({ 10: { chip: '3xc' } });
ok(Math.abs(R[10].xp - (53 + 7 * 3 - 7)) < 1e-9, 'triple captain: armband x3');

const played = [{ name: '3xc', event: 5 }];
R = run({ 10: { chip: '3xc' } }, { played });
eq(R[10].chipClash, { where: 'played', gw: 5 }, 'chips: TC played in GW5 blocks GW10');
eq(P.chipTaken('3xc', 22, played, {}), null, 'chips: second half has its own set');
R = run({ 10: { chip: 'wildcard' }, 12: { chip: 'wildcard' } });
ok(R[10].chipClash && R[12].chipClash, 'chips: same chip twice in a half flagged both weeks');

R = run({ 10: { order: [1, 3, 4, 5, 13, 9, 10, 11, 12, 15, 16, 2, 6, 7, 17] } });
ok(R[10].order[4] === 13, 'subs: valid 3-5-2 accepted');
ok(P.validXI([1, 3, 4, 9, 6, 5, 10, 11, 12, 15, 16, 2, 13, 7, 17], deps.pos), 'formation: reordered XI still legal');
ok(!P.validXI([1, 3, 4, 9, 10, 11, 12, 13, 15, 16, 17, 2, 5, 6, 7], deps.pos), 'formation: two at the back rejected');

R = run({ 10: { tr: [{ out: 9, in: 14 }] } }, { locked: [{ out: 15, in: 18, sell: 88, cost: 80 }] });
eq([R[10].used, R[10].trs[0].locked, R[10].bank], [2, true, 10 + 88 - 80 + 100 - 90], 'locked: FPL-made moves count and use FPL prices');

const plan = {};
P.addTransfer(plan, 10, 9, 14); P.addTransfer(plan, 10, 14, 13);
eq(plan[10].tr, [{ out: 9, in: 13 }], 'pending: A→B then B→C collapses to A→C');
P.addTransfer(plan, 10, 13, 9);
eq(plan[10].tr, [], 'pending: sending him back cancels the move');

R = run({ 10: { tr: [{ out: 9, in: 14 }] } });
eq([R[10].cap, R[10].vc], [10, 14], 'captain: sold captain promotes the vice, new vice is best by xP');

console.log('\n' + (n - bad) + '/' + n + ' passed · ' + P.PLANNER_BUILD);
process.exit(bad ? 1 : 0);
