// netlify/functions/odds-kick.js — odds-kick-2026-10-24a
//
// Netlify scheduled function. Every 10 minutes it checks whether the odds
// snapshot is due and, if so, starts the GitHub "Odds snapshot" workflow
// directly (workflow_dispatch).
//
// Why this exists: GitHub's own scheduler is best-effort and on this repo it
// fires the hourly odds cron only every 3–6 hours. On GW8 (deadline 23 Oct
// 17:30 UTC) not one run landed in the 55–175 min late band, so there was no
// late capture. A manual dispatch is not throttled the way scheduled runs are.
//
// It only dispatches when it matters:
//   - the clock is inside the early or late band, and
//   - that band's file (history/odds/<season>/pre/gw-N-<point>.json) is not
//     in the repo yet.
// Everything else is a no-op, so the Actions tab only gets a run when a capture
// is actually due, and it stops as soon as the file lands.
//
// Preview is left to GitHub's hourly cron on purpose. Its band is ten days
// wide and it often writes nothing (odds not listed yet), so kicking it every
// 10 minutes would mean hundreds of runs and wasted Odds API credits.
//
// The dispatched run re-checks the clock and the file itself
// (odds-snapshot.mjs pre), so a stale decision here can never cause a bad
// write. Worst case is one wasted run.
//
// SETUP (Netlify env var, never committed):
//   GH_DISPATCH_TOKEN  fine-grained GitHub token, repository frendod/Fpl only,
//                      permissions: Actions = Read and write, Contents = Read.

const BUILD = 'odds-kick-2026-10-24a';

const OWNER = 'frendod';
const REPO = 'Fpl';
const WORKFLOW = 'odds-snapshot.yml';
const BRANCH = 'main';

// Must stay inside CAPTURES in odds-snapshot.mjs (early 1320–1560m,
// late 55–175m). Trimmed 2 minutes each side so a run that takes a few
// seconds to start still lands inside the script's band.
const BANDS = [
  { point: 'early', minMins: 22 * 60 + 2, maxMins: 26 * 60 - 2 },
  { point: 'late',  minMins: 57,          maxMins: 173 },
];

const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';

function currentSeason(d = new Date()) {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
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

  // 1. Next deadline from FPL.
  let next;
  try {
    const r = await fetch(FPL_BOOTSTRAP, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'application/json',
      },
    });
    if (!r.ok) throw new Error(`FPL ${r.status}`);
    const events = (await r.json()).events || [];
    next = events.find(e => e.is_next) || events.find(e => !e.finished);
  } catch (err) {
    log('FPL fetch failed:', err.message);
    return;
  }
  if (!next || !next.deadline_time) { log('no upcoming deadline'); return; }

  const mins = Math.round((new Date(next.deadline_time) - Date.now()) / 60000);
  const band = BANDS.find(b => mins >= b.minMins && mins <= b.maxMins);
  if (!band) { log(`GW${next.id}: ${mins}m to deadline, no band — idle`); return; }

  // 2. Already captured? Contents API, not raw.githubusercontent (that is
  //    CDN-cached for minutes).
  const file = `history/odds/${currentSeason()}/pre/gw-${next.id}-${band.point}.json`;
  const head = await gh(`contents/${file}?ref=${BRANCH}`, token, { method: 'GET' });
  if (head.status === 200) { log(`GW${next.id} ${band.point}: already captured — idle`); return; }
  if (head.status !== 404) { log(`GW${next.id}: file check returned ${head.status}, dispatching anyway`); }

  // 3. Start the workflow. No inputs: the script reads the clock and claims
  //    the band itself.
  const res = await gh(`actions/workflows/${WORKFLOW}/dispatches`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (res.status === 204) {
    log(`GW${next.id} ${band.point}: ${mins}m out, file missing — dispatched`);
  } else {
    log(`GW${next.id} ${band.point}: dispatch failed ${res.status} ${await res.text()}`);
  }
};

export const config = { schedule: '*/10 * * * *' };
