// Pure DSP helpers for the spectrum analyzer / sound level meter.

/** IEC 61672 A-weighting gain in dB at frequency f (Hz). */
export function aWeightDb(f) {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const ra =
    (12194 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

/** IEC 61672 C-weighting gain in dB at frequency f (Hz). */
export function cWeightDb(f) {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const rc = (12194 ** 2 * f2) / ((f2 + 20.6 ** 2) * (f2 + 12194 ** 2));
  return 20 * Math.log10(rc) + 0.06;
}

export function weightingTable(kind, binCount, sampleRate, fftSize) {
  const t = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) {
    const f = (k * sampleRate) / fftSize;
    t[k] = kind === 'A' ? aWeightDb(f) : kind === 'C' ? cWeightDb(f) : 0;
  }
  return t;
}

// Web Audio's AnalyserNode applies a Blackman window (a0=.42 a1=.5 a2=.08) and
// scales the FFT by 1/N. Summing |X[k]|^2 over the positive bins therefore
// recovers (sum w^2 / N) / 2 of the signal's mean-square value. This constant
// undoes that so the summed spectrum reads as true RMS in dBFS.
const BLACKMAN_MEAN_SQ = 0.42 ** 2 + 0.5 ** 2 / 2 + 0.08 ** 2 / 2; // 0.3046
export const SPECTRUM_POWER_CORRECTION_DB = 10 * Math.log10(2 / BLACKMAN_MEAN_SQ); // ~ +8.17 dB

/**
 * Integrate an AnalyserNode dB spectrum into a band level (dB RMS re full scale).
 * freqDb: Float32Array from getFloatFrequencyData
 * weights: optional Float32Array weighting gains (dB) per bin
 */
export function bandLevel(freqDb, sampleRate, fftSize, fLo = 0, fHi = Infinity, weights = null) {
  const binHz = sampleRate / fftSize;
  const k0 = Math.max(1, Math.ceil(fLo / binHz)); // skip DC
  const k1 = Math.min(freqDb.length - 1, Math.floor(fHi / binHz));
  let p = 0;
  for (let k = k0; k <= k1; k++) {
    const db = freqDb[k] + (weights ? weights[k] : 0);
    if (db > -200) p += 10 ** (db / 10);
  }
  return p > 0 ? 10 * Math.log10(p) + SPECTRUM_POWER_CORRECTION_DB : -Infinity;
}

/** Map frequency to [0,1] on a log axis between fMin and fMax. */
export const logPos = (f, fMin, fMax) => Math.log(f / fMin) / Math.log(fMax / fMin);
export const logFreq = (pos, fMin, fMax) => fMin * (fMax / fMin) ** pos;

/** Exponential time weighting ("Fast" = 0.125 s, "Slow" = 1 s) on power. */
export class TimeWeighting {
  constructor(tau) {
    this.tau = tau;
    this.p = 0;
  }
  push(db, dt) {
    const p = Number.isFinite(db) ? 10 ** (db / 10) : 0;
    const a = 1 - Math.exp(-dt / this.tau);
    this.p += a * (p - this.p);
    return this.db;
  }
  get db() {
    return this.p > 0 ? 10 * Math.log10(this.p) : -Infinity;
  }
}

/** Rolling equivalent continuous level (Leq) over a window of seconds. */
export class RollingLeq {
  constructor(windowSec) {
    this.windowSec = windowSec;
    this.items = []; // [t, power, dt]
    this.sumE = 0;
    this.sumT = 0;
  }
  push(db, t, dt) {
    const p = Number.isFinite(db) ? 10 ** (db / 10) : 0;
    this.items.push([t, p, dt]);
    this.sumE += p * dt;
    this.sumT += dt;
    while (this.items.length && this.items[0][0] < t - this.windowSec) {
      const [, op, odt] = this.items.shift();
      this.sumE -= op * odt;
      this.sumT -= odt;
    }
    return this.db;
  }
  get db() {
    return this.sumT > 0 && this.sumE > 0 ? 10 * Math.log10(this.sumE / this.sumT) : -Infinity;
  }
}
