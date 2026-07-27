# Complete file set — where each one goes in your repo

Upload all four. The folder location matters — Netlify looks for functions in
a specific place, and the redirects depend on it.

## Repo layout (what it should look like when done)

    your-repo/
    ├─ index.html                        ← repo ROOT
    ├─ netlify.toml                      ← repo ROOT
    └─ netlify/
       └─ functions/
          ├─ fpl.js                      ← the daily-data fetcher
          └─ player.js                   ← the player-history fetcher

## The four files

| File          | Goes in                    | What it is                          | Version stamp        |
|---------------|----------------------------|-------------------------------------|----------------------|
| index.html    | repo root                  | the whole app                       | app-2026-07-26a      |
| netlify.toml  | repo root                  | build config + /api/ redirects      | —                    |
| fpl.js        | netlify/functions/         | fetches FPL data (main Load button) | —                    |
| player.js     | netlify/functions/         | fetches one player's history        | v5-fpl-only          |

## After uploading — confirm it worked

1. Netlify → Deploys → newest entry says **Published** with today's time.
2. Netlify → Functions → you see BOTH `fpl` and `player` listed.
3. Open https://fplrock.netlify.app in Safari.
4. Top-left line must read:
       FANTASY PREMIER LEAGUE · 2026/27 · app-2026-07-26a
   If the "app-2026-07-26a" is there, the new app is live.
5. Tap "Load data" — the "Not loaded" label should change to "Reload".
6. Go to "All players", tap any player — history panel fills in.

## Two endpoint checks (open in Safari, should return JSON)

Main data:   https://fplrock.netlify.app/api/fpl
Player 328:  https://fplrock.netlify.app/api/player?id=328
  → player.js response must start with  "build":"v5-fpl-only"

## Deploy tip that ends the mismatch problem

Uploading files one at a time is where things have gone wrong before. The safest
method on a phone: for each existing file in the repo, open it, tap the pencil
(edit) icon, select all, paste the new contents over it, commit. Editing in place
guarantees the file is replaced where it already sits — it can't land in the
wrong folder. For a brand-new file (player.js the first time), use Add file →
Create new file and type the path  netlify/functions/player.js  so GitHub makes
the folders.
