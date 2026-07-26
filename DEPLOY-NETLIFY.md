# Deploying fplrock on Netlify

Your site auto-deploys from GitHub, so deployment is just: commit these files,
push, done. Netlify builds and publishes on its own.

## Files to add to your repo

- `index.html` — the app (this is your renamed fpl-model.html)
- `netlify.toml` — build config + the /api/fpl pretty URL
- `netlify/functions/fpl.js` — the serverless fetch, runs on Netlify's servers

Folder layout in the repo:

    your-repo/
    ├─ index.html
    ├─ netlify.toml
    └─ netlify/
       └─ functions/
          └─ fpl.js

## How it works

The app calls `/api/fpl` on its own domain. That hits the Netlify function,
which fetches the FPL API server-side (no browser CORS) and returns the data.
Netlify's CDN caches each response for 10 minutes, so FPL is contacted at most
about six times an hour regardless of traffic.

No pasting, no proxies, no scheduled job, no stored file to go stale. The data
is fetched fresh (within the 10-minute cache) every time the app loads.

## If the function ever fails

The app falls back on its own, in order:
1. /api/fpl  (the function)
2. /data.json  (if you ever add a static file)
3. public CORS proxies
4. IndexedDB cache from the last good load
5. manual paste

So a function outage degrades to the cache — the app keeps working with the
last data it saw.

## One setup note

Netlify auto-detects functions in `netlify/functions/`. No dashboard toggle is
needed for regular functions. After the first deploy, open
`https://fplrock.netlify.app/api/fpl` directly in a browser — you should see
JSON. If you do, the app will load automatically.
