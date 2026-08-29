// Netlify Function — generic read-only passthrough to the FPL API.
// Reached at  /api/fpl-proxy?path=entry/185282/history/
//
// Why this exists in its current shape: the previous version called
// res.json() straight off the fetch. When FPL returns an empty body — which it
// does when it throttles or blocks a datacenter IP — that throws
// "Unexpected end of JSON input", and the real upstream status is lost. Every
// distinct failure collapsed into one meaningless 500.
//
// So: read the body as text first, decide what happened, and pass the upstream
// status through. A 403 should look like a 403.

const BUILD = 'proxy-v2';

// Netlify Functions v2 lets a function declare its own route, so this does not
// depend on a redirect rule in netlify.toml existing or being correct. Without
// it the function is only reachable at /.netlify/functions/fpl-proxy, and a
// missing redirect shows up as Netlify's own 404 page rather than any error
// this file could return.
export const config = {
  path: '/api/fpl-proxy',
};

const UA = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-GB,en;q=0.9',
  'referer': 'https://fantasy.premierleague.com/',
};

// Only these prefixes may be proxied. Without this the endpoint is an open
// relay for anything under fantasy.premierleague.com.
const ALLOWED = [
  'entry/',
  'element-summary/',
  'bootstrap-static/',
  'fixtures',
  'event/',
  'leagues-classic/',
];

export default async (req) => {
  const HEADERS = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    // Entry data changes during a gameweek, so cache briefly rather than not
    // at all — enough to absorb a reload storm without serving stale picks.
    'cache-control': 'public, max-age=0',
    'netlify-cdn-cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
  };

  let path;
  try {
    path = new URL(req.url).searchParams.get('path') || '';
  } catch (e) {
    return fail(400, 'bad request url', HEADERS);
  }

  if (!path) return fail(400, 'missing path parameter', HEADERS);

  // Reject anything trying to escape the API root or point elsewhere entirely.
  if (path.includes('..') || path.includes('//') || /^[a-z]+:/i.test(path))
    return fail(400, 'illegal path', HEADERS);

  const clean = path.replace(/^\/+/, '');
  if (!ALLOWED.some(p => clean.startsWith(p)))
    return fail(403, 'path not allowed: ' + clean, HEADERS);

  const target = 'https://fantasy.premierleague.com/api/' + clean;

  // FPL intermittently returns an empty body or a 429 to cloud IPs. One retry
  // clears most of it; more than that just burns the function's time budget.
  let last = { status: 0, body: '' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 600));

    let res;
    try {
      res = await fetch(target, { headers: UA });
    } catch (e) {
      last = { status: 502, body: 'fetch threw: ' + (e && e.message || e) };
      continue;
    }

    // Text first. Calling .json() here is what produced the original
    // "Unexpected end of JSON input" with no indication of why.
    const text = await res.text();
    last = { status: res.status, body: text };

    if (!res.ok) {
      // 4xx other than 429 will not improve on a retry.
      if (res.status !== 429 && res.status < 500) break;
      continue;
    }

    if (!text || !text.trim()) continue; // empty 200 — throttling, retry

    try {
      JSON.parse(text); // validate before handing it on
    } catch (e) {
      continue; // truncated or an HTML error page
    }

    return new Response(text, { status: 200, headers: HEADERS });
  }

  // Out of retries. Report what actually happened, with a body sample so the
  // failure is diagnosable from the browser without opening Netlify's logs.
  const snippet = (last.body || '').slice(0, 200);
  return fail(
    last.status && last.status >= 400 ? last.status : 502,
    'upstream returned ' + (last.status || 'no response') +
      (snippet ? ' — ' + snippet : ' with an empty body'),
    HEADERS,
    { path: clean }
  );
};

function fail(status, message, headers, extra) {
  return new Response(
    JSON.stringify(Object.assign({ build: BUILD, error: message }, extra || {})),
    { status, headers }
  );
}
