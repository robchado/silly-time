// Microphone capture + FFT analysis via the Web Audio API.

import { weightingTable, bandLevel, TimeWeighting, RollingLeq } from './dsp.js';

export const BANDS = [
  { key: 'rumble', label: 'Rumble', lo: 20, hi: 200 }, // aircraft, traffic, HVAC, generators
  { key: 'low', label: 'Low-mid', lo: 200, hi: 1000 }, // engines, voices' fundamentals
  { key: 'mid', label: 'Mid', lo: 1000, hi: 4000 }, // speech intelligibility, birds
  { key: 'high', label: 'High', lo: 4000, hi: 20000 }, // hiss, sirens' harmonics, insects
];

export class AudioAnalyzer {
  constructor({ fftSize = 8192 } = {}) {
    this.fftSize = fftSize;
    this.ctx = null;
    this.running = false;
    this.calOffset = 100; // dB SPL = dBFS + calOffset
    this.weighting = 'A';
    this.fast = new TimeWeighting(0.125);
    this.slow = new TimeWeighting(1.0);
    this.leq = new RollingLeq(10);
    this.max = -Infinity;
    this.lastT = null;
    this.bandMeters = Object.fromEntries(BANDS.map((b) => [b.key, new TimeWeighting(0.125)]));
  }

  async start(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs HTTPS (or localhost) and a modern browser.');
    }
    // Disable all voice processing: we want the raw room, not a phone call.
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0; // raw frames; we do our own time weighting
    this.analyser.minDecibels = -140;
    this.analyser.maxDecibels = 0;
    this.source.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.display = new Float32Array(this.analyser.frequencyBinCount).fill(-140);
    this.peak = new Float32Array(this.analyser.frequencyBinCount).fill(-140);
    this.setWeighting(this.weighting);
    this.running = true;
    this.lastT = null;
    this.resetMax();
    return this.stream.getAudioTracks()[0]?.label ?? 'Microphone';
  }

  async stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  setWeighting(w) {
    this.weighting = w;
    if (this.analyser) {
      this.weights = weightingTable(w, this.analyser.frequencyBinCount, this.sampleRate, this.fftSize);
    }
  }

  resetMax() {
    this.max = -Infinity;
    this.peak?.fill(-140);
  }

  /** Pull one analysis frame. Returns null if not running. */
  frame(nowSec) {
    if (!this.running) return null;
    const dt = this.lastT == null ? 1 / 60 : Math.min(0.5, nowSec - this.lastT);
    this.lastT = nowSec;
    this.analyser.getFloatFrequencyData(this.freq);
    const sr = this.sampleRate;
    const n = this.fftSize;
    const cal = this.calOffset;

    // display smoothing + peak hold (in calibrated dB per bin)
    const decay = 30 * dt; // peak falls 30 dB/s
    for (let k = 0; k < this.freq.length; k++) {
      const v = (Number.isFinite(this.freq[k]) ? this.freq[k] : -140) + cal;
      this.display[k] = v > this.display[k] ? v : this.display[k] * 0.8 + v * 0.2;
      this.peak[k] = Math.max(v, this.peak[k] - decay);
    }

    const inst = bandLevel(this.freq, sr, n, 20, 20000, this.weights) + cal;
    const fast = this.fast.push(inst, dt);
    const slow = this.slow.push(inst, dt);
    const leq = this.leq.push(inst, nowSec, dt);
    if (fast > this.max) this.max = fast;

    const bands = {};
    for (const b of BANDS) {
      const lvl = bandLevel(this.freq, sr, n, b.lo, Math.min(b.hi, sr / 2), null) + cal;
      bands[b.key] = this.bandMeters[b.key].push(lvl, dt); // fast-weighted, like the main meter
    }

    return { dt, inst, fast, slow, leq, max: this.max, bands, sampleRate: sr, fftSize: n };
  }
}
