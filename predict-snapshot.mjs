#!/usr/bin/env node
/* predict-snapshot.mjs — predict-2026-09-11a
 *
 * Freezes what FPL Rock predicts for the coming gameweek, inside the same
 * pre-deadline window as `fpl-snapshot.mjs pre`, into:
 *
 *   history/fpl/<season>/pred/gw-N.json
 *
 * The weekly report joins that file to post/gw-N.json. Predictions expire
 * exactly like ep_next does: once the deadline passes, the inputs move and
 * the number the app showed can no longer be produced. So they are captured
 * now, and judged later.
 *
 * WHY A HEADLESS BROWSER RATHER THAN A NODE PORT OF THE ENGINE
 *
 * The engine lives in index.html and leans on the page: the Understat store,
 * the xMins window read from the deployed history/ files, the optimiser. A
 * port would be a second copy of the model, and this project has been bitten
 * every time two copies of something were allowed to exist. Loading the live
 * site and calling window.fplLedger() records what was actually deployed —
 * build stamp included — so if a stale deploy was serving the wrong model,
 * the ledger says so rather than hiding it.
 *
 * Commands:
 *   node predict-snapshot.mjs check   [--within M]  cheap: is a capture due? prints due=true|false
 *   node predict-snapshot.mjs capture [--within M]  load the site headless, write the ledger
 *
 * `check` needs no browser and prints only key=value lines on stdout, so the
 * workflow can append it straight to $GITHUB_OUTPUT and skip installing
 * Chromium on the ~160 hourly runs a week where nothing is due. All logging
 * goes to stderr for the same reason.
 *
 * Flags:
 *   --url <u>      site to load (default https://fplrock.netlify.app/)
 *   --out <dir>    root output dir (default ./history/fpl)
 *   --season <s>   season folder name (default derived from date)
 *   --within <m>   only when the deadline is 0..m minutes away
 *   --force        write even outside the window / over an existing file
 *   --dry          do everything but write
 */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STAMP = 'predict-2026-09-11a';
const API = 'https://fantasy.premierleague.com/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://fantasy.premierleague.com/',
};

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes('--' + name);

const URL_ = flag('url', 'https://fplrock.netlify.app/');
const OUT = flag('out', './history/fpl');
const FORCE = has('force');
const DRY = has('dry');
const WITHIN = parseInt(flag('within', ''), 10);
const log = (...a) => console.error(...a);   // stdout is reserved for key=value

function currentSeason() {
  const explicit = flag('season');
  if (explicit) return explicit;
  const d = new Date(), y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

/* Is a capture due, and for which gameweek? Same rules as the pre snapshot,
 * so the two files for a week are taken in the same window:
 *   - the deadline must be 0..WITHIN minutes away (unless --force)
 *   - an existing in-window capture is final
 *   - an existing early capture (manual run outside the window) is replaced */
async function due() {
  const res = await fetch(`${API}/bootstrap-static/`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for bootstrap-static`);
  const boot = await res.json();
  const next = (boot.events || []).find(e => e.is_next) || (boot.events || []).find(e => !e.finished);
  if (!next) return { due: false, why: 'no upcoming gameweek' };

  const mins = next.deadline_time ? Math.round((new Date(next.deadline_time) - Date.now()) / 60000) : null;
  const path = join(OUT, currentSeason(), 'pred', `gw-${next.id}.json`);
  const base = { gw: next.id, deadline: next.deadline_time, mins, path };

  if (!FORCE && !Number.isNaN(WITHIN)) {
    if (mins == null) return { ...base, due: false, why: 'no deadline on this event' };
    if (mins > WITHIN) return { ...base, due: false, why: `${mins} min out, outside ${WITHIN} min window` };
    if (mins < 0) return { ...base, due: false, why: 'deadline passed' };
  }
  if (!FORCE && await exists(path)) {
    let prev = null;
    try { prev = JSON.parse(await readFile(path, 'utf8')); } catch { /* leave it */ }
    const prevMins = prev ? prev.minutesBeforeDeadline : null;
    if (Number.isNaN(WITHIN) || prevMins == null || prevMins <= WITHIN)
      return { ...base, due: false, why: 'already on disk' };
    log(`  existing capture was early (${prevMins} min out) — will replace`);
  }
  return { ...base, due: true, why: 'in window' };
}

async function check() {
  const d = await due();
  log(`check: gw ${d.gw ?? '?'} — ${d.why}`);
  console.log(`due=${d.due}`);
  if (d.gw) console.log(`gw=${d.gw}`);
}

async function capture() {
  const d = await due();
  log(`capture: gw ${d.gw ?? '?'}, deadline ${d.deadline ?? '?'} (${d.mins} min away) — ${d.why}`);
  if (!d.due) return;

  /* Imported here, not at the top, so `check` runs on a runner with no
   * browser installed. */
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const pageErrors = [];
  let led;
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    log(`  loading ${URL_}`);
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });

    /* Wait for the first build, then for the xMins window to settle: it loads
     * after boot and triggers one rescore, and a ledger taken before that
     * would record the fallback gate rather than the one the app shows. */
    await page.waitForFunction(
      () => typeof players !== 'undefined' && players.length > 0,
      null, { timeout: 90000 });
    const hasHook = await page.evaluate(() => typeof window.fplLedger === 'function');
    if (!hasHook) {
      const build = await page.evaluate(() => typeof APP_BUILD !== 'undefined' ? APP_BUILD : '?');
      throw new Error(`site build ${build} has no fplLedger() — deploy app-2026-09-10a or later`);
    }
    await page.waitForFunction(
      () => state.gwPlayed === 0 || (MINWIN.status !== 'idle' && MINWIN.status !== 'loading'),
      null, { timeout: 30000 }).catch(() => log('  ! xMins window did not settle; capturing anyway'));
    await page.waitForTimeout(1500);

    led = await page.evaluate(() => window.fplLedger());
  } finally {
    await browser.close();
  }

  if (!led) throw new Error('fplLedger() returned nothing — the app had no players');
  /* Filing a projection under the wrong gameweek would poison every
   * comparison built on it. Refuse rather than guess. */
  if (led.gw !== d.gw)
    throw new Error(`site projects GW${led.gw} but FPL's next deadline is GW${d.gw} — not writing`);
  if (led.minwinStatus !== 'ready')
    log(`  ! xMins window was "${led.minwinStatus}" — Score gate used the season-to-date fallback`);
  if (pageErrors.length) log(`  ! ${pageErrors.length} page error(s): ${pageErrors.slice(0, 3).join(' | ')}`);

  const out = {
    ...led,
    stamp: STAMP,
    season: currentSeason(),
    url: URL_,
    deadline: d.deadline,
    minutesBeforeDeadline: d.mins,
    lookahead: d.mins != null && d.mins < 0,
    pageErrors,
  };
  if (DRY) { log(`  [dry] would write ${d.path} (${led.counts.players} players, build ${led.build})`); return; }
  await mkdir(dirname(d.path), { recursive: true });
  await writeFile(d.path, JSON.stringify(out) + '\n', 'utf8');
  log(`  wrote ${d.path} — ${led.counts.players} players, build ${led.build}, xP model ${led.xpModel ? led.xpModel.status : 'n/a'}, ` +
      `XI totals ${Object.entries(led.xi || {}).map(([k, x]) => `${k} ${x ? x.objTotal : '—'}`).join(' / ')}`);
}

const commands = { check, capture };
if (!commands[cmd]) {
  log('usage: node predict-snapshot.mjs <check|capture> [--within M] [--url U] [--out dir] [--season s] [--force] [--dry]');
  process.exit(1);
}
commands[cmd]().catch(err => { log('\nFAILED:', err.message); process.exit(1); });
