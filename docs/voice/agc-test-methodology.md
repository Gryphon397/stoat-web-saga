# Stoat Voice — AGC Test Methodology

**Beads:** Voice/B4 (leveler), Voice/B3 (DF3 default). Companion to
[target-architecture.md](target-architecture.md) and parallel to
[aec-test-methodology.md](aec-test-methodology.md).

The leveler replaces the legacy envelope-follower AGC for users who opt in
via `useStoatAgc=true`. This doc is the verification path before flipping
the default. Tests are run blind through the H2 A/B harness so listener
preference and the empirical observations drive the call, not internal
metric tuning.

---

## What we're comparing

Three configurations, run pairwise through H2. The variable is which AGC
implementation is active; everything else (mic, room, DF3 level=25 post-B3,
input sensitivity, gate hold) is held constant.

| ID | useStoatAgc | B4 kill switch | Implementation                                       |
|----|-------------|----------------|------------------------------------------------------|
| C1 | false       | n/a            | Chrome AGC (current default)                         |
| C2 | true        | **set**        | Legacy Stoat envelope-follower AGC (`stoat-agc`)     |
| C3 | true        | unset          | B4 K-weighted leveler + sample-peak limiter (`stoat-leveler`) |

The H2 harness records two 10 s passes back-to-back; record one config per
pass, then play blind. Run the three pairings (C1 vs C2, C1 vs C3, C2 vs
C3) over enough trials to build a preference signal.

Kill switch flip requires a reload (worklet selection happens at
`#applyInputGate` time). Plan the run order so you change settings, flip
the switch, reload, rejoin — then capture.

---

## Test stimulus

30 seconds of speech mixing the three loudness regions and at least one
deliberate transient. Record from the test rig microphone — speak into
the mic naturally, don't play a file back through speakers (that
introduces AEC into the loop and tangles the comparison).

Section breakdown:

- **0–10 s — quiet conversational speech.** Close-mic'd, soft. The
  leveler should pull this up toward target without pumping room tone
  during the brief pauses.
- **10–20 s — moderate conversational speech.** Normal speaking volume.
  Tests the leveler at near-target loudness; expect minimal gain change.
- **20–25 s — loud passage with a deliberate burst.** Raise your voice,
  include at least one transient peak (clap, "PAH!", door bump). Tests
  attack behavior and the peak limiter at -1 dBFS.
- **25–30 s — return to quiet.** Tests release behavior — gain should
  return to its quiet-speech value, not stay pinned at low gain.

Save the H2 clips in memory (the harness doesn't disk-write). Each
configuration's pass is its own 10 s recording — you'll capture three
stimuli for each config, one per loudness region, and compare via H2.

Alternative: a single 30 s pass that spans all three regions, captured
twice (once per config) via the 30 s debug capture flow instead of H2.
That gives you analyzable WAVs but no blind A/B — useful for offline
analysis but doesn't drive the listener-preference decision.

---

## Listening criteria

Rate each clip on the four dimensions below. Score 1–5 where 5 = ideal.
Vote per H2 round only when one clip clearly wins on the aggregate.

1. **Smoothness on loud passages.** The loud burst should sound
   level-controlled but natural — no audible clipping, no momentary
   "swallow" as gain crashes down, no audible pumping post-transient.
   - **C1 (Chrome AGC):** baseline; aggressive, can sound "pumpy."
   - **C2 (legacy):** smoother than Chrome on transients due to 5 ms
     lookahead, but the basic envelope follower can chase noise.
   - **C3 (B4 leveler):** 50 ms attack + -1 dBFS peak limiter; should
     sound smoother than C1, comparable to C2 on the transient, but
     more consistent in overall level.

2. **Absence of pumping.** Listen for gain breathing during the quiet
   sections, especially the 0–10 s and 25–30 s segments. The leveler
   freezes during silence (see "Frozen during VAD-closed periods" in
   the worklet code), so room tone should NOT pump up between phrases.
   - **C1:** Chrome AGC's auto-disable during silence is documented;
     may pump anyway between sentences.
   - **C2:** explicit silent-threshold freeze; should be quiet.
   - **C3:** same silent-threshold pattern; should match or beat C2.

3. **Preservation of quiet speech audibility.** The 0–10 s segment
   should be raised toward target loudness. If it sounds the same
   relative volume as the 10–20 s moderate segment, the leveler is
   working. If quiet speech still sounds quiet, gain isn't reaching it.
   - **Failure mode**: if release is too slow (>2 s), quiet speech
     after a loud burst may stay attenuated. The 25–30 s segment tests
     this — if the quiet end sounds compressed, release tuning is off.

4. **Perceived loudness consistency across the clip.** A listener
   should not need to adjust their output volume between the 0–10 s
   and 20–25 s segments. This is the headline goal of a leveler;
   commercial voice chat normalizes for this.
   - The reference is your own subjective impression of "is this
     evenly loud," not a meter reading. Discord-target perception.

---

## Procedure

For each pairing (C1 vs C2, C1 vs C3, C2 vs C3):

1. Configure Stoat per the first config of the pair (settings → voice
   processing; flip B4 kill switch in DevTools if needed; reload).
2. Join a 1:1 voice channel.
3. Open Settings → Voice Processing → Debug section → **A/B harness
   (record two passes)**.
4. Record Pass A while speaking the 30 s stimulus (split into three
   10 s rounds: quiet, moderate, loud, captured separately as Pass A
   per round, OR record one 10 s segment that covers all three).
5. Hit "Adjust settings…" — flip to the second config of the pair,
   reload if a B4 kill switch flip is involved (the harness state
   doesn't survive reload, so you'd lose Pass A — preferred: do all
   reloads BEFORE arming the harness). Practical workflow:
   - For C1 vs C2: settings flip only (useStoatAgc), no reload needed
     because both worklets are registered and live-toggleable via
     port. The kill switch determines which is *attached*, but the
     useStoatAgc port flag determines `enabled`. Between Chrome AGC and
     legacy Stoat AGC, the on-air implementation is just the
     useStoatAgc toggle.
   - For C1 vs C3 and C2 vs C3 with the leveler involved, you need to
     decide upfront which run (which kill-switch state) is the session.
     Practical: pick one B4 state, reload, do all harness rounds
     against that state, then flip, reload, do another session.
6. Record Pass B.
7. Play Clip 1 and Clip 2 blind. Score per criteria above.
8. Hit Reveal. Cast vote if one clearly won.
9. Log: configs, scores, preferred clip, brief note on which criterion
   drove the call.

Run at least three rounds per pairing to mitigate single-trial bias.
H2's crypto-random label assignment handles A/B identity blinding.

---

## What "B4 ships" looks like

Default flip (useStoatAgc=true by default, B4 as the implementation)
happens in a follow-up bead, not this PR. The bar for that flip:

- C3 beats C1 on smoothness and pumping in ≥ 60 % of paired trials.
- C3 ties or beats C2 on smoothness and quiet-speech preservation in
  ≥ 60 % of paired trials.
- No regression on perceived loudness consistency relative to either
  baseline.
- The diagnostic gain readout (window.stoatDiag → "Leveler (B4):
  gain=X dB, peak-limiter=Y dB") shows the leveler operating within
  expected bounds — not pinning at +12 dB rail constantly (signal too
  quiet), not at -6 dB rail (signal too hot — let the limiter handle
  it instead).

If C3 loses to C2 on a specific dimension, the gap drives the next
tuning round. Likely candidates: attack time (50 ms might be too slow
on transients), release time (1500 ms might be too slow on quiet
recovery), target loudness (-20 LUFS-S vs -23 LUFS-S vs higher).

---

## Diagnostic surface

While testing, watch the dev-tools console for:

- `[stoat-dev] build 44` — confirms the B3+B4 build is loaded.
- `[Voice/A2] active` (or `disabled via kill switch`) — confirms the
  A2 pipeline state for context.
- Every 30 s when in a voice channel: `Leveler (B4): gain=+X.X dB,
  peak-limiter=Y.Y dB` — only emitted when the leveler is the active
  worklet and `useStoatAgc=true`. If you see this line missing while
  in C3, the leveler isn't running.
- `window.stoatDiag()` for an on-demand snapshot of the same.

---

## Run log

Captures and notes for each run go here, latest at top.

| Date | Pairing | Stoat AGC | B4 kill | Winner | Drivers | Notes |
|------|---------|-----------|---------|--------|---------|-------|
| —    | —       | —         | —       | —      | —       | (No runs yet — fill in as testing progresses.) |
