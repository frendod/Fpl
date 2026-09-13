// Netlify Function — runs on Netlify's servers, where browser CORS does not
// apply. Fetches the FPL API directly and returns it to the app.
// Reached at  /api/fpl  (see the redirect in netlify.toml).
//
// Two modes:
//   /api/fpl                     -> bundle of bootstrap-static + fixtures
//   /api/fpl?path=entry/123/     -> passthrough to that FPL endpoint

const BUILD = 'fpl-v3';
const FPL = 'https://fantasy.premierleague.com/api/';

// FPL answers bootstrap-static to almost anything, but guards the entry and
// league endpoints harder — a bare user-agent gets a 403 from their edge.
// Rather than guess which headers it wants, try progressively more
// browser-like profiles and remember whichever one worked.
const PROFILES = [
  { name: 'browser', headers: () => ({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-GB,en;q=0.9',
      'referer': 'https://fantasy.premierleague.com/',
      'origin': 'https://fantasy.premierleague.com',
      'x-requested-with': 'XMLHttpRequest',
    }) },
  { name: 'browser-noref', headers: () => ({
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-GB,en;q=0.9',
    }) },
  { name: 'simple', headers: () => ({ 'user-agent': 'Mozilla/5.0 (fplrock netlify function)' }) },
  { name: 'bare',   headers: () => ({}) },
];

// Sticky across requests on a warm instance, so the probe cost is paid once.
let WORKING = null;

// Logs a failed round to Netlify's function log (Logs & metrics → Functions →
// fpl → Function log). Only fires when a whole profile walk came back empty,
// so a normal successful fetch writes nothing and the log stays readable.
function logRound(path, round, attempts) {
  console.error(JSON.stringify({
    build: BUILD,
    time: new Date().toISOString(),
    path,
    round,
    attempts,
  }));
}

// Walk every profile once. Separated from fplFetch so the retry loop below can
// repeat the whole walk rather than just the last profile — a transient edge
// block rejects all four identically, so retrying one is pointless.
async function walkProfiles(path) {
  const order = WORKING
    ? [PROFILES.find(p => p.name === WORKING), ...PROFILES.filter(p => p.name !== WORKING)]
    : PROFILES;
  const attempts = [];
  for (const prof of order) {
    if (!prof) continue;
    try {
      const res = await fetch(FPL + path, { headers: prof.headers() });
      if (res.ok) { WORKING = prof.name; return { res, via: prof.name, attempts }; }
      let body = '';
      try { body = (await res.text()).slice(0, 180); } catch (e) {}
      attempts.push({ profile: prof.name, status: res.status, body });
    } catch (e) {
      attempts.push({ profile: prof.name, error: String((e && e.message) || e) });
    }
  }
  return { res: null, via: null, attempts };
}

// Fetch an FPL url, walking the profiles until one is accepted. Returns the
// response plus a per-attempt log, so a failure explains itself instead of
// surfacing as a bare 403 in the UI.
//
// Why the retry loop: until fpl-v3 this walked the four profiles once, back to
// back, with no delay — the whole thing finished inside a second. FPL's edge
// intermittently refuses a datacenter IP outright for a few seconds, which
// rejected all four attempts identically and surfaced as a 502 in the UI, even
// though a manual retry moments later always worked. The backoff gives that
// block time to clear. Three rounds at 0/700/1800ms keeps the worst case near
// three seconds, well inside the function's time budget.
const ROUND_DELAYS = [0, 700, 1800];

async function fplFetch(path) {
  let last = { res: null, via: null, attempts: [] };
  for (let round = 0; round < ROUND_DELAYS.length; round++) {
    if (ROUND_DELAYS[round]) await new Promise(r => setTimeout(r, ROUND_DELAYS[round]));

    const got = await walkProfiles(path);
    if (got.res) {
      // Recovered on a later round. Worth logging: if this shows up often the
      // block is not as transient as assumed and needs a real fix.
      if (round) logRound(path, round + 1, [{ recovered: true, via: got.via }]);
      return got;
    }

    logRound(path, round + 1, got.attempts);
    // The remembered profile is only worth keeping while it works. If a whole
    // round failed, clear it so the next round re-probes from the top rather
    // than leading with a profile FPL has just rejected.
    WORKING = null;
    // A clean 404 or 400 will not improve on a retry — only keep going while
    // the failures look like blocking (403/429/5xx) or outright network errors.
    const retryable = got.attempts.some(a =>
      a.error || a.status === 403 || a.status === 429 || a.status >= 500);
    last = got;
    if (!retryable) break;
  }
  return last;
}

// Only endpoints the app actually uses. This keeps the function from being
// repurposed as an open proxy, and blocks traversal out of the FPL api root.
const ALLOWED = [
  /^bootstrap-static\/$/,
  /^fixtures\/$/,
  /^entry\/\d+\/$/,
  /^entry\/\d+\/history\/$/,
  /^entry\/\d+\/event\/\d+\/picks\/$/,
  /^element-summary\/\d+\/$/,
  /^event\/\d+\/live\/$/,
  /^leagues-classic\/\d+\/standings\/(\?page_standings=\d+)?$/,
];

export default async (req) => {
  const HEADERS = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0',
    'netlify-cdn-cache-control': 'public, s-maxage=600, stale-while-revalidate=3600',
  };
  const fail = (msg, status, extra) => new Response(
    JSON.stringify(Object.assign({ build: BUILD, error: msg }, extra || {})),
    { status, headers: HEADERS }
  );

  let path = null;
  try { path = new URL(req.url).searchParams.get('path'); } catch (e) {}

  try {
    /* ── passthrough mode ── */
    if (path) {
      if (path.indexOf('..') > -1 || /^https?:/i.test(path))
        return fail('path rejected', 400);
      if (!ALLOWED.some(re => re.test(path)))
        return fail('path not allowed: ' + path, 400);

      const got = await fplFetch(path);
      if (!got.res) return fail('refused by FPL', 502, { diagnostics: got.attempts, path });

      const text = await got.res.text();
      return new Response(text, {
        status: 200,
        headers: Object.assign({}, HEADERS, {
          // Picks and standings move during a gameweek, so they are cached far
          // more briefly than the bundle.
          'netlify-cdn-cache-control': 'public, s-maxage=120, stale-while-revalidate=600',
        }),
      });
    }

    /* ── bundle mode ── */
    const [bs, fx] = await Promise.all([
      fplFetch('bootstrap-static/'),
      fplFetch('fixtures/'),
    ]);
    if (!bs.res) return fail('bootstrap refused by FPL', 502, { diagnostics: bs.attempts });
    if (!fx.res) return fail('fixtures refused by FPL', 502, { diagnostics: fx.attempts });

    const bootstrap = await bs.res.json();
    const fixtures = await fx.res.json();

    if (!bootstrap || !Array.isArray(bootstrap.elements) || !bootstrap.elements.length)
      return fail('bootstrap payload malformed', 502);

    return new Response(JSON.stringify({
      build: BUILD,
      via: bs.via,
      fetched_at: new Date().toISOString(),
      bootstrap,
      fixtures: Array.isArray(fixtures) ? fixtures : [],
    }), { status: 200, headers: HEADERS });

  } catch (err) {
    return fail(String((err && err.message) || err), 502);
  }
};
