// Quiet on Set flight-data proxy for Cloudflare Workers (free tier is plenty).
//
// The ADS-B providers don't send CORS headers, so a page on GitHub Pages
// can't read them directly. This worker fetches on the page's behalf, adds
// CORS headers, and caches each answer for a few seconds so every phone on
// set shares one upstream request.
//
// Self-contained on purpose: you can paste this file straight into the
// Cloudflare dashboard editor, or deploy it with `npx wrangler deploy`.
//
// Optional variable ALLOWED_ORIGINS (comma-separated, e.g.
// "https://you.github.io") restricts which sites may use the proxy.
// Leave it unset to allow any site.

const CACHE_SECONDS = 5;
const UA = 'quiet-on-set-proxy/1.0';

const clampRadius = (r) => Math.max(1, Math.min(250, Math.round(r)));

export function upstreamUrl(provider, lat, lon, radiusNm) {
  const la = lat.toFixed(4);
  const lo = lon.toFixed(4);
  const r = clampRadius(radiusNm);
  switch (provider) {
    case 'adsblol':
      return `https://api.adsb.lol/v2/point/${la}/${lo}/${r}`;
    case 'adsbfi':
      return `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`;
    case 'opensky': {
      const R = 6371008.8;
      const m = radiusNm * 1852;
      const dLat = (m / R) * (180 / Math.PI);
      const dLon = (m / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
      const q = { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon };
      return `https://opensky-network.org/api/states/all?${Object.entries(q).map(([k, v]) => `${k}=${v.toFixed(4)}`).join('&')}&extended=1`;
    }
    default:
      return null;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env?.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : null;
  const h = { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400', vary: 'origin' };
  if (allow) h['access-control-allow-origin'] = allow;
  return { headers: h, allowed: allow !== null };
}

const json = (status, body, headers) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
    if (!cors.allowed) return json(403, { error: 'origin not allowed' }, cors.headers);
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, cors.headers);

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/api/health') return json(200, { ok: true, service: 'quiet-on-set proxy' }, cors.headers);
    if (url.pathname !== '/api/flights') return json(404, { error: 'not found' }, cors.headers);

    const p = url.searchParams;
    const lat = parseFloat(p.get('lat'));
    const lon = parseFloat(p.get('lon'));
    const radius = parseFloat(p.get('radius') || '15');
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && radius > 0)) {
      return json(400, { error: 'lat, lon and radius are required' }, cors.headers);
    }
    const target = upstreamUrl(p.get('provider') || 'adsblol', lat, lon, radius);
    if (!target) return json(400, { error: 'unknown provider' }, cors.headers);

    try {
      const res = await fetch(target, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      });
      if (!res.ok) return json(502, { error: `upstream HTTP ${res.status}` }, cors.headers);
      return json(200, await res.text(), cors.headers);
    } catch (e) {
      return json(502, { error: `upstream unreachable: ${e.message}` }, cors.headers);
    }
  },
};
