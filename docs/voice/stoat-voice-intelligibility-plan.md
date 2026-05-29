# Stoat Voice — Intelligibility-First Plan

Replaces v2. Focus: eliminate garbled speech, dropouts, and missed words. Quality/warmth concerns are deferred or dropped.

---

## The reframe

You're not solving "make my voice sound nice." You're solving "I missed what they said and had to ask them to repeat." These have different causes and different fixes:

- **Quality/warmth** is about tonal balance, sibilance, dynamic range. Fixed by EQ, de-essing, leveling.
- **Intelligibility** is about words actually arriving and being audible. Fixed by reducing dropouts, eliminating gate cutoffs, recovering from packet loss, and avoiding processing that mangles speech.

Most of the v2 plan addressed the first. Most of it doesn't help the second.

---

## What actually causes word-loss in the current dev pipeline

Re-reading the audit through this lens, here are the likely culprits ranked by contribution to "I missed that":

### 1. First 200 ms of every speech burst publishes pre-DF3 (the J4 race)

This is *the* most direct cause of "scratchy / garbled / sudden cut-in at the very start" — the exact complaint from your original investigation. Every time someone unmutes or speech starts after silence, ~200 ms of unprocessed mic audio reaches the SFU. On the listener side this sounds like the first syllable was eaten.

This is a real bug, easy to fix. **Highest priority.**

### 2. DF3 cold-start ramp at every speech onset

DF3 has ~150 ms of model-adaptation ramp every time speech starts after silence. Sentences after a pause get attenuated for the first syllable or two. Listener interprets this as "missed the first word."

The bleed floor (currently −54 dBFS) is meant to keep DF3 warm during gate-closed periods, but it's set quiet enough that the model's internal state still drifts. Raising it to −45 dBFS keeps DF3 warmer at the cost of audible-but-faint room tone during silence.

### 3. Gate cutoff on quiet speech onsets

The input gate's bandpass detector (300–3400 Hz) doesn't see sibilance or low-formant content. Words starting with /h/, /f/, /th/, /s/, or whispered onsets have most of their energy outside the detector band, so the gate stays closed for the first few milliseconds. The Silero hold-extender doesn't help here — per the source comments, Silero only *extends* hold time, it doesn't *open* the gate faster.

Combined with the +12 dB auto-calibration headroom (hardcoded), users with quiet voices or low mic gain may get the first phoneme of every utterance trimmed.

### 4. Bursty packet loss handling

`playoutDelayHint = 0.05` (50 ms) is aggressive. On a network with 1% average loss, ~16% of those losses are multi-packet bursts (per rtcbits.com analysis of Opus). With only 50 ms of jitter buffer, multi-packet bursts exceed the buffer, and NetEq has to extrapolate or insert silence. Result: audible wibbling, brief dropouts, syllables lost.

The audit doesn't say what RED distance is configured. Default in livekit-client is distance 1. Testing on Chrome with 60% loss showed that RED distance 1 still produces audible artifacts, while distance 2 produces "almost perfect audio." If you're on default, bumping to 2 is a meaningful intelligibility win for lossy networks.

### 5. DF3 over-suppression at level 40 (resolved — default now 25)

Aggressive NS produces false positives — pieces of speech the model classifies as noise and attenuates. Most common on consonants, breathy speech, and speech at low SNR. Lowering to 25 reduces this without sacrificing real noise removal in quiet rooms. **[Resolved, build 44]** The default `noiseSupressionLevel` shipped at **25** (Voice/B3); 40 is no longer the default anywhere in code.

### 6. Reconnect churn on network flaps

The audit notes LiveKit's reconnect fires aggressively on flapping networks: CONNECTING / CONNECTED / RECONNECTING in a tight loop. During each transition, audio is dropped or muted. Debouncing the state machine prevents this.

### 7. Mic disappearance with no recovery

USB unplug, default device change, even a Windows session-event lock can leave the mic in a dead state with no Stoat code to recover. Total dropout until the user notices and rejoins.

---

## Revised Beads

### KEEP from v2 (still relevant for intelligibility)

- **J2** — Pin DF3 version. Avoids regression.
- **J3** — Surface Silero load failure. If Silero silently falls to RMS-only, gate behavior changes — users should know.
- **J4** — Fix mic-publish/DF3-attach race. **Top priority. This is *the* fix for the original complaint.**
- **H1** — LUFS measurement in capture. Still useful as a measurement primitive.
- **H2** — A/B harness. Still useful for validating intelligibility changes.
- **H3** — Rolling diagnostic log. Critical: lets you see `concealedSamples / totalSamplesReceived` history when complaints happen. Without this, you're guessing.
- **B3** — Drop DF3 default to 25. Reduces over-suppression word-loss.
- **D1** — Pre-warm AudioContext + worklets. Faster join, less first-utterance loss.
- **D2** — DF3 model pre-warm. Eliminates the per-utterance ramp.
- **D4** — Raise bleed floor to −45 dBFS. Keeps DF3 warm during pauses, reduces onset ramp.
- **F1** — Live mic-level meter. Lets users see if their voice is below the gate threshold and adjust mic gain or sensitivity.
- **F4** — Expose auto-calibration headroom slider. User with quiet voice can lower from +12 to +6 dB.
- **F5** — Per-participant quality indicator. Users can see who has packet loss.
- **C5** — Adaptive `playoutDelayHint`. Critical for lossy networks. **Promoted in priority.**
- **E1** — `devicechange` listener. Total dropouts are intelligibility issues.
- **G1, G2** — AEC validation. Echo-feedback in the room is intelligibility-destroying for everyone except the speaker.

### DROP (quality, not intelligibility)

- B1a, B1b — mic profile presets (skipped per prior message)
- B2 — de-esser (quality, not intelligibility)
- B6 — 75 Hz HPF (mostly quality)
- B4 — leveler/limiter replacement (quality/loudness)
- B5 — graph reorder (no longer needed without B1/B2/B4)
- C1 — global output limiter (clip protection, not intelligibility — though defensible to keep eventually)
- C2 — LUFS normalization (loudness, not word-loss)
- C4 — soft ducking (conversational rhythm, not intelligibility)
- D3 — Silero lazy load (CPU/memory, not intelligibility)
- F2 — test mic button (UX, not intelligibility)
- F3 — send diagnostics (UX, not intelligibility — keep on roadmap but defer)
- J1 — output device getter bug (UX, not intelligibility)

### NEW BEADS for intelligibility

#### N1: Verify and increase Opus RED distance to 2

Audit didn't capture what RED distance LiveKit defaults to. Verify in dev. RED with distance 2 produces "almost perfect audio" even at 60% packet loss; distance 1 has audible artifacts. Bandwidth cost is roughly 2× audio bitrate for the redundancy stream — at 128 kbps base this is ~256 kbps total upstream, well within reasonable.

**Acceptance:** RED distance 2 confirmed in capability negotiation (check SDP). Synthetic 10% loss test (`tc qdisc add dev eth0 root netem loss 10%`) produces audibly cleaner audio than current. Concealment % drops measurably.

**Files:** dev `state.tsx` LiveKit Room construction, codec options.

**Effort:** S (config) + M (testing).

#### N2: Investigate Opus 1.5 DRED availability in Chromium

Opus 1.5 added Deep REDundancy (DRED), a neural-network-based packet loss concealment that can recover entire missing syllables. Chromium has been integrating Opus 1.5 features incrementally. Worth checking what's actually exposed via WebRTC in the Chromium version your Electron build ships.

**Acceptance:** Document current DRED status in target Chromium versions. If available, propose enabling. If not, note for future Electron upgrades.

**Files:** Research only; possible Electron flag changes.

**Effort:** S (research).

#### N3: Reduce gate attack time and consider "open immediately, classify later" pattern

The gate's `_ATTACK = 0.3` (~10 ms ramp) plus the bandpass detector miss quiet onsets. A more aggressive design: open the gate immediately on any input above a hard floor, then close it within 30–50 ms if Silero classifies the burst as non-speech. This trades a tiny amount of bandwidth (false-positive opens get transmitted briefly) for guaranteed first-syllable preservation.

**Acceptance:** Words starting with /h/, /f/, /th/, /s/ no longer have onset clipped. False-positive opens (e.g., chair noise) are closed within 50 ms — listener may hear a brief click but no full word.

**Files:** dev gate worklet `state.tsx:197-272`.

**Effort:** M.

#### N4: Reconnect state debouncing

Per audit: "if the underlying network is flapping, the state churns CONNECTING/CONNECTED/RECONNECTING repeatedly; UI doesn't debounce." During state transitions, audio drops.

**Acceptance:** State transitions debounced 300 ms. User sees "RECONNECTING" only if state is stable for 300 ms. Tested with simulated network flap (`tc qdisc` cycling in/out).

**Files:** dev `state.tsx` Room event handlers.

**Effort:** S.

#### N5: Concealment-percentage alerting and history

`printVoiceStats` already computes `concealedSamples / totalSamplesReceived`. Surface it: a small UI indicator that turns yellow when 5-minute rolling concealment exceeds 3% per remote, red above 10%. Logs a diagnostic event when it spikes so post-hoc analysis can correlate with reported "I missed what you said."

**Acceptance:** Per-remote concealment indicator. Spike events logged with timestamp and participant. Threshold tunable.

**Depends on:** H3.

**Files:** dev voice-call UI components, dev `state.tsx:427-581`.

**Effort:** M.

---

## Suggested execution order

```
Wave 1 (parallel, ~3-5 days):
  J2, J3, J4 — bug fixes (J4 is THE big one)
  H1, H3 — measurement infrastructure
  G1 — AEC test methodology
  N1 — RED distance verification + bump to 2
  N2 — DRED research

Wave 2 (parallel, ~1-1.5 weeks):
  H2 — A/B harness (uses H1)
  B3 — DF3 default to 25
  D4 — bleed floor to -45
  C5 — adaptive playoutDelayHint
  N4 — reconnect debouncing
  F1, F4 — mic meter + headroom slider
  G2 — EC+DF3 verification
  E1 — devicechange handler

Wave 3 (parallel, ~1-1.5 weeks):
  D1, D2 — pre-warm framework
  N3 — gate attack rework
  N5 — concealment alerting
  F5 — per-participant quality indicators
```

**Realistic budget: 3 weeks of focused engineering** for the intelligibility-first plan. Down from 4-5 in the v2 plan, plus more focused on what your friend was actually complaining about.

---

## Where the original complaints map

The friend's original complaints, mapped to fixes:

| Complaint | Likely cause | Fix |
|---|---|---|
| "Aliasing-sounding" / harsh | Wave:3 sibilance + DF3 not attenuating it | **Skipped** (per your decision — handle at OS level if needed) |
| "Doesn't sound as warm" | Tonal character of the chain | **Skipped** (quality, not intelligibility) |
| "Fade-in at speech onset every time" | DF3 cold-start ramp | **D2 + D4** |
| "Scratchy / garbled / sudden cut-in at the very start" | **J4 race** + cold-start | **J4 + D2 + D4** — top priority |
| Volume swings (Stoat AGC bug) | Custom AGC misbehavior | **Already mitigated** — Stoat AGC is opt-in default off; Chrome AGC is fine |

The "scratchy / garbled / sudden cut-in" complaint and "fade-in at speech onset" are *both* intelligibility problems. The first is J4 (mic publishes pre-DF3 for 200ms). The second is DF3 cold-start. Fix those two and you've addressed the substantive parts of the original complaint without doing any of the EQ/de-esser work.

---

## Things to leave alone (unchanged from v2)

The audit's "things that are surprisingly fine" list is unchanged. Resist the urge to touch any of:

- Opus codec settings (DTX, FEC, RED-on, bitrate, packetization) — except verifying RED distance per N1
- Input gate hysteresis design (dual-threshold + Silero hold-extender + bleed)
- AudioContext reuse pattern
- Keepalive `<audio>` element trick
- Debug capture infrastructure
- PTT release-delay handling
- GCC SDP munging for screenshare
- `networkPriority = "high"` DSCP marking

---

## How to load this into Beads

Same as before — each `####` is a bead, Group/Wave structure is labels and milestones. New beads use `N` prefix to disambiguate from prior plans. Suggested priorities:

- **P0:** J4, N1 (these directly address word-loss)
- **P1:** J2, J3, H3, B3, D2, D4, C5, N4 (intelligibility wins)
- **P2:** H1, H2, F1, F4, F5, E1, D1, N3, N5
- **P3:** G1, G2, N2 (research / validation / lower-impact)

Pass this alongside the audit. It overrides v2 entirely for the TX/RX quality work that's been dropped.
