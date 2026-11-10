import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aWeightDb, cWeightDb, bandLevel, RollingLeq, TimeWeighting, SPECTRUM_POWER_CORRECTION_DB } from '../public/js/dsp.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

test('A-weighting matches IEC 61672 table values', () => {
  close(aWeightDb(1000), 0, 0.05);
  close(aWeightDb(100), -19.1, 0.1);
  close(aWeightDb(63), -26.2, 0.1);
  close(aWeightDb(4000), 1.0, 0.1);
  close(aWeightDb(10 ** 1.5), -39.4, 0.1); // nominal 31.5 Hz band = 31.62 Hz exact
});

test('C-weighting matches IEC 61672 table values', () => {
  close(cWeightDb(1000), 0, 0.05);
  close(cWeightDb(31.5), -3.0, 0.1);
  close(cWeightDb(8000), -3.0, 0.1);
});

// Emulate AnalyserNode.getFloatFrequencyData: Blackman window, DFT, |X|/N in dB.
function analyserSpectrum(signal) {
  const N = signal.length;
  const out = new Float32Array(N / 2);
  const w = (n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N);
  for (let k = 0; k < N / 2; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const v = signal[n] * w(n);
      re += v * Math.cos((2 * Math.PI * k * n) / N);
      im -= v * Math.sin((2 * Math.PI * k * n) / N);
    }
    out[k] = 20 * Math.log10(Math.hypot(re, im) / N);
  }
  return out;
}

test('bandLevel recovers true RMS of a sine from an analyser-style spectrum', () => {
  const N = 1024, sr = 48000;
  for (const [amp, f] of [[1, 1000], [0.1, 437.3], [0.5, 5210]]) {
    const sig = Float32Array.from({ length: N }, (_, n) => amp * Math.sin((2 * Math.PI * f * n) / sr));
    const spec = analyserSpectrum(sig);
    const expected = 20 * Math.log10(amp / Math.SQRT2);
    close(bandLevel(spec, sr, N), expected, 0.25, `sine ${amp}@${f}Hz`);
  }
  close(SPECTRUM_POWER_CORRECTION_DB, 8.17, 0.01);
});

test('bandLevel restricts to the requested band', () => {
  const N = 1024, sr = 48000;
  const sig = Float32Array.from({ length: N }, (_, n) => Math.sin((2 * Math.PI * 3000 * n) / sr));
  const spec = analyserSpectrum(sig);
  assert.ok(bandLevel(spec, sr, N, 20, 1000) < -60);
  close(bandLevel(spec, sr, N, 1000, 6000), -3.01, 0.25);
});

test('RollingLeq averages energy, not decibels', () => {
  const leq = new RollingLeq(10);
  for (let t = 0; t < 5; t += 0.1) leq.push(60, t, 0.1);
  for (let t = 5; t < 10; t += 0.1) leq.push(80, t, 0.1);
  close(leq.db, 10 * Math.log10((1e6 + 1e8) / 2), 0.2); // ~77 dB, not 70
});

test('TimeWeighting converges to steady input', () => {
  const tw = new TimeWeighting(0.125);
  for (let i = 0; i < 200; i++) tw.push(70, 1 / 60);
  close(tw.db, 70, 0.01);
});
