// Netlify Function — one page of a classic league, with every manager's picks
// for the gameweek folded in, so the app can compute ownership client-side.
//
// FPL has no bulk endpoint for this: it is one /entry/{id}/event/{gw}/picks/
// call per manager. A page is 50 managers, fetched 6 at a time, which lands
// well inside the function timeout. One page per invocation keeps it that way.
//
// Reached at /api/league?id=123&gw=4&page=1&me=1847293
//   id    — classic league id (required)
//   gw    — gameweek (required)
//   page  — standings page, 50 managers each (default 1)
//   me    — your entry id, so your own picks come back even if you are
//           outside this page. Excluded from the ownership denominators.
//   t     — cache buster, sent by the Refresh button. Ignored otherwise.

export const config = { path: '/api/league' };

const BUILD = 'league-v3';
const FPL = 'https://fantasy.premierleague.com/api/';
// FPL answers bootstrap-static to almost anything, but guards the league
// endpoints harder — a bare user-agent gets a 403 from their edge. Rather than
// guess which headers it wants, try progressively more browser-like profiles
// and remember whichever one worked for the life of the instance.
const PROFILES = [
  { name: 'browser', headers: (id) => ({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-GB,en;q=0.9',
      'referer': 'https://fantasy.premierleague.com/leagues/' + id + '/standings/c',
      'origin': 'https://fantasy.premierleague.com',
      'x-requested-with': 'XMLHttpRequest',
    }) },
  { name: 'browser-noref', headers: () => ({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-GB,en;q=0.9',
    }) },
  { name: 'simple', headers: () => ({ 'user-agent': 'Mozilla/5.0 (fplrock league)' }) },
  { name: 'bare',   headers: () => ({}) },
];

// Sticky across requests on a warm instance, so we pay the probe cost once.
let WORKING = null;

// Fetch a FPL url, walking the profiles until one is accepted. Returns the
// response plus a per-attempt log so a failure explains itself instead of
// surfacing as a bare 403 in the UI.
async function fplFetch(path, ctx) {
  const url = FPL + path;
  const order = WORKING
    ? [PROFILES.find(p => p.name === WORKING), ...PROFILES.filter(p => p.name !== WORKING)]
    : PROFILES;
  const attempts = [];
  for (const prof of order) {
    if (!prof) continue;
    try {
      const res = await fetch(url, { headers: prof.headers(ctx) });
      if (res.ok) { WORKING = prof.name; return { res, via: prof.name, attempts }; }
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 180); } catch (e) {}
      attempts.push({ profile: prof.name, status: res.status, body: snippet });
    } catch (e) {
      attempts.push({ profile: prof.name, error: String((e && e.message) || e) });
    }
  }
  return { res: null, via: null, attempts };
}

// How many picks requests are in flight at once. Six is deliberate: fifty
// sequential requests would blow the function timeout, and a fifty-wide burst
// is the pattern FPL rate-limits. Netlify egress is a shared IP, so restraint
// here protects every other site on the same address, not just this one.
const CONCURRENCY = 6;

// Stop starting new picks requests after this. The ones already in flight are
// still awaited, so a slow league returns partial rows rather than a 502.
const BUDGET_MS = 7000;

export default async (req) => {
  const HEADERS = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0',
    // Picks are frozen at the deadline; only the points move during a live
    // gameweek. Five minutes is short enough to feel current and long enough
    // that a league everyone in it is refreshing hits FPL once, not once each.
    'netlify-cdn-cache-control': 'public, s-maxage=300, stale-while-revalidate=1800',
  };

  let id, gw, page, me;
  try {
    const u = new URL(req.url);
    id = u.searchParams.get('id');
    gw = parseInt(u.searchParams.get('gw') || '0', 10);
    page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
    me = u.searchParams.get('me') || null;
  } catch (e) {
    return json({ build: BUILD, error: 'bad url' }, HEADERS, 400);
  }

  if (!id) return json({ build: BUILD, error: 'missing league id' }, HEADERS, 400);
  if (!gw || gw < 1 || gw > 38) return json({ build: BUILD, error: 'missing or invalid gw' }, HEADERS, 400);

  const started = Date.now();

  try {
    const got = await fplFetch(
      'leagues-classic/' + encodeURIComponent(id) + '/standings/?page_standings=' + page, id);
    if (!got.res) {
      // Every profile was refused. Hand the whole log back so the cause is
      // visible rather than hidden behind a status code.
      return json({
        build: BUILD, error: 'standings refused by FPL',
        diagnostics: got.attempts,
      }, HEADERS, 502);
    }
    const st = await got.res.json();

    const results = (st.standings && Array.isArray(st.standings.results)) ? st.standings.results : [];
    const hasNext = !!(st.standings && st.standings.has_next);

    // Fan out the picks.
    const fetched = await mapLimit(results, CONCURRENCY, async (r) => {
      if (Date.now() - started > BUDGET_MS) return null;   // out of budget, skip
      return getPicks(r.entry, gw);
    });

    const rows = results.map((r, i) => ({
      entry: r.entry,
      mgr: r.player_name || '',
      team: r.entry_name || '',
      rank: r.rank,
      last: r.last_rank,
      gwp: r.event_total,
      tot: r.total,
      chip: fetched[i] ? fetched[i].chip : null,
      subs: fetched[i] ? fetched[i].subs : [],
      picks: fetched[i] ? fetched[i].picks : [],
      ok: !!fetched[i],
    }));

    // Your own team, if it did not land on this page. Flagged so the app can
    // show it without folding it into the sample.
    let meRow = null;
    if (me && !rows.some(r => String(r.entry) === String(me))) {
      const mp = await getPicks(me, gw);
      if (mp) meRow = { entry: Number(me), picks: mp.picks, chip: mp.chip, subs: mp.subs, outOfSample: true };
    }

    return json({
      ok: true,
      build: BUILD,
      leagueId: Number(id),
      name: (st.league && st.league.name) || '',
      gw, page, hasNext,
      via: got.via,
      count: rows.length,
      failed: rows.filter(r => !r.ok).length,
      rows,
      me: meRow,
      ms: Date.now() - started,
    }, HEADERS);

  } catch (err) {
    return json({ build: BUILD, error: String((err && err.message) || err) }, HEADERS, 502);
  }
};

// One manager's picks, flattened to arrays to keep the payload small:
//   [element, position, multiplier, isCaptain, isViceCaptain]
// position is what tells you a player was benched — 12 to 15. multiplier does
// not, because Bench Boost gives bench players a multiplier of 1.
async function getPicks(entry, gw) {
  try {
    const got = await fplFetch('entry/' + entry + '/event/' + gw + '/picks/', entry);
    if (!got.res) return null;
    const j = await got.res.json();
    if (!j || !Array.isArray(j.picks)) return null;
    return {
      chip: j.active_chip || null,
      // Automatic substitutions, as [in, out]. Without these the per-player
      // points in the squad view will not add up to the manager's gameweek
      // total whenever a starter blanked.
      subs: (j.automatic_subs || []).map(sub => [sub.element_in, sub.element_out]),
      picks: j.picks.map(p => [
        p.element,
        p.position,
        p.multiplier,
        p.is_captain ? 1 : 0,
        p.is_vice_captain ? 1 : 0,
      ]),
    };
  } catch (e) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

function json(obj, headers, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}
