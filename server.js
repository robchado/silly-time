// Zero-dependency server for Quiet on Set.
//  - serves ./public
//  - proxies /api/flights to the selected ADS-B provider (avoids browser CORS
//    limits and lets several devices on set share one upstream request)
//
//   node server.js            -> http://localhost:8080
//   PORT=3000 node server.js

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, buildUrl } from './public/js/providers.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_MS = 4000; // de-duplicate requests from multiple devices on set

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const cache = new Map(); // url -> { at, status, body }

export async function handleFlights(query, fetchImpl = fetch) {
  const provider = query.get('provider') || 'adsblol';
  const lat = parseFloat(query.get('lat'));
  const lon = parseFloat(query.get('lon'));
  const radius = parseFloat(query.get('radius') || '15');
  if (!PROVIDERS[provider]) return { status: 400, body: JSON.stringify({ error: `unknown provider ${provider}` }) };
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && radius > 0)) {
    return { status: 400, body: JSON.stringify({ error: 'lat, lon and radius are required' }) };
  }
  const url = buildUrl(provider, lat, lon, Math.min(radius, 250));
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'quiet-on-set/1.0', accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    const out = { at: Date.now(), status: res.ok ? 200 : 502, body: res.ok ? body : JSON.stringify({ error: `upstream HTTP ${res.status}` }) };
    if (res.ok) cache.set(url, out);
    for (const [k, v] of cache) if (Date.now() - v.at > 60000) cache.delete(k);
    return out;
  } catch (e) {
    return { status: 502, body: JSON.stringify({ error: `upstream unreachable: ${e.message}` }) };
  }
}

async function serveStatic(pathname, res) {
  let p = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (p === '' || p.endsWith(sep)) p = join(p, 'index.html');
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  try {
    const s = await stat(file);
    if (s.isDirectory()) return serveStatic(join(pathname, 'index.html'), res);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    send(res, 404, 'not found');
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(body);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/flights') {
      const r = await handleFlights(u.searchParams);
      return send(res, r.status, r.body, 'application/json');
    }
    if (u.pathname === '/api/health') return send(res, 200, '{"ok":true}', 'application/json');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(u.pathname, res);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Quiet on Set running at http://localhost:${PORT}`);
    console.log(`Demo traffic: http://localhost:${PORT}/?demo`);
  });
}
