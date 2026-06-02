# Voice Loopback Test Harness (Phantom Participant)

> **Status:** design note. Token path (Step 0) recommended but **pending sign-off**;
> implementation (H5 → H6 → H7) gated on that sign-off. Beads: `StoatData-vfo`
> (H5), `StoatData-0fg` (H6), `StoatData-cwt` (H7).

## Purpose

A repeatable, **friend-free** way to hear "what I'd sound like to someone else"
through the full local TX chain + the normal RX chain. The near-term driver is
validating voice changes that have **already landed** and were waiting on a live
tester. It is also reusable later to validate the Phase 3 restructure
(A2/A3/A5/A6) against a fixed, known signal.

## Why a second identity is required (the phantom)

LiveKit does **not** send your own published track back to you. So you cannot
hear your own round trip from a single connection. The only way to hear it is to
publish from a **second identity** that your real client subscribes to like any
other remote participant.

```
                 reginald (LiveKit "worldwide" node)
                  ▲                         │
   real client    │ publish (you)           │ subscribe
   (identity = you)│                         ▼  → plays bot through normal RX
                  │                  ┌──────────────────┐
   PHANTOM ───────┘  publish (bot)   │ real client RX:  │
   (identity = bot)                  │ 4:1 @ -24 dBFS   │
   injected source → full TX chain   │ comp + out gain  │
                                     └──────────────────┘
```

The phantom runs the **injected source** (not a live mic) through the *same* TX
chain — bandpass detector → gate worklet → AGC worklet → DF3 → publish — on its
own Room connection. Your real client receives and plays it through the unmodified
RX path. The phantom **must not subscribe to itself**.

## Token path (Step 0)

The phantom obtains its token the same way the real client does — via the audited
`POST /channels/:id/join_call` endpoint (`Channel.joinCall()`) — but authenticated
as a dedicated **bot account**, not as you.

- This fork supports native bots: `Client.loginBot(token)` (stoat.js) +
  Revolt `/bots/create`.
- One-time setup: create `voice-test-bot`, add it to the test server, grant it
  **Connect** on the test voice channel.
- Token reaches the dev build via the existing VITE injection pattern: a
  gitignored `VITE_VOICE_TEST_BOT_TOKEN` in `communications/.env`, surfaced by
  `docker/inject.js` (same as `VITE_KLIPY_KEY`).
- Runtime: construct a **second** stoat.js `Client`, set the bot token as its
  session (REST `join_call` works without spinning the bot's event WS), call
  `botClient.channels.get(id).joinCall()` → token identity = bot user id, distinct
  from yours.

**Rejected alternatives.** Client-side minting with the LiveKit secret
(`livekit-server-sdk` + `AccessToken`) would bake the **prod** LiveKit secret
(shared `worldwide` server) into a publicly-served dev bundle — anyone could mint
tokens for any room. A dev-only API endpoint means patching the shared Rust
backend prod also runs. The bot path needs zero backend changes, zero client-side
secrets, and no new dependency. Leak blast radius = one revocable throwaway bot.

**Build-time check:** confirm a bot identity is actually allowed to obtain a
`join_call` token (some forks gate voice behind a permission bots lack by default).

## Breakdown

### H5 — Swappable TX input source (`StoatData-vfo`) · the seam
Refactor `#applyInputGate` (`state.tsx` ~2158–2475) so the **head** of the graph
is EITHER the live mic `MediaStreamAudioSourceNode` OR an arbitrary injected
`AudioNode`, with everything downstream (bandpass split, gate, AGC, DF3,
publish/`MediaStreamAudioDestinationNode`) unchanged. Reuse the existing
`#inputGateCtx` (48 kHz) — **do not** spin up a parallel context. Independently
useful; everything else hangs off this seam. Dep: none.

### H6 — Phantom-participant loopback (`StoatData-0fg`)
Second Room under the bot identity; run the H5-injected source through the full
TX chain on that connection and publish. Real client subscribes + plays via normal
RX. Phantom does not subscribe to itself. Dep: H5 + Step 0 token sign-off.

### H7 — Layered source mixer + dev test panel (`StoatData-cwt`)
UI to record/import WAVs (e.g. a rainbow-passage voice take, an AC-noise bed, a
typing bed) and play them mixed. Per-source enable + gain slider + loop toggle;
one Play button schedules all enabled sources with the same `start(when)` so they
are sample-aligned. The summed `GainNode` is the H5-injected source. Dev-gated
behind `isDebugCaptureBuild()` (DEV or `__STOAT_DEBUG_CAPTURE__`), same as debug
capture. Dep: H5, H6.

## Mixer rules (H7) — non-negotiable

- **decodeAudioData** resamples to the 48 kHz context automatically; source files
  need not match the rate.
- **Mono downmix** every source on the way into the mixer — the chain is
  single-channel.
- **Headroom-aware summing** — pad per-source gains so the sum cannot clip past
  0 dBFS. A clipped mix tests garbage.
- **Loop beds outlast the one-shot voice clip** — so the gate's release tail can
  be heard with the bed still bleeding underneath.
- **Mute the real mic publication while a test plays**, and warn to use headphones,
  so nothing live leaks into the channel.

## Caveat: this harness CANNOT test AEC

There is **no acoustic coupling** on the phantom — the injected source never goes
out a speaker and back into a mic, so there is no echo for AEC to cancel. Acoustic
echo cancellation is validated **separately** via the two-user acoustic tests
(G1/G2), not here. The harness validates the TX processing chain (HPF, DF3, gate,
AGC) and the RX chain (compressor, output gain) — everything *except* AEC.

## Confidence check (acceptance gate for H6/H7)

Before trusting the round trip to judge real changes: inject a known file and arm
debug capture on the phantom run. **Stage 01 (`raw_mic`, pre-bandpass) must
reproduce the injected file downmixed to mono at 48 kHz.** If it does, the
injection seam (H5) is faithful and stages 02–05 are the genuine pipeline doing
real work. If stage 01 diverges from the input beyond resample/mono, the seam is
coloring the signal and must be fixed before the harness can be trusted.

## Leave-alone list

This harness adds only an injection seam and a second connection. It must **not**
alter the signal path of a normal call. Do not touch: Opus codec settings
(DTX/FEC/RED/bitrate/packetization), input-gate hysteresis design, the
AudioContext reuse pattern, the keepalive `<audio>` trick, the existing
debug-capture infrastructure, PTT release-delay handling, GCC SDP munging, or
`networkPriority="high"`.

## H5 as-built (build 48) + STEP 4 confidence check

H5 shipped as a seam inside `#applyInputGate` (`state.tsx`):

- `#injectedSource: AudioNode | null` — when set, it is the **head** of the
  graph; otherwise the mic path runs **byte-identical** to pre-H5 (the mic code
  is the untouched `else` branch). Silero is skipped under injection (it binds to
  `#rawMicTrack`, which injection never sets).
- Public API: `get inputGateContext` (create your node on this ctx),
  `get isTxInjectionActive`, and `async setInjectedTxSource(node | null)` —
  dev-gated by `isDebugCaptureBuild()`, rejects nodes from a different
  AudioContext, and rebuilds the gate against the live mic publication.
- Dev console hook (temporary, until H7's panel): `window.stoatVoiceTest`.

**STEP 4 stage-01 confidence check (acceptance gate; run in a debug build):**

1. Open the dev client, **Clear cache & reload**, confirm `[stoat-dev] build 48`.
2. Join a voice channel **solo (or muted)** — local injection routes to your
   publish track.
3. Console: `await window.stoatVoiceTest.injectUrl("<speech.wav>", {loop:true})`
   — **inject SPEECH** (e.g. a spoken rainbow-passage take), not a tone or
   notification chime. DF3 sits on the clean path (gate input 0) upstream of
   the gate and will suppress non-speech ~30 dB, so a chime reaches the gate as
   near-silence (this is correct pipeline behaviour, not a seam bug). To test a
   non-speech bed deliberately, turn **Noise Suppression off** first.
4. Arm **debug capture** (Settings → Voice Processing) for a 5 s bundle.
5. Check two things:
   - **Stage 01** (`01_raw_mic.wav`) reproduces the injected file **mono @
     48 kHz** → the seam is faithful (not coloring).
   - **Stage 03** (`03_post_gate.wav`) **tracks stage 01** (gate open, output
     near input level) and `window.stoatDiag()`'s "raw mic, pre-gate" reads the
     **injected** level — confirming Silero/auto-cal/diag are bridged to the
     injection, not the hardware mic.

   Stage layout for reference: 01 head (pre-bandpass) · 02 bandpass detector
   (gate input 1) · 03 post-gate · 04 post-AGC · 05 **DF3 output = gate input 0**
   (in A2, DF3 is upstream of the gate, so "05_post_dfn3" is the *clean-path*
   feed, not the final transmit). If stage 05 is silent but stage 01 isn't, DF3
   suppressed the input — inject speech or disable NS.
6. `await window.stoatVoiceTest.revert()` to restore the mic; leave the channel.

Gate-onset note: per `StoatInputGateProcessor`, **RMS alone opens the gate**;
Silero only *extends* the hold through speech pauses. So a `useSileroVad:false`
re-run won't change onset — it isn't the right discriminator. The right
discriminator for a silent transmit is speech-vs-non-speech input + stage 05.

Only after stage 03 tracks stage 01 do we trust the round trip and start **H6**.

## H6 as-built (build 51) + live round-trip test

Phantom shipped in `state.tsx`:

- Token wiring: `VITE_VOICE_TEST_BOT_TOKEN` (compose `web-dev` env, **dev only**)
  → `inject.js` → `window.__STOAT_VOICE_TEST_BOT_TOKEN__` (same pattern as the
  debug-capture flag). Read by `#readVoiceTestBotToken()`.
- `startPhantom()` mints a bot LiveKit token via `POST /channels/:id/join_call`
  with `x-bot-token` + `{node:"worldwide", force_disconnect:false}` (both
  required — `force_disconnect:true` → 403 `IsBot`; missing node → 400
  `UnknownNode`), connects a **second** headless Room (`autoSubscribe:false`,
  `publishDefaults` matched to the main room), and publishes a **clone** of the
  `#inputGateDest` track. The clone is deliberate: the original is the user's
  main-room publication, and stopping a shared track on phantom teardown would
  kill the user's real audio.
- `stopPhantom()` disconnects the phantom Room; also called from `disconnect()`.
- Console hook: `window.stoatVoiceTest.startPhantom() / .stopPhantom()`.

**Live round-trip test (acceptance for H6; only you can run it):**

1. Join a voice channel **solo** (the pipeline output also leaves under your
   identity on the main room; H7 will auto-mute that).
2. Optionally `await window.stoatVoiceTest.injectUrl("<speech.wav>", {loop:true})`
   to drive a known signal; otherwise the phantom carries your live mic.
3. `await window.stoatVoiceTest.startPhantom()` → expect a remote participant
   **voice-test-bot** to appear, and you should **hear** the TX→wire→RX round
   trip through the normal receive path.
4. `await window.stoatVoiceTest.stopPhantom()` to end; `revert()` to drop
   injection.

This is what no single-client setup can do otherwise — LiveKit never sends your
own published track back to you, so the phantom's second identity is the round
trip made audible.

## H7 as-built (build 54) — layered mixer + dev test panel

Supersedes the `window.stoatVoiceTest.injectUrl` console hook with a UI. Three
new pieces:

- **`loopbackMixer.ts`** (`components/rtc/`) — pure, dependency-free audio-graph
  helpers: `downmixToMono`, `bufferPeakAmplitude`, `computeHeadroomScalar`
  (= `min(1, 1/Σ(peak·gain))` over enabled sources — bounds the worst case of
  every source peaking in the same sample, attenuates the whole mix by its
  reciprocal so it can't clip past 0 dBFS while preserving the user's balance),
  `buildMixGraph` (each source → per-source `GainNode` → master `GainNode`), and
  `startAligned` (one `start(when)` for all sources → sample-aligned). The master
  is the H5 injected head.
- **`LoopbackTestPanel.tsx`** (voice settings) — import file(s) / record a take →
  decoded on the **input-gate ctx** (`decodeAudioData` resamples to 48 kHz) and
  downmixed to mono; per-source enable / gain / loop / remove; phantom start-stop;
  Play / Stop. **Play** mutes the real publication (`setHarnessMicMuted`), wires
  the master via `setInjectedTxSource`, then `startAligned` (0.1 s lead).
  **Stop** stops the nodes, reverts injection, restores the prior mic state.
  One-shot-only mixes auto-stop after the longest clip + tail; any loop bed holds
  until Stop so the gate release tail is audible underneath.
- **`state.tsx`** — `get isMicPublicationEnabled` + `async setHarnessMicMuted()`:
  toggle the main-room publication **without** the mute/unmute chimes and without
  touching `#settings.micOn`, so the test leaves the user's persisted preference
  intact. Dev-gated.

Rendered inside `VoiceProcessingOptions`' `showDebugSection` block, independent of
the debug-capture checkbox.

**Why the round trip survives injection:** `#inputGateDest` and its published
track are created once and **reused** across every gate rebuild (state.tsx
~2479), so toggling injection does not swap the track the phantom cloned — the
clone keeps carrying whatever the pipeline now outputs. And the clone is an
independent `MediaStreamTrack` (own `enabled` flag), so muting the main
publication during Play leaves the phantom audible. **Order matters:** start the
phantom (clones the *enabled* track) **before** Play mutes — the panel lays the
buttons out in that order and the copy says so.

**Live test (acceptance for H7; only you can run it):**

1. Debug build, **Clear cache & reload**, confirm `[stoat-dev] build 54`.
2. Join a voice channel **solo**. Settings → Voice Processing → **Loopback test**.
3. Import a speech WAV (and optionally a noise/typing bed — toggle **Loop** on
   the bed). **Start phantom** → `voice-test-bot` appears.
4. **Play mix** → your real mic mutes; you hear the mixed signal round-tripped
   through TX→wire→RX. Confirm no clipping (headroom note shows if it scaled).
5. **Stop mix** restores the mic; **Stop phantom** ends. (STEP-4 stage-01
   confidence check from the H5 section still applies if you want to re-verify
   seam fidelity with debug capture armed.)

## Relationship to other beads

- **Voice/H2** (`StoatData-id5`, A/B harness) — complementary: H2 compares
  processing chains; this harness lets a single tester hear the round trip.
- **Voice/F2 (test mic)** — never filed as a bead; existed only in the
  target-architecture "unchanged" list. H5–H7 are a **superset** of its intent.
- **Voice/H4** (`StoatData-kne`) — unrelated (EC debug-capture-tap bug); the new
  trio was numbered H5–H7 to avoid colliding with it.
