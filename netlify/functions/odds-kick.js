// netlify/functions/odds-kick.js — odds-kick-2026-10-25a
//
// Netlify scheduled function. Every 10 minutes it checks whether an odds
// capture is due and, if so, starts the GitHub "Odds snapshot" workflow
// directly (workflow_dispatch).
//
// Why this exists: GitHub's own scheduler is best-effort and on this repo it
// fires the hourly odds cron only every 3–6 hours. On GW8 (deadline 23 Oct
// 17:30 UTC) not one run landed in the 55–175 min late band, so there was no
// late capture. A manual dispatch is not throttled the way scheduled runs are.
//
// It only dispatches when it matters — one of these windows is open and its
// file is not in the repo yet:
//   early      22–26h before the deadline      gw-N-early.json
//   late       55–175m before the deadline     gw-N-late.json
//   deadline   3–25m before the deadline       gw-N-deadline.json
//   kickoff    45–70m before each kickoff      gw-N-ko-YYYYMMDDTHHMMZ.json
// Everything else is a no-op, so the Actions tab only gets a run when a capture
// is actually due, and it stops as soon as the file lands. One dispatch covers
// everything due on that tick: the script captures every open window itself.
//
// Preview is left to GitHub's hourly cron on purpose. Its band is ten days
// wide and it often writes nothing (odds not listed yet), so kicking it every
// 10 minutes would mean hundreds of runs and wasted Odds API credits.
//
// The dispatched run re-checks the clock and the files itself
// (odds-snapshot.mjs pre), so a stale decision here can never cause a bad
// write. Worst case is one wasted run.
//
// SETUP (Netlify env var, never committed):
//   GH_DISPATCH_TOKEN  fine-grained GitHub token, repository frendod/Fpl only,
//                      permissions: Actions = Read and write, Contents = Read.

const BUILD = 'odds-kick-2026-10-25a';

const OWNER = 'frendod';
const REPO = 'Fpl';
const WORKFLOW = 'odds-snapshot.yml';
const BRANCH = 'main';

// Must stay inside the bands in odds-snapshot.mjs. Trimmed 2 minutes each
// side so a run that takes a little while to start still lands inside the
// script's band.
const DEADLINE_BANDS = [
  { point: 'early',    minMins: 22 * 60 + 2, maxMins: 26 * 60 - 2 },
  { point: 'late',     minMins: 57,          maxMins: 173 },
  { point: 'deadline', minMins: 5,           maxMins: 23 },
];
const KICKOFF_BAND = { minMins: 47, maxMins: 68 };

const FPL = 'https://fantasy.premierleague.com/api/';
const FPL_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/json',
};

function currentSeason(d = new Date()) {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Same naming as odds-snapshot.mjs koTag().
function koTag(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
}

const minsUntil = iso => Math.round((new Date(iso) - Date.now()) / 60000);

async function fpl(path) {
  const r = await fetch(FPL + path, { headers: FPL_HEADERS });
  if (!r.ok) throw new Error(`FPL ${r.status} for ${path}`);
  return r.json();
}

function gh(path, token, init = {}) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': BUILD,
      ...(init.headers || {}),
    },
  });
}

export default async () => {
  const log = (...a) => console.log(`[${BUILD}]`, ...a);
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) { log('GH_DISPATCH_TOKEN not set, doing nothing'); return; }

  let events;
  try { events = (await fpl('bootstrap-static/')).events || []; }
  catch (err) { log('FPL fetch failed:', err.message); return; }

  const season = currentSeason();
  const due = [];   // { label, file }

  // 1. Deadline-relative windows, against the next gameweek.
  const next = events.find(e => e.is_next) || events.find(e => !e.finished);
  if (next && next.deadline_time) {
    const m = minsUntil(next.deadline_time);
    const band = DEADLINE_BANDS.find(b => m >= b.minMins && m <= b.maxMins);
    if (band) due.push({ label: `GW${next.id} ${band.point} (${m}m to deadline)`, file: `gw-${next.id}-${band.point}.json` });
  }

  // 2. Kickoff windows, against the gameweek being played (and next, for the
  //    minutes either side of a deadline when the flags may lag).
  const gws = [events.find(e => e.is_current), next]
    .filter((e, i, a) => e && a.findIndex(x => x && x.id === e.id) === i);
  for (const ev of gws) {
    let fixtures;
    try { fixtures = await fpl(`fixtures/?event=${ev.id}`); }
    catch (err) { log(`GW${ev.id} fixtures fetch failed:`, err.message); continue; }
    const slots = new Set();
    for (const f of fixtures) {
      if (!f.kickoff_time || f.started || f.finished) continue;
      const m = minsUntil(f.kickoff_time);
      if (m >= KICKOFF_BAND.minMins && m <= KICKOFF_BAND.maxMins) slots.add(f.kickoff_time);
    }
    for (const ko of slots) {
      due.push({ label: `GW${ev.id} kickoff ${ko} (${minsUntil(ko)}m to KO)`, file: `gw-${ev.id}-ko-${koTag(ko)}.json` });
    }
  }

  if (!due.length) {
    const m = next && next.deadline_time ? minsUntil(next.deadline_time) : '?';
    log(`GW${next ? next.id : '?'}: ${m}m to deadline, no window open — idle`);
    return;
  }

  // 3. Drop anything already captured. Contents API, not raw.githubusercontent
  //    (that is CDN-cached for minutes).
  const missing = [];
  for (const d of due) {
    const r = await gh(`contents/history/odds/${season}/pre/${d.file}?ref=${BRANCH}`, token, { method: 'GET' });
    if (r.status === 200) { log(`${d.label}: already captured`); continue; }
    if (r.status !== 404) log(`${d.label}: file check returned ${r.status}, treating as missing`);
    missing.push(d);
  }
  if (!missing.length) { log('everything due is captured — idle'); return; }

  // 4. One dispatch covers all of them. No inputs: the script reads the clock
  //    and claims every open window itself.
  const res = await gh(`actions/workflows/${WORKFLOW}/dispatches`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: BRANCH }),
  });
  const what = missing.map(d => d.label).join('; ');
  if (res.status === 204) log(`dispatched for: ${what}`);
  else log(`dispatch FAILED ${res.status} for: ${what} — ${await res.text()}`);
};

export const config = { schedule: '*/10 * * * *' };
