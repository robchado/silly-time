# Quiet on Set

A browser app for film sound departments and ADs. It answers one question: **can we roll right now, and if not, when?**

It does this two ways:

1. **Sky.** It pulls live ADS-B aircraft positions around your set, projects each track forward, estimates how loud each aircraft will be at your location, and finds the next quiet window long enough for your take.
2. **Ground.** It runs a live **spectrum analyzer and sound level meter** on the device microphone: A/C/Z-weighted fast and slow levels, a 10 s Leq, max hold, octave-ish band meters, and a scrolling spectrogram.

The banner combines both into a single call: **ROLL**, **STANDBY** (an aircraft will cut into the take; it shows how long to wait), or **HOLD** (an aircraft is loud now, or the set itself is over your limit).

## Quick start

```bash
npm start            # http://localhost:8080  (Node 18+, no dependencies)
```

- `http://localhost:8080/?demo` runs with **simulated traffic**. Use it to rehearse or demo without a network connection.
- On first launch, open **Settings → 📍 Use my location**, or enter the set's coordinates and ground elevation.
- Press **🎙 Start mic**. Browsers only allow the microphone on `https://` or `localhost`. To use phones on set, put the server behind HTTPS (for example a reverse proxy, a tunnel, or any static host).

### Hosted on GitHub Pages

Each push to the default branch runs the tests and publishes `public/` to GitHub Pages (`.github/workflows/pages.yml`). Pages serves over HTTPS, so the microphone works on phones; open the link and use **Add to Home Screen**. Without the server, the app fetches flight data directly from the browser. If a provider rejects those requests, pick a different one in Settings.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

`npm test` runs the unit tests (noise model, roll logic, data parsing, DSP and calibration math, and the proxy).

## Flight data sources

| Source | Notes |
| --- | --- |
| **adsb.lol** (default) | Free, open, community-fed ADS-B. No key needed. |
| airplanes.live | Same readsb format. |
| adsb.fi | Same readsb format. |
| OpenSky Network | Anonymous access is rate-limited. |
| Demo | Simulated traffic, including helicopters. |

**Route:** with `npm start`, requests go through the built-in proxy at `/api/flights`. That avoids CORS problems, and a 4 s cache lets several devices on set share one upstream request. If the page is hosted statically with no server, it falls back to calling the provider directly from the browser.

## How "safe to roll" is decided

For every aircraft reported within the search radius (default 15 nm):

1. The position is dead-reckoned to *now* from the report's age, then projected forward along its track, ground speed and vertical rate over the look-ahead window (default 10 min) in 5 s steps.
2. Its A-weighted level at the set is estimated from a reference level at 1000 ft for its ADS-B category (light, small, large, heavy, rotorcraft…). The model applies −6 dB per doubling of slant distance plus about 2.5 dB/km of air absorption, adds +3 dB when the aircraft is climbing and subtracts 2 dB when it is descending. Helicopters are recognised by category or ICAO type code.
3. Levels from all aircraft are summed by energy, and the optional **building attenuation** is subtracted for interior stages.
4. Every time step is compared against **limit − safety margin** (default 45 − 3 = 42 dBA):
   - **HOLD**: over the limit now.
   - **STANDBY**: quiet now, but there isn't a full take length of quiet ahead. The banner shows when the next window opens.
   - **ROLL**: quiet for at least the take length. The banner shows how long the window lasts.

The microphone gate puts the set on **HOLD** whenever the slow-weighted level stays over your on-set limit for more than half a second.

> ⚠️ The aircraft noise model is a deliberately simple, conservative estimate, not a certified noise model. It can't predict aircraft that turn or haven't entered the search radius yet, and some aircraft don't broadcast ADS-B. Use it as an early warning and treat your ears and the mic as the final word.

## Calibrating the meter

Phone and laptop mics differ by ±10 dB or more. For readings in dB SPL you can trust, place the device next to a reference sound level meter in a steady noise. Enter the meter's reading under **Settings → Microphone → Calibrate**, press **Match current reading**, then **Save**. The app disables AGC, noise suppression and echo cancellation on the input. USB measurement mics such as the miniDSP UMIK-1 work well and can be picked from the input device list.

## Layout

```
server.js               static server + /api/flights proxy (zero dependencies)
public/index.html       UI
public/js/app.js        controller: polling, evaluation, rendering, settings
public/js/providers.js  ADS-B provider URLs + response normalisation
public/js/noise.js      aircraft noise prediction + ROLL/STANDBY/HOLD logic
public/js/geo.js        local geometry and dead reckoning
public/js/audio.js      microphone capture + FFT analysis (Web Audio)
public/js/dsp.js        A/C weighting, band integration, Leq, time weighting
public/js/views.js      radar, prediction strip, spectrum, spectrogram
public/js/sim.js        simulated traffic for demo mode
test/                   node:test unit tests
```
