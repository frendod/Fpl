// Netlify Function — per-player history, fetched on click.
// FPL-only (Understat scraping retired: their data is no longer inline in the
// page HTML, so multi-season xG-vs-club is parked until we have the new endpoint).
//
// Returns, for one player:
//   pastSeasons  — one row per previous season (points, mins, goals, price, xG, DefCon)
//   thisSeason   — this season's games so far (empty until the season starts)
//   vsClubThis   — this season's returns grouped by opponent (populates once games exist)
//   teams        — id→short_name map so the app can label opponents
// Reached at /api/player?id=123

const BUILD = 'v5-fpl-only';
const UA = { 'user-agent': 'Mozilla/5.0 (fplrock player history)' };

export default async (req) => {
  const HEADERS = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    // short cache: history changes at most once per gameweek
    'netlify-cdn-cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400',
  };

  let fplId;
  try { fplId = new URL(req.url).searchParams.get('id'); }
  catch(e){ return json({ build:BUILD, error:'bad url' }, HEADERS); }

  const out = { build:BUILD, id:fplId, pastSeasons:null, thisSeason:null, vsClubThis:null };
  if (!fplId){ out.error='missing id'; return json(out, HEADERS); }

  try {
    // element-summary carries history_past (prev seasons) + history (this season)
    const sumRes = await fetch(
      'https://fantasy.premierleague.com/api/element-summary/'+fplId+'/', { headers: UA });
    if (!sumRes.ok) throw new Error('element-summary '+sumRes.status);
    const sum = await sumRes.json();

    out.pastSeasons = (sum.history_past || []).map(h => ({
      season: h.season_name,
      points: h.total_points,
      minutes: h.minutes,
      goals: h.goals_scored,
      assists: h.assists,
      cleanSheets: h.clean_sheets,
      bonus: h.bonus,
      bps: h.bps,
      startCost: h.start_cost/10,
      endCost: h.end_cost/10,
      xg: parseFloat(h.expected_goals)||0,
      xa: parseFloat(h.expected_assists)||0,
      defcon: h.defensive_contribution||0,
      ict: parseFloat(h.ict_index)||0,
      starts: h.starts||0,
    }));

    out.thisSeason = (sum.history || []).map(h => ({
      round: h.round,
      opponent: h.opponent_team,          // team id — labelled client-side
      home: h.was_home,
      points: h.total_points,
      minutes: h.minutes,
      goals: h.goals_scored,
      assists: h.assists,
      cleanSheet: h.clean_sheets,
      bonus: h.bonus,
      bps: h.bps,
      xg: parseFloat(h.expected_goals)||0,
      xa: parseFloat(h.expected_assists)||0,
      defcon: h.defensive_contribution||0,
      value: h.value/10,
    }));

    // this-season per-opponent aggregation (empty until games are played)
    const by = {};
    out.thisSeason.forEach(g => {
      const k = g.opponent;
      if (!by[k]) by[k] = { opponent:k, games:0, points:0, goals:0, assists:0,
                            xg:0, xa:0, minutes:0, home:0, away:0 };
      const b = by[k];
      b.games++; b.points+=g.points; b.goals+=g.goals; b.assists+=g.assists;
      b.xg+=g.xg; b.xa+=g.xa; b.minutes+=g.minutes;
      if (g.home) b.home++; else b.away++;
    });
    out.vsClubThis = Object.values(by).map(b => ({
      ...b, xg:Math.round(b.xg*100)/100, xa:Math.round(b.xa*100)/100
    })).sort((a,b)=>b.points-a.points);

  } catch(e){
    out.error = String(e && e.message || e);
  }

  return json(out, HEADERS);
};

function json(obj, headers){
  return new Response(JSON.stringify(obj), { status:200, headers });
}
