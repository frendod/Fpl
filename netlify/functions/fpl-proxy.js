// Netlify Function: Proxy FPL API requests
// Deploy to netlify/functions/fpl-proxy.js

export default async (request, context) => {
  const url = new URL(request.url);
  const fplPath = url.searchParams.get('path');
  
  if (!fplPath) {
    return new Response('Missing path parameter', { status: 400 });
  }

  const fplUrl = `https://fantasy.premierleague.com/api/${fplPath}`;
  
  try {
    const fplRes = await fetch(fplUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const data = await fplRes.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: '/api/fpl-proxy'
};
