// Aircraft noise prediction and "safe to roll" assessment.
//
// This is a deliberately simple, conservative engineering model -- not a
// certified noise model. Each aircraft gets a reference A-weighted level at
// 1000 ft slant range, then spherical spreading (-6 dB per doubling of
// distance) and a broadband atmospheric absorption term are applied. It is
// meant to answer "is anything loud close enough, or about to be?", and the
// live microphone is the ground truth that backs it up.

import { toLocal, project, FT, KT, bearingDeg } from './geo.js';

export const REF_DIST_M = 1000 * FT; // reference slant range: 1000 ft
const ABSORPTION_DB_PER_M = 0.0025; // ~2.5 dB/km broadband A-weighted
const MIN_DIST_M = 30;

// Approximate LAmax at 1000 ft by ADS-B emitter category.
export const CATEGORY_REF_DBA = {
  A1: 76, // light (< 15,500 lb): Cessna, Piper
  A2: 82, // small (15.5k-75k lb): bizjets, turboprops
  A3: 88, // large (75k-300k lb): A320, 737
  A4: 89, // high-vortex large: 757
  A5: 94, // heavy (> 300k lb): 777, 747, A350
  A6: 96, // high performance: military jets
  A7: 87, // rotorcraft -- low, slow, and loud: the classic take-killer
  B1: 40, // glider
  B2: 55, // balloon (burner)
  B3: 40, // parachutist
  B4: 72, // ultralight
  B6: 70, // UAV
  C1: 0,
  C2: 0,
  C3: 0,
};
export const UNKNOWN_REF_DBA = 86;

// ICAO type designators for common helicopters (some feeds omit category).
const HELI_TYPES = new Set(
  ('R22 R44 R66 B06 B06T B407 B412 B429 B505 B212 AS50 AS55 AS65 AS32 AS3B EC20 EC25 EC30 EC35 EC45 EC55 EC75 ' +
    'H125 H130 H135 H145 H155 H160 H175 A109 A119 A139 A169 A189 AW09 S76 S92 H60 UH1 UH1Y MD52 MD60 EXPL BK17 ' +
    'H47 H53 H64 G2CA CABR').split(' ')
);

export function isHelicopter(ac) {
  return ac.category === 'A7' || HELI_TYPES.has((ac.type || '').toUpperCase());
}

export function referenceLevel(ac) {
  if (HELI_TYPES.has((ac.type || '').toUpperCase())) return CATEGORY_REF_DBA.A7;
  return CATEGORY_REF_DBA[ac.category] ?? UNKNOWN_REF_DBA;
}

/** Predicted A-weighted level (dBA) at the set for a given slant distance. */
export function levelAtDistance(refDbA, slantM, vrateFpm = 0) {
  const d = Math.max(MIN_DIST_M, slantM);
  let L = refDbA - 20 * Math.log10(d / REF_DIST_M) - ABSORPTION_DB_PER_M * Math.max(0, d - REF_DIST_M);
  if (vrateFpm > 500) L += 3; // climbing = high thrust
  else if (vrateFpm < -500) L -= 2; // descending = reduced power
  return L;
}

/** Energetic sum of levels in dB. */
export function sumDb(levels) {
  let p = 0;
  for (const l of levels) if (Number.isFinite(l)) p += 10 ** (l / 10);
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
}

/**
 * Turn normalised aircraft into local kinematic tracks relative to the set.
 * ageSec: seconds elapsed since the data was fetched (added to each report's own age).
 */
export function buildTracks(aircraft, set, { ageSec = 0, includeGround = false, maxSeenSec = 60 } = {}) {
  const setElevM = (set.elevFt ?? 0) * FT;
  const tracks = [];
  for (const ac of aircraft) {
    if (ac.onGround && !includeGround) continue;
    if ((ac.seenSec ?? 0) > maxSeenSec) continue;
    if (ac.altFt == null && !ac.onGround) continue;
    const p0 = toLocal(set, ac.lat, ac.lon);
    const base = {
      x: p0.x,
      y: p0.y,
      altM: Math.max(0, (ac.altFt ?? 0) * FT - setElevM),
      gsMs: (ac.gsKt ?? 0) * KT,
      trackDeg: ac.trackDeg ?? 0,
      vrateMs: ((ac.vrateFpm ?? 0) * FT) / 60,
    };
    // bring the report up to "now"
    const now = project(base, (ac.seenSec ?? 0) + ageSec);
    tracks.push({ ...ac, ...base, ...now, refDbA: referenceLevel(ac), heli: isHelicopter(ac) });
  }
  return tracks;
}

/** Instantaneous state of a track t seconds from now. */
export function trackAt(tr, t) {
  const p = t === 0 ? tr : project(tr, t);
  const horiz = Math.hypot(p.x, p.y);
  const slant = Math.hypot(horiz, p.altM);
  return { ...p, horizM: horiz, slantM: slant, dbA: levelAtDistance(tr.refDbA, slant, tr.vrateFpm) };
}

/**
 * Predict each aircraft's level at the set over the lookahead horizon, and
 * combine them into a single timeline.
 */
export function predict(tracks, { horizonSec = 600, stepSec = 5, attenuationDb = 0 } = {}) {
  const n = Math.floor(horizonSec / stepSec) + 1;
  const times = Array.from({ length: n }, (_, i) => i * stepSec);
  const totalP = new Float64Array(n);
  const perAircraft = tracks.map((tr) => {
    let peak = -Infinity;
    let peakT = 0;
    let cpaM = Infinity;
    let cpaT = 0;
    for (let i = 0; i < n; i++) {
      const s = trackAt(tr, times[i]);
      const L = s.dbA - attenuationDb;
      totalP[i] += 10 ** (L / 10);
      if (L > peak) [peak, peakT] = [L, times[i]];
      if (s.slantM < cpaM) [cpaM, cpaT] = [s.slantM, times[i]];
    }
    const nowState = trackAt(tr, 0);
    return {
      track: tr,
      nowDbA: nowState.dbA - attenuationDb,
      horizM: nowState.horizM,
      slantM: nowState.slantM,
      bearing: bearingDeg(tr.x, tr.y),
      peakDbA: peak,
      peakT,
      cpaM,
      cpaT,
    };
  });
  const totalDbA = Array.from(totalP, (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity));
  return { times, stepSec, horizonSec, totalDbA, perAircraft };
}

/**
 * Decide whether a take of `takeSec` can start now.
 * Returns:
 *   status: 'ROLL' | 'STANDBY' | 'HOLD'
 *   windowSec: if ROLL, how long the sky is predicted to stay quiet
 *   clearInSec: if not ROLL, when the next window of >= takeSec opens (null if beyond horizon)
 *   culprits: aircraft responsible
 */
export function assess(prediction, { thresholdDbA = 45, marginDb = 3, takeSec = 120 } = {}) {
  const { times, totalDbA, stepSec, horizonSec, perAircraft } = prediction;
  const limit = thresholdDbA - marginDb;
  const loud = totalDbA.map((l) => l >= limit);
  const takeSteps = Math.ceil(takeSec / stepSec);

  const firstLoud = loud.indexOf(true);
  const quietFor = (i) => {
    let j = i;
    while (j < loud.length && !loud[j]) j++;
    return j; // index of next loud step (or length)
  };

  // Earliest start index followed by takeSec of predicted quiet. A quiet run
  // that hits the end of the horizon only counts if it is already long enough:
  // we can't vouch for what we can't see yet.
  let clearIdx = null;
  for (let i = 0; i < loud.length; i++) {
    if (loud[i]) continue;
    const end = quietFor(i);
    if (end - i >= takeSteps) {
      clearIdx = i;
      break;
    }
    i = end;
  }

  let status;
  if (loud[0]) status = 'HOLD';
  else if (clearIdx === 0) status = 'ROLL';
  else status = 'STANDBY';

  const culprits = perAircraft
    .filter((a) => a.peakDbA >= limit)
    .sort((a, b) => (status === 'HOLD' ? b.nowDbA - a.nowDbA : a.peakT - b.peakT));

  const windowEnd = firstLoud === -1 ? horizonSec : times[firstLoud];
  return {
    status,
    limit,
    nowDbA: totalDbA[0],
    windowSec: status === 'ROLL' ? windowEnd : 0,
    windowOpenEnded: status === 'ROLL' && firstLoud === -1,
    clearInSec: status === 'ROLL' ? 0 : clearIdx == null ? null : times[clearIdx],
    culprits,
  };
}
