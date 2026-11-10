import { PROVIDERS, buildUrl, parse } from './providers.js';
import { buildTracks, predict, assess } from './noise.js';
import { NM, compassPoint } from './geo.js';
import { TrafficSimulator } from './sim.js';
import { AudioAnalyzer, BANDS } from './audio.js';
import { drawRadar, drawTimeline, drawSpectrum, Spectrogram, spectrumFreqAt, levelColor } from './views.js';

// ------------------------------------------------------------------ settings

const DEFAULTS = {
  lat: 34.0522, // Los Angeles; replaced by "Use my location"
  lon: -118.2437,
  elevFt: 300,
  provider: 'adsblol',
  route: 'auto',
  radiusNm: 15,
  pollSec: 10,
  includeGround: false,
  thresholdDbA: 45,
  marginDb: 3,
  takeSec: 120,
  horizonMin: 10,
  attenuationDb: 0,
  deviceId: '',
  weighting: 'A',
  micLimit: 50,
  calOffset: 100,
};
const STORE_KEY = 'quiet-on-set:settings';

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch {
    /* private mode: settings just won't persist */
  }
}

const params = new URLSearchParams(location.search);
const S = loadSettings();
if (params.has('demo')) S.provider = 'demo';

// ------------------------------------------------------------------ state

const $ = (id) => document.getElementById(id);
const state = {
  aircraft: [],
  fetchedAt: 0,
  lastError: null,
  prediction: null,
  verdict: null,
  overall: null,
  sim: null,
  simLastT: 0,
  proxyWorks: null, // null = unknown
  selectedId: null,
  log: [],
  sound: { status: null, overSince: null },
};
const audio = new AudioAnalyzer();
const spectrogram = new Spectrogram($('spectrogram'));

// ------------------------------------------------------------------ flight data

async function fetchFlights() {
  if (S.provider === 'demo') {
    const set = { lat: S.lat, lon: S.lon };
    const now = performance.now() / 1000;
    if (!state.sim || state.sim.set.lat !== S.lat || state.sim.set.lon !== S.lon || state.sim.radiusNm !== S.radiusNm) {
      state.sim = new TrafficSimulator(set, { radiusNm: S.radiusNm });
      state.sim.radiusNm = S.radiusNm;
      state.simLastT = now;
    }
    state.sim.step(now - state.simLastT);
    state.simLastT = now;
    return state.sim.snapshot();
  }

  const tryProxy = S.route === 'proxy' || (S.route === 'auto' && state.proxyWorks !== false);
  if (tryProxy) {
    try {
      const q = new URLSearchParams({ provider: S.provider, lat: S.lat, lon: S.lon, radius: S.radiusNm });
      const res = await fetch(`api/flights?${q}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`proxy ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const json = await res.json();
      state.proxyWorks = true;
      return parse(S.provider, json);
    } catch (e) {
      if (S.route === 'proxy') throw e;
      // In auto mode, only fall back to direct when there is no proxy at all.
      if (state.proxyWorks === true) throw e;
      state.proxyWorks = false;
    }
  }
  const res = await fetch(buildUrl(S.provider, S.lat, S.lon, S.radiusNm), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${PROVIDERS[S.provider].label} returned HTTP ${res.status}`);
  return parse(S.provider, await res.json());
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    state.aircraft = await fetchFlights();
    state.fetchedAt = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message || String(e);
    console.warn('flight fetch failed', e);
  }
  updateFeed();
  evaluate();
  pollTimer = setTimeout(poll, Math.max(3, S.pollSec) * 1000);
}

function updateFeed() {
  const el = $('feed');
  el.classList.remove('ok', 'err', 'demo');
  if (S.provider === 'demo') {
    el.classList.add('demo');
    $('feedText').textContent = 'Demo mode — simulated traffic';
  } else if (state.lastError) {
    el.classList.add('err');
    const age = state.fetchedAt ? ` · last good ${fmtAgo(Date.now() - state.fetchedAt)}` : '';
    $('feedText').textContent = `${PROVIDERS[S.provider].label}: ${state.lastError}${age}`;
  } else if (state.fetchedAt) {
    el.classList.add('ok');
    const via = state.proxyWorks ? 'via proxy' : 'direct';
    $('feedText').textContent = `${PROVIDERS[S.provider].label} ${via} · updated ${fmtAgo(Date.now() - state.fetchedAt)}`;
  }
}

// ------------------------------------------------------------------ evaluation

function evaluate() {
  const stale = !state.fetchedAt || Date.now() - state.fetchedAt > Math.max(60, S.pollSec * 4) * 1000;
  const set = { lat: S.lat, lon: S.lon, elevFt: S.elevFt };
  const tracks = buildTracks(state.aircraft, set, {
    ageSec: state.fetchedAt ? (Date.now() - state.fetchedAt) / 1000 : 0,
    includeGround: S.includeGround,
  });
  // ignore aircraft that have drifted out of the search area since the last fetch
  const inRange = tracks.filter((t) => Math.hypot(t.x, t.y) <= S.radiusNm * NM * 1.15);
  const prediction = predict(inRange, { horizonSec: S.horizonMin * 60, stepSec: 5, attenuationDb: S.attenuationDb });
  const verdict = assess(prediction, { thresholdDbA: S.thresholdDbA, marginDb: S.marginDb, takeSec: S.takeSec });
  verdict.stale = stale && S.provider !== 'demo';
  state.prediction = prediction;
  state.verdict = verdict;
  renderVerdict();
  renderTable();
  renderRadar();
}

function soundStatus() {
  if (!audio.running) return null;
  return state.sound.status;
}

function renderVerdict() {
  const v = state.verdict;
  if (!v) return;
  const snd = soundStatus();
  let overall = v.status;
  if (v.stale) overall = 'STANDBY';
  if (snd === 'HOLD') overall = 'HOLD';

  let headline;
  let sub = '';
  const c = v.culprits[0];
  const describe = (a) => {
    const t = a.track;
    const name = t.callsign || t.reg || t.id.toUpperCase();
    const kind = t.heli ? 'helicopter' : t.type || 'aircraft';
    return `${name} (${kind}) ${fmtNm(a.horizM)} ${compassPoint(a.bearing)}, ${fmtFt(t.altFt)}`;
  };

  if (v.stale) {
    headline = 'Flight data is stale — check connection';
    sub = state.lastError || '';
  } else if (snd === 'HOLD' && v.status !== 'HOLD') {
    headline = `Set is loud: ${fmtDb(audio.fast.db)} ${S.weighting === 'Z' ? 'dBZ' : 'dB' + S.weighting} (limit ${S.micLimit})`;
    sub = v.status === 'ROLL' ? 'Sky is clear — noise is local to the set.' : `Sky: ${v.clearInSec == null ? 'busy' : 'clear in ' + fmtDur(v.clearInSec)}`;
  } else if (v.status === 'ROLL') {
    headline = v.windowOpenEnded ? `Clear for ${fmtDur(v.windowSec)}+` : `Clear for ${fmtDur(v.windowSec)}`;
    sub = c ? `Next: ${describe(c)} — peak ~${Math.round(c.peakDbA)} dBA in ${fmtDur(c.peakT)}` : `No aircraft predicted above ${v.limit} dBA in the next ${S.horizonMin} min.`;
  } else if (v.status === 'STANDBY') {
    headline = v.clearInSec == null ? `Not enough quiet for a ${fmtDur(S.takeSec)} take` : `Wait ${fmtDur(v.clearInSec)} for a ${fmtDur(S.takeSec)} window`;
    sub = c ? `${describe(c)} — peak ~${Math.round(c.peakDbA)} dBA in ${fmtDur(c.peakT)}` : '';
  } else {
    headline = v.clearInSec == null ? 'Aircraft overhead — no window in look-ahead' : `Aircraft overhead — clear in ${fmtDur(v.clearInSec)}`;
    sub = c ? `${describe(c)} — ~${Math.round(c.nowDbA)} dBA now` : '';
  }

  const banner = $('banner');
  banner.className = `banner ${overall.toLowerCase()}`;
  $('verdict').textContent = overall;
  $('headline').textContent = headline;
  $('subline').textContent = sub;

  const sky = $('skyPill');
  sky.className = `pill ${v.stale ? 'standby' : v.status.toLowerCase()}`;
  $('skyVal').textContent = v.stale ? 'stale' : `${v.status} · ${fmtDb(v.nowDbA)} dBA`;
  $('takeVal').textContent = fmtDur(S.takeSec);

  if (overall !== state.overall) {
    if (state.overall) addLog(overall, `${headline}${sub ? ' — ' + sub : ''}`);
    if (overall === 'HOLD' && state.overall && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    state.overall = overall;
  }
}

function renderTable() {
  const p = state.prediction;
  const body = $('acBody');
  const limit = state.verdict.limit;
  const rows = [...p.perAircraft].sort((a, b) => b.peakDbA - a.peakDbA);
  $('acCount').textContent = `${rows.length} tracked`;
  $('acEmpty').style.display = rows.length ? 'none' : '';
  const cls = (db) => (db >= limit ? 'hold' : db >= limit - 10 ? 'standby' : 'roll');
  body.replaceChildren(
    ...rows.map((a) => {
      const t = a.track;
      const tr = document.createElement('tr');
      if (t.id === state.selectedId) tr.className = 'sel';
      tr.dataset.id = t.id;
      const td = (text, className) => {
        const el = document.createElement('td');
        if (className) el.className = className;
        el.textContent = text;
        return el;
      };
      const flight = document.createElement('td');
      const cs = document.createElement('span');
      cs.className = 'cs';
      cs.textContent = t.callsign || t.reg || t.id.toUpperCase();
      const ty = document.createElement('span');
      ty.className = 'ty';
      ty.textContent = [t.heli ? 'HELI' : '', t.type, t.category].filter(Boolean).join(' · ') || '—';
      flight.append(cs, ty);
      tr.append(
        flight,
        td(fmtFt(t.altFt)),
        td(`${fmtNm(a.horizM)} ${compassPoint(a.bearing)}`),
        td(fmtLow(a.nowDbA), `db ${cls(a.nowDbA)}`),
        td(`${fmtLow(a.peakDbA)}${a.peakT > 0 ? ' @' + fmtDur(a.peakT) : ''}`, `db ${cls(a.peakDbA)}`),
        td(`${fmtNm(a.cpaM)}${a.cpaT > 0 ? ' @' + fmtDur(a.cpaT) : ''}`)
      );
      return tr;
    })
  );
}

function renderRadar() {
  if (!state.prediction) return;
  drawRadar($('radar'), {
    prediction: state.prediction,
    radiusNm: S.radiusNm,
    limit: state.verdict.limit,
    lookaheadSec: Math.min(S.horizonMin * 60, 180),
    selectedId: state.selectedId,
  });
  drawTimeline($('timeline'), {
    prediction: state.prediction,
    limit: state.verdict.limit,
    takeSec: S.takeSec,
    thresholdDbA: S.thresholdDbA,
  });
  $('radarMeta').textContent = `${S.lat.toFixed(4)}, ${S.lon.toFixed(4)} · ${S.radiusNm} nm`;
  $('tlMeta').textContent = `limit ${state.verdict.limit} dBA${S.attenuationDb ? ` (−${S.attenuationDb} dB building)` : ''} · next ${S.horizonMin} min`;
}

// ------------------------------------------------------------------ audio

function buildBands() {
  $('bands').replaceChildren(
    ...BANDS.map((b) => {
      const el = document.createElement('div');
      el.className = 'band';
      el.innerHTML = `<span>${b.label} <span class="muted">${fmtHz(b.lo)}–${fmtHz(b.hi)}</span></span><div class="bar"><i></i></div><b>--</b>`;
      el.dataset.key = b.key;
      return el;
    })
  );
}

function setMeterLabels() {
  const w = S.weighting;
  $('lafLabel').textContent = `L${w}F (fast)`;
  $('lasLabel').textContent = `L${w}S (slow)`;
  $('leqLabel').textContent = `L${w}eq 10s`;
  $('maxLabel').textContent = `L${w}Fmax`;
}

let lastSpecDraw = 0;
function audioLoop(ts) {
  requestAnimationFrame(audioLoop);
  if (!audio.running) return;
  const f = audio.frame(ts / 1000);
  if (!f) return;

  // sound gate: hold if slow level is over the limit for more than 0.5 s
  const over = f.slow >= S.micLimit;
  const now = ts / 1000;
  if (over) {
    state.sound.overSince ??= now;
    if (now - state.sound.overSince > 0.5) state.sound.status = 'HOLD';
  } else {
    state.sound.overSince = null;
    state.sound.status = f.slow >= S.micLimit - 6 ? 'STANDBY' : 'ROLL';
  }

  if (ts - lastSpecDraw > 33) {
    lastSpecDraw = ts;
    drawSpectrum($('spectrum'), {
      display: audio.display,
      peak: audio.peak,
      sampleRate: f.sampleRate,
      fftSize: f.fftSize,
    });
    spectrogram.push({ display: audio.display, sampleRate: f.sampleRate, fftSize: f.fftSize });
    $('laf').textContent = fmtDb(f.fast);
    $('las').textContent = fmtDb(f.slow);
    $('leq').textContent = fmtDb(f.leq);
    $('lmax').textContent = fmtDb(f.max);
    $('laf').parentElement.classList.toggle('over', f.fast >= S.micLimit);
    $('las').parentElement.classList.toggle('over', f.slow >= S.micLimit);
    for (const el of $('bands').children) {
      const db = f.bands[el.dataset.key];
      el.querySelector('b').textContent = `${fmtDb(db)} dB`;
      el.querySelector('i').style.width = `${Math.max(0, Math.min(100, ((db - 10) / 90) * 100))}%`;
    }
    const sp = $('soundPill');
    sp.className = `pill ${state.sound.status.toLowerCase()}`;
    $('soundVal').textContent = `${fmtDb(f.slow)} dB${S.weighting}`;
  }
}

async function toggleMic() {
  const btn = $('micBtn');
  if (audio.running) {
    await audio.stop();
    btn.textContent = '🎙 Start mic';
    btn.classList.remove('on');
    $('soundPill').className = 'pill';
    $('soundVal').textContent = 'mic off';
    state.sound.status = null;
    renderVerdict();
    return;
  }
  try {
    audio.calOffset = S.calOffset;
    audio.weighting = S.weighting;
    const label = await audio.start(S.deviceId || undefined);
    btn.textContent = '■ Stop mic';
    btn.classList.add('on');
    $('micNote').textContent = `Listening on: ${label}. Voice processing (AGC, noise suppression, echo cancel) disabled.`;
    addLog('INFO', `Mic started: ${label}`);
    populateDevices();
    requestWakeLock();
  } catch (e) {
    $('micNote').textContent = `Microphone unavailable: ${e.message}`;
    addLog('INFO', `Mic failed: ${e.message}`);
  }
}

async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('deviceSelect');
  sel.replaceChildren(new Option('Default', ''), ...devs.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  sel.value = S.deviceId;
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or denied */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock?.released) requestWakeLock();
});

// ------------------------------------------------------------------ log

function addLog(status, msg) {
  const entry = { t: new Date(), status, msg };
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, 500);
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = entry.t.toLocaleTimeString();
  const tag = document.createElement('span');
  tag.className = `tag ${status.toLowerCase()}`;
  tag.textContent = status;
  const m = document.createElement('span');
  m.textContent = msg;
  li.append(time, tag, m);
  $('log').prepend(li);
  while ($('log').children.length > 200) $('log').lastChild.remove();
}

function exportLog() {
  const esc = (s) => `"${String(s).replaceAll('"', '""')}"`;
  const csv = ['time,status,detail', ...[...state.log].reverse().map((e) => [e.t.toISOString(), e.status, esc(e.msg)].join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `quiet-on-set-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ settings dialog

const NUMERIC = ['lat', 'lon', 'elevFt', 'radiusNm', 'pollSec', 'thresholdDbA', 'marginDb', 'takeSec', 'horizonMin', 'attenuationDb', 'micLimit', 'calOffset'];

function openSettings() {
  const f = $('settingsForm');
  for (const [k, v] of Object.entries(S)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  populateDevices();
  $('settings').showModal();
}

function applySettings() {
  const f = $('settingsForm');
  const prev = { ...S };
  for (const k of Object.keys(DEFAULTS)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (NUMERIC.includes(k)) {
      const n = parseFloat(el.value);
      if (Number.isFinite(n)) S[k] = n;
    } else S[k] = el.value;
  }
  S.radiusNm = Math.max(2, Math.min(60, S.radiusNm));
  S.horizonMin = Math.max(2, Math.min(30, S.horizonMin));
  S.takeSec = Math.max(10, Math.min(S.horizonMin * 60, S.takeSec));
  saveSettings();
  audio.calOffset = S.calOffset;
  audio.setWeighting(S.weighting);
  setMeterLabels();
  if (prev.route !== S.route) state.proxyWorks = null;
  if (audio.running && prev.deviceId !== S.deviceId) toggleMic().then(toggleMic);
  addLog('INFO', 'Settings updated');
  const refetch = ['lat', 'lon', 'provider', 'route', 'radiusNm', 'pollSec'].some((k) => prev[k] !== S[k]);
  if (refetch) {
    state.aircraft = [];
    state.fetchedAt = 0;
    poll();
  } else evaluate();
}

$('settingsForm').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') applySettings();
});
$('settingsBtn').addEventListener('click', openSettings);
$('micBtn').addEventListener('click', toggleMic);
$('resetMax').addEventListener('click', () => audio.resetMax());
$('exportLog').addEventListener('click', exportLog);
$('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation is not available in this browser.');
  $('locateBtn').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const f = $('settingsForm');
      f.elements.lat.value = pos.coords.latitude.toFixed(5);
      f.elements.lon.value = pos.coords.longitude.toFixed(5);
      if (pos.coords.altitude != null) f.elements.elevFt.value = Math.round(pos.coords.altitude / 0.3048);
      $('locateBtn').textContent = '📍 Use my location';
    },
    (err) => {
      $('locateBtn').textContent = '📍 Use my location';
      alert(`Could not get location: ${err.message}`);
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});
$('calBtn').addEventListener('click', () => {
  const ref = parseFloat($('calRef').value);
  if (!audio.running) return alert('Start the mic first, then hold it next to your sound level meter.');
  if (!Number.isFinite(ref)) return alert('Enter the reading from your reference sound level meter.');
  // the slow reading already includes the active offset; strip it, then solve for the new one
  const raw = audio.slow.db - audio.calOffset;
  if (!Number.isFinite(raw)) return alert('No signal from the microphone yet.');
  $('settingsForm').elements.calOffset.value = (ref - raw).toFixed(1);
});

$('acBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  state.selectedId = state.selectedId === tr.dataset.id ? null : tr.dataset.id;
  renderTable();
  renderRadar();
});

$('spectrum').addEventListener('mousemove', (e) => {
  const f = spectrumFreqAt($('spectrum'), e.clientX);
  if (!f || !audio.running) return ($('hoverFreq').textContent = '');
  const k = Math.round((f * audio.fftSize) / audio.sampleRate);
  $('hoverFreq').textContent = `${fmtHz(f)} · ${fmtDb(audio.display[k])} dB`;
});
$('spectrum').addEventListener('mouseleave', () => ($('hoverFreq').textContent = ''));

window.addEventListener('resize', () => {
  renderRadar();
  if (!audio.running) drawSpectrum($('spectrum'), {});
});

// ------------------------------------------------------------------ formatting

function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtAgo(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}
const fmtNm = (m) => `${(m / NM).toFixed(m < 10 * NM ? 1 : 0)} nm`;
const fmtFt = (ft) => (ft == null ? '—' : ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(Math.round(ft / 100) * 100).toLocaleString()} ft`);
const fmtLow = (db) => (db < 20 ? '<20' : `${Math.round(db)}`);
const fmtDb = (db) => (Number.isFinite(db) ? db.toFixed(1) : '--.-');
const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

// expose for debugging in the console
window.quietOnSet = { state, settings: S, audio, levelColor };

// ------------------------------------------------------------------ boot

buildBands();
setMeterLabels();
drawSpectrum($('spectrum'), {});
addLog('INFO', `Monitoring ${S.radiusNm} nm around ${S.lat.toFixed(4)}, ${S.lon.toFixed(4)} via ${S.provider === 'demo' ? 'demo traffic' : PROVIDERS[S.provider].label}`);
poll();
setInterval(() => {
  updateFeed();
  if (state.fetchedAt) evaluate();
}, 1000);
requestAnimationFrame(audioLoop);
let firstRun = false;
try {
  firstRun = !localStorage.getItem(STORE_KEY);
} catch {
  /* storage blocked */
}
if (firstRun && !params.has('demo')) openSettings();
