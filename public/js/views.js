// Canvas renderers: radar scope, spectrum analyzer, spectrogram, prediction strip.

import { NM } from './geo.js';
import { logPos, logFreq } from './dsp.js';
import { project } from './geo.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

export function levelColor(db, limit) {
  if (db >= limit) return css('--hold');
  if (db >= limit - 10) return css('--standby');
  return css('--roll');
}

// ---------------------------------------------------------------- radar

export function drawRadar(canvas, { prediction, radiusNm, limit, lookaheadSec, selectedId }) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 18 * dpr;
  const scale = R / (radiusNm * NM);
  const grid = css('--grid');
  const text = css('--muted');

  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;

  // rings
  const rings = niceRings(radiusNm);
  for (const nm of rings) {
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.arc(cx, cy, nm * NM * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.fillText(`${nm} nm`, cx + 4 * dpr, cy - nm * NM * scale + 12 * dpr);
  }
  // crosshair + compass
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy - R - 5 * dpr);
  ctx.fillText('S', cx, cy + R + 13 * dpr);
  ctx.textAlign = 'left';
  ctx.fillText('E', cx + R + 4 * dpr, cy + 4 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText('W', cx - R - 4 * dpr, cy + 4 * dpr);
  ctx.textAlign = 'left';

  // set marker
  ctx.fillStyle = css('--accent');
  ctx.beginPath();
  ctx.arc(cx, cy, 4 * dpr, 0, Math.PI * 2);
  ctx.fill();

  if (!prediction) return;
  const toScreen = (p) => [cx + p.x * scale, cy - p.y * scale];

  for (const a of prediction.perAircraft) {
    const tr = a.track;
    const col = levelColor(a.peakDbA, limit);
    const [sx, sy] = toScreen(tr);
    // projected path
    const fut = project(tr, lookaheadSec);
    const [fx, fy] = toScreen(fut);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(fx, fy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // aircraft glyph
    const ang = (tr.trackDeg * Math.PI) / 180;
    const s = (a.track.heli ? 6 : 7) * dpr;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = col;
    if (a.track.heli) {
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(ang);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(-s * 1.4, 0);
      ctx.lineTo(s * 1.4, 0);
      ctx.moveTo(0, -s * 1.4);
      ctx.lineTo(0, s * 1.4);
      ctx.stroke();
    } else {
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.3);
      ctx.lineTo(s * 0.8, s);
      ctx.lineTo(0, s * 0.45);
      ctx.lineTo(-s * 0.8, s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (tr.id === selectedId) {
      ctx.strokeStyle = css('--fg');
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(sx, sy, 13 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1 * dpr;
    }
    // label
    ctx.fillStyle = css('--fg');
    const label = tr.callsign || tr.id.toUpperCase();
    ctx.fillText(label, sx + 10 * dpr, sy - 2 * dpr);
    ctx.fillStyle = text;
    ctx.fillText(`${Math.round((tr.altFt ?? 0) / 100) * 100}ft ${a.nowDbA < 20 ? '<20' : Math.round(a.nowDbA)}dB`, sx + 10 * dpr, sy + 10 * dpr);
  }
}

function niceRings(radiusNm) {
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50];
  const step = steps.find((s) => radiusNm / s <= 4) ?? 50;
  const out = [];
  for (let r = step; r <= radiusNm + 1e-9; r += step) out.push(+r.toFixed(2));
  return out;
}

// ---------------------------------------------------------------- prediction strip

export function drawTimeline(canvas, { prediction, limit, takeSec, thresholdDbA }) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!prediction) return;
  const { times, totalDbA, horizonSec } = prediction;
  const pad = { l: 34 * dpr, r: 8 * dpr, t: 8 * dpr, b: 18 * dpr };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const dbMin = 20;
  const dbMax = Math.max(90, thresholdDbA + 20);
  const X = (t) => pad.l + (t / horizonSec) * pw;
  const Y = (db) => pad.t + ph * (1 - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin));

  ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = css('--muted');
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1 * dpr;
  for (let db = 30; db <= dbMax; db += 20) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(db));
    ctx.lineTo(w - pad.r, Y(db));
    ctx.stroke();
    ctx.fillText(`${db}`, 4 * dpr, Y(db) + 3 * dpr);
  }
  for (let t = 0; t <= horizonSec; t += 60) {
    ctx.fillText(`${t / 60}m`, X(t) - 6 * dpr, h - 4 * dpr);
  }

  // take-length bracket
  ctx.fillStyle = css('--accent');
  ctx.globalAlpha = 0.12;
  ctx.fillRect(X(0), pad.t, X(takeSec) - X(0), ph);
  ctx.globalAlpha = 1;

  // filled level curve, coloured per segment
  for (let i = 0; i < times.length - 1; i++) {
    const db = Math.max(totalDbA[i], totalDbA[i + 1]);
    ctx.fillStyle = levelColor(db, limit);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(X(times[i]), Y(dbMin));
    ctx.lineTo(X(times[i]), Y(totalDbA[i]));
    ctx.lineTo(X(times[i + 1]), Y(totalDbA[i + 1]));
    ctx.lineTo(X(times[i + 1]), Y(dbMin));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // limit line
  ctx.strokeStyle = css('--hold');
  ctx.setLineDash([5 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(pad.l, Y(limit));
  ctx.lineTo(w - pad.r, Y(limit));
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------- spectrum

const F_MIN = 20;
const F_MAX = 20000;

export function drawSpectrum(canvas, { display, peak, sampleRate, fftSize, dbMin = 0, dbMax = 110, weights, showWeighted }) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const pad = { l: 34 * dpr, r: 6 * dpr, t: 6 * dpr, b: 18 * dpr };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const X = (f) => pad.l + logPos(f, F_MIN, F_MAX) * pw;
  const Y = (db) => pad.t + ph * (1 - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin));

  ctx.clearRect(0, 0, w, h);
  ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--muted');
  for (const f of [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
    ctx.beginPath();
    ctx.moveTo(X(f), pad.t);
    ctx.lineTo(X(f), pad.t + ph);
    ctx.stroke();
    const lbl = f >= 1000 ? `${f / 1000}k` : `${f}`;
    ctx.fillText(lbl, X(f) - 8 * dpr, h - 4 * dpr);
  }
  for (let db = dbMin; db <= dbMax; db += 20) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(db));
    ctx.lineTo(w - pad.r, Y(db));
    ctx.stroke();
    ctx.fillText(`${db}`, 4 * dpr, Y(db) + 3 * dpr);
  }
  if (!display) return;

  const binHz = sampleRate / fftSize;
  const n = display.length;
  // one point per pixel column, taking the max of bins that fall in it
  const path = (arr) => {
    ctx.beginPath();
    let started = false;
    for (let px = 0; px <= pw; px += 1 * dpr) {
      const f0 = logFreq(px / pw, F_MIN, F_MAX);
      const f1 = logFreq((px + dpr) / pw, F_MIN, F_MAX);
      const k0 = Math.max(1, Math.floor(f0 / binHz));
      const k1 = Math.min(n - 1, Math.max(k0, Math.floor(f1 / binHz)));
      let v = -Infinity;
      for (let k = k0; k <= k1; k++) {
        const val = arr[k] + (showWeighted && weights ? weights[k] : 0);
        if (val > v) v = val;
      }
      const y = Y(v);
      if (!started) {
        ctx.moveTo(pad.l + px, y);
        started = true;
      } else ctx.lineTo(pad.l + px, y);
    }
  };

  // fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  grad.addColorStop(0, css('--hold'));
  grad.addColorStop(0.45, css('--standby'));
  grad.addColorStop(1, css('--roll'));
  path(display);
  ctx.lineTo(pad.l + pw, pad.t + ph);
  ctx.lineTo(pad.l, pad.t + ph);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  path(display);
  ctx.strokeStyle = css('--fg');
  ctx.lineWidth = 1.25 * dpr;
  ctx.stroke();
  if (peak) {
    path(peak);
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 1 * dpr;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** Pixel x position -> frequency, for hover readout. */
export function spectrumFreqAt(canvas, clientX) {
  const r = canvas.getBoundingClientRect();
  const pw = r.width - 34 - 6;
  const pos = (clientX - r.left - 34) / pw;
  if (pos < 0 || pos > 1) return null;
  return logFreq(pos, F_MIN, F_MAX);
}

export class Spectrogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.col = 0;
  }
  push({ display, sampleRate, fftSize, dbMin = 10, dbMax = 100 }) {
    const { w, h } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    // scroll left by 1px
    ctx.drawImage(this.canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
    const img = ctx.createImageData(1, h);
    const binHz = sampleRate / fftSize;
    for (let y = 0; y < h; y++) {
      const f = logFreq(1 - y / h, F_MIN, F_MAX);
      const f1 = logFreq(1 - (y + 1) / h, F_MIN, F_MAX);
      const k0 = Math.max(1, Math.floor(f1 / binHz));
      const k1 = Math.max(k0, Math.floor(f / binHz));
      let v = -Infinity;
      for (let k = k0; k <= k1 && k < display.length; k++) if (display[k] > v) v = display[k];
      const t = Math.max(0, Math.min(1, (v - dbMin) / (dbMax - dbMin)));
      const [r, g, b] = heat(t);
      const i = y * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, w - 1, 0);
  }
}

// perceptual-ish dark->blue->magenta->orange->yellow map
function heat(t) {
  const stops = [
    [0, [8, 10, 20]],
    [0.25, [30, 40, 120]],
    [0.5, [150, 40, 140]],
    [0.75, [240, 110, 40]],
    [1, [255, 240, 150]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const u = (t - t0) / (t1 - t0);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * u));
    }
  }
  return stops[stops.length - 1][1];
}
