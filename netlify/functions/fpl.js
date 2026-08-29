// Netlify Function — runs on Netlify's servers, where browser CORS does not
// apply. Reached at /api/fpl (see the redirect in netlify.toml).
//
// Two modes:
//   /api/fpl                       -> bootstrap + fixtures bundle (unchanged)
//   /api/fpl?path=entry/185282/    -> passthrough to any allowed FPL API path
//
// The passthrough lives here rather than in its own fpl-proxy function because
// this route is known to deploy and resolve, and a separate function was
// returning Netlify's 404 page — i.e. never reaching any code at all. One
// function, one route, nothing extra to wire up.

const BUILD = 'fpl-v2';

const UA = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-GB,en;q=0.9',
  'referer': 'https://fantasy.premierleague.com/',
};

// Only these prefixes may be proxied. Without this the endpoint relays anything
// under fantasy.premierleague.com.
const ALLOWED = [
  'entry/',
  'element-summary/',
  'bootstrap-static/',
  'fixtures',
  'event/',
  'leagues-classic/',
];

const BASE = 'https://fantasy.premierleague.com/api/';

export default async (req, context) => {
  // The bundle is stable for minutes; entry data changes during a gameweek, so
  // the two modes cannot share a cache policy.
  const bundleHeaders = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0',
    'netlify-cdn-cache-control': 'public, s-maxage=600, stale-while-revalidate=3600',
  };
  const pathHeaders = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0',
    'netlify-cdn-cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  };

  let path = '';
  try {
    path = new URL(req.url).searchParams.get('path') || '';
  } catch (e) {
    return fail(400, 'bad request url', bundleHeaders);
  }

  return path
    ? servePath(path, pathHeaders)
    : serveBundle(bundleHeaders);
};

/* ── passthrough mode ───────────────────────────────────────────────── */
async function servePath(path, HEADERS) {
  if (path.includes('..') || path.includes('//') || /^[a-z]+:/i.test(path))
    return fail(400, 'illegal path', HEADERS);

  const clean = path.replace(/^\/+/, '');
  if (!ALLOWED.some(p => clean.startsWith(p)))
    return fail(403, 'path not allowed: ' + clean, HEADERS);

  const result = await fetchJson(BASE + clean);
  if (result.ok) return new Response(result.text, { status: 200, headers: HEADERS });

  return fail(
    result.status >= 400 ? result.status : 502,
    'upstream returned ' + (result.status || 'no response') +
      (result.snippet ? ' \u2014 ' + result.snippet : ' with an empty body'),
    HEADERS,
    { path: clean }
  );
}

/* ── bundle mode ────────────────────────────────────────────────────── */
async function serveBundle(HEADERS) {
  const [bs, fx] = await Promise.all([
    fetchJson(BASE + 'bootstrap-static/'),
    fetchJson(BASE + 'fixtures/'),
  ]);

  if (!bs.ok) return fail(bs.status >= 400 ? bs.status : 502,
    'bootstrap: upstream returned ' + (bs.status || 'no response'), HEADERS);
  if (!fx.ok) return fail(fx.status >= 400 ? fx.status : 502,
    'fixtures: upstream returned ' + (fx.status || 'no response'), HEADERS);

  let bootstrap, fixtures;
  try {
    bootstrap = JSON.parse(bs.text);
    fixtures = JSON.parse(fx.text);
  } catch (e) {
    return fail(502, 'could not parse upstream payload', HEADERS);
  }

  if (!bootstrap || !Array.isArray(bootstrap.elements) || !bootstrap.elements.length)
    return fail(502, 'bootstrap payload malformed', HEADERS);

  return new Response(JSON.stringify({
    build: BUILD,
    fetched_at: new Date().toISOString(),
    bootstrap,
    fixtures: Array.isArray(fixtures) ? fixtures : [],
  }), { status: 200, headers: HEADERS });
}

/* ── shared fetch ───────────────────────────────────────────────────── */
// Reads the body as text before parsing. Calling res.json() directly is what
// produced "Unexpected end of JSON input" with no trace of the real status:
// FPL returns an empty body when it throttles a datacenter IP. One retry
// clears most of that; more just burns the function's time budget.
async function fetchJson(url) {
  let last = { status: 0, text: '' };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 600));

    let res;
    try {
      res = await fetch(url, { headers: UA });
    } catch (e) {
      last = { status: 502, text: 'fetch threw: ' + (e && e.message || e) };
      continue;
    }

    const text = await res.text();
    last = { status: res.status, text };

    if (!res.ok) {
      if (res.status !== 429 && res.status < 500) break; // 4xx will not improve
      continue;
    }
    if (!text || !text.trim()) continue;                 // empty 200 = throttled

    try { JSON.parse(text); }
    catch (e) { continue; }                              // truncated or HTML

    return { ok: true, status: res.status, text };
  }

  return {
    ok: false,
    status: last.status,
    snippet: (last.text || '').slice(0, 200),
  };
}

function fail(status, message, headers, extra) {
  return new Response(
    JSON.stringify(Object.assign({ build: BUILD, error: message }, extra || {})),
    { status, headers }
  );
}
