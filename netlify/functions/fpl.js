// Netlify Function — runs on Netlify's servers, where browser CORS does not
// apply. Fetches the FPL API directly and returns it to the app.
// Reached at  /api/fpl  (see the redirect in netlify.toml).
//
// Two modes:
//   /api/fpl                     -> bundle of bootstrap-static + fixtures
//   /api/fpl?path=entry/123/     -> passthrough to that FPL endpoint

const BUILD = 'fpl-v2';
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

// Fetch an FPL url, walking the profiles until one is accepted. Returns the
// response plus a per-attempt log, so a failure explains itself instead of
// surfacing as a bare 403 in the UI.
async function fplFetch(path) {
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
