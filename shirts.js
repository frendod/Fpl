/* shirts.js · shirts-2026-10-25c
   Club shirt icons for FPL Rock, 2026-27 Premier League.
   Generic shirts in club colours: no crests, sponsors, maker marks or kit graphics.
   Keyed by FPL team short_name (bootstrap-static teams[].short_name).

   shirtSVG('ARS')                          -> home shirt, 28px
   shirtSVG('ARS', {kit:'away', size:20})   -> 2026-27 away shirt
   shirtSVG('ARS', {kit:'gk'})              -> goalkeeper shirt ({gk:true} also works)
   Unknown codes get a neutral grey shirt, so a new club never breaks a row.

   Away colours follow each club's 2026-27 away kit and need refreshing every
   summer when new kits launch. Update AWAY_SEASON when you do. */
(function (g) {
  'use strict';
  const SHIRTS_BUILD = 'shirts-2026-10-25c';
  const AWAY_SEASON = '2026-27';

  // kit: { body, pattern?, sleeve, collar, cuff }
  // pattern.type: 'stripes' (7 bold vertical bands, a on the edges), 'pin' (vertical pinstripes),
  //               'hpin' (horizontal pinstripes), 'check' (chequerboard). a = base, b = second colour.
  const SHIRTS = {
    ARS: { name: 'Arsenal', gk: '#2BB24C',
      home: { body: '#EF0107', sleeve: '#FFFFFF', collar: '#FFFFFF', cuff: '#EF0107' },
      away: { body: '#1B2A4A', sleeve: '#1B2A4A', collar: '#F2C230', cuff: '#F2C230' } },
    AVL: { name: 'Aston Villa', gk: '#F6C700',
      home: { body: '#670E36', sleeve: '#95BFE5', collar: '#95BFE5', cuff: '#670E36' },
      away: { body: '#151515', sleeve: '#151515', collar: '#7A1E3D', cuff: '#95BFE5' } },
    BOU: { name: 'Bournemouth', gk: '#19B5D3',
      home: { pattern: { type: 'stripes', a: '#DA291C', b: '#111111' }, sleeve: '#111111', collar: '#111111', cuff: '#DA291C' },
      away: { body: '#7357B0', sleeve: '#7357B0', collar: '#2B1B4D', cuff: '#2B1B4D' } },
    BRE: { name: 'Brentford', gk: '#F28C28',
      home: { pattern: { type: 'stripes', a: '#E30613', b: '#FFFFFF' }, sleeve: '#E30613', collar: '#111111', cuff: '#111111' },
      away: { pattern: { type: 'pin', a: '#1B2547', b: '#EDE3CC' }, sleeve: '#1B2547', collar: '#EDE3CC', cuff: '#EDE3CC' } },
    BHA: { name: 'Brighton', gk: '#9BD33A',
      home: { pattern: { type: 'stripes', a: '#0057B8', b: '#FFFFFF' }, sleeve: '#0057B8', collar: '#FFFFFF', cuff: '#FFFFFF' },
      away: { pattern: { type: 'pin', a: '#FFFFFF', b: '#0057B8' }, sleeve: '#FFFFFF', collar: '#0057B8', cuff: '#0057B8' } },
    CHE: { name: 'Chelsea', gk: '#F6C700',
      home: { body: '#034694', sleeve: '#034694', collar: '#FFFFFF', cuff: '#034694' },
      away: { body: '#151515', sleeve: '#151515', collar: '#C9A44C', cuff: '#C9A44C' } },
    COV: { name: 'Coventry', gk: '#E8508E',
      home: { body: '#59B4E5', sleeve: '#59B4E5', collar: '#0B2545', cuff: '#0B2545' },
      away: { body: '#F4F0E6', sleeve: '#F4F0E6', collar: '#0B2545', cuff: '#FF6F61' } },
    CRY: { name: 'Crystal Palace', gk: '#2BB24C',
      home: { pattern: { type: 'stripes', a: '#1B458F', b: '#C4122E' }, sleeve: '#1B458F', collar: '#C4122E', cuff: '#C4122E' },
      away: { body: '#151515', sleeve: '#151515', collar: '#C4122E', cuff: '#1B458F' } },
    EVE: { name: 'Everton', gk: '#F28C28',
      home: { body: '#274488', sleeve: '#274488', collar: '#FFFFFF', cuff: '#FFFFFF' },
      away: { pattern: { type: 'pin', a: '#FFFFFF', b: '#274488' }, sleeve: '#FFFFFF', collar: '#274488', cuff: '#F2A900' } },
    FUL: { name: 'Fulham', gk: '#7A4FD8',
      home: { body: '#FFFFFF', sleeve: '#FFFFFF', collar: '#111111', cuff: '#111111' },
      away: { pattern: { type: 'check', a: '#151515', b: '#C8102E' }, sleeve: '#151515', collar: '#C8102E', cuff: '#C8102E' } },
    HUL: { name: 'Hull City', gk: '#19B5D3',
      home: { body: '#F5A12D', sleeve: '#F5A12D', collar: '#111111', cuff: '#111111' },
      away: { body: '#FFFFFF', sleeve: '#FFFFFF', collar: '#111111', cuff: '#F5A12D' } },
    IPS: { name: 'Ipswich', gk: '#9BD33A',
      home: { body: '#0044A9', sleeve: '#0044A9', collar: '#FFFFFF', cuff: '#FFFFFF' },
      away: { pattern: { type: 'hpin', a: '#EFE6D2', b: '#C8102E' }, sleeve: '#EFE6D2', collar: '#111111', cuff: '#C8102E' } },
    LEE: { name: 'Leeds', gk: '#2BB24C',
      home: { body: '#FFFFFF', sleeve: '#FFFFFF', collar: '#1D428A', cuff: '#FFCD00' },
      away: { body: '#FFCD00', sleeve: '#FFCD00', collar: '#1D428A', cuff: '#1D428A' } },
    LIV: { name: 'Liverpool', gk: '#9BD33A',
      home: { body: '#C8102E', sleeve: '#C8102E', collar: '#FFFFFF', cuff: '#C8102E' },
      away: { body: '#13213F', sleeve: '#13213F', collar: '#D4AF37', cuff: '#C8102E' } },
    MCI: { name: 'Man City', gk: '#F28C28',
      home: { body: '#6CABDD', sleeve: '#6CABDD', collar: '#FFFFFF', cuff: '#FFFFFF' },
      away: { body: '#151515', sleeve: '#151515', collar: '#F6C700', cuff: '#F6C700' } },
    MUN: { name: 'Man Utd', gk: '#19B5D3',
      home: { body: '#DA291C', sleeve: '#DA291C', collar: '#111111', cuff: '#111111' },
      away: { body: '#1F4FBF', sleeve: '#1F4FBF', collar: '#DA291C', cuff: '#DA291C' } },
    NEW: { name: 'Newcastle', gk: '#E8508E',
      home: { pattern: { type: 'stripes', a: '#FFFFFF', b: '#111111' }, sleeve: '#111111', collar: '#111111', cuff: '#FFFFFF' },
      away: { body: '#3A3F47', sleeve: '#1B2547', collar: '#2BB3A3', cuff: '#FFFFFF' } },
    NFO: { name: "Nott'm Forest", gk: '#7A4FD8',
      home: { body: '#E53233', sleeve: '#E53233', collar: '#FFFFFF', cuff: '#FFFFFF' },
      away: { body: '#1E5B3A', sleeve: '#1E5B3A', collar: '#E53233', cuff: '#E53233' } },
    SUN: { name: 'Sunderland', gk: '#F6C700',
      home: { pattern: { type: 'stripes', a: '#FFFFFF', b: '#EB172B' }, sleeve: '#EB172B', collar: '#111111', cuff: '#111111' },
      away: { body: '#F49AC1', sleeve: '#111111', collar: '#111111', cuff: '#F49AC1' } },
    TOT: { name: 'Spurs', gk: '#F28C28',
      home: { body: '#FFFFFF', sleeve: '#FFFFFF', collar: '#132257', cuff: '#132257' },
      away: { body: '#14213D', sleeve: '#14213D', collar: '#E8508E', cuff: '#F28C28' } }
  };
  const PLAIN_GREY = { body: '#8A93A6', sleeve: '#8A93A6', collar: '#5B6475', cuff: '#5B6475' };
  const FALLBACK = { name: 'Unknown', gk: '#8A93A6', home: PLAIN_GREY, away: PLAIN_GREY };

  // 64x64 shirt silhouette: crew neck, short sleeves. Body runs x 15..49.
  const SHAPE = 'M22 6 L14 9 L3 19 L10 28 L15 24 L15 58 L49 58 L49 24 L54 28 L61 19 L50 9 L42 6 Q32 14 22 6 Z';
  let uid = 0;

  function rect(x, y, w, h, c) {
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${c}"/>`;
  }

  function bodyFill(k) {
    const p = k.pattern;
    if (!p) return rect(0, 0, 64, 64, k.body);
    let out = rect(0, 0, 64, 64, p.a);
    if (p.type === 'stripes') {
      const w = 34 / 7;
      for (let i = 1; i < 7; i += 2) out += rect(15 + i * w, 0, w, 64, p.b);
    } else if (p.type === 'pin') {
      for (let x = 19; x < 49; x += 5) out += rect(x, 0, 1.4, 64, p.b);
    } else if (p.type === 'hpin') {
      for (let y = 18; y < 58; y += 6) out += rect(0, y, 64, 1.4, p.b);
    } else if (p.type === 'check') {
      const s = 34 / 6;
      for (let r = 0; r < 10; r++) for (let c = 0; c < 6; c++) {
        if ((r + c) % 2) out += rect(15 + c * s, r * s, s, s, p.b);
      }
    }
    return out;
  }

  function shirtSVG(code, opts) {
    opts = opts || {};
    const size = opts.size || 28;
    const club = SHIRTS[String(code || '').toUpperCase()] || FALLBACK;
    const kitName = opts.gk ? 'gk' : (opts.kit || 'home');
    const k = kitName === 'gk'
      ? { body: club.gk, sleeve: club.gk, collar: '#111111', cuff: '#111111' }
      : (club[kitName] || club.home);
    const id = 'fs' + (++uid);
    const label = club.name + (kitName === 'gk' ? ' goalkeeper' : kitName === 'away' ? ' away' : ' home');

    return `<svg class="shirt" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><clipPath id="${id}"><path d="${SHAPE}"/></clipPath></defs>` +
      `<g clip-path="url(#${id})">${bodyFill(k)}` +
      rect(0, 0, 15.4, 64, k.sleeve) + rect(48.6, 0, 15.4, 64, k.sleeve) +
      `<path d="M3 19 L10 28 M61 19 L54 28" stroke="${k.cuff}" stroke-width="5"/>` +
      `<path d="M22 6 Q32 14 42 6" fill="none" stroke="${k.collar}" stroke-width="5"/>` +
      `</g>` +
      `<path d="${SHAPE}" fill="none" stroke="#7C8496" stroke-width="1.4" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  // Fixture helper: the home side wears home, the away side wears away.
  function fixtureShirt(code, isHomeSide, opts) {
    return shirtSVG(code, Object.assign({}, opts, { kit: isHomeSide ? 'home' : 'away' }));
  }

  /* ── Colour clash ────────────────────────────────────────
     Real football: the home side always wears home; the away side changes
     only when its home shirt would be confused with the home side's. So the
     question is whether two shirts read as the same colour on a pitch.

     A shirt's identity is its body colour(s): the plain body, or both colours
     of a pattern (Newcastle's stripes are black AND white). Sleeves are left
     out on purpose: Arsenal's white sleeves do not stop red-on-red clashing.
     Two shirts clash when any body colour of one sits close to any body
     colour of the other, measured as CIE76 distance in Lab, which tracks how
     different colours look rather than how different their hex codes are. */
  function hexLab(h) {
    const n = parseInt(String(h).replace('#', ''), 16);
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const r = lin((n >> 16) & 255), gr = lin((n >> 8) & 255), b = lin(n & 255);
    const x = (r * 0.4124 + gr * 0.3576 + b * 0.1805) / 0.95047;
    const y = (r * 0.2126 + gr * 0.7152 + b * 0.0722);
    const z = (r * 0.0193 + gr * 0.1192 + b * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }
  // Bold stripes and chequers are two colours in equal measure; pinstripes are
  // a base colour with a thin line, and read as the base from the stands.
  function bodyColours(k) {
    const p = k.pattern;
    if (!p) return [k.body];
    return p.type === 'stripes' || p.type === 'check' ? [p.a, p.b] : [p.a];
  }
  // Smallest visual distance between two shirts' body colours.
  function kitGap(a, b) {
    let best = Infinity;
    bodyColours(a).forEach(x => bodyColours(b).forEach(y => {
      const p = hexLab(x), q = hexLab(y);
      best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }));
    return best;
  }
  const CLASH_GAP = 35;   // below this two body colours read as the same on a pitch

  /* Which kit a club wears for one fixture: 'home' or 'away'.
     Home side: always home. Away side: home unless it clashes with the home
     side's home shirt; then away — unless the away shirt clashes worse, in
     which case the less-bad of the two (there is no third kit on file). */
  function matchKit(code, oppCode, isHomeSide) {
    if (isHomeSide) return 'home';
    const me = SHIRTS[String(code || '').toUpperCase()], opp = SHIRTS[String(oppCode || '').toUpperCase()];
    if (!me || !opp) return 'home';
    const gHome = kitGap(me.home, opp.home);
    if (gHome >= CLASH_GAP) return 'home';
    return kitGap(me.away, opp.home) > gHome ? 'away' : 'home';
  }

  g.SHIRTS = SHIRTS;
  g.SHIRTS_BUILD = SHIRTS_BUILD;
  g.SHIRTS_AWAY_SEASON = AWAY_SEASON;
  g.shirtSVG = shirtSVG;
  g.fixtureShirt = fixtureShirt;
  g.matchKit = matchKit;
  g.kitGap = kitGap;
})(typeof window !== 'undefined' ? window : globalThis);
