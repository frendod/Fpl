/* nav.js — nav-2026-10-02a
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
 */
(function(){
  const NAV_BUILD = 'nav-2026-10-02a';

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
