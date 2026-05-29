# Stoat Voice — AEC Test Methodology

**Bead:** Voice/G1. Companion to [target-architecture.md](target-architecture.md).
Defines a repeatable procedure for measuring acoustic echo cancellation in the
Stoat voice pipeline across the four configurations that matter for the A2
restructure.

The goal is to answer two questions before A2 ships:

1. Does AEC3 (Chrome's getUserMedia `echoCancellation: true`) actually work in
   Stoat's deployment, on real desktop hardware, with speakers?
2. Does running AEC3 *together with* DF3 produce static (the prod-era concern
   that motivated the "EC off when NS on" rule)?

If both answers are favourable, A2 can ship with EC unconditionally on. If
either answer is "no," A2 needs a fallback story: either keep the conditional
EC-off, find a different AEC, or accept that speaker users will transmit echo
when DF3 is enabled.

---

## Metric: ERLE (Echo Return Loss Enhancement)

ERLE compares the energy of the input mic signal to the energy of the
post-AEC mic signal during periods when the speaker is playing audio and the
user is silent. Measured in dB; higher = more echo suppression.

```
ERLE(dB) = 10 * log10( mean(input^2) / mean(output^2) )
```

Reference baselines (industry expectations on the test signal below):

| Configuration                              | Expected ERLE       |
|--------------------------------------------|---------------------|
| Headphones (no echo path)                  | N/A — no echo to suppress |
| Speakers, AEC off                          | 0 dB ± 2 dB        |
| Speakers, AEC3 on                          | 25–40 dB           |
| Speakers, AEC3 on, far-end double-talk      | 15–25 dB (degrades during double-talk) |

Below 15 dB on the AEC-on configurations indicates AEC3 is failing or only
partially working (alignment lost, reference signal not reaching the AEC).

---

## Test signal

A 30-second composite stimulus:

- **0–10 s**: Pink noise at −20 dBFS — broadband stationary signal, easy for
  AEC alignment, exposes baseline echo suppression.
- **10–20 s**: Speech sample (any 10-s clip of a single voice, e.g. an EBU
  SQAM track) at −18 dBFS — non-stationary, real-world.
- **20–30 s**: Logarithmic sweep 100 Hz → 8 kHz, −20 dBFS — exposes
  frequency-dependent residuals; AEC3 is known to underperform on
  near-tonal sweeps.

Generate once; reuse across runs. Save under `docs/voice/aec-test-stimulus.wav`
(not committed — generate locally with the script below).

```bash
# Generate stimulus.wav using sox (or equivalent). Document for reference;
# adjust paths/levels as needed.
sox -n -r 48000 -c 1 stim_pink.wav synth 10 pinknoise vol -20dB
sox path/to/speech.wav stim_speech.wav trim 0 10 gain -h vol -18dB
sox -n -r 48000 -c 1 stim_sweep.wav synth 10 sine 100/8000 vol -20dB
sox stim_pink.wav stim_speech.wav stim_sweep.wav aec-test-stimulus.wav
```

---

## Test rig

Required hardware:

- **Speakers** — built-in laptop speakers OR a desktop pair within 0.5–1.5 m
  of the mic. Document position in the run log.
- **Microphone** — whatever the user normally uses; document model.
- A second machine (or Audacity instance on the same machine using a
  loopback device) capable of recording the post-AEC mic signal that Stoat
  publishes to LiveKit.

Required software:

- Stoat dev branch with debug capture enabled (`/d/StoatData/stoat-web-dev`).
  Needs `state.voice.debugCaptureEnabled = true` and a build that includes
  `isDebugCaptureBuild() === true`.
- The debug capture bundle is dumped to disk; `01_raw_mic.wav` is pre-AEC
  mic input as Stoat sees it (after browser AEC has already run, since AEC
  is a getUserMedia constraint applied upstream of our AudioContext graph).

> **Important methodological note:** Chrome's AEC3 runs *inside* getUserMedia,
> which means `01_raw_mic.wav` is already post-AEC. To measure ERLE we need
> a *pre-AEC* reference. Two options:
>
> 1. Record on a second machine the speaker output verbatim (or capture
>    the audio file we're playing — same thing).
> 2. Run Stoat once with AEC off (debug-only build flag — not currently
>    exposed; see "Open work" below).
>
> Option 1 is simpler and works today: the stimulus file IS the reference.
> ERLE is computed against the stimulus file, not against `01_raw_mic.wav`.

---

## Procedure

For each of the four configurations below, run the following steps:

1. **Configure** the Stoat client per the configuration row (settings are
   in User Settings → Voice Processing).
2. **Join** a 1:1 voice channel with a second client (the second client's
   only role is to consume the published audio so the LiveKit Room is
   active and AEC has a "remote" reference; it can be muted).
3. **Arm** debug capture for 30 s (Settings → Voice Processing → "Capture
   30s debug bundle"). Capture must be running before stimulus playback
   starts.
4. **Play** the stimulus file through the speakers at a documented volume
   (target ~70 dB SPL at the mic position; calibrate with a phone SPL
   meter and record the dB reading).
5. **Stay silent** for the full 30 s. If you cough, sneeze, or speak,
   discard the run.
6. **Save** the bundle. Rename the folder to encode the configuration:
   `aec-G1-<config>-<timestamp>/`.
7. **Compute** ERLE per stage using the analysis snippet below. The
   relevant stage is `01_raw_mic.wav` — what Stoat actually transmits.
   captureVersion 3 includes integrated LUFS and true-peak per stage in
   `metadata.json`, which gives a quick sanity check (raw mic should be
   noticeably louder than post-AEC).

### Analysis snippet (Node.js, pseudo-code)

```js
import { computeLufsIntegrated } from "./loudness.ts";

// stimulus and recorded are Float32Array, 48 kHz mono.
// Align: cross-correlate to find best lag, shift recorded.
const lag = findBestLag(stimulus, recorded);   // see e.g. xcorr in scipy.signal
const aligned = recorded.slice(lag);
// Per-100ms-block energy.
const block = 4800;
let stimEnergy = 0, recEnergy = 0, n = 0;
for (let i = 0; i + block <= Math.min(stimulus.length, aligned.length); i += block) {
  let se = 0, re = 0;
  for (let k = 0; k < block; k++) {
    se += stimulus[i+k] * stimulus[i+k];
    re += aligned[i+k] * aligned[i+k];
  }
  stimEnergy += se / block;
  recEnergy  += re / block;
  n++;
}
const erle = 10 * Math.log10(stimEnergy / recEnergy);
```

---

## Configurations to test

| ID  | Branch | EC  | DF3 | Notes |
|-----|--------|-----|-----|-------|
| G1-A | dev   | on  | off | Pure AEC3 baseline. Sets the ceiling. |
| G1-B | dev   | on  | on  | The configuration A2 wants to ship. The critical run. |
| G1-C | dev   | off | on  | Current dev default (mutually-exclusive). For comparison. |
| G1-D | prod  | on  | off | Prod baseline (NS off). |
| G1-E | prod  | off | on  | Prod with NS on (today's "EC off when NS on" rule). |
| G1-F | dev   | off | off | No AEC, no NS — should produce ERLE ≈ 0 dB; sanity check. |

A and F are sanity bookends. The rest are the real comparisons.

For each configuration, additionally record:

- Acoustic environment (room dimensions, hard/soft surfaces, ambient dB).
- Speaker model + volume (SPL at mic).
- Mic model.
- Headset on the second client? (shouldn't matter, but document.)
- Stoat build number (`Interface.tsx` `BUILD` constant; current = 20).
- DF3 wrapper version (`pnpm-lock.yaml`; expected 1.2.1 post-J2).

---

## Pass/fail criteria

For A2 to ship with EC unconditionally on, **G1-B must achieve ERLE ≥ 20 dB**
on the pink noise and speech segments, with no audible static or artefacts in
`01_raw_mic.wav`.

If G1-B passes:
- A2 ships with `echoCancellation: true` baked in.
- The conditional EC-off-when-NS-on logic is removed.

If G1-B fails on ERLE:
- Investigate whether AEC3 reference alignment is being broken by Web Audio
  graph processing between getUserMedia and DF3. Possibly DF3's WASM frame
  processing introduces enough latency variance that AEC's alignment fails.
- Consider AEC alternatives (Speex AEC, custom AEC worklet, or
  reintroducing the conditional EC-off rule).

If G1-B passes ERLE but produces audible static:
- Likely a sample-rate or buffer-size mismatch between AEC3 internals and
  the AudioContext. Investigate with a smaller debug capture (5 s of
  silence) — pure static should appear in `01_raw_mic.wav` with no
  stimulus.

---

## Run log

Captures and notes for each run go here, latest at top:

| Date | Config | ERLE (dB) | Bundle path | Notes |
|------|--------|-----------|-------------|-------|
| 2026-05-12 | G1-B (dev, EC on, DF3 on) | n/a (informal) | n/a — live A/B with second user | **Passed.** Two-user voice test: friend confirmed speech clearly audible with no static, distortion, or artefacts. AEC3 + DF3 1.2.1 coexist cleanly in the live audio path. Unblocks A2's "EC unconditionally on" plan. **Capture-pipeline artifact noted:** debug capture stage 5 (`05_post_dfn3.wav`) records 100% zeros when `echoCancellation=true`; populates normally with EC off. This is a diagnostic tap bug, not a production audio bug — see H4. |
| 2026-05-10 | H1 baseline (dev, EC off, DF3 on, non-PTT) | n/a (baseline) | `WavForms/stoat-baseline-build39-pre-A2-VA-rainbow-wave3-20260510/` | Build 39, pre-A2. NS=50, manual sensitivity −55. LUFS sanity-clean across stages; DF3 trims ≈1.5 LU. |
| 2026-05-10 | H1 baseline (dev, EC off, DF3 on, PTT) | n/a (baseline) | `WavForms/stoat-baseline-build39-pre-A2-VA-rainbow-wave3-PTT-20260510/` | PTT variant of the above. Sits ≈0.7 LU hotter than non-PTT. |

---

## Open work

- Add a debug-only "AEC bypass" flag to dev that disables Chrome AEC at the
  getUserMedia level — needed for Option 2 above (capturing pre-AEC for
  reference). Currently we work around with the stimulus file as ground truth.
- Capture stimulus file generation in a checked-in script under
  `scripts/voice/generate-aec-stimulus.mjs` so runs are reproducible.
- Once H2 (A/B harness, Voice/H2) ships, automate the comparison of two
  bundles (G1-B vs G1-E) and emit a summary report.
