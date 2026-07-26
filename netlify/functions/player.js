// Netlify Function — per-player history, fetched on click.
// Runs server-side (no browser CORS), pulls two sources and merges them:
//   1. FPL element-summary/{id}  → FPL points history + this-season game log
//   2. Understat player/{uid}    → multi-season per-match xG, for vs-club splits
//
// The two systems use different player IDs with no official mapping, so we
// resolve the Understat id by name against the season's Understat player list
// and report how confident that match is. Reached at /api/player?id=123&name=...

const UA = { 'user-agent': 'Mozilla/5.0 (fplrock player history)' };

function normName(s){
  return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z\s'-]/g,'').replace(/\s+/g,' ').trim();
}

// Understat embeds each table as  var X = JSON.parse('...hex-escaped...')
function extractJSON(html, varName){
  const pats = [
    new RegExp('var\\s+'+varName+"\\s*=\\s*JSON\\.parse\\('([\\s\\S]+?)'\\)"),
    new RegExp('var\\s+'+varName+'\\s*=\\s*JSON\\.parse\\("([\\s\\S]+?)"\\)'),
  ];
  for (const p of pats){
    const m = html.match(p);
    if (m){
      const decoded = m[1]
        .replace(/\\x([0-9A-Fa-f]{2})/g, (_,h)=>String.fromCharCode(parseInt(h,16)))
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_,h)=>String.fromCharCode(parseInt(h,16)))
        .replace(/\\'/g,"'").replace(/\\\\/g,'\\');
      try { return JSON.parse(decoded); } catch(e){ return null; }
    }
  }
  return null;
}

// Find an Understat player id by name, across the given seasons' league lists.
async function resolveUnderstatId(name, seasons){
  const target = normName(name);
  const targetLast = target.split(' ').slice(-1)[0];
  const trace = { target, seasonsTried:[], reason:null };
  if (!target){ trace.reason='empty name parameter'; return { id:null, confidence:'none', trace }; }
  for (const yr of seasons){
    const step = { season:yr, fetchOk:false, parsed:0 };
    const res = await fetch('https://understat.com/league/EPL/'+yr, { headers: UA });
    step.status = res.status;
    if (!res.ok){ trace.seasonsTried.push(step); continue; }
    step.fetchOk = true;
    const html = await res.text();
    step.htmlLen = html.length;
    const players = extractJSON(html, 'playersData');
    if (!players){ step.parseFail=true; trace.seasonsTried.push(step); continue; }
    step.parsed = players.length;
    trace.seasonsTried.push(step);

    // exact full-name match first
    let hit = players.find(p => normName(p.player_name) === target);
    let confidence = 'exact';
    // then unique last-name match
    if (!hit){
      const lastMatches = players.filter(p => {
        const n = normName(p.player_name);
        return n.split(' ').slice(-1)[0] === targetLast;
      });
      if (lastMatches.length === 1){ hit = lastMatches[0]; confidence = 'lastname'; }
      else if (lastMatches.length > 1){
        trace.reason='ambiguous surname in '+yr;
        return { id:null, confidence:'ambiguous', trace,
          candidates:lastMatches.slice(0,6).map(p=>({id:p.id,name:p.player_name})) };
      }
    }
    if (hit) return { id:hit.id, confidence, name:hit.player_name, trace };
  }
  trace.reason = trace.seasonsTried.every(x=>!x.fetchOk) ? 'all understat league fetches failed'
    : trace.seasonsTried.every(x=>x.parseFail) ? 'league pages fetched but playersData never parsed'
    : 'name not found in any parsed season';
  return { id:null, confidence:'none', trace };
}

// Pull a player's full match list from their Understat page.
// matchesData rows carry h_team + a_team but NOT which side is the player's, so
// we infer the player's team per season: whichever team appears in every (or
// nearly every) of that season's matches. This also handles mid-career transfers,
// since the inference is done season by season rather than once globally.
async function understatMatches(uid){
  const res = await fetch('https://understat.com/player/'+uid, { headers: UA });
  if (!res.ok) throw new Error('understat player '+res.status);
  const html = await res.text();
  const raw = extractJSON(html, 'matchesData') || [];

  // Count how often each team appears within each season.
  const seasonTeamCount = {};   // season -> {team -> count}
  raw.forEach(m => {
    const s = m.season || '?';
    seasonTeamCount[s] = seasonTeamCount[s] || {};
    [m.h_team, m.a_team].forEach(tm => {
      if (!tm) return;
      seasonTeamCount[s][tm] = (seasonTeamCount[s][tm]||0) + 1;
    });
  });
  // The player's team for a season is the most frequent team that season
  // (the player is in every one of their own matches; opponents vary).
  const playerTeamBySeason = {};
  Object.keys(seasonTeamCount).forEach(s => {
    let best=null, bestN=-1;
    Object.entries(seasonTeamCount[s]).forEach(([tm,n])=>{ if(n>bestN){bestN=n;best=tm;} });
    playerTeamBySeason[s] = best;
  });

  return raw.map(m => {
    const mine = playerTeamBySeason[m.season||'?'];
    const isHome = m.h_team === mine;
    const opponent = isHome ? m.a_team : m.h_team;
    return {
      date: m.date, season: m.season,
      playerTeam: mine,
      opponent: opponent || null,
      homeAway: isHome ? 'H' : 'A',
      goals: +m.goals||0, assists: +m.assists||0,
      xg: +m.xG||0, xa: +m.xA||0,
      shots: +m.shots||0, keyPasses: +m.key_passes||0,
      minutes: +m.time||0,
    };
  });
}

// Aggregate matches into per-opponent splits across all seasons.
function vsClub(matches){
  const by = {};
  matches.forEach(m => {
    const opp = m.opponent;
    if (!opp) return;
    const k = opp;
    if (!by[k]) by[k] = { opponent:opp, games:0, goals:0, assists:0, xg:0, xa:0,
                          mins:0, home:0, away:0, seasons:new Set() };
    const b = by[k];
    b.games++; b.goals+=m.goals; b.assists+=m.assists;
    b.xg+=m.xg; b.xa+=m.xa; b.mins+=m.minutes;
    if (m.homeAway==='H') b.home++; else b.away++;
    if (m.season) b.seasons.add(m.season);
  });
  return Object.values(by).map(b => ({
    opponent:b.opponent, games:b.games, goals:b.goals, assists:b.assists,
    xg:Math.round(b.xg*100)/100, xa:Math.round(b.xa*100)/100,
    mins:b.mins, home:b.home, away:b.away,
    seasons:[...b.seasons].sort(),
    gp90: b.mins>0 ? Math.round((b.goals/(b.mins/90))*100)/100 : 0,
  })).sort((a,b)=>b.goals-a.goals || b.xg-a.xg);
}

export default async (req) => {
  const HEADERS = {
    'content-type':'application/json',
    'access-control-allow-origin':'*',
    'netlify-cdn-cache-control':'public, s-maxage=86400, stale-while-revalidate=604800',
  };
  const url = new URL(req.url);
  const fplId = url.searchParams.get('id');
  const name  = url.searchParams.get('name') || '';
  const uidParam = url.searchParams.get('uid'); // optional: user-confirmed Understat id

  if (!fplId) return new Response(JSON.stringify({error:'missing id'}),{status:400,headers:HEADERS});

  const out = { fpl:null, understat:null, vsClub:null, match:null };

  // 1 ── FPL element-summary (points history + this-season log)
  try {
    const r = await fetch('https://fantasy.premierleague.com/api/element-summary/'+fplId+'/', { headers: UA });
    if (r.ok){
      const j = await r.json();
      out.fpl = {
        history_past: j.history_past || [],   // previous-season totals
        history: (j.history||[]).map(h => ({  // this-season game by game
          round:h.round, opponent_team:h.opponent_team, was_home:h.was_home,
          total_points:h.total_points, minutes:h.minutes, goals:h.goals_scored,
          assists:h.assists, xg:+h.expected_goals||0, xa:+h.expected_assists||0,
          bps:h.bps, value:h.value,
        })),
      };
    }
  } catch(e){ out.fplError = String(e.message||e); }

  // 2 ── Understat multi-season matches
  try {
    let uid = uidParam;
    let matchInfo = { confidence: uidParam ? 'user' : null };
    if (!uid){
      const seasons = ['2025','2024','2023'];   // search recent seasons for the id
      const resolved = await resolveUnderstatId(name, seasons);
      matchInfo = resolved;
      uid = resolved.id;
    }
    out.match = matchInfo;
    if (uid){
      const matches = await understatMatches(uid);
      out.understat = { uid, matchCount: matches.length, matches };
      out.vsClub = vsClub(matches);
    }
  } catch(e){ out.understatError = String(e.message||e); }

  return new Response(JSON.stringify(out), { status:200, headers:HEADERS });
};
