#!/usr/bin/env node
/* entry-snapshot.mjs — entry-2026-09-13a
 *
 * Captures the FPL endpoints that Netlify cannot reach.
 *
 * Why this exists: FPL's edge intermittently returns an empty 403 to the
 * Netlify function's IP for entry/* paths. fpl-v3 proved the block ignores
 * request headers entirely — four header profiles over three rounds, twelve
 * attempts, all 403 — so it is an IP-level refusal, not something a user-agent
 * can talk its way past. bootstrap-static/ and fixtures/ are unaffected.
 *
 * GitHub's runners are not blocked. So the runner fetches these paths on the
 * existing hourly schedule and commits them, and the function falls back to
 * the committed copy when it is refused.
 *
 * Files land in history/fpl/entry/. That directory is excluded from Netlify's
 * build trigger, so these commits do NOT cause a deploy — which is why the
 * function reads them from raw.githubusercontent.com rather than from the
 * site itself. A file committed here is live immediately; a file waiting on a
 * deploy would not be.
 *
 * Usage:
 *   node entry-snapshot.mjs                    capture the default entry
 *   node entry-snapshot.mjs --entry 185282     capture a specific entry
 *   node entry-snapshot.mjs --dry              fetch and report, write nothing
 *
 * Idempotent in the sense that matters: it overwrites each run. These are
 * "latest known good" files, not history — the pre/post snapshots in
 * fpl-snapshot.mjs are the historical record, and they are immutable. Do not
 * conflate the two.
 */

const STAMP = 'entry-2026-09-13a';

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const FPL = 'https://fantasy.premierleague.com/api/';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes('--' + name);

const ENTRY = flag('entry', '185282');
const OUT = flag('out', './history/fpl/entry');
const DRY = has('dry');

/* The function derives the same name from the request path, so the two must
 * agree exactly. Keep this function and the one in netlify/functions/fpl.js
 * identical — a mismatch means the fallback silently never finds a file. */
function slug(path) {
  return path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '.json';
}

async function fetchJson(path) {
  // The runner is not blocked, but FPL still rate-limits. A couple of spaced
  // retries costs nothing on an hourly job and avoids a needless empty run.
  const delays = [0, 1500, 4000];
  let last = null;
  for (const d of delays) {
    if (d) await new Promise(r => setTimeout(r, d));
    try {
      const res = await fetch(FPL + path, {
        headers: {
          'user-agent': 'Mozilla/5.0 (fplrock entry-snapshot)',
          'accept': 'application/json',
        },
      });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // reject a truncated or HTML body before writing it
        return { ok: true, text };
      }
      last = 'status ' + res.status;
    } catch (e) {
      last = String((e && e.message) || e);
    }
  }
  return { ok: false, why: last };
}

async function main() {
  console.log(STAMP + ' — entry ' + ENTRY);

  /* The picks endpoint needs a gameweek. Use the current one from
   * bootstrap-static, which is not blocked and is cheap to read. Before the
   * season's first deadline there is no current event, and picks simply do
   * not exist yet — that is not an error. */
  let currentGw = null;
  const bs = await fetchJson('bootstrap-static/');
  if (bs.ok) {
    try {
      const events = JSON.parse(bs.text).events || [];
      const cur = events.find(e => e.is_current) || events.filter(e => e.finished).pop();
      if (cur) currentGw = cur.id;
    } catch (e) {}
  }

  const paths = [
    `entry/${ENTRY}/`,
    `entry/${ENTRY}/history/`,
  ];
  if (currentGw) paths.push(`entry/${ENTRY}/event/${currentGw}/picks/`);

  let written = 0, failed = 0;
  for (const path of paths) {
    const got = await fetchJson(path);
    if (!got.ok) {
      // One failed path must not cost the others, so this reports and moves on
      // rather than throwing. A stale file is better than a deleted one.
      console.log('  skip  ' + path + ' (' + got.why + ')');
      failed++;
      continue;
    }

    const file = join(OUT, slug(path));
    if (DRY) {
      console.log('  dry   ' + path + ' -> ' + file + ' (' + got.text.length + ' bytes)');
      continue;
    }

    // Skip the write when nothing changed, so an unchanged hour produces no
    // commit. The workflow commits on git status, so an identical rewrite
    // would otherwise still look like a change to the file's mtime only —
    // harmless, but it makes the log noisy.
    let prev = null;
    try { prev = await readFile(file, 'utf8'); } catch (e) {}
    const body = got.text + '\n';
    if (prev === body) {
      console.log('  same  ' + path);
      continue;
    }

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
    console.log('  write ' + file + ' (' + got.text.length + ' bytes)');
    written++;
  }

  console.log(`done — ${written} written, ${failed} failed, gw ${currentGw || 'none'}`);
  // Never exit non-zero on a fetch failure: this step runs alongside the pre
  // and post captures, and must not fail the job and lose them.
}

main().catch(err => {
  console.error('entry-snapshot failed: ' + ((err && err.message) || err));
});
