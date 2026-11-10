import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelAtDistance, buildTracks, predict, assess, sumDb, referenceLevel, REF_DIST_M } from '../public/js/noise.js';
import { fromLocal, toLocal, NM } from '../public/js/geo.js';

const SET = { lat: 34.05, lon: -118.25, elevFt: 0 };

// aircraft starting at local (x, y) metres with a track and speed
function ac(id, x, y, { altFt = 1500, gsKt = 120, trackDeg = 0, category = 'A3', type = '', vrateFpm = 0 } = {}) {
  const { lat, lon } = fromLocal(SET, x, y);
  return { id, callsign: id, lat, lon, altFt, gsKt, trackDeg, category, type, vrateFpm, onGround: false, seenSec: 0 };
}

test('geo round trip', () => {
  const { lat, lon } = fromLocal(SET, 5000, -3000);
  const p = toLocal(SET, lat, lon);
  assert.ok(Math.abs(p.x - 5000) < 0.01 && Math.abs(p.y + 3000) < 0.01);
});

test('spreading loss is ~6 dB per doubling near the reference distance', () => {
  const L1 = levelAtDistance(88, REF_DIST_M);
  const L2 = levelAtDistance(88, REF_DIST_M * 2);
  assert.equal(L1, 88);
  assert.ok(L1 - L2 > 6 && L1 - L2 < 7.5);
});

test('helicopter type codes are recognised even without a category', () => {
  assert.equal(referenceLevel({ type: 'EC35', category: '' }), referenceLevel({ category: 'A7' }));
});

test('sumDb adds energies', () => {
  assert.ok(Math.abs(sumDb([60, 60]) - 63.01) < 0.01);
});

test('empty sky is ROLL with an open-ended window', () => {
  const v = assess(predict([], { horizonSec: 600 }), { thresholdDbA: 45, takeSec: 120 });
  assert.equal(v.status, 'ROLL');
  assert.equal(v.windowSec, 600);
  assert.ok(v.windowOpenEnded);
});

test('jet directly overhead is HOLD', () => {
  const tracks = buildTracks([ac('OVR', 0, 0, { altFt: 2000 })], SET);
  const v = assess(predict(tracks), { thresholdDbA: 45 });
  assert.equal(v.status, 'HOLD');
  assert.equal(v.culprits[0].track.id, 'OVR');
});

test('inbound helicopter makes it STANDBY with a predicted clear time', () => {
  // 8 nm south, heading north at 100 kt => overhead in ~4.8 min
  const tracks = buildTracks([ac('HELI', 0, -8 * NM, { altFt: 1000, gsKt: 100, trackDeg: 0, category: 'A7' })], SET);
  const p = predict(tracks, { horizonSec: 900 });
  const v = assess(p, { thresholdDbA: 45, marginDb: 3, takeSec: 300 });
  assert.equal(v.status, 'STANDBY');
  assert.ok(v.clearInSec > 300, `clears after passing overhead, got ${v.clearInSec}`);
  const a = p.perAircraft[0];
  assert.ok(Math.abs(a.cpaT - 288) <= 5, `CPA ~288s, got ${a.cpaT}`);
});

test('same helicopter with a short take is ROLL now, with a finite window', () => {
  const tracks = buildTracks([ac('HELI', 0, -8 * NM, { altFt: 1000, gsKt: 100, trackDeg: 0, category: 'A7' })], SET);
  const v = assess(predict(tracks, { horizonSec: 900 }), { thresholdDbA: 45, takeSec: 30 });
  assert.equal(v.status, 'ROLL');
  assert.ok(v.windowSec > 30 && v.windowSec < 288);
  assert.equal(v.windowOpenEnded, false);
});

test('outbound aircraft far away does not block', () => {
  const tracks = buildTracks([ac('AWAY', 0, 12 * NM, { altFt: 8000, gsKt: 300, trackDeg: 0 })], SET);
  assert.equal(assess(predict(tracks), { thresholdDbA: 45 }).status, 'ROLL');
});

test('building attenuation can turn a HOLD into ROLL', () => {
  const tracks = buildTracks([ac('MID', 3 * NM, 0, { altFt: 6000, gsKt: 250, trackDeg: 90 })], SET);
  const out = assess(predict(tracks), { thresholdDbA: 45 });
  const inside = assess(predict(tracks, { attenuationDb: 30 }), { thresholdDbA: 45 });
  assert.notEqual(out.status, 'ROLL');
  assert.equal(inside.status, 'ROLL');
});

test('stale and ground aircraft are excluded by default', () => {
  const list = [
    { ...ac('OLD', 0, 0), seenSec: 300 },
    { ...ac('GND', 0, 0), onGround: true, altFt: 0 },
  ];
  assert.equal(buildTracks(list, SET).length, 0);
  assert.equal(buildTracks(list, SET, { includeGround: true }).length, 1);
});

test('report age is dead-reckoned forward', () => {
  const [t] = buildTracks([{ ...ac('MOV', 0, 0, { gsKt: 360, trackDeg: 90 }), seenSec: 10 }], SET);
  // 360 kt = 185.2 m/s east for 10 s
  assert.ok(Math.abs(t.x - 1852) < 2, `x=${t.x}`);
});
