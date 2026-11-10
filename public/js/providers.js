// Live ADS-B data providers. Shared by the browser (direct mode) and by
// server.js (proxy mode, which sidesteps CORS and rate-limit quirks).
//
// Every provider is normalised into the same aircraft shape:
//   { id, callsign, reg, type, category, lat, lon, altFt, onGround,
//     gsKt, trackDeg, vrateFpm, seenSec }

import { bbox } from './geo.js';

const clampRadius = (r, max) => Math.max(1, Math.min(max, Math.round(r)));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const PROVIDERS = {
  adsblol: {
    label: 'adsb.lol',
    url: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${clampRadius(r, 250)}`,
    parse: parseReadsb,
  },
  airplaneslive: {
    label: 'airplanes.live',
    url: (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${clampRadius(r, 250)}`,
    parse: parseReadsb,
  },
  adsbfi: {
    label: 'adsb.fi',
    url: (lat, lon, r) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${clampRadius(r, 250)}`,
    parse: parseReadsb,
  },
  opensky: {
    label: 'OpenSky Network',
    url: (lat, lon, r) => {
      const b = bbox(lat, lon, r);
      const q = Object.entries(b).map(([k, v]) => `${k}=${v.toFixed(4)}`).join('&');
      return `https://opensky-network.org/api/states/all?${q}&extended=1`;
    },
    parse: parseOpenSky,
  },
};

/** readsb / tar1090 "v2" JSON, used by adsb.lol, airplanes.live and adsb.fi. */
export function parseReadsb(json) {
  const list = json?.ac ?? json?.aircraft ?? [];
  const out = [];
  for (const a of list) {
    const lat = num(a.lat) ?? num(a.lastPosition?.lat);
    const lon = num(a.lon) ?? num(a.lastPosition?.lon);
    if (lat == null || lon == null) continue;
    const onGround = a.alt_baro === 'ground';
    const altFt = onGround ? 0 : num(a.alt_geom) ?? num(a.alt_baro);
    out.push({
      id: String(a.hex ?? '').toLowerCase(),
      callsign: (a.flight ?? '').trim(),
      reg: a.r ?? '',
      type: a.t ?? '',
      category: a.category ?? '',
      lat,
      lon,
      altFt,
      onGround,
      gsKt: num(a.gs) ?? 0,
      trackDeg: num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading) ?? 0,
      vrateFpm: num(a.geom_rate) ?? num(a.baro_rate) ?? 0,
      seenSec: num(a.seen_pos) ?? num(a.seen) ?? 0,
    });
  }
  return out;
}

// OpenSky integer categories -> ADS-B emitter category codes
const OSK_CAT = { 2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7', 9: 'B1', 10: 'B2', 11: 'B3', 12: 'B4', 14: 'B6' };

/** OpenSky /states/all response. */
export function parseOpenSky(json, nowSec = json?.time ?? Date.now() / 1000) {
  const out = [];
  for (const s of json?.states ?? []) {
    const [icao, callsign, , timePos, lastContact, lon, lat, baroAlt, onGround, vel, track, vrate, , geoAlt] = s;
    if (num(lat) == null || num(lon) == null) continue;
    const altM = num(geoAlt) ?? num(baroAlt);
    out.push({
      id: String(icao ?? '').toLowerCase(),
      callsign: (callsign ?? '').trim(),
      reg: '',
      type: '',
      category: OSK_CAT[s[17]] ?? '',
      lat,
      lon,
      altFt: onGround ? 0 : altM == null ? null : altM / 0.3048,
      onGround: !!onGround,
      gsKt: (num(vel) ?? 0) * 1.943844,
      trackDeg: num(track) ?? 0,
      vrateFpm: (num(vrate) ?? 0) * 196.8504,
      seenSec: Math.max(0, nowSec - (num(timePos) ?? num(lastContact) ?? nowSec)),
    });
  }
  return out;
}

export function buildUrl(provider, lat, lon, radiusNm) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  return p.url(lat, lon, radiusNm);
}

export function parse(provider, json) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  return p.parse(json);
}
