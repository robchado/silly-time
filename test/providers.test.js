import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReadsb, parseOpenSky, buildUrl } from '../public/js/providers.js';
import { handleFlights } from '../server.js';

test('parses readsb v2 JSON (adsb.lol / adsb.fi)', () => {
  const json = {
    ac: [
      { hex: 'A1B2C3', flight: 'UAL123  ', r: 'N12345', t: 'B738', category: 'A3', lat: 34.1, lon: -118.3, alt_baro: 4500, alt_geom: 4625, gs: 250.4, track: 92.1, baro_rate: -640, seen_pos: 1.2 },
      { hex: 'abcdef', alt_baro: 'ground', lat: 34.0, lon: -118.4, gs: 12 },
      { hex: 'nopos', alt_baro: 9000 },
    ],
  };
  const out = parseReadsb(json);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { id: out[0].id, cs: out[0].callsign, alt: out[0].altFt, vr: out[0].vrateFpm, type: out[0].type },
    { id: 'a1b2c3', cs: 'UAL123', alt: 4625, vr: -640, type: 'B738' }
  );
  assert.equal(out[1].onGround, true);
  assert.equal(out[1].altFt, 0);
});

test('parses OpenSky states with unit conversion', () => {
  const json = {
    time: 1000,
    states: [['abc123', 'SWA42   ', 'United States', 995, 999, -118.3, 34.1, 1000, false, 100, 270, -5, null, 1050, '1200', false, 0, 4]],
  };
  const [a] = parseOpenSky(json);
  assert.equal(a.callsign, 'SWA42');
  assert.equal(a.category, 'A3');
  assert.ok(Math.abs(a.altFt - 3444.9) < 0.5);
  assert.ok(Math.abs(a.gsKt - 194.4) < 0.1);
  assert.ok(Math.abs(a.vrateFpm + 984.3) < 0.5);
  assert.equal(a.seenSec, 5);
});

test('builds provider URLs', () => {
  assert.equal(buildUrl('adsblol', 34.05, -118.25, 15), 'https://api.adsb.lol/v2/point/34.0500/-118.2500/15');
  assert.match(buildUrl('opensky', 34, -118, 10), /lamin=33\.83.*extended=1/);
});

test('server proxy validates input and relays upstream', async () => {
  const bad = await handleFlights(new URLSearchParams({ provider: 'nope', lat: 1, lon: 1 }));
  assert.equal(bad.status, 400);
  let called;
  const fake = async (url) => {
    called = url;
    return { ok: true, status: 200, text: async () => '{"ac":[]}' };
  };
  const ok = await handleFlights(new URLSearchParams({ provider: 'adsbfi', lat: 51.5, lon: -0.12, radius: 10 }), fake);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '{"ac":[]}');
  assert.match(called, /adsb\.fi\/api\/v2\/lat\/51\.5000\/lon\/-0\.1200\/dist\/10/);
  const down = await handleFlights(new URLSearchParams({ provider: 'adsbfi', lat: 1, lon: 2 }), async () => { throw new Error('ECONNRESET'); });
  assert.equal(down.status, 502);
});
