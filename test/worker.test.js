import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { upstreamUrl } from '../worker/worker.js';
import { buildUrl, PROVIDERS } from '../public/js/providers.js';

test('worker builds the same upstream URLs as the app', () => {
  for (const p of Object.keys(PROVIDERS)) {
    for (const [lat, lon, r] of [[34.05, -118.25, 15], [51.47, -0.45, 7.6], [-33.9, 151.2, 40]]) {
      assert.equal(upstreamUrl(p, lat, lon, r), buildUrl(p, lat, lon, r), `${p} ${lat},${lon}`);
    }
  }
});

async function call(path, { origin = 'https://robchado.github.io', method = 'GET', env = {}, upstream } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = upstream ?? (async () => new Response('{"ac":[]}', { status: 200 }));
  try {
    return await worker.fetch(new Request(`https://proxy.example${path}`, { method, headers: { origin } }), env);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('worker relays data with CORS headers', async () => {
  let seen;
  const res = await call('/api/flights?provider=adsbfi&lat=34.05&lon=-118.25&radius=15', {
    upstream: async (u) => ((seen = u), new Response('{"aircraft":[1]}')),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(await res.text(), '{"aircraft":[1]}');
  assert.match(seen, /opendata\.adsb\.fi/);
});

test('worker answers CORS preflight', async () => {
  const res = await call('/api/flights', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get('access-control-allow-origin'));
});

test('worker rejects bad input and maps upstream failures', async () => {
  assert.equal((await call('/api/flights?provider=evil&lat=1&lon=1')).status, 400);
  assert.equal((await call('/api/flights?lat=999&lon=1')).status, 400);
  assert.equal((await call('/elsewhere')).status, 404);
  const down = await call('/api/flights?lat=1&lon=1', { upstream: async () => new Response('', { status: 429 }) });
  assert.equal(down.status, 502);
  assert.match(await down.text(), /429/);
});

test('ALLOWED_ORIGINS restricts callers', async () => {
  const env = { ALLOWED_ORIGINS: 'https://robchado.github.io' };
  const ok = await call('/api/flights?lat=1&lon=1', { env });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://robchado.github.io');
  assert.equal((await call('/api/flights?lat=1&lon=1', { env, origin: 'https://evil.example' })).status, 403);
});
