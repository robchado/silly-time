// Flat-earth local geometry around the set. Accurate to well under 1% within
// ~100 km, which is far beyond the range at which aircraft matter for sound.

export const EARTH_R = 6371008.8; // metres
export const FT = 0.3048;
export const NM = 1852;
export const KT = NM / 3600; // m/s per knot

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Convert lat/lon to local east/north metres relative to origin {lat, lon}. */
export function toLocal(origin, lat, lon) {
  let dLon = lon - origin.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return {
    x: rad(dLon) * Math.cos(rad(origin.lat)) * EARTH_R,
    y: rad(lat - origin.lat) * EARTH_R,
  };
}

/** Convert local east/north metres back to lat/lon. */
export function fromLocal(origin, x, y) {
  return {
    lat: origin.lat + deg(y / EARTH_R),
    lon: origin.lon + deg(x / (EARTH_R * Math.cos(rad(origin.lat)))),
  };
}

/** Compass bearing (0 = north, clockwise) from origin to local point. */
export function bearingDeg(x, y) {
  return (deg(Math.atan2(x, y)) + 360) % 360;
}

export function compassPoint(b) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(b / 22.5) % 16];
}

/**
 * Dead-reckon an aircraft forward t seconds.
 * ac: {x, y, altM, gsMs, trackDeg, vrateMs}
 */
export function project(ac, t) {
  const tr = rad(ac.trackDeg ?? 0);
  const v = ac.gsMs ?? 0;
  return {
    x: ac.x + Math.sin(tr) * v * t,
    y: ac.y + Math.cos(tr) * v * t,
    altM: Math.max(0, ac.altM + (ac.vrateMs ?? 0) * t),
  };
}

/** Lat/lon bounding box for a radius in nautical miles. */
export function bbox(lat, lon, radiusNm) {
  const r = radiusNm * NM;
  const dLat = deg(r / EARTH_R);
  const dLon = deg(r / (EARTH_R * Math.cos(rad(lat))));
  return { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon };
}
