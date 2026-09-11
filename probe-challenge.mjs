#!/usr/bin/env node
/* probe-challenge.mjs — probe-2026-09-11a
 *
 * One-off reconnaissance: open the FPL Challenge site in a headless browser
 * and record every JSON response the page loads, so we can see what data
 * feed sits behind it — its addresses, its fields, whether it holds
 * per-match history, and whether it needs a login.
 *
 *   node probe-challenge.mjs "<url>[,<url>...]"
 *
 * Writes probe/challenge.json (committed by the workflow, readable from
 * GitHub without logging in) and prints a table for the Actions summary.
 * It stores the SHAPE of each response plus a trimmed sample (first few
 * items of every list), not whole payloads, so the file stays small.
 */
import fs from 'node:fs';

const urls = (process.argv[2] || '').split(/[,\s]+/).filter(Boolean);
if (!urls.length) { console.error('usage: node probe-challenge.mjs "<url>[,<url>...]"'); process.exit(1); }

/* Describe a JSON value's structure: keys and types, lists by length plus the
 * shape of their first item. Depth-limited so a big feed stays readable. */
function shape(v, d = 0) {
  if (v === null) return 'null';
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const ks = Object.keys(v);
    if (ks.length > 20 && ks.slice(0, 20).every(k => /^\d+$/.test(k))) return { keyedById: ks.length, of: d < 4 ? shape(v[ks[0]], d + 1) : 'object' };
  }
  if (Array.isArray(v)) return v.length ? { list: v.length, of: d < 4 ? shape(v[0], d + 1) : typeof v[0] } : { list: 0 };
  if (typeof v === 'object') {
    if (d >= 4) return 'object';
    const o = {}; for (const k of Object.keys(v).slice(0, 120)) o[k] = shape(v[k], d + 1); return o;
  }
  return typeof v;
}
/* A small, readable copy: lists cut to three items, long strings cut. */
function trim(v, d = 0) {
  if (Array.isArray(v)) return v.slice(0, 3).map(x => trim(x, d + 1));
  if (v && typeof v === 'object') {
    if (d > 6) return '…';
    /* An object keyed by ids (players by element id) is really a list:
       keep three entries and say how many there were. */
    const ks = Object.keys(v), idKeyed = ks.length > 20 && ks.slice(0, 20).every(k => /^\d+$/.test(k));
    const o = {}; for (const k of ks.slice(0, idKeyed ? 3 : 150)) o[k] = trim(v[k], d + 1);
    if (idKeyed) o['…'] = ks.length + ' entries';
    return o;
  }
  if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
  return v;
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();
const requests = [], samples = {}, pages = [];
page.on('response', async res => {
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  if (!ct.includes('json')) return;
  let body; try { body = await res.json(); } catch { return; }
  const text = JSON.stringify(body);
  requests.push({ url: res.url(), status: res.status(), bytes: text.length, method: res.request().method(), shape: shape(body) });
  if (!samples[res.url()]) samples[res.url()] = trim(body);
});

for (const u of urls) {
  const entry = { url: u };
  try {
    const r = await page.goto(u, { waitUntil: 'networkidle', timeout: 60000 });
    entry.status = r ? r.status() : null;
    /* Single-page apps keep loading as you scroll; give it a nudge and time. */
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(1200); }
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    entry.finalUrl = page.url();
    entry.title = await page.title();
    const text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 4000);
    entry.loginWall = /sign in|log in|login|create account/i.test(text) && text.length < 3000;
    entry.textStart = text.slice(0, 600);
  } catch (e) { entry.error = String(e.message || e); }
  pages.push(entry);
}
await browser.close();

/* Keep the biggest responses' samples: the player feed will be among them. */
const keep = new Set([...requests].sort((a, b) => b.bytes - a.bytes).slice(0, 15).map(r => r.url));
const out = {
  schema: 'probe/1', stamp: 'probe-2026-09-11a', probedAt: new Date().toISOString(), urls, pages,
  requests: requests.map(({ shape, ...r }) => r),
  shapes: Object.fromEntries(requests.filter(r => keep.has(r.url)).map(r => [r.url, r.shape])),
  samples: Object.fromEntries(Object.entries(samples).filter(([u]) => keep.has(u))),
};
fs.mkdirSync('probe', { recursive: true });
fs.writeFileSync('probe/challenge.json', JSON.stringify(out, null, 1) + '\n');

/* Summary table for the Actions run page. */
const lines = ['| status | size | url |', '|---|---|---|',
  ...requests.map(r => `| ${r.status} | ${(r.bytes / 1024).toFixed(0)} KB | ${r.url.replace(/\|/g, '%7C')} |`)];
console.log(`pages: ${pages.map(p => `${p.url} → ${p.finalUrl || p.error} (${p.title || ''})${p.loginWall ? ' [LOGIN WALL?]' : ''}`).join('; ')}`);
console.log(`${requests.length} JSON responses captured`);
fs.writeFileSync('probe-summary.md', ['## Challenge probe', '', ...pages.map(p => `- **${p.url}** → ${p.finalUrl || p.error} — "${p.title || ''}"${p.loginWall ? ' — looks like a login wall' : ''}`), '', `${requests.length} JSON responses:`, '', ...lines, ''].join('\n'));
