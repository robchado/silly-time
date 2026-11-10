// Simulated traffic for rehearsal, demos and offline testing. Produces
// aircraft in the same normalised shape as the live providers.

import { fromLocal, NM } from './geo.js';

const TYPES = [
  { category: 'A3', type: 'A320', prefix: 'UAL', gsKt: [250, 320], altFt: [3000, 12000], weight: 5 },
  { category: 'A3', type: 'B738', prefix: 'SWA', gsKt: [240, 320], altFt: [2500, 14000], weight: 5 },
  { category: 'A5', type: 'B77W', prefix: 'AAL', gsKt: [280, 360], altFt: [6000, 20000], weight: 2 },
  { category: 'A1', type: 'C172', prefix: 'N', gsKt: [90, 120], altFt: [1500, 4500], weight: 3 },
  { category: 'A2', type: 'CL35', prefix: 'EJA', gsKt: [200, 300], altFt: [4000, 15000], weight: 2 },
  { category: 'A7', type: 'AS50', prefix: 'N', gsKt: [70, 120], altFt: [700, 2000], weight: 3 },
];

export class TrafficSimulator {
  constructor(set, { radiusNm = 15, seed = Date.now() } = {}) {
    this.set = set;
    this.radiusM = radiusNm * NM;
    this.rand = mulberry32(seed >>> 0);
    this.aircraft = [];
    this.t = 0;
    this.nextSpawn = 0;
    this.serial = 0;
    // start with a little traffic already in the air
    for (let i = 0; i < 3; i++) this.spawn(this.rand() * 0.8);
  }

  pick(arr) {
    const total = arr.reduce((s, a) => s + a.weight, 0);
    let r = this.rand() * total;
    for (const a of arr) if ((r -= a.weight) <= 0) return a;
    return arr[arr.length - 1];
  }
  range([a, b]) {
    return a + this.rand() * (b - a);
  }

  /** Spawn an aircraft that will cross the area. progress: 0 = at edge, 1 = at closest point. */
  spawn(progress = 0) {
    const kind = this.pick(TYPES);
    const entryBearing = this.rand() * Math.PI * 2;
    const offset = (this.rand() - 0.5) * 2 * this.radiusM * 0.45; // miss distance
    const heading = entryBearing + Math.PI + (this.rand() - 0.5) * 0.3;
    const gsKt = this.range(kind.gsKt);
    const r = this.radiusM * 0.98 * (1 - progress);
    // entry point on circle, shifted sideways for the miss distance
    const x = Math.sin(entryBearing) * r + Math.cos(entryBearing) * offset;
    const y = Math.cos(entryBearing) * r - Math.sin(entryBearing) * offset;
    const climbing = this.rand() < 0.3;
    const id = (0xa00000 + ((this.serial++ * 7919 + Math.floor(this.rand() * 4096)) & 0xfffff)).toString(16);
    const num = Math.floor(100 + this.rand() * 8900);
    this.aircraft.push({
      id,
      callsign: kind.prefix === 'N' ? `N${num}${'ABCDEFGHJK'[num % 10]}` : `${kind.prefix}${num}`,
      reg: '',
      type: kind.type,
      category: kind.category,
      x,
      y,
      altFt: this.range(kind.altFt),
      gsKt,
      trackDeg: ((heading * 180) / Math.PI + 360) % 360,
      vrateFpm: kind.category === 'A7' ? 0 : climbing ? 1500 : this.rand() < 0.4 ? -900 : 0,
    });
  }

  step(dt) {
    this.t += dt;
    if (this.t >= this.nextSpawn) {
      this.spawn(0);
      this.nextSpawn = this.t + 40 + this.rand() * 110;
    }
    for (const a of this.aircraft) {
      const v = a.gsKt * (NM / 3600);
      const tr = (a.trackDeg * Math.PI) / 180;
      a.x += Math.sin(tr) * v * dt;
      a.y += Math.cos(tr) * v * dt;
      a.altFt = Math.max(500, Math.min(30000, a.altFt + (a.vrateFpm * dt) / 60));
    }
    this.aircraft = this.aircraft.filter((a) => Math.hypot(a.x, a.y) < this.radiusM * 1.05);
  }

  snapshot() {
    return this.aircraft.map((a) => {
      const { lat, lon } = fromLocal(this.set, a.x, a.y);
      return {
        id: a.id,
        callsign: a.callsign,
        reg: a.reg,
        type: a.type,
        category: a.category,
        lat,
        lon,
        altFt: a.altFt,
        onGround: false,
        gsKt: a.gsKt,
        trackDeg: a.trackDeg,
        vrateFpm: a.vrateFpm,
        seenSec: 0,
      };
    });
  }
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
