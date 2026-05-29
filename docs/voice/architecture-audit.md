# Stoat Voice/Audio Architecture Audit

**Repos audited:** stoat-web-saga (production, 1047-line state.tsx), stoat-web-dev (2601-line state.tsx, ahead of prod), stoat-desktop-saga (Electron). Backend config in `D:\StoatData\communications\livekit.yml` and `Revolt.toml`. All file paths in the report are absolute.

---

## 1. Capture / TX chain

### Current state

**Prod (stoat-web-saga):**

- LiveKit Room constructed in `D:\StoatData\stoat-web-saga\packages\client\components\rtc\state.tsx:340-367`.
- `audioCaptureDefaults` (line 353-360):
  - `deviceId: this.#settings.preferredAudioInputDevice` (line 354)
  - `echoCancellation: this.#settings.noiseSupression ? false : (this.#settings.echoCancellation ?? true)` — EC is forced off whenever NS is on (line 357).
  - `noiseSuppression: false` (line 358; DF3 handles it).
  - `autoGainControl: this.#settings.autoGainControl` (line 359).
- No `sampleRate`, `channelCount`, or `latencyHint` set anywhere in `getUserMedia` or Room constructor.
- Track lifecycle: `restartTrack(options)` is used on settings change (`applyMicConstraints`, line 531). On initial connect, DF3 is attached via `track.audioTrack.setProcessor(new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" } }))` (line 396).
- DF3 wrapper version: `deepfilternet3-noise-filter ^1.1.4` declared in `D:\StoatData\stoat-web-saga\packages\client\package.json:104`. No suppression-level argument is passed in prod.
- No input gate. No custom AGC. The mic track flows: `getUserMedia → DF3 processor → publish`.
- Publication settings: `publishDefaults` lines 343-352 — `audioPreset.maxBitrate=128_000`, `dtx:false`, `red:true`, `codecOptions={opusFec:true, opusDtx:false, opusMaxPlaybackRate:48000}`.

**Dev (stoat-web-dev) — significantly more elaborate [dev only]:**

- Room constructor at `D:\StoatData\stoat-web-dev\packages\client\components\rtc\state.tsx:775-802`. Same Opus settings, but echoCancellation is independent of NS (line 790: `echoCancellation: this.#settings.echoCancellation ?? true`).
- `autoGainControl` is now driven by a separate `chromeAgcEnabled` setting (line 794) — Chrome AGC is opt-in.
- The TX graph is rebuilt by `#applyInputGate(track)` (lines 1592-1796):
  1. `getUserMedia` with `{ deviceId, echoCancellation, noiseSuppression: false, autoGainControl: chromeAgcEnabled }` — explicit re-acquisition rather than `restartTrack` because `restartTrack` was observed to hand back a phantom destination-node track on user-provided tracks (line 1058-1066).
  2. Single `AudioContext({ sampleRate: 48000 })` (line 1622), reused across rebuilds — comment at lines 1592-1605 explains Chrome's "context stuck in suspended" gesture-policy bug.
  3. Mic clone → `MediaStreamAudioSourceNode` → splits to (a) `BiquadFilterNode` highpass 300Hz Q=0.707 → `BiquadFilterNode` lowpass 3400Hz Q=0.707 for detector side-chain (line 1681-1684); (b) clean signal path.
  4. `AudioWorkletNode "stoat-input-gate"` (lines 197-271, registered inline via blob URL) — 2-input gate: input 0 = clean, input 1 = bandpass detector. RMS hysteresis with `_CLOSE_RATIO = -10 dB`, attack 0.3 (~10 ms), release 0.03, hold 30 frames; outputs a -54 dBFS bleed (≈ 0.002 linear) when closed to keep DF3 warm.
  5. `AudioWorkletNode "stoat-agc"` (lines 292-382) — sliding-window EMA RMS (~150 ms), 5 ms lookahead delay line, target -18 dBFS, max gain +18 dB, min gain -12 dB, holds gain when below -50 dBFS silent threshold. Always present in graph; bypass routes through delay line so toggle doesn't pop.
  6. `MediaStreamAudioDestinationNode` (reused across rebuilds — line 1720-1724) → `track.replaceTrack(dt, true)` first build only; subsequent builds keep the same published track to avoid renegotiation (line 1735-1745).
  7. DF3 is then attached as a LiveKit-level processor on the publication — `track.setProcessor(new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" }, noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 20 }))` (line 910-912 and 1071). DF3 in dev runs after the gate+AGC. Wrapper version 1.2.1 actually installed (`D:\StoatData\stoat-web-dev\node_modules\deepfilternet3-noise-filter\package.json`). Prod dependency declares `^1.1.4`. **[Updated 2026-05-28]** This snapshot is pre-A2. Post-A2 (build ≥ 43) DF3 is a continuous Web Audio node via `new DeepFilterNet3Core(...)` upstream of the gate, and the default `noiseSupressionLevel` is now **25** (lowered from 40 in build 44 per Voice/B3), not 20. See target-architecture.md "As-built post-A2 dev pipeline."
  8. Silero VAD (`@ricky0123/vad-web ^0.0.30`, dev only): consumes a separate clone of `#rawMicTrack` (line 1822), posts `vadActive` messages to the gate worklet which uses it as a hold-extender (gate worklet lines 251-254).
  9. `RTCRtpSender.networkPriority = "high"` set on every encoding after publish (line 894-898).

### Worklet implementation files

- Gate + AGC + PCM feeder are inline blob-URL AudioWorklet strings inside `state.tsx`:
  - PCM feeder: prod `state.tsx:126-155`, dev `state.tsx:150-188`.
  - Gate: dev `state.tsx:197-272`.
  - Stoat AGC: dev `state.tsx:292-383`.
- Capture recorder (debug capture): `D:\StoatData\stoat-web-dev\packages\client\components\rtc\debugCapture.ts:15-52`.

### Not present

- No explicit `sampleRate: 48000` or `channelCount: 1` constraints on the `getUserMedia` call (LiveKit picks defaults).
- No `latencyHint` on the AudioContext (Chrome default is "interactive"). Dev's `AudioContext({ sampleRate: 48000 })` does not pass latencyHint.
- No mic EQ stage. Bandpass exists but is detector-only; the clean signal is unfiltered.
- No de-esser, expander, or limiter on TX. No per-frame loudness measurement (LUFS).
- No "raw mic level" UI meter in either branch (only diagnostic `printVoiceStats` console output).
- Prod has no input gate at all — every breath / keypress is transmitted.

### Honest assessment

Dev TX chain is at or above Discord parity in absolute capability surface (Silero VAD, dual-AGC offering, configurable NS level, gate hysteresis, hold-extender, debug capture). The signal flow is also genuinely well-thought-out — bandpass-detector + clean-pass + lookahead AGC + DF3 is more sophisticated than what Discord exposes to users.

Prod TX chain is substantially below Discord parity — it has DF3 + Chrome AGC + browser EC and nothing else. No VAD/gate, no per-process AGC, no Silero. A user on prod with a noisy keyboard or fan transmits constantly while the mic is unmuted; Discord (and dev) gate it.

The fact that the entire feature gap lives in dev and hasn't shipped to prod is the single biggest piece of context for any future research.

### Risks / gaps

- Default `useStoatAgc: false`, `chromeAgcEnabled: true` (dev `Voice.ts:98-100`). The custom AGC is gated behind opt-in and most users will keep Chrome AGC. Chrome AGC is documented in Stoat's own UI (`VoiceProcessingOptions.tsx:132`) as "Aggressive — pumps gain during silences." There's no opinion on which combination is recommended.
- The bandpass detector uses 300–3400 Hz Q=0.707 — that's a telephony band. Speech energy above 3.4 kHz (sibilance) and below 300 Hz (low-male formants) will not contribute to gate decision. Could miss whisper-quiet input.
- DF3 is loaded fresh from `/df3-assets` on every mic rebuild via `setProcessor` — see "Cold start" section. There's no warm path.
- No mic input-level meter visible to the user during tuning. Auto-calibration is silent (logs only).
- The auto-calibration sample window is 2 s; the rolling history is up to 20 entries (~10 min). Floor is `median + 12 dB headroom`, clamped to `[-60, -20]` dBFS. This "+12 dB" is hardcoded (line 2290).

### Interaction with future TX-chain changes

Touching TX heavily intersects with this section. Anything that wants to:

- **Replace DF3** → has two attach points to update simultaneously (dev `state.tsx:910-912` and `state.tsx:1071`); prod has two as well (line 396 and line 538).
- **Add mic EQ** → would land in the dev `#applyInputGate` graph, between bandpass-source split and gate, or after AGC. Note the `#inputGateDest` reuse rule (line 1714-1724) — adding/removing nodes between AGC and dest is fine, but replacing dest will renegotiate the LiveKit publication.
- **Replace the AGC** → straight swap of the worklet code in dev `state.tsx:292-383`, plus the constructor-time options. Prod has no AGC worklet to replace.
- **Add pre-warm logic** → the AudioContext-reuse pattern in dev (line 1606+) makes pre-warming the gate easy, but DF3 is wrapped by LiveKit's processor abstraction and isn't trivially pre-warmable without an actual published track.

---

## 2. Receive / RX chain

### Current state

**Prod RX:**

- `D:\StoatData\stoat-web-saga\packages\client\components\rtc\components\RoomAudioManager.tsx:42-65` — for each remote audio publication, mounts a `<AudioTrack>` from solid-livekit-components.
- Volume = `state.voice.outputVolume * (perUserVolume or perScreenshareVolume)` (lines 48-53).
- Mute = `state.voice.getUserMuted(...) || voice.deafen()` (lines 54-58).
- `enableBoosting` flag is on (line 60).
- `solid-livekit-components AudioTrack` (`D:\StoatData\stoat-web-saga\packages\solid-livekit-components\src\components\participant\AudioTrack.tsx`) renders `<audio ref={mediaEl}>` and calls `t.attach(mediaEl)` via `useMediaTrackBySourceOrName` (`...\src\signals\useMediaTrackBySourceOrName.ts:62`). When `enableBoosting && volume > 1`, it mutes the `<audio>`, opens its own AudioContext, builds `MediaStreamSource → GainNode → destination` (lines 92-119) and calls `setSinkId` from `activeDeviceId` of `useMediaDeviceSelect`.
- Per-user volume / mute UI: `D:\StoatData\stoat-web-saga\packages\client\components\app\menus\UserContextMenu.tsx:202-229` — slider 0–3 step 0.1, mute checkbox.
- Per-screenshare volume default 1.5 (`Voice.ts:300`) and per-user default 1.0 (`Voice.ts:264`).
- `outputVolume` default in prod: 1.0 (`Voice.ts:73`).
- Receiver-side `playoutDelayHint`: not set.

**Dev RX [dev only]:**

- `D:\StoatData\stoat-web-dev\packages\client\components\rtc\components\RoomAudioManager.tsx:37-56` — same loop, but additionally sets `(receiver as ...).playoutDelayHint = 0.05` (50 ms) on every remote receiver to lower the LiveKit jitter buffer target from ~120 ms.
- Each remote track is rendered through `CompressedAudioTrack` (`D:\StoatData\stoat-web-dev\packages\client\components\rtc\components\CompressedAudioTrack.tsx`) instead of solid-livekit-components's `AudioTrack`.
- Per-track graph (`buildChain`, lines 65-96): `AudioContext()` (no explicit sampleRate) → `applySinkId(outputDeviceId)` → keepalive `<audio>` element (lines 75-79, addresses Chromium's MediaStreamAudioSourceNode zero-samples bug, called out in source comments lines 52-56) → `MediaStreamAudioSourceNode` → `DynamicsCompressorNode` (threshold -24 dB, ratio 4, knee 30 dB, attack 3 ms, release 250 ms; lines 84-88) → `GainNode` (line 90, value = `props.volume`) → `ctx.destination`.
- Mute drives `pub.setEnabled(!muted)` which stops server transmission (line 152) — same as prod.
- Default `outputVolume`: 2.0 in dev (`Voice.ts:105`) — relies on `enableBoosting`-style headroom that compressor + gain stage provides.
- `screenshareVolume` default 1.5 (dev `Voice.ts:381`), per-user default 1.0 (dev `Voice.ts:345`).

### Hidden-audio-element keepalive verification

- **Prod:** present, indirectly. `solid-livekit-components AudioTrack` always renders a real `<audio ref={mediaEl}>` at the end (`AudioTrack.tsx:139`) and `t.attach(el)` is called inside `useMediaTrackBySourceOrName.ts:62`. When `enableBoosting && volume > 1`, the second AudioContext path mutes via `t.setVolume(0)` on the underlying audio track but the `<audio>` element is still in the DOM consuming the stream, so the Chromium WebRTC pipeline stays primed.
- **Dev:** present, explicit (`CompressedAudioTrack.tsx:75-79` — muted `<audio>` element with `srcObject = stream` and `play().catch(...)`). The bug is called out in comments. Chain only built when track is actually a `RemoteAudioTrack` (line 117).

### Not present

- No per-participant peak/RMS leveling or normalization beyond the dev DynamicsCompressor. The compressor is per-track (per-person) but not loudness-normalized — a quiet speaker still sounds quieter than a loud one.
- No output mixing bus. Each remote audio track creates its own AudioContext and connects to `ctx.destination` independently. Browser mixes them at the OS layer.
- No global output limiter. No clipping protection. With dev's default `outputVolume: 2.0` and per-user up to 3.0, total gain can reach 6× before any peaks hit destination — relies entirely on the per-track compressor (only 4:1 above -24 dBFS) and the user not boosting too hard.
- No soft ducking when local user speaks. No "auto-attenuate others while I'm talking" feature in either branch.
- No server mute / soft mute / suppress role — only client-side mute (`Voice.userMutes`) and `pub.setEnabled(false)` which tells the server to stop sending.
- No spatial / 3D audio or panning per participant.

### Honest assessment

- **Prod RX:** roughly at par with Discord baseline — per-user volume slider, per-user mute, output volume, `setSinkId` device routing. Below Discord on normalization (no auto-leveling). Below Mumble (Mumble has positional audio, talk-detection ducking). The bug-known keepalive trick is correctly handled via `t.attach(el)`.
- **Dev RX:** above Discord baseline due to per-track DynamicsCompressor — addresses the most common voice-chat complaint (Chad sounds 3× louder than Brad). Tighter `playoutDelayHint = 50 ms` is good for LAN/WireGuard but is below LiveKit's default robustness margin. Still below Mumble on positional features. Above prod.
- The per-track AudioContext-per-participant pattern is fine for ≤16 participants. For larger rooms (24+), it stops scaling — Chrome caps AudioContexts at 6 simultaneously on some platforms. Not a today-problem; will be a problem if Stoat ever hits Discord-sized rooms.

### Risks / gaps

- Loudness mismatch is unsolved — DynamicsCompressor flattens transient peaks but doesn't normalize average loudness across speakers. Discord uses a target loudness EBU R128 / -14 LUFS approach.
- Output limiter absent — a participant who publishes loud audio (mic pegged, played-back music) can clip the listener at default settings. The compressor's 4:1 above -24 dB helps but isn't a true limiter.
- No ducking — when the local user is talking, remote audio plays at full volume; conversational rhythm suffers.
- Dev's `playoutDelayHint = 0.05` (`RoomAudioManager.tsx:50`) is aggressive — on a 5% packet-loss link the NetEq buffer will adapt up but you'll get more concealments at the start of bursts.
- Output device routing: dev `CompressedAudioTrack.tsx:58-63` uses `AudioContext.setSinkId` (Chrome 110+, not in Safari/Firefox). The prod path in `solid-livekit-components AudioTrack.tsx:99-106` uses the same. **Bug** in `D:\StoatData\stoat-web-saga\packages\client\components\state\stores\Voice.ts:395` and `D:\StoatData\stoat-web-dev\packages\client\components\state\stores\Voice.ts:535` — the `preferredAudioOutputDevice` getter returns `preferredAudioInputDevice` (`return this.get().preferredAudioInputDevice;`). The output-device setting is plumbed through `useMediaDeviceSelect` paths but the persisted-store getter is broken; depending on call site this may cause output device preference to silently revert.

### Interaction with future TX-chain changes

Limited interaction. RX is largely orthogonal to TX. Two relevant points:

- If you add EQ on TX (e.g. presence-boost), inter-participant loudness mismatch worsens — RX-side normalization becomes more valuable.
- If you change DF3 / drop the gate, the resulting raw-noise levels users transmit will stress RX compressor settings. Re-tune compressor thresholds together.

---

## 3. Echo cancellation

### Current state

- **Prod:** EC enabled/disabled at two points:
  - `audioCaptureDefaults.echoCancellation` (`state.tsx:357`): forced to `false` whenever `noiseSupression` (DF3) is on; otherwise reads `state.voice.echoCancellation ?? true`.
  - `applyMicConstraints` (`state.tsx:527`): same forcing rule on settings change.
  - EC and DF3 are mutually exclusive in prod by code rule. UI confirms — `D:\StoatData\stoat-web-saga\packages\client\components\app\interface\settings\user\voice\VoiceProcessingOptions.tsx:25` greys out the EC checkbox while NS is on.
- **Dev:** EC and NS are independent (`state.tsx:790`, `1652`). Dev allows both Chrome EC and DF3 to coexist.
- Default state for new users: `echoCancellation: true` (both branches, `Voice.ts:69` prod / `Voice.ts:95` dev).
- The AEC reference signal is whatever Chromium's WebRTC stack uses — speaker audio rendered through the OS mixer. It's the standard Chrome AEC3 implementation; no custom AEC in either branch.
- Electron does not handle AEC differently from web. Both run the same Chromium WebRTC stack. There is no native loopback reference captured to feed into a software AEC.

### Not present

- No documentation or test of speaker-mode (non-headphone) behavior.
- No "AEC test tone" or "echo monitor" diagnostic UI.
- No way to opt into a stronger AEC (Speex, RNN-AEC).
- No AEC reference probe — there's no way to verify in console "what does AEC3 think it's cancelling."

### Honest assessment

- **Prod:** forcing EC off whenever NS is on is the correct move — the comment at line 355-356 documents the static-artifact rationale. But it leaves a class of users who use DF3 with speakers (no headphones) with full echo back to other participants. That's below Discord, which can run echo cancellation alongside its noise-suppression (Discord uses a separately-tuned pipeline).
- **Dev:** allowing both to coexist is more flexible but the on-the-record artifact issue (per CLAUDE.md memory entry "EC + DF3 = static") may resurface depending on DF3 wrapper version. No test harness to confirm it doesn't.
- Both branches are at par with stock Chromium AEC3 quality. Without measurement, assume below Discord/Mumble on speaker-mode echo, since both of those have invested in echo cancellation as a first-class problem.

### Risks / gaps

- Speaker users on prod with NS on: zero echo cancellation, transmit room echo to others. Unverified but structurally true.
- The "EC + DF3 = static" outcome documented in prod's comment may not reproduce on the current DF3 wrapper version — code asserts but doesn't measure.
- Dev's coexistence path is untested at scale.
- No diagnostic surface for echo. `printVoiceStats` (`state.tsx:175` prod, `427` dev) shows kbps/jitter/loss/concealed; nothing for echo return loss enhancement (ERLE) or AEC convergence.

### Interaction with TX-chain changes

- Adding mic EQ (e.g. presence boost) before AEC would degrade AEC convergence. Order matters: AEC must see mic input as close to raw as possible.
- Replacing DF3 with a different noise suppressor changes the artifact equation — the "EC must be off when NS is on" rule may become unnecessary.
- Adding pre-warm logic does not interact.

---

## 4. Voice activation (VA) vs PTT

### Current state

**PTT (both branches):**

- Settings: `pushToTalkEnabled`, `pushToTalkKeybind` (default "V"), `pushToTalkMode: "hold" | "toggle"`, `pushToTalkReleaseDelay: 0..5000ms`, `pushToTalkNotificationSounds`. See `D:\StoatData\stoat-web-saga\packages\client\components\state\stores\Voice.ts:79-83` (prod) and `D:\StoatData\stoat-web-dev\packages\client\components\state\stores\Voice.ts:115-119` (dev).
- Web hotkey only works when window focused. Desktop adds global hook via keyspy — `D:\StoatData\stoat-desktop-saga\src\native\pushToTalk.ts:329-432`. Auto-repeat suppression (line 287-292), separate handling for focused vs unfocused (line 363-365), release delay timer (line 96-114).
- IPC plumbed both ways: desktop sends push-to-talk state events to renderer (`pushToTalk.ts:60-69`); renderer can `updateSettings()` back via `window.pushToTalk.updateSettings` (state.tsx prod 94-101, dev 112-119; main-side handler `pushToTalk.ts:552-594`).
- PTT initial-state guard exists in both (web `state.tsx` prod 838: `if (!state.voice.pushToTalkEnabled) return;`).
- Settings UI: `D:\StoatData\stoat-web-dev\packages\client\components\app\interface\settings\user\voice\PushToTalkSettings.tsx` (197 lines, identical-sized in prod) — keybind input, hold/toggle switch, release-delay slider 0-5000 ms.

**VA / Input Sensitivity:**

- Prod has no VA / input gate at all. The mic publishes raw (post-DF3) audio whenever unmuted. There is no `inputSensitivity` setting in prod's `Voice.ts`.
- Dev: input gate worklet — see Section 1. Threshold stored as `inputSensitivity` (dBFS, range -100 to -20, default -60; `Voice.ts:101`, `Voice.ts:175-177`). Auto/manual via `inputSensitivityAuto` (default true; line 102).
- Auto-calibration: `#calibrateInputSensitivity` (dev `state.tsx:2252-2297`). Runs every 30 s while connected (interval set on connected listener line 837-841). Each run samples 2 s of raw mic at 100 ms slices, takes the 25th percentile (not absolute min, line 2278), pushes to a rolling history of 20 entries, takes the median, adds +12 dB headroom, clamps to `[-60, -20]`.
- History is pre-seeded with 3 copies of the stored threshold on connect (line 833-835) so the first measurement can't corrupt it.
- Manual mode UI: dev `VoiceProcessingOptions.tsx:73-87` — slider when auto is off.
- Hold time / hysteresis: in the gate worklet — `_HOLD_FRAMES = 30` (~640 ms at 48 kHz / 128-sample render quanta), `_CLOSE_RATIO = -10 dB`, attack 0.3, release 0.03 (`state.tsx` dev:202-213).
- Silero VAD layered on top as second-pass classifier (`state.tsx` dev:1804-1870). Default `useSileroVad: true` (`Voice.ts:103`). Loaded from `/silero/` self-hosted assets. Acts as hold-extender only — does not block onset (`state.tsx` dev:214-221, comment is explicit).

### Not present

- No calibration UI in either branch. Auto-calibration is silent (logs only). The auto-detected threshold is not surfaced — even with manual slider hidden behind `Show when={!state.voice.inputSensitivityAuto}` (dev `VoiceProcessingOptions.tsx:73`), the user can't see what auto picked.
- No live mic-level meter anywhere in settings UI.
- No speech-onset latency measurement. Anecdotally with `_ATTACK = 0.3` you get ~10 ms ramp-up; not visible to user.
- Prod has no VA at all. This is the biggest gap.

### Honest assessment

- **Dev VA:** above Discord on technical surface (RMS gate + Silero hold-extender + auto-calibration with rolling history), at or below on UX (no live meter, calibration is silent). The auto-calibration is genuinely better than Discord's "input sensitivity" slider, which is purely manual.
- **Prod VA:** nonexistent. Below Mumble's stock VAD. Users on prod must either use PTT or transmit constantly.
- The Silero hold-extender pattern (dev `state.tsx:214-221`) is well thought out — original AND-gate design swallowed sentence onsets; the fix is documented.

### Risks / gaps

- Whisper-quiet input: auto-calibration is clamped at -60 dBFS minimum (line 2290). Genuinely-quiet voices below that floor will not open the gate. Manual mode allows -100 dBFS.
- Background talker: any other voice in the room within the bandpass detector window opens the gate. Silero filters non-speech (typing, sneezes) but not actual speech from another speaker.
- 30-second calibration cadence is fast enough for most situations but doesn't react to a sudden noisy environment (e.g. someone turning on a loud fan mid-call). Would need to wait 30 s for next sample.
- Hardcoded headroom of +12 dB (line 2290) — no setting to make gate more or less aggressive. A user with a hot mic preamp may want -6 dB; a user in a quiet room may want +20 dB.
- The 25th percentile sampling is a clever-but-magic number. Not exposed for tuning.

### Interaction with TX-chain changes

- VA/gate is the sample-rate-locked first stage of the TX chain after `getUserMedia`. Anything inserted before it (mic EQ, pre-emphasis) will need to feed both the clean path and the bandpass-detector path, or you'll have to re-tune the gate threshold.
- Replacing DF3 with another suppressor doesn't directly interact with VA, but the 0.002 linear bleed in the gate (`state.tsx:264`) is there to keep DF3 warm — different suppressors may not need that, allowing actual silence.
- Pre-warm logic could include warming up Silero (~6 MB ONNX load on first attach is slow, line 1815-1834).

---

## 5. Device handling

### Current state

- No `navigator.mediaDevices.devicechange` listener anywhere in Stoat application code. Searched both branches, no matches.
- `solid-livekit-components` provides `useMediaDeviceSelect` (`...\src\signals\useMediaDeviceSelect.ts`) which calls into `@livekit/components-core`'s `createMediaDeviceObserver`. That library does subscribe to `devicechange`, but only updates the device list in the settings UI — it does not trigger a track restart on device disappearance.
- No code path in prod or dev recovers from active mic unplug. When a USB mic is yanked mid-call:
  - Browser fires `ended` on the underlying `MediaStreamTrack`.
  - LiveKit's internal handling may or may not re-acquire the new default device — see livekit-client v2 internals; this is not Stoat code.
  - Stoat does not wrap or handle this event.
- No code path detects sample-rate change when switching between 16 kHz HFP (Bluetooth headset profile) and 48 kHz A2DP. The `AudioContext({ sampleRate: 48000 })` in dev (`state.tsx:1622`, `1517` for app audio, `397` for `measureDbfs`) is fixed.
- No code path adapts processing for low-quality input. DF3 and the gate are applied unconditionally regardless of device class.

### Not present

- No `devicechange` handler.
- No "active mic unplugged → reacquire" logic.
- No Bluetooth profile detection.
- No sample-rate auto-detect (input is always assumed 48 kHz; `getUserMedia` doesn't pin sample rate).
- No quality-class branching (e.g. "if BT mic detected, lower DF3 aggressiveness").
- No visual indicator when active device changes mid-call.

### Honest assessment

Below Discord and below Mumble. Discord aggressively switches devices and reacquires; Mumble has explicit BT handling. Stoat is stuck with whatever LiveKit does internally, which is functional for most cases but doesn't try to do better. If a user plugs in a headset mid-call, behavior is undefined from Stoat's perspective.

### Risks / gaps

- Bluetooth headsets routinely renegotiate to HFP (16 kHz mono, garbage quality) when the call begins on Windows. With no detection, the user transmits 48 kHz upmixed-from-16 kHz audio with DF3 trained on 48 kHz — model mismatch, audible artifacts likely.
- USB mic disconnect mid-call: at minimum, `getStats` will show 0 packets — but no UI surface alerts the user.
- The `preferredAudioOutputDevice` getter bug noted in section 2 means the persisted output device may revert to default on reload.

### Interaction with TX-chain changes

- Adding pre-warm logic almost certainly should include `enumerateDevices()` and a `devicechange` listener. This is the right place to fix.
- Mic EQ presets per device class would land here.

---

## 6. Network resilience

### Current state

- LiveKit Room constructor in both branches doesn't tune the jitter buffer beyond dev's `playoutDelayHint = 0.05` per receiver (`RoomAudioManager` dev:50). Prod has no `playoutDelayHint` adjustment.
- No `adaptiveStream`, no custom `reconnectPolicy`. Defaults from `livekit-client v2.13`.
- `dynacast: true` (`state.tsx` prod:342, dev:777) — server-side simulcast layer skipping for video.
- `red: true` and `opusFec: true` (Section 1) — application-layer redundancy for audio.
- `dtx: false` and `opusDtx: false` — packet rate stays steady at ~50 pps even during silence.
- Reconnection: handled by livekit-client's built-in logic. State machine in `state.tsx`:
  - `room.addListener("reconnecting", ...)` → `setState("RECONNECTING")` (prod:409, dev:844).
  - `room.addListener("reconnected", ...)` → `setState("CONNECTED")`.
  - `room.addListener("disconnected", ...)` → `setState("DISCONNECTED")` and clears stats maps.
- No code-level retry logic, backoff, or fallback. Pure LiveKit defaults.
- Prod uses `autoSubscribe: false` (line 489), then `setSubscribed(true)` per track in `RoomAudioManager`. Dev uses `autoSubscribe: true` (line 985-987) — VAD-improvement-#10 in comments — for faster first-audio-frame.
- `printVoiceStats` shows RTT, jitter, packets received/sent, concealed%, kbps. No GC of state on reconnect mid-session.
- Sender `networkPriority = "high"` in dev (line 894-898) — DSCP marking hint to QoS-aware routers.

### Not present

- No application-level retry beyond what livekit-client does.
- No "we're on a bad network, halve bitrate" logic.
- No bursty-loss specific tuning — the jitter buffer behavior is pure NetEq defaults.
- No metric on FEC effectiveness (e.g. "x% of packets recovered via FEC").
- No region/server failover (the voice-server channel description tag in `state.tsx:475-483` picks a region but doesn't fail over).

### Honest assessment

At par with stock LiveKit / WebRTC defaults. WebRTC NetEq is industry-best — both Discord and Mumble use the same underlying components. The dev branch's `playoutDelayHint = 50 ms` is a reasonable conversational-feel choice but trades robustness for latency. Below Discord in the absence of any reconnection / region failover logic; Discord's client retries servers actively. At par with Mumble for resilience (Mumble similarly does not have aggressive client-side failover).

### Risks / gaps

- Bursty loss on `playoutDelayHint = 0.05`: NetEq adapts up but you'll see concealment spikes at the start of bursts, audible as "wibbling" on the first 50-100 ms of a packet burst.
- LiveKit reconnect fires aggressively — if the underlying network is flapping, the state churns CONNECTING/CONNECTED/RECONNECTING repeatedly; UI doesn't debounce.
- No ICE restart triggered manually if STUN/TURN gets blocked partway through a call.

### Interaction with TX-chain changes

Limited. TX changes don't typically touch jitter buffer or transport. The one exception:

- DTX changes — current setting `dtx: false` and `opusDtx: false` means continuous 50 pps. If someone adds DTX back to save bandwidth, the silent-vs-active transitions may interact poorly with FEC + RED.

---

## 7. Cold start / first-utterance UX

### Current state

**Pre-warm logic: none in either branch.**

- DF3 (`DeepFilterNoiseFilterProcessor`) is constructed and attached after the mic publishes — see `state.tsx` prod:393-403, dev:909-916. The `.onnx` models are loaded from `/df3-assets` at that moment.
- Silero VAD is loaded on demand in dev — `await import("@ricky0123/vad-web")` plus `MicVAD.new(...)` (`state.tsx` dev:1815-1819). First-time cost: ~5 MB ONNX runtime + ~1 MB Silero model. Loaded from `/silero/` self-hosted (line 1820).
- AudioContext for the input gate is constructed at first `#applyInputGate` call — inside the user-gesture chain on initial join (dev `state.tsx:1592-1605` explains why context is created in-gesture).
- Opus encoder: nothing pre-warmed; created by Chromium WebRTC on first publication.

**Join tone:** yes, both branches play `join_call.mp3` via `voiceNotifications.playSelfJoin()` immediately on connected (`state.tsx` prod:406, dev:830). The MP3 is preloaded on first-user-interaction (`VoiceNotifications.ts:46-60` prod). This does mask a portion of the cold-start latency.

### "Click join → transmitting clean audio" timeline (informed estimate)

1. ~50-100 ms: WebSocket auth + `room.connect`.
2. ~50-200 ms: ICE gathering and DTLS handshake.
3. ~200-1000 ms: `getUserMedia` first-mic-permission grant (one-time; later joins skip).
4. ~50-100 ms: track publish + SFU forwarding setup.
5. ~50-500 ms: DF3 model load from `/df3-assets` (first call only; browser-cached after).
6. ~500-3000 ms: Silero load (dev only, first call only; `/silero/` self-hosted).
7. ~50-300 ms: gate auto-calibration first window (2-second sample, dev).

On a warm cache, second-join in same session: ~300-500 ms to "publishing." Cold first-ever-join: 1.5-3 s with all the model downloads.

DF3 also has a per-frame ~72 ms latency baked in (debug capture metadata `dfn3LatencyMs: 72` in `state.tsx:2148`), which is signal latency once active.

### Not present

- No DF3 pre-load on app start.
- No Silero pre-load.
- No AudioContext warming (the in-gesture creation in dev is for context-state stability, not pre-warming).
- No Opus encoder warm-publish.
- No "join silently and only start transmitting once warm" pattern.

### Honest assessment

Below Discord on cold-start. Discord pre-warms its VAD/AGC models and audio devices on app load. Stoat does not. The join-tone helps mask latency perceptually but does not fix it.

The Silero on-demand load is a deliberate "don't pay the 6 MB cost unless the user uses voice" choice — defensible UX. But once the user does turn it on, the next join still pays it.

Above-par detail: the dev branch's note about Chrome AudioContext gesture-policy interaction (`state.tsx` dev:1592-1605) suggests the team has hit cold-start bugs and patched specific instances. But there's no general pre-warm framework.

### Risks / gaps

- First voice join after browser restart: slowest, ~2-3 s before clean audio starts. The first ~200 ms of speech may be transmitted pre-DF3 (mid-attach race).
- If `room.localParticipant.setMicrophoneEnabled(true)` resolves before DF3 finishes attaching, you can hear raw mic audio briefly. Code doesn't guard against this race (`state.tsx` dev:824 fires the `.then setProcessor` lazily off `localTrackPublished`).
- Silero load failure falls back to RMS-only gate but with a console warn only (line 1839) — no UI surface.

### Interaction with TX-chain changes

Big interaction surface for any pre-warm change. Pre-warm should:

- Boot DF3 with a silent track once on app startup to populate model cache, then immediately tear down.
- Boot Silero on first voice settings open to amortize the 6 MB cost.
- Pre-create the input gate AudioContext and load the worklet modules during a click anywhere (use a deferred user-gesture queue).
- Avoid pre-creating an AudioContext outside any user gesture — it'll suspend forever (the comment at dev `state.tsx:1593-1604` spells this out).

Adding a join-tone pre-roll that's longer than today's 500 ms would visually mask the slow path further.

---

## 8. Cross-platform parity

### Web vs Electron audio differences

- TX/RX audio path is identical web ↔ Electron (Electron embeds Chromium; same WebRTC stack).
- Screenshare differs significantly:
  - **Web:** `room.localParticipant.setScreenShareEnabled(true, ...)` standard `getDisplayMedia` flow (dev `state.tsx:1453-1466`).
  - **Electron:** `window.desktopCapture.listSources()` IPC → custom picker UI → `getUserMedia` with `mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId, minFrameRate, maxFrameRate, minWidth, ... }` (dev `state.tsx:1307-1360`). This is the only path that honors `frameRate` constraints; `setDisplayMediaRequestHandler` in Electron's main process delivers ~2 fps regardless. The custom path also lets `contentHint = 'motion'` and `degradationPreference = 'maintain-framerate'` be applied (lines 1366, 1399-1411).
  - Electron also has SDP munging (`mungeSdpGCC`, dev `state.tsx:586-602`) to inject `x-google-start-bitrate=6000;x-google-min-bitrate=2000` to short-circuit GCC slow-start.
- Per-process audio capture (Windows): Electron-only via `application-loopback` native module (`D:\StoatData\stoat-desktop-saga\src\native\appAudioCapture.ts`). Renderer hooks into `window.appAudioCapture` (`state.tsx` prod:39-46, dev:55-62). Captured PCM is fed to a `pcm-feeder` AudioWorklet (`state.tsx` prod:126-155 / dev:150-188) which converts to a `MediaStreamDestination` track, then published as `Track.Source.ScreenShareAudio`. Replaces the loopback audio that would otherwise be captured for the screen.
- Push-to-talk: web has `window.pushToTalk` integration only when running inside Electron (`state.tsx` prod:830, dev:2352 check `window.pushToTalk`). The native PTT lives entirely in Electron — keyspy global key listener (`pushToTalk.ts:329-432`).
- Title-bar / window controls: Electron-only. Not directly audio-related.

### Native modules touching audio

- **keyspy** — global keyboard listener for unfocused PTT (`pushToTalk.ts:18-30`). Indirect — no audio data, just state.
- **application-loopback** — per-process audio capture (`appAudioCapture.ts:16-44`). Direct.
- No other native modules touch audio.

### Build / dependency parity

- `livekit-client` declared `^2.13.0` in both prod + dev `package.json` (`state.tsx` prod:103, dev:106).
- `deepfilternet3-noise-filter` declared `^1.1.4` in both. Actual installed in dev: 1.2.1 (`node_modules/deepfilternet3-noise-filter/package.json`); not installed locally in prod — built via Docker.
- `@ricky0123/vad-web ^0.0.30` — dev only.
- Desktop app currently 1.5.9 per `CLAUDE.md`.

### Routing differences

- All voice traffic goes through Chromium WebRTC in both web and Electron. There is no native voice routing in Electron (no native UDP, no native Opus encoder, no native AEC). This means everything that's true about Chrome's WebRTC stack — AEC3 quality, jitter buffer behavior, codec selection — is true identically in both.

### Not present

- No native microphone access path bypassing WebRTC (e.g. a CoreAudio direct-input node).
- No native Opus encoder.
- No native AEC reference (system mix capture).
- No native low-latency audio I/O on macOS/Windows.

### Honest assessment

- Cross-platform parity is good for audio specifically — same Chromium = same behavior.
- The screenshare divergence is well-architected: the Electron path is a deliberate workaround for the slow `setDisplayMediaRequestHandler` path. The SDP munging and content-hint manipulation are sophisticated.
- Below Discord on system-audio capture ergonomics — Discord has cleaner per-app capture; Stoat's Windows-only `application-loopback` is functional but binds to HWND lookups (`appAudioCapture.ts:51-69`). Linux and macOS get nothing.
- Native PTT via keyspy is fine but depends on a third-party module being unpacked from asar (lines 21-32 fallback path). One more failure mode for users.

### Risks / gaps

- Windows-only per-process audio. macOS/Linux Electron users get loopback for the whole screen, not the focused window.
- keyspy runs as a child process (line 351-358) — if it crashes mid-call, PTT silently breaks. There's a watchdog (lines 351-358) but only logs.
- DF3 wrapper version drift between prod's `^1.1.4` declaration and dev's actual 1.2.1 install means an in-place pnpm install on prod could change DF3 behavior unexpectedly.

### Interaction with TX-chain changes

- Any TX change affects both web and Electron equally — no platform-specific TX divergence to worry about.
- Adding native AEC (e.g. Windows core audio reference loopback) would land in Electron-only.
- Changes to per-process audio path are Electron-only.

---

## 9. Diagnostics and observability

### Current state

**Voice diagnostic auto-print (both branches):**

- `printVoiceStats(room, df3Active)` defined at `state.tsx` prod:175-269 and dev:427-581. Called every 30 s while connected (interval setup `state.tsx` prod:951-958, dev:2473-2480) and on-demand via `window.stoatDiag()` (prod:938, dev:2460).
- Reports per upload (mic): pps (expect ~50), kbps, packetsSent, RTT, jitter, fractionLost.
- Per remote receiver: jitter, loss%, concealedSamples delta as % of totalSamples (the wibbling indicator), kbps, mute state.
- Dev adds: per-screenshare outbound-rtp video stats (resolution, fps, kbps, qualityLimitationReason — dev `state.tsx:474-499`).
- Dev adds: signal-level metering at four taps — local (raw mic, pre-gate), local (post-gate, pre-DF3), local (post-DF3, transmitted), and per-remote (dev `state.tsx:548-578`). Uses 150 ms `getFloatTimeDomainData` sample (dev `state.tsx:395-416` `measureDbfs`).
- DF3-active flag printed (`Pipeline: DF3=✅/❌`).

**Debug capture ([dev only]):**

- Settings UI: `D:\StoatData\stoat-web-dev\packages\client\components\app\interface\settings\user\voice\VoiceProcessingOptions.tsx:181-228`. Gated behind `isDebugCaptureBuild()` (DEV mode or env-var `__STOAT_DEBUG_CAPTURE__ === "1"` injected by `docker/inject.js`; see `debugCapture.ts:167-172`).
- Captures 5 sample-aligned WAVs of the outgoing pipeline for 30 s (dev `state.tsx:1951-2230`, `armDebugCapture`):
  1. `01_raw_mic.wav` — pre-bandpass, post-getUserMedia (raw mic source).
  2. `02_post_bandpass.wav` — bandpass-filtered detector input.
  3. `03_post_gate.wav` — gate output, pre-AGC.
  4. `04_post_agc.wav` — AGC output (or 5 ms-delayed bypass when AGC disabled), pre-DF3.
  5. `05_post_dfn3.wav` — final transmitted audio (omitted if DF3 inactive).
- All recorders attached to the same `#inputGateCtx` so first-sample timing is render-quantum-aligned (variance ≪ 1 ms).
- Outputs a `metadata.json` with `captureVersion: 2`, sampleRate, framesRecorded per file, `dfn3LatencyMs: 72`, the gate constants, and the user's voice settings snapshot (dev `state.tsx:2132-2168`).
- IPC: renderer → main `debug-capture:pickDir` (folder picker) and `debug-capture:writeBundle` (ArrayBuffer → file). Handlers in `D:\StoatData\stoat-desktop-saga\src\native\debugCapture.ts:31-72`. Subfolder name regex-validated.
- Re-entrancy locked via `applyMicConstraints` deferral (dev `state.tsx:1026-1029`).

**Runtime metrics:**

- Pure console logs. No telemetry export, no Prometheus endpoint, no remote logging.

**A/B testing harness:**

- None. The Stoat AGC vs Chrome AGC choice is a manual user setting (dev `Voice.ts:476-500` mutual exclusion). No blinded comparison, no metric collection.

### Not present

- No persistent log of voice diagnostics (just console).
- No telemetry export to a backend.
- No A/B harness.
- No "voice quality score" metric aggregation.
- No automatic anomaly detection (e.g. "concealed% > 10%, alert user").
- No live waveform / level meter UI — `printVoiceStats` is text-only.
- No prod-build access to debug capture (gated behind env flag).

### Honest assessment

Above Discord on outgoing-pipeline visibility for developers. The 5-stage WAV capture with metadata is genuinely better than what Discord's docs describe — Discord's "voice debug" gives RTC stats but not signal-domain captures. Below Discord on user-facing diagnostics — Discord shows live dB meters and connection-quality icons; Stoat shows none.

The 30-second auto-print to console is fine for development but useless for users diagnosing problems. Below Discord's UX.

### Risks / gaps

- Console-only logs mean a user who reports a voice bug must DevTools-grab logs by hand. No "Send diagnostics" button.
- The per-track-receiver stats logging may include PII (track IDs, identities, server URLs). If the user pastes logs to a public channel, this could leak.
- Concealed% calculation uses `r.concealedSamples` and `r.totalSamplesReceived` which are not tracked by `RTCRtpReceiver` on all browsers — Firefox returns undefined, prints 0.0. Diagnostics will be falsely-reassuring on Firefox.
- Auto-print every 30 s spams the console group — easy to lose in a noisy log.

### Interaction with TX-chain changes

- The debug capture is the most useful tool for any TX-chain change. Adding a new processing stage means adding a new tap point. The capture-version field is already there for forward compat (`captureVersion: 2`).
- Would be the natural place to add LUFS / true-peak measurements per stage.

---

## 10. Settings / UX surface

### Settings exposed (defaults in parens)

**Both branches:**

- Microphone device selector (default = "default") — `VoiceInputOptions.tsx`.
- Speaker device selector (default = "default") — same file.
- Output Volume slider 0–3 step 0.1 (prod default 1.0, dev default 2.0) — `VoiceInputOptions.tsx:131-138`.
- Echo Cancellation toggle (default true).
- Noise Suppression toggle (default true).
- Automatic Gain Control toggle (prod default true via `autoGainControl`).
- Push to Talk: enabled toggle (default false), keybind ("V"), mode ("hold"), release delay (0–5000 ms, 250 default), notification sounds (default false).
- Notification sounds: master toggle, master volume slider 0–1 (default 0.3), 11 individual toggles for each event sound. UI: `NotificationSoundsSettings.tsx` (339 lines, identical between branches).
- Per-user volume / mute via `UserContextMenu.tsx`.
- Per-screenshare volume via `VoiceCallCardActiveRoom.tsx`.

**Prod-only:** the `autoGainControl` toggle (single AGC) — `VoiceProcessingOptions.tsx:34-43`.

**Dev-only [dev only]:**

- Input Sensitivity panel (`VoiceProcessingOptions.tsx:60-87`):
  - "Automatically determine input sensitivity" toggle (default true).
  - Sensitivity Threshold slider -100 to -20 dBFS (default -60), only when auto is off.
- Suppression Level slider 0-100 step 5 (default **25** as of build 44; was 40 at audit time) under NS toggle (`VoiceProcessingOptions.tsx:101-114`).
- Chrome AGC toggle (default true) — separate from Stoat AGC, mutually exclusive (`Voice.ts:480-500`).
- Stoat AGC (experimental) toggle (default false), with target loudness slider -30 to -6 dBFS (default -18, line 152-166).
- Smart Voice Detection (Silero VAD) toggle (default true; line 167-179).
- Debug capture (gated build) (line 181-228).
- Screen Share Settings panel (`ScreenShareOptions.tsx`):
  - Quality dropdown (low/high/4k).
  - "Always ask for quality before sharing" toggle.

### Power-user-hidden vs surfaced

**Hidden / surfaced inconsistently:**

- DF3 noise reduction level (0-100) → surfaced in dev, hidden in prod entirely.
- Input gate hold frames, attack, release, close ratio → hardcoded constants, not exposed.
- Stoat AGC max gain (+18 dB), min gain (-12 dB), silent threshold (-50 dBFS) → hardcoded, not exposed (dev `state.tsx:1707-1711`).
- AGC attack/release timings → hardcoded.
- Auto-calibration cadence (30 s), window size (2 s), p25, +12 dB headroom → hardcoded.
- Silero load failure → console warn only.
- `playoutDelayHint = 50 ms` (dev) → hardcoded.

### Not present

- No live mic-level meter / dB readout in UI.
- No "test microphone" button.
- No per-user equalizer / per-user processing profile.
- No "ducking" toggle / amount.
- No output limiter toggle / threshold.
- No "voice quality" indicator surfacing (other than livekit's `connectionQuality` enum logged to console, `state.tsx` prod:458, dev:949).
- No language / region preference (LiveKit voice-server tag exists but isn't a user-facing setting — set by server description, `state.tsx:475-483`).

### Honest assessment

- **Dev settings UX:** roughly at-par with Discord on count of toggles, above Discord on signal-chain visibility (no other voice client exposes a "Stoat AGC vs Chrome AGC" choice with explanatory tooltips). The description strings in `VoiceProcessingOptions.tsx:132-178` are actually written for users, not just devs — that's better than typical.
- **Prod settings UX:** below Discord — three checkboxes (NS / EC / AGC) and two device pickers. No level meter, no calibration, no granular controls.
- Power-user-hidden: a lot. The gate constants would arguably be useful to expose for the kind of user who cares (broadcaster, podcast guest). But shipping them risks support burden.
- The AGC mutual-exclusion logic in dev `Voice.ts:480-500` (toggling one auto-disables the other) is a UX choice that's fine but un-discoverable. The user can also turn both off — silently — and end up with no gain control at all.

### Risks / gaps

- No live mic meter during settings = users tune blindly. Discord's pre-call mic test is missed here.
- The hard-coded +12 dB auto-calibration headroom (`state.tsx:2290`) is undiscoverable; users who think auto isn't sensitive enough have no recourse but to switch to manual.
- **Bug:** `preferredAudioOutputDevice` getter returns input device value (`Voice.ts` prod:395, dev:535). Live UI uses `useMediaDeviceSelect` from solid-livekit-components which goes through `LiveKit Room.getActiveDevice`; the persisted store getter is broken but may not be load-bearing (depends on call sites).

### Interaction with TX-chain changes

Heaviest interaction surface. Any TX change that affects perceived loudness, latency, or noise rejection requires:

- Re-tuning defaults in `Voice.ts:default()`.
- Updating UI descriptions (`VoiceProcessingOptions.tsx`).
- Considering new toggles for opt-in.
- Potentially exposing previously-hardcoded gate / AGC parameters.

---

## Final summary

### Single biggest gaps

1. **Prod is missing the entire dev TX pipeline.** Input gate, Silero VAD, Stoat AGC, NS level slider, auto-calibration, debug capture, per-track RX compressor — none of it has shipped. If "production users" is the audience, the audit's de-facto subject is stoat-web-dev not stoat-web-saga.
2. **No `devicechange` listener anywhere.** Mid-call mic unplug, BT headset profile switching, USB pop-out are all undefined-behavior. Stoat just defers to LiveKit defaults.
3. **No mic-level meter in any settings UI** in either branch. Users tune sensitivity/AGC blindly.
4. **No output limiter** even though dev's `outputVolume` default is 2.0 with per-user up to 3.0; total gain ≥ 6× is achievable. Per-track 4:1 compressor at -24 dBFS is the only protection.
5. **No pre-warm of DF3 / Silero / AudioContext.** First-ever join after browser restart pays the full ~2-3 s cold-start cost; first 200 ms of speech may publish pre-DF3.
6. **Bug:** `preferredAudioOutputDevice` getter returns input-device value (`Voice.ts` prod line 395 / dev line 535). Output preference may silently revert.
7. **No echo cancellation when DF3 is on (prod).** Speaker-mode users transmit echo. Dev allows coexistence but is not test-verified.
8. **No A/B harness** for the Chrome-AGC vs Stoat-AGC choice — it's a user-facing toggle without a "recommended" answer.
9. **`@ricky0123/vad-web` runs at 16 kHz internally** and consumes a clone of the 48 kHz raw mic. Per-instance ONNX runtime + Silero model is ~6 MB load; default-on means everyone pays even if they prefer pure RMS gating.
10. **No telemetry / no "send diagnostics" button.** Voice issues require DevTools console capture by hand.

### Things that are surprisingly fine

- **Opus codec settings.** `dtx:false` at both signaling and codec level, `red:true`, `opusFec:true`, `opusMaxPlaybackRate:48000`, 128 kbps. The team has been here, suffered the bug, and the comments explain why each flag is set — both branches.
- **Input gate hysteresis design (dev).** Dual-threshold (`_CLOSE_RATIO = -10 dB`), bandpass-detector-only, Silero-as-hold-extender (not AND-gate), -54 dBFS bleed to keep DF3 warm. Each design decision is annotated in source.
- **AudioContext reuse pattern** (dev `state.tsx:1592-1605`). The Chrome gesture-policy bug is well-understood and solved by reusing the context across rebuilds. This is the kind of bug most teams ship without ever realizing exists.
- **Per-track AudioContext keepalive `<audio>` element.** Both prod (via solid-livekit-components's `t.attach(el)`) and dev (explicit muted `<audio>` in `CompressedAudioTrack.tsx`) preserve the Chromium-bug workaround. Dev calls it out in source comments.
- **Debug capture infrastructure.** Sample-aligned 5-stage WAV dump with metadata bundle is a quality piece of dev tooling.
- **Diagnostic logging.** `printVoiceStats` is comprehensive, the concealed% measurement is the right one for diagnosing wibbling, and the dev-side per-stage `measureDbfs` taps are useful.
- **PTT release-delay handling (Electron).** Auto-repeat suppression, focused-vs-keyspy split, deactivation timer — all carefully implemented in `pushToTalk.ts`.
- **GCC SDP munging for screenshare (dev).** `mungeSdpGCC` injecting `x-google-start-bitrate=6000` skips the 3-minute slow-start. Sophisticated.
- **`networkPriority = "high"`** on `RTCRtpEncodingParameters` (dev `state.tsx:894-898`). DSCP marking hint applied per-encoding. Not many WebRTC apps do this.
- **DF3 + EC mutual exclusion (prod).** The "they conflict and produce static" rule is encoded and the UI greys out EC accordingly. May be overly conservative now but it's correct as written.
