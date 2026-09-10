/* xp-data.mjs — xpdata-2026-09-10b
 *
 * Loads a vaastav season into the shapes the xP engine consumes, which are
 * deliberately the same shapes the app can build from history/fpl/post/ and
 * bootstrap. If the backtest and the app ever read different fields for the
 * same idea, the backtest stops meaning anything.
 */
import fs from 'node:fs';

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const num = v => (v === undefined || v === '' ? 0 : Number(v));
const POS = { GK: 'GKP', GKP: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };

/* Fetch a vaastav season into dir if it is not there yet. The data is a few
 * MB per season and lives outside git (model/data/ is ignored), so a fresh
 * clone runs the backtest with no manual download step. */
const VAASTAV = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
export async function ensureSeason(dir, season, files = ['gws/merged_gw.csv', 'players_raw.csv', 'fixtures.csv', 'teams.csv']) {
  for (const f of files) {
    const out = `${dir}/${season}/${f.split('/').pop()}`;
    if (fs.existsSync(out)) continue;
    fs.mkdirSync(`${dir}/${season}`, { recursive: true });
    const r = await fetch(`${VAASTAV}/${season}/${f}`);
    if (!r.ok) throw new Error(`${r.status} fetching ${season}/${f}`);
    fs.writeFileSync(out, await r.text());
    console.error(`  fetched ${season}/${f}`);
  }
}

export function loadSeason(dir, season) {
  const read = f => parseCSV(fs.readFileSync(`${dir}/${season}/${f}`, 'utf8'));
  const teamsRaw = read('teams.csv');
  const teamCode = Object.fromEntries(teamsRaw.map(t => [num(t.id), num(t.code)]));
  const teamShort = Object.fromEntries(teamsRaw.map(t => [num(t.code), t.short_name]));
  const fxRaw = read('fixtures.csv');
  const fixtures = {};
  for (const f of fxRaw) fixtures[num(f.id)] = {
    id: num(f.id), gw: num(f.event), home: teamCode[num(f.team_h)], away: teamCode[num(f.team_a)],
    kickoff: f.kickoff_time, hd: num(f.team_h_difficulty), ad: num(f.team_a_difficulty),
  };
  const pr = read('players_raw.csv');
  const code = Object.fromEntries(pr.map(p => [num(p.id), num(p.code)]));

  const hasDC = fs.readFileSync(`${dir}/${season}/merged_gw.csv`, 'utf8').slice(0, 2000).includes('defensive_contribution');
  const rows = [];
  for (const r of read('merged_gw.csv')) {
    const pos = POS[r.position]; if (!pos) continue;          // drops the AM chip rows
    const fx = fixtures[num(r.fixture)]; if (!fx) continue;
    const home = r.was_home === 'True' || r.was_home === 'true' || r.was_home === '1';
    rows.push({
      el: num(r.element), code: code[num(r.element)], pos, gw: num(r.GW), fx: fx.id,
      team: home ? fx.home : fx.away, opp: home ? fx.away : fx.home, home,
      min: num(r.minutes), st: num(r.starts), xg: num(r.expected_goals), xa: num(r.expected_assists),
      g: num(r.goals_scored), a: num(r.assists), cs: num(r.clean_sheets), gc: num(r.goals_conceded),
      sv: num(r.saves), bn: num(r.bonus), yc: num(r.yellow_cards), rc: num(r.red_cards),
      og: num(r.own_goals), pm: num(r.penalties_missed), ps: num(r.penalties_saved),
      dc: hasDC ? num(r.defensive_contribution) : null,
      pts: num(r.total_points), price: num(r.value) / 10, name: r.name,
    });
  }
  return { season, rows, fixtures, teamShort, hasDC };
}

/* Actual points by component, from the same rules the engine predicts with.
 * Used both to validate the rules (components must sum to total_points) and
 * to score each component's prediction against its own outcome. */
export function actualParts(r, R) {
  const app = r.min >= 60 ? R.app60 : r.min > 0 ? R.app1 : 0;
  const parts = {
    app,
    goals: r.g * R.goal[r.pos],
    assists: r.a * R.assist,
    cs: r.cs * R.cs[r.pos],
    gc: R.gcPer2[r.pos] ? R.gcPer2[r.pos] * Math.floor(r.gc / 2) : 0,
    saves: r.pos === 'GKP' ? Math.floor(r.sv / 3) * R.savesPer3 : 0,
    defcon: R.defcon && r.pos !== 'GKP' && r.dc != null && r.dc >= R.defcon.thr[r.pos] ? R.defcon.pts : 0,
    bonus: r.bn,
    cards: r.yc * R.yellow - 3 * r.rc,
    other: -2 * r.og - 2 * r.pm + 5 * r.ps,
  };
  return parts;
}
