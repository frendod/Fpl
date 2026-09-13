// Netlify Function — runs on Netlify's servers, where browser CORS does not
// apply. Fetches the FPL API directly and returns it to the app.
// Reached at  /api/fpl  (see the redirect in netlify.toml).
//
// Two modes:
//   /api/fpl                     -> bundle of bootstrap-static + fixtures
//   /api/fpl?path=entry/123/     -> passthrough to that FPL endpoint

const BUILD = 'fpl-v5';
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

// Last good body per path, held on the warm instance. This is the answer to
// the fpl-v3 finding: when FPL's edge refuses, it refuses every header profile
// identically with an empty 403, and three rounds of backoff over ~3s did not
// outlast it. Headers and retries cannot beat an IP-level block, but the block
// is intermittent — the same path succeeds minutes either side of it. So keep
// the last accepted body and serve that instead of failing.
//
// Deliberately in-memory rather than a store: no dependency, no new
// infrastructure, and it covers the case that actually hurts, which is a block
// landing between two working requests. A cold instance has nothing cached and
// still fails; the repo snapshot is what covers that, not this.
const LAST_GOOD = new Map();
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function remember(path, body) {
  LAST_GOOD.set(path, { body, at: Date.now() });
}

function recall(path) {
  const hit = LAST_GOOD.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > STALE_TTL_MS) { LAST_GOOD.delete(path); return null; }
  return hit;
}

// Last resort, below the in-memory cache: the copy the hourly GitHub workflow
// captured. A cold instance has an empty LAST_GOOD, so without this a block
// landing on a first request still shows an error.
//
// Read from raw.githubusercontent.com rather than from this site, deliberately.
// history/fpl is excluded from the Netlify build trigger (see netlify.toml), so
// a snapshot commit does not deploy — the file exists in the repo but not in
// the published site. raw is current the moment the workflow pushes.
const RAW = 'https://raw.githubusercontent.com/frendod/Fpl/main/history/fpl/entry/';

// Must stay byte-identical to slug() in entry-snapshot.mjs. If the two drift,
// the fallback finds nothing and fails silently.
function slug(path) {
  return path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '.json';
}

async function fromRepo(path) {
  // Only entry paths are snapshotted; everything else would be a guaranteed
  // 404 and a wasted round trip.
  if (!/^entry\//.test(path)) return null;
  try {
    const res = await fetch(RAW + slug(path), {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    JSON.parse(body); // do not serve a half-written or HTML body as FPL data
    return body;
  } catch (e) {
    return null;
  }
}

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

      if (!got.res) {
        // Blocked. Serve the last accepted copy rather than a 502 — for entry
        // and picks data, minutes-old truth beats an error screen. The headers
        // say it is stale so the app can label it; the body stays byte-identical
        // to what FPL would have sent, since callers parse it as FPL's own shape.
        const stale = recall(path);
        if (stale) {
          logRound(path, 'served-stale', [{ age_ms: Date.now() - stale.at }]);
          return new Response(stale.body, {
            status: 200,
            headers: Object.assign({}, HEADERS, {
              'x-fpl-stale': 'true',
              'x-fpl-fetched-at': new Date(stale.at).toISOString(),
              'netlify-cdn-cache-control': 'no-store',
            }),
          });
        }
        // Nothing in memory — cold instance, or the block outlasted the TTL.
        // Fall back to the workflow's committed capture.
        const repo = await fromRepo(path);
        if (repo) {
          logRound(path, 'served-repo', [{ source: 'github-raw' }]);
          return new Response(repo, {
            status: 200,
            headers: Object.assign({}, HEADERS, {
              'x-fpl-stale': 'true',
              'x-fpl-source': 'repo-snapshot',
              'netlify-cdn-cache-control': 'no-store',
            }),
          });
        }

        return fail('refused by FPL', 502, { diagnostics: got.attempts, path });
      }
      const text = await got.res.text();
      remember(path, text);
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

    // Same stale fallback as passthrough. The bundle is a shape this function
    // builds itself, so the staleness can go in the body where the app will
    // actually see it, rather than only in a header.
    if (!bs.res || !fx.res) {
      const sBs = recall('bootstrap-static/');
      const sFx = recall('fixtures/');
      if (sBs) {
        logRound('bundle', 'served-stale', [{ age_ms: Date.now() - sBs.at }]);
        let bootstrap = null, fixtures = [];
        try { bootstrap = JSON.parse(sBs.body); } catch (e) {}
        if (sFx) { try { fixtures = JSON.parse(sFx.body); } catch (e) {} }
        if (bootstrap) {
          return new Response(JSON.stringify({
            build: BUILD,
            via: 'stale-cache',
            stale: true,
            fetched_at: new Date(sBs.at).toISOString(),
            bootstrap,
            fixtures: Array.isArray(fixtures) ? fixtures : [],
          }), { status: 200, headers: Object.assign({}, HEADERS, {
            'x-fpl-stale': 'true',
            'netlify-cdn-cache-control': 'no-store',
          }) });
        }
      }
      if (!bs.res) return fail('bootstrap refused by FPL', 502, { diagnostics: bs.attempts });
      return fail('fixtures refused by FPL', 502, { diagnostics: fx.attempts });
    }

    const bsText = await bs.res.text();
    const fxText = await fx.res.text();
    remember('bootstrap-static/', bsText);
    remember('fixtures/', fxText);

    let bootstrap = null, fixtures = [];
    try { bootstrap = JSON.parse(bsText); } catch (e) {}
    try { fixtures = JSON.parse(fxText); } catch (e) {}

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
