#!/usr/bin/env node
/* xp-test.mjs — xptest-2026-09-06a
 *
 * Behavioural test for the expected-points engine in index.html.
 *
 * Run from the repo root:  node xp-test.mjs
 *
 * WHY IT READS index.html RATHER THAN A COPY
 *
 * The functions are pulled out of the shipped file by name at run time, so
 * there is no second copy of the engine to drift away from the first. If a
 * splice renames or removes one of them the test throws immediately instead
 * of passing against a stale duplicate. The cost is that it is coupled to the
 * function names, which is the intended coupling.
 *
 * The fixtures are synthetic. This checks the engine's ARITHMETIC — doubles,
 * blanks, the next-gameweek split, the My Team horizon override — not whether
 * ep_next is a good number to build on. That question needs a backtest, not
 * an assertion.
 */
import fs from 'node:fs';
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('no script block found in index.html'); process.exit(1); }
const src = m[1];
const grab = name => {
  const i = src.indexOf('function '+name+'(');
  if(i<0) throw new Error('missing '+name);
  let d=0, j=src.indexOf('{', i), k=j;
  for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
  return src.slice(i,k+1);
};
const mult = src.slice(src.indexOf('const XP_FDR_MULT='), src.indexOf('};', src.indexOf('const XP_FDR_MULT='))+2);

globalThis.clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
let fixtures=[], state={nextGW:5}, userTeam={};
const code = mult + '\n' + grab('xpNextGW') + '\n' + grab('oddsMult') + '\n'
  + grab('xpFixtures') + '\n' + grab('projectedPoints') + '\n' + grab('projectedRun');
const fn = new Function('fixtures','state','userTeam','clamp',
  code + '\nreturn {xpFixtures,projectedPoints,projectedRun,xpNextGW,XP_FDR_MULT};');

const F=(event,h,a,hd,ad)=>({event,team_h:h,team_a:a,team_h_difficulty:hd,team_a_difficulty:ad});
fixtures=[
  F(5, 1, 2, 2, 4),            // GW5: team 1 home, easy
  F(6, 3, 1, 2, 5),            // GW6: team 1 away, hard (diff 5)
  F(7, 1, 4, 2, 3),            // GW7: team 1 home, double leg A
  F(7, 5, 1, 3, 2),            // GW7: team 1 away, double leg B
  // GW8 deliberately absent for team 1 -> blank
];
const M = fn(fixtures, state, userTeam, clamp);
const p = {epNext:5.0, teamId:1, pos:'MID'};

const eq=(label,got,want)=>{
  const ok=Math.abs(got-want)<1e-9;
  console.log((ok?'PASS':'FAIL')+'  '+label+'  got '+got.toFixed(4)+'  want '+want.toFixed(4));
  if(!ok) process.exitCode=1;
};

eq('next GW is state.nextGW with no team loaded', M.xpNextGW(), 5);
eq('GW5 (next) returns ep_next unmodified', M.projectedPoints(p,5), 5.0);
eq('GW6 diff 5 MID => 5.0 * 0.77',            M.projectedPoints(p,6), 5.0*0.77);
eq('GW7 double sums both legs (diff 2 each => 1.13)', M.projectedPoints(p,7), 5.0*1.13 + 5.0*1.13);
eq('GW8 blank => 0',                          M.projectedPoints(p,8), 0);
eq('3-GW run = GW5+GW6+GW7',                  M.projectedRun(p,3), 5.0 + 5.0*0.77 + (5.0*1.13+5.0*1.13));

// a double in the NEXT gameweek must split, not multiply
const p2={epNext:6.0, teamId:9, pos:'FWD'};
const fx2=[F(5,9,2,2,4), F(5,3,9,3,3)];
const M2 = fn(fx2, {nextGW:5}, {}, clamp);
eq('double in the next GW splits ep_next', M2.projectedPoints(p2,5), 6.0);
console.log('legs:', M2.xpFixtures(p2,5).map(f=>f.xp));

// My Team pins the horizon to its own loaded squad
const M3 = fn(fixtures, {nextGW:5}, {currentEvent:6}, clamp);
eq('userTeam.currentEvent wins when a squad is loaded', M3.xpNextGW(), 7);
eq('GW7 then reads as the next GW and splits', M3.projectedPoints(p,7), 5.0);

/* ── HORIZON ────────────────────────────────────────────────────────────
 * The window the squad is built for. The rule that matters: a played
 * gameweek must never be selectable, and a long span must not run off the
 * end of the season.
 */
const grabConst = name => {
  const i = src.indexOf('const ' + name + '=');
  if (i < 0) throw new Error('missing const ' + name);
  return src.slice(i, src.indexOf(';', i) + 1);
};
const H = new Function('state','bootstrap','clamp','xiSpan','xiStart',
  grabConst('XI_SPAN_MIN') + '\n'
  + grab('lastGW') + '\n' + grab('xiMaxSpan') + '\n' + grab('xiSpanEff') + '\n'
  + grab('xiStartGW') + '\n' + grab('xiGWs')
  + '\nreturn {lastGW,xiMaxSpan,xiSpanEff,xiStartGW,xiGWs};');

const boot = { events: Array.from({length:38},(_,i)=>({id:i+1})) };
const win = (nextGW, span, start) =>
  H({nextGW}, boot, clamp, span, start).xiGWs();

const same = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok?'PASS':'FAIL') + '  ' + label + '  got [' + got + ']  want [' + want + ']');
  if (!ok) process.exitCode = 1;
};

same('default follows the season',            win(4, 3, null), [4,5,6]);
same('span of 1 is a single gameweek',        win(4, 1, null), [4]);
same('a stored past start is pulled forward', win(9, 3, 2),    [9,10,11]);
same('a start at the season edge is clamped', win(4, 5, 38),   [34,35,36,37,38]);
same('span 5 with 3 weeks left shrinks to 3', win(36, 5, null),[36,37,38]);
same('span 5 with 5 weeks left is intact',   win(34, 5, null),[34,35,36,37,38]);
same('final gameweek, span 1',                win(38, 1, null),[38]);
