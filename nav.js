/* nav.js — nav-2026-10-25a
 *
 * The site menu, in one place. Every page has a placeholder:
 *
 *   <nav class="tabs" role="tablist" data-page="odds"></nav>
 *   <script src="nav.js"></script>
 *
 * and this file fills it. To add, remove, rename or reorder a tab, edit NAV
 * below and nothing else.
 *
 * data-page says which page this is, so its tab is shown as current:
 *   index    the main app — its own views become in-page buttons
 *   odds     gw-odds.html
 *   targets  fixture-targets.html
 *   prices   price-changes.html
 *
 * On index.html the view tabs are <button data-view>, exactly as before, and
 * index.html's own code still wires their clicks and highlighting. That is why
 * this script must load straight after the placeholder, before the page's main
 * script: index.html binds its click handlers to whatever .tab elements exist
 * when it runs. On every other page the same views are links to
 * index.html?view=…, which index.html already opens.
 *
 * Language follows the page: it starts from the shared 'fplLang' key and
 * relabels in place whenever the page changes <html lang>, which every page's
 * setLang() already does. Relabelling never rebuilds the buttons, so the
 * listeners index.html attached survive a language switch.
 *
 * Styling stays with each page (.tabs / .tab), as it was.
 *
 * It also draws the site's blue-and-white ball: every ⚽ in a page title
 * (h1, .epc-title) is redrawn with its dark patches turned blue. This used to
 * live only in fixture-targets.html; here it covers every page that loads
 * nav.js, in both themes.
 */
(function(){
  const NAV_BUILD = 'nav-2026-10-25a';

  /* view: a view inside index.html.  href: a separate page.  page: matches data-page. */
  const NAV = [
    { view:'picks',   en:'Picks',           es:'Selecciones' },
    { view:'myteam',  en:'My Team',         es:'Mi equipo' },
    { view:'leagues', en:'My Leagues',      es:'Mis ligas' },
    { view:'xi',      en:'Best XI',         es:'Mejor XI' },
    { view:'table',   en:'All players',     es:'Jugadores' },
    { view:'plan',    en:'Season plan',     es:'Plan de temporada' },
    { href:'gw-odds.html',         page:'odds',    en:'GW odds',         es:'Cuotas' },
    { href:'fixture-targets.html', page:'targets', en:'Fixture targets', es:'Objetivos por calendario' },
    { href:'price-changes.html',   page:'prices',  en:'Price changes',   es:'Cambios de precio' },
    { view:'diag',    en:'Diagnostics',     es:'Diagnóstico' },
  ];

  const host = document.currentScript && document.currentScript.previousElementSibling;
  const nav = (host && host.matches('nav[data-page]')) ? host : document.querySelector('nav[data-page]');
  if (!nav) { console.warn('nav.js: no <nav data-page> placeholder'); return; }
  const here = nav.dataset.page;
  const onIndex = here === 'index';

  function lang(){
    const l = document.documentElement.getAttribute('lang');
    if (l === 'en' || l === 'es') return l;
    try { return localStorage.getItem('fplLang') === 'es' ? 'es' : 'en'; } catch(e) { return 'en'; }
  }

  const items = [];
  NAV.forEach((it, i) => {
    let el;
    if (it.view && onIndex) {
      el = document.createElement('button');
      el.setAttribute('role', 'tab');
      el.dataset.view = it.view;
      el.setAttribute('aria-selected', String(i === 0));     // index opens on its first view
    } else if (it.page && it.page === here) {
      el = document.createElement('span');
      el.setAttribute('aria-selected', 'true');
    } else {
      el = document.createElement('a');
      el.href = it.view ? 'index.html?view=' + it.view : it.href;
    }
    el.className = 'tab';
    nav.appendChild(el);
    items.push([el, it]);
  });

  function label(){
    const l = lang();
    items.forEach(([el, it]) => { el.textContent = it[l] || it.en; });
  }
  label();
  new MutationObserver(label).observe(document.documentElement, { attributes:true, attributeFilter:['lang'] });

  window.SiteNav = { build: NAV_BUILD, relabel: label };
})();

/* ── BALL ──────────────────────────────────────────────────
   The ⚽ emoji drawn by the device's own emoji font, with its dark patches
   turned blue: only dark pixels are recoloured, keeping their shading, so the
   white panels stay white. Drawn once and reused. Titles that a page relabels
   on a language switch (Price Changes) are watched and redrawn. If canvas or
   the emoji font is unavailable, the plain emoji stays. */
(function(){
  const SEL = 'h1, .epc-title';
  let art = null, tried = false;

  function draw(){
    if (tried) return art; tried = true;
    try{
      const px = 128, pad = 24, c = document.createElement('canvas');
      c.width = c.height = px + pad * 2;
      const g = c.getContext('2d', { willReadFrequently:true });
      g.font = px + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('⚽', c.width / 2, c.height / 2);
      const d = g.getImageData(0, 0, c.width, c.height), a = d.data, B = [31, 95, 191];
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let i = 0; i < a.length; i += 4){
        if (!a[i + 3]) continue;
        const L = .299 * a[i] + .587 * a[i + 1] + .114 * a[i + 2];
        const w = L >= 150 ? 0 : L <= 95 ? 1 : (150 - L) / 55;
        if (w) for (let k = 0; k < 3; k++){ const blue = Math.min(255, B[k] * (.7 + L / 170)); a[i + k] = a[i + k] * (1 - w) + blue * w; }
        const x = (i / 4) % c.width, y = (i / 4) / c.width | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) return null;                       // no emoji font: keep the text
      g.putImageData(d, 0, 0);
      const w = x1 - x0 + 1, h = y1 - y0 + 1, o = document.createElement('canvas');
      o.width = w; o.height = h;
      o.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
      art = { src:o.toDataURL(), em:h / px, wem:w / px };
    }catch(e){ art = null; }
    return art;
  }

  function img(){
    const im = new Image();
    im.src = art.src; im.alt = '⚽'; im.className = 'ball site-ball';
    im.style.cssText = 'display:inline-block;height:' + art.em + 'em;width:' + art.wem + 'em;vertical-align:'
      + (-(art.em - 0.7) / 2).toFixed(3) + 'em';
    return im;
  }

  function apply(root){
    if (!draw()) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.indexOf('⚽') > -1) hits.push(n);
    hits.forEach(n => {
      const parts = n.nodeValue.split('⚽'), frag = document.createDocumentFragment();
      parts.forEach((t, i) => { if (i) frag.appendChild(img()); if (t) frag.appendChild(document.createTextNode(t)); });
      n.parentNode.replaceChild(frag, n);
    });
  }

  function run(){
    document.querySelectorAll(SEL).forEach(el => {
      apply(el);
      if (el.__ballWatch) return;
      el.__ballWatch = new MutationObserver(() => apply(el));   // relabels put the emoji back
      el.__ballWatch.observe(el, { childList:true, characterData:true, subtree:true });
    });
  }
  run();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  if (window.SiteNav) window.SiteNav.ball = run;
})();
