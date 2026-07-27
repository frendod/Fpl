// Netlify Function — runs on Netlify's servers, where browser CORS does not
// apply. Fetches the FPL API directly and returns a single bundle to the app.
// Reached at  /api/fpl  (see the redirect in netlify.toml).

export default async (req, context) => {
  const HEADERS = {
    'content-type': 'application/json',
    // let the app on the same site read it, and allow the preview domains too
    'access-control-allow-origin': '*',
    // Netlify's edge caches this for 10 minutes, so FPL is hit at most ~6x/hour
    // no matter how many people load the page. Stale copy served while revalidating.
    'cache-control': 'public, max-age=0',
    'netlify-cdn-cache-control': 'public, s-maxage=600, stale-while-revalidate=3600',
  };

  const UA = { 'user-agent': 'Mozilla/5.0 (fplrock netlify function)' };

  try {
    const [bsRes, fxRes] = await Promise.all([
      fetch('https://fantasy.premierleague.com/api/bootstrap-static/', { headers: UA }),
      fetch('https://fantasy.premierleague.com/api/fixtures/', { headers: UA }),
    ]);

    if (!bsRes.ok) throw new Error('bootstrap ' + bsRes.status);
    if (!fxRes.ok) throw new Error('fixtures ' + fxRes.status);

    const bootstrap = await bsRes.json();
    const fixtures = await fxRes.json();

    if (!bootstrap || !Array.isArray(bootstrap.elements) || !bootstrap.elements.length)
      throw new Error('bootstrap payload malformed');

    const body = JSON.stringify({
      fetched_at: new Date().toISOString(),
      bootstrap,
      fixtures: Array.isArray(fixtures) ? fixtures : [],
    });

    return new Response(body, { status: 200, headers: HEADERS });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message || err) }),
      { status: 502, headers: HEADERS }
    );
  }
};
