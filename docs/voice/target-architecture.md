# Stoat Voice — Target Architecture (Discord/Mumble Parity)

This document supersedes the intelligibility plan where they conflict. The intelligibility plan was right about *symptoms* and *priorities*; this document is about *architecture*. Most of the intelligibility beads are still correct; a few become obsolete and a few new beads replace them.

---

## The reference architecture (what Discord, Zoom, Teams actually do)

Every commercial real-time voice application uses approximately the same canonical pipeline order. WebRTC's own Audio Processing Module (APM), which Chromium implements and which all browser-based voice apps inherit by default, defines the order:

```
TX (microphone → wire):
  Mic capture
    ↓
  Pre-amplifier / capture-level adjustment    [optional]
    ↓
  High-pass filter (~80 Hz)                   [removes rumble, AC hum, pops]
    ↓
  Acoustic Echo Cancellation (AEC)            [must come before NS — needs raw-ish signal]
    ↓
  Noise Suppression (NS)                      [continuous; never gated]
    ↓
  Automatic Gain Control (AGC)                [final loudness shaping]
    ↓
  Voice Activity Detection (VAD)              [decision: transmit or not]
    ↓ (gate is downstream of NS, not upstream)
  If VAD says "speech": pass through
  If VAD says "silence": transmit DTX or comfort noise
    ↓
  Codec encoder (Opus)
    ↓
  Network
```

The crucial properties of this architecture:

**NS is continuous, not gated.** It runs on every frame from the moment audio capture starts. The model's internal state is always warm because it's always seeing real microphone input, including room tone during pauses.

**AEC comes before NS.** AEC needs the speaker reference signal to align with the captured mic signal. Adding NS before AEC degrades AEC's ability to find that alignment because NS distorts the signal in ways the AEC reference doesn't account for.

**AGC comes after NS.** AGC works on speech that's already been cleaned. If AGC came first, it would amplify noise during quiet periods, making NS's job harder.

**VAD/gate is the last decision before encoding.** The gate decides "transmit the cleaned, leveled signal or not" — it's a routing decision, not a processing stage. The signal it gates is already fully processed.

**Discord specifically:** uses Krisp (a commercial NS) at the NS stage. Krisp runs continuously. Discord's voice activation is downstream of Krisp, not upstream. This is why Discord doesn't have the wibble problem you observed in Stoat.

**Mumble specifically:** uses Speex DSP (older but reference-architecture). NS continuous, gate last. Same topology, different NS implementation.

**Zoom/Teams:** proprietary NS, same topology.

There is no commercial voice chat that puts NS *after* the gate. That arrangement is unique to Stoat's current implementation, and the wibble you observed in your captures is the direct consequence.

---

## Stoat's architecture vs. the reference

### Historical pre-A2 dev pipeline (superseded — kept for context)

> **This diagram describes the pre-A2 pipeline. It is NO LONGER the shipping
> dev architecture.** A2 (StoatData-t9m) restructured the TX chain in build 43.
> The pre-A2 topology now only runs under the `stoat.disableA2Architecture`
> kill switch. See the as-built post-A2 diagram below for what actually ships.

```
Mic → split → bandpass detector ─────┐
       └→ clean signal               │
                                     ↓
                              GATE worklet (closes during silence, bleeds -54 dBFS)
                                     ↓
                              AGC worklet (custom, opt-in)
                                     ↓
                              MediaStreamDestination → LiveKit replaceTrack
                                     ↓
                              DF3 (LiveKit-level processor)
                                     ↓
                              Opus encoder → network
```

Differences from reference (the problems A2 fixed):
- **No HPF.** Rumble and AC hum pass through. Plosives ("p"/"b") cause exaggerated thumps.
- **No AEC.** Browser AEC3 is available via getUserMedia constraint, but it's currently mutually-exclusive with NS in prod and untested in dev. No measurement of whether it's working.
- **NS (DF3) is at the END of the chain, not the middle.** This is the architectural inversion. DF3 sees gate output (mostly silence with bleed) instead of continuous mic input. Causes the wibble.
- **Gate is BEFORE NS, not after.** Gate makes a transmit/silence decision based on raw mic energy, then NS sees that gated signal. Reference does this in the opposite order.
- **AGC is between gate and NS**, which is also wrong relative to reference (should be after NS).

### As-built post-A2 dev pipeline (current, build ≥ 43, default-on)

This is what `#applyInputGate` actually wires today (`state.tsx:2158-2475`). It
is the reference topology for HPF/DF3/gate ordering, **but the AGC is still
between the gate and the destination — A5 (move AGC post-NS, between DF3 and
gate) has NOT shipped yet.** So this is "A2 + A4 done, A5 pending."

```
getUserMedia (EC=user, NS=false, AGC=chromeAgc) ─┐
                                                  │ raw mic track (this.#rawMicTrack)
                          ┌───────────────────────┴──────────────────────────┐
                          │ clone → ctx.createMediaStreamSource = `src`        │
                          ▼                                                    ▼
   src → HPF 80 Hz (BiquadFilter)                          src → HP 300 → LP 3400
            → DF3 continuous node (DeepFilterNet3Core)        (bandpass detector,
            → gate input 0  (CLEAN audio path)                 raw-mic, never DF3)
                          │                                    → gate input 1
                          ▼                                       (SIDE-CHAIN)
                   stoat-input-gate  (open/close decision driven by input 1)
                          ▼
                   stoat-leveler (B4) / stoat-agc (legacy)  [AGC — A5 will move this]
                          ▼
                   MediaStreamDestination → LiveKit publish → Opus → network

   Silero VAD: separate hold-extender, consumes the RAW MIC track (not DF3 output).
```

Reference-conformance status of the as-built pipeline:
- **HPF (80 Hz):** ✅ present (A4, `state.tsx:2318`). Strict-on under A2.
- **DF3 continuous, upstream of gate:** ✅ present (A2). Model stays warm; bleed retired (`disableBleed: true`).
- **Gate downstream of DF3 on the clean path:** ✅ but the gate's **open/close decision still reads a raw-mic bandpass side-chain** (gate input 1), NOT DF3 output. The detector was deliberately left on raw mic so the existing threshold tuning + auto-calibration stay valid (`state.tsx:2287-2289`, `2337`). Moving it is the open scope of **A3** — see the reconciled A3 spec below.
- **AGC position:** ⚠️ still pre-publish but **post-gate**, not post-NS-pre-gate. A5 moves it. Until then the AGC sees gated (clean) audio, which is acceptable but not the reference slot.
- **AEC:** browser AEC3 via `echoCancellation` constraint, now independent of NS (G2 verified EC + DF3 1.2.1 coexist). Defaults on.

The fact that the pre-A2 architecture sort of worked at all was a testament to the gate hysteresis and Silero hold-extender being well-tuned. A2 removed the architectural inversion; A3/A5/A6 finish aligning the detector/AGC/Silero taps to the reference.

---

## Target architecture

```
Mic capture (getUserMedia, EC: true, NS: false, AGC: false, sampleRate: 48000)
    ↓
HPF (BiquadFilterNode, type 'highpass', frequency 80, Q 0.707)
    ↓
DF3 (continuous, Web Audio node — see implementation note below)
    ↓
AGC (custom worklet — leveler + peak limiter, post-NS)
    ↓
VAD/gate (bandpass detector — see A3 below for the raw-mic-vs-DF3-output decision; NOT yet moved off raw mic in the as-built code)
    ↓
MediaStreamDestination → LiveKit publish → Opus → network
```

### Per-stage details

**HPF.** Single BiquadFilterNode at the start of the AudioContext graph. Universal default-on. Removes <80 Hz content that's never speech (AC hum is 50/60 Hz; rumble is broadband <60 Hz). Not a quality "tilt" — strict improvement for any mic. Discord does this implicitly via WebRTC APM's HPF stage.

**AEC.** Browser AEC3 enabled via `echoCancellation: true` in getUserMedia. Single source of truth. The current prod logic ("EC off when DF3 on") is wrong in the new architecture because DF3 will be running on EC-cleaned input, not the other way around. EC should be unconditionally on. This requires verification (see G1/G2) but the architectural answer is clear: AEC comes first.

**DF3 continuous.** This is the central change. DF3 must run as a continuous Web Audio node (or an AudioWorklet wrapping the model), seeing every frame of microphone input from AudioContext start. Implementation depends on what `deepfilternet3-noise-filter` exposes — see implementation note below.

**AGC.** The leveler + peak limiter design from the original B4 plan. Its target position is post-NS, but **as-built it's still post-gate (A5 pending)**. The leveler sees clean speech and shapes loudness. K-weighted detector, 50 ms attack, 1500 ms release, +12/-6 dB range, frozen below -50 dBFS.

**Target loudness — unit note.** The leveler target is **hardcoded** in the worklet: `_targetLin = 10^(-20/20)`, i.e. -20 dBFS RMS measured on the **K-weighted** signal. We label this "-20 LUFS-S" as shorthand, but it is NOT gauge-corrected to true ITU LUFS (which adds the -0.691 dB offset and integrates over a 400 ms momentary block); the effective true loudness target is ≈ -20.7 LUFS-S. Close enough for voice; the label is an approximation, not a measured LUFS value.

**The `stoatAgcTargetDbfs` slider does NOT feed the leveler.** That slider (default -18 dBFS, range -30…-6, correctly in dBFS because it drives the *legacy envelope-follower* `stoat-agc` worklet's RMS target) is only wired to the legacy AGC (`state.tsx:2381`). Under B4 (default) the leveler ignores it entirely — only `enabled` and `silentThresholdDbfs` are posted to `stoat-leveler` (`state.tsx:2362-2366`) — and the UI hides the slider (`VoiceProcessingOptions.tsx` `isB4LevelerDisabled()` gate). So the "-20 LUFS-S vs -18 dBFS" apparent mismatch is **not a value-mapping bug**: the two numbers belong to two different, mutually-exclusive AGC implementations and never interact.

**VAD/gate.** The gate's job becomes purely "should this transmit?" It no longer has to keep DF3 warm because DF3 is always warm. The bleed mechanism is retired (✅ done in A2). The bandpass detector *could* split off DF3's clean output rather than raw mic — speech is more reliably detected on cleaned audio — **but in the as-built code the detector still reads raw mic, deliberately, because the auto-calibration that sets its threshold also reads raw mic and the two must stay in one reference frame.** Whether to move both to DF3 output is the open A3 decision (see the authoritative A3 spec below). Silero VAD continues as hold-extender (still on raw mic; A6 evaluates moving it). Hold time and hysteresis tuning carries over.

**Gate output → publish.** Direct route. No bleed during gate-closed periods. The track is genuinely silent during pauses, which matches Discord's behavior at this layer (Discord transmits at very low energy, not exact zero, but the silence is clean).

### Implementation note: how to run DF3 as a Web Audio node

`deepfilternet3-noise-filter@1.2.1` is structured as a LiveKit `TrackProcessor`. It internally uses Web Audio (the audit confirms it runs inside an AudioContext via the LiveKit processor abstraction). To use it before the gate, three options:

**Option A: Inspect/extend the existing wrapper.** The wrapper likely has a Web Audio node inside that LiveKit calls into. If we can access that node directly (or fork the wrapper to expose it), we route audio through it as a normal node. Probably half a day to a few days of work depending on how the wrapper is structured. Lowest cost.

**Option B: Build an AudioWorklet wrapper around the underlying ONNX model.** DF3's model files are loaded from `/df3-assets`. Load them in an AudioWorklet that runs the inference directly using ONNX Runtime Web. Bypass the wrapper entirely. Probably 1-2 weeks of work. Highest cost but most flexible — also lets us upgrade DF3 versions independently of the wrapper.

**Option C: Run two DF3 instances in parallel.** Keep the existing LiveKit-level DF3 for actual processing, and run a second silent DF3 instance on the raw mic continuously. The second instance's only job is to keep an internal noise model warm. When the LiveKit DF3 attaches, somehow seed it from the warm one. *This option is dumb — just listing it for completeness. The wrapper probably doesn't expose state transfer, and even if it did, it's a hack. Not recommended.*

**Recommendation:** Try Option A first. Single investigation bead (half-day to one day) to inspect the wrapper. If the internal node is accessible or trivially exposed, take that path. Only fall back to Option B if A is impossible. Don't do C.

### Latency

End-to-end latency in the new architecture:
- HPF: ~0 ms
- AEC: ~10 ms (Chrome AEC3 internal)
- DF3: 40 ms algorithmic + ~32 ms WASM = 72 ms (unchanged)
- AGC: 5 ms lookahead
- Gate: ~5-10 ms hysteresis ramp
- Opus: 5 ms
- Network: ~50 ms typical
- Jitter buffer: 50 ms (current playoutDelayHint)
- Decode: 5 ms

**Total: ~205 ms.** Under the 200 ms target by a small margin or just over. Same as current architecture — moving DF3 doesn't add latency, it just moves where the latency is spent. Good.

---

## Complications and risks

**The bandpass detector retunes.** Currently the detector runs on raw mic in 300-3400 Hz, and so does the auto-cal sampler (separate node, but same raw-mic signal — see A3). If A3 chooses to move the detector to DF3 output, the auto-cal sampler MUST move with it (option 2 in the A3 spec), because DF3 attenuates noise outside speech bands and the threshold would otherwise be derived from a different reference frame than the signal the detector measures. The 300-3400 Hz window probably still works but the +12 dB headroom constant and `[-60, -15]` clamp need re-deriving against the cleaned signal. The simpler first move (A3 option 1) is to retune the +12 dB headroom alone with both taps left on raw mic.

**Silero VAD topology.** Silero currently consumes a clone of raw mic. After the change, it should probably consume DF3 output instead, for the same reason (cleaner classifications). Or we keep it on raw mic — it's a classifier, not a processor, and raw signal has more information. Worth a single A/B test once the rest is wired up.

**EC + DF3 coexistence.** Prod's "EC off when NS on" rule was added because of static. The audit notes this hasn't been re-tested on current DF3 wrapper version. In the new architecture, the question becomes "does AEC3 → DF3 produce static" which is a different question (AEC output is closer to the reference than raw mic). G1/G2 still apply but priority bumps because the answer determines whether AEC can be unconditionally on.

**CPU cost.** DF3 currently runs only when track is active (LiveKit-level). After the change, DF3 runs continuously while the AudioContext is alive. Strictly more CPU. Single-digit % of one core on desktop, so probably fine, but worth measuring.

**The bleed signal is retired.** ✅ Done in A2 — the gate outputs true zero when closed (`disableBleed: true`); the legacy -45 dBFS floor only fires under the kill switch. The auto-calibration samples the **raw mic** directly (its own throwaway AudioContext on `#rawMicTrack`), never gate output, so it was unaffected by the bleed change. Note this means the "auto-cal transfers cleanly because we still have raw mic" reasoning only holds if the detector ALSO stays on raw mic — see A3.

**Track lifecycle.** LiveKit's `replaceTrack` and `setProcessor` abstractions assume DF3-as-processor. Switching to DF3-as-node means we no longer use `setProcessor` for DF3. The publish track is now the output of our AudioContext graph (as it already is in dev), and DF3 is just another node in that graph. Cleaner conceptually, but it means the "DF3 is supported" check moves from `track.setProcessor` capability to "can we instantiate the DF3 node in our context."

**J4's mute window may become redundant.** J4 mutes the track during the LiveKit `setProcessor` race. If DF3 is no longer a LiveKit-level processor, that race doesn't exist. J4 stays as documentation/safety, but the muteWindow may end up never triggering in the new architecture. That's fine — it's a defensive measure.

---

## What this means for the existing beads

### Obsolete (drop these)

**D2 (DF3 pre-warm).** No longer needed. DF3 is always warm because it always sees mic input.

**D4 (raise bleed floor).** No longer needed. There is no bleed.

These two were the entire reason we'd been planning for the wibble problem. The architectural fix removes the problem class.

### Promote (these matter more in the new architecture)

**B6 (HPF at 80 Hz).** Was a quality nice-to-have; becomes a structural part of the reference architecture. P1.

**B4 (leveler + peak limiter replacement).** Was opt-in code quality; becomes the canonical AGC stage. The position in the chain changes (post-NS instead of pre-NS) but the implementation is the same. P1.

**G1 + G2 (AEC validation).** Were lower priority. In the new architecture, AEC unconditional-on is a key design decision; the static issue must be resolved or proven non-existent. P0/P1.

**N3 (gate attack rework, "open immediately classify later").** Still useful but its rationale shifts. Currently the gate's bandpass detector misses sibilants. In the new architecture, the detector runs on DF3 output, which is cleaner — and the "open immediately" pattern works better when downstream stages are warm and ready. Stays at P2.

### Unchanged (these are independent of the architectural reshuffle)

J1, J2, J3, J4, H1, H2, H3, B3, C1, C2, C3, C4, C5, D1, D3, E1, F1, F2, F3, F4, F5, N1, N2, N4, N5 — none of these are affected by changing DF3's position. They stay as planned.

### New beads

**A1: Investigate `deepfilternet3-noise-filter` Web Audio mode.** Half-day spike. Read the wrapper source. Determine whether it exposes its internal Web Audio node, whether forking is viable, or whether we need to go to Option B (AudioWorklet around ONNX). Output: a one-paragraph recommendation and an effort estimate for A2.

**A2: Restructure pipeline to reference architecture.** The big one. Implements the target architecture. Drops bleed mechanism. Reorders AGC and gate. Updates auto-calibration. Updates Silero plumbing. Removes DF3 from `setProcessor`, adds it as a Web Audio node in the graph. Effort depends on A1's output: if Option A works, ~3-5 days; if Option B is required, ~10-15 days. Includes a flag to fall back to current architecture if A2 ships and immediately regresses something we didn't catch.

**A3: Re-tune gate calibration (and decide the detector signal source).** ⭐ **This is the authoritative A3 spec — supersedes the looser phrasings elsewhere in this doc.**

Code truth (verified 2026-05-28, `state.tsx`): the gate's bandpass open/close **detector** and the auto-calibration **sampler** are TWO DISTINCT taps, not one shared node.
- Detector: `src → HP 300 → LP 3400 → gate input 1`, inside the persistent input-gate `AudioContext`, reading a clone of the raw mic (`#applyInputGate`, ~`state.tsx:2291-2337`).
- Auto-cal sampler: `#calibrateInputSensitivity` (~`state.tsx:3316`) spins up its **own throwaway `AudioContext`** + AnalyserNode on `this.#rawMicTrack` for a 2 s window, every 30 s, then closes it.

Because they are separate nodes, it is **mechanically possible** to move one without the other. **But they are coupled in meaning:** the auto-cal sampler *sets the threshold* that the detector *compares against*. They must share a reference frame. Three options, pick ONE:

1. **Keep both on raw mic (status quo), retune headroom only.** Lowest risk. Per the A3 bead (StoatData-vcg), Gryphon's F17 session showed the dominant problem is the **+12 dB headroom constant** (gate stayed closed at conversational volume), not the detector signal source. Reducing +12 dB → ~+6–8 dB may resolve the cold-open failure without touching either tap. This is the recommended first move.
2. **Move BOTH detector and auto-cal sampler to DF3 output.** Keeps them in the same (cleaned) reference frame. The +12 dB headroom must be re-derived empirically against DF3-cleaned noise (which is far lower than raw-mic floor), and the `[-60, -15]` clamp likely shifts. Higher effort, more correct long-term.
3. ~~Detector on DF3 output, auto-cal on raw mic.~~ **Do NOT do this.** It is mechanically possible (separate nodes) but produces a unit mismatch: the threshold is derived from raw-mic noise floor while the detector measures DF3-attenuated signal. The numbers are in different reference frames and the gate behavior is undefined. This is the trap the older "detector moves to DF3, auto-cal stays on raw mic" phrasing accidentally specified.

Recommended A3 scope: do **(1)** first (headroom retune, both taps on raw mic) and re-verify with H2; only escalate to **(2)** if detector reliability on raw mic proves insufficient after the headroom fix. Either way, both taps stay coupled. ~1-2 days, mostly empirical tuning + H2 capture rounds.

**A4: Add HPF at the start of the AudioContext graph.** Was B6. Now structurally required. ~half-day. Strict improvement for any mic. New default-on.

**A5: Move AGC to post-NS position.** Code change is small (just reorder node connections in `#applyInputGate`); the meaningful work is verifying that the existing AGC parameters (or B4's new leveler design) still work correctly on already-cleaned input. Effort depends on whether B4 has shipped: if yes, this is just verification; if no, ship B4 in this position from the start. ~1 day standalone, or merge into A2.

**A6: Verify Silero placement.** Quick A/B: Silero on raw mic vs Silero on DF3 output. Pick whichever gives better detection. ~half-day.

---

## Current status snapshot (2026-05-28)

Code-verified status of the items most likely to be misremembered. Update the date when re-verified.

| Bead | Item | Status in code | Notes |
|------|------|----------------|-------|
| **N1** (StoatData-8xu) | Opus RED distance = 2 | ❌ **NOT done.** `red: true` is set in `publishDefaults` (`state.tsx:1233`) so RED is **enabled**, but no distance is configured. livekit-client exposes `red` only as a boolean — there is no distance field in `publishDefaults`/`codecOptions`, so the encoder uses the **default RED distance of 1** (one redundant copy of the previous frame). Bumping to 2 requires SDP munging, not a client-API flag. N1 remains open and is the real work. |
| **N2** (DRED) | Opus 1.5 DRED in Chromium | ❌ Not enabled / not investigated in code. Research item; no DRED plumbing exists. Status: open research, no code path. |
| **C5** (StoatData-246) | Adaptive `playoutDelayHint` | ❌ Not adaptive. `playoutDelayHint` is **hardcoded to 0.05 (50 ms)** per receiver in `RoomAudioManager.tsx:50`, wrapped in try/catch (Firefox no-op). No concealment-driven adaptation. C5 open. |
| **N4** (StoatData-k22) | Reconnect debouncing | ❌ Not implemented. No debounce on LiveKit Room reconnect state transitions in the connect path. N4 open. |
| **DF3 default level** | `noiseSupressionLevel` default | ✅ **25** (`Voice.ts:97`; `?? 25` fallbacks at `state.tsx:2222, 2241`). Lowered from 40 in build 44 (Voice/B3). Older docs saying 20 or 40 are stale. |
| **A2** | DF3 continuous, pre-gate | ✅ Shipped (build 43, default-on). Kill switch `stoat.disableA2Architecture`. |
| **A4** | 80 Hz HPF | ✅ Shipped, wired in `#applyInputGate` under A2. |
| **A3 / A5 / A6** | detector source / AGC position / Silero source | ⏳ Open. See as-built diagram and A3 spec above. |

## Recommended execution order

This re-orders the original wave structure significantly. Suggested new phasing:

```
Phase 1 — Foundation (ship in parallel, ~1 week):
  J1, J2, J3, J4 — bug fixes (J4 already shipped)
  H1, H3 — measurement infrastructure
  G1 — AEC test methodology
  A1 — DF3 wrapper investigation [BLOCKER for A2]

Phase 2 — Validation infrastructure (~1.5 weeks):
  H2 — A/B harness
  G2 — AEC verification on current architecture
  N1 — RED distance verification
  C3 — single output bus (independent of restructure)
  F1, F4 — mic meter, headroom slider

Phase 3 — Architectural restructure (~2-3 weeks depending on A1 outcome):
  A2 — pipeline restructure (DF3 continuous)
  A3 — gate calibration retune
  A4 — HPF (or merge into A2)
  A5 — AGC repositioning (or merge into A2)
  A6 — Silero placement A/B

Phase 4 — Post-restructure polish (~1-1.5 weeks):
  B3 — DF3 default level (re-evaluate after restructure)
  B4 — leveler/limiter replacement (if not done in A5)
  C1, C2, C4 — RX chain enhancements
  C5 — adaptive playoutDelayHint
  N4 — reconnect debouncing
  E1 — devicechange handler

Phase 5 — Diagnostics & UX (~1 week):
  F2, F3, F5 — test mic, send diagnostics, quality indicators
  N3 — gate attack rework (re-evaluate if still needed)
  N5 — concealment alerting

Dropped: D2, D4 (made obsolete by A2)
```

**Realistic budget: 6-9 weeks** depending on A1 outcome (which determines A2's complexity). Up from the intelligibility plan's 3 weeks because we're now doing a real architectural change rather than incremental fixes. This is the cost of doing it right.

The single biggest unknown is A1. Spend the half-day on it before committing to the rest of the phasing.

---

## What I'd feed Claude Code

```
We're doing an architectural restructure of the dev voice pipeline to match
the reference WebRTC/Discord/Mumble topology. The intelligibility plan got
the priorities right but anchored on the existing pipeline structure;
the analysis of recent debug captures revealed that the wibble at speech
onset is a structural consequence of running NS *after* the gate, which
is the inverse of every commercial voice chat. We need to fix the
architecture, not patch around it.

Read docs/voice/target-architecture.md fully before doing anything.
Then:

1. Confirm you understand the target architecture and the rationale.
   Flag anything that conflicts with what's actually in the current
   dev codebase. Trust the code over the doc; the doc was synthesized
   from the audit and may have drifted.

2. The intelligibility plan beads in Beads need updates:
   - Drop D2 and D4 (made obsolete by the restructure)
   - Add new beads A1 through A6 per the doc
   - Adjust priorities and phase assignments per the new execution order
   - Keep all other beads as they are
   
   Do this update via Beads, then report back what changed.

3. Start on A1 (the DF3 wrapper investigation) immediately. This is
   a half-day spike: read the deepfilternet3-noise-filter@1.2.1 source,
   determine whether it exposes its internal Web Audio node or whether
   we need to fork or rebuild around the underlying ONNX model. Output
   a recommendation with an effort estimate for A2.

4. Don't start A2 until I've reviewed A1's output. A2 is the multi-week
   restructure and we want to commit to a path consciously, not by
   accident.

The other beads in Phase 1 (J1, J2, J3, H1, H3, G1) can proceed in
parallel with A1 since they don't depend on the architectural decision.
```

---

## Final notes

The intelligibility plan wasn't wrong, exactly — every individual bead in it addresses a real symptom. The problem was that several of those beads (D2, D4, partly N3) were patching around an architectural inversion rather than fixing it. Once you fix the architecture, those patches become unnecessary.

This is a longer path than the intelligibility plan promised. But it's the right one: at the end of it, Stoat's voice pipeline is structurally identical to Discord's and Mumble's, and the failure modes that gave rise to the original "garbled at the start" complaint don't exist as a class.

J4 stays. The work you've done so far isn't wasted — J4 is genuinely a real bug regardless of architecture, and the verification methodology you've built (the debug capture pipeline, the A/B harness once H2 ships) is reusable for everything in Phase 3. The intelligibility plan got us to "we have good measurement"; this plan uses that measurement to validate a real fix.
