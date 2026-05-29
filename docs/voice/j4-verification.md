# J4 Verification — Blind Listening Protocol

Validates the mic-publish/DF3-attach race fix (`StoatData-4wu`). The fix mutes
the LocalAudioTrack at the WebRTC layer for the duration of `#applyInputGate`
+ DF3 `setProcessor` on initial connect, so listeners never hear the
pre-DF3 raw mic / gate-only window.

The kill switch lets us flip the fix on/off without rebuilding, which makes
this a clean A/B test in one build (Stoat web-dev build 37+).

## Kill switch

Either of these disables the fix (reverts to legacy "publishes pre-DF3" behavior):

```js
// In sender-side DevTools console, then reload:
localStorage.setItem("stoat.disableMicWarmupMute", "1")
```

Or set `window.__STOAT_DISABLE_MIC_WARMUP_MUTE__ = "1"` before app load
(useful for inject.js-style env injection).

To re-enable the fix:

```js
localStorage.removeItem("stoat.disableMicWarmupMute")
```

Confirm state before each trial:

```js
localStorage.getItem("stoat.disableMicWarmupMute")  // "1" = fix off; null = fix on
```

## Layer 1 — local pipeline timing (existing debug capture)

Quick sanity check that the fix is actually doing what we think.

1. In the sender tab, ensure debug-capture build is on (it is on the dev container).
2. Settings → Voice Processing → Debug Capture → arm.
3. Cold-join a voice channel and immediately speak "aaaa" continuously for ~10s.
4. Compare `05_post_dfn3.wav` first 500 ms across:
   - **Fix on**: should be silent (RMS < -60 dBFS) for ~150–500 ms (the mute
     window), then clean speech with no DF3 ramp-in.
   - **Fix off** (kill switch set): should show non-trivial signal in the first
     500 ms with a visible DF3 attack ramp / spectral artifact at the join.

Run 3 captures of each and verify the silence-then-clean pattern holds. This
is the engineering-level check before doing the human-ear test below.

## Layer 2 — blind listening on receiver side

This is the test that actually validates the original "scratchy / garbled /
sudden cut-in" complaint. You're the original listener; this is your call.

### Setup

- **Sender machine/profile (S)** — Chrome or Stoat desktop, signed in as one
  account. Joins voice. This is where the kill switch flips per trial.
- **Receiver machine/profile (R)** — anything that can join the same channel
  with a different account: second browser profile, second device, mobile.
  Records system audio output.
- **Recording tool on R** — anything that captures the audio coming out of
  R's speakers/output. Audacity (Windows: WASAPI loopback), OBS, even a phone
  near speakers. Doesn't matter — just needs to capture what R hears.

### Generate trial schedule (do not peek)

Run this in any shell — it produces a randomized 10-trial schedule. The
mapping of trial → variant (X or Y) is fixed; the mapping of variant → fix-on
vs fix-off you write down separately and DO NOT consult until after scoring.

```bash
# Generate schedule (deterministic shuffle of 5 X + 5 Y)
python -c "import random; trials = ['X']*5 + ['Y']*5; random.shuffle(trials); print('\n'.join(f'trial-{i+1:02d}: variant {v}' for i, v in enumerate(trials)))" > j4-schedule.txt
cat j4-schedule.txt
```

Then write a `j4-key.txt` somewhere you won't accidentally read during scoring:

```
X = fix on
Y = fix off
```

Or flip them — the assignment of X/Y to fix on/off is also a coin flip. Just
commit to it before starting.

### Run the trials

For each trial, in order:

1. On S (sender), open DevTools console.
2. Look at the schedule line for this trial number. If it says variant X, run
   the localStorage command for whichever you assigned X to (fix on = remove
   the key; fix off = set it to "1"). Same for Y.
3. **Don't look at j4-key.txt.** You're picking the variant per the schedule
   without knowing what it maps to.
4. Reload S. Confirm in console: `[stoat-dev] build 37` and the kill-switch
   state matches what you set.
5. On R, start recording with a filename matching the trial number
   (e.g. `j4-trial-01.wav`).
6. On S, click "join voice" and immediately say "the quick brown fox jumps
   over the lazy dog" — same phrase every trial. Pause 2 s. Say it again.
7. Leave the voice channel on S (wait ~3 s for buffers to flush).
8. Stop recording on R.
9. Don't listen yet. Move to the next trial.

### Score blind

Once all 10 trials are recorded:

1. Listen to each `j4-trial-NN.wav` file in order. Headphones recommended.
2. For each trial, score the first ~500 ms after the speaker starts:
   - **clean** — phrase starts cleanly, no scratch or garble at onset
   - **bad** — audible scratch, garble, or sudden cut-in at the very start

3. Optional finer scoring: 1–5 scale where 5 is perfect and 1 is the original
   complaint exactly. Useful if results are mixed.

Write your scores in a table:

```
trial-01: <score>
trial-02: <score>
...
trial-10: <score>
```

### Unblind

Now open `j4-key.txt` and `j4-schedule.txt`. Map each trial → variant → fix-on/off.

Pass criteria:

- All "fix on" trials score **clean** (or ≥4/5).
- "Fix off" trials replicate the original complaint at least sometimes — if
  they don't, either the original complaint isn't reproducible from this
  setup (network conditions, headset, time of day) or DF3 is now warm-cached
  in a way that mitigates the race naturally. Document and discuss before
  closing.

## Things that would fail this verification

- Fix-on trials still scratch → the mute didn't actually take effect. Check
  console logs for `[Voice/J4] mic warmup mute failed` warnings. Inspect
  actual RTP packets being sent during the warmup window (chrome://webrtc-internals).
- Fix-off and fix-on sound identical → either DF3 is so well-warmed in your
  setup that the race window is sub-detection, or the kill switch isn't
  flipping correctly. Confirm `localStorage.getItem(...)` per trial.
- Listener reports "no audio at all on join" → the unmute path failed. Check
  for `[Voice/J4] mic warmup unmute failed` in console; check for
  `track.isMuted === true` lingering after join via DevTools.

## Rollback

If the fix introduces any regression that scoring catches, rollback options
in escalating cost:

1. **Per-user immediate** — set `localStorage.setItem("stoat.disableMicWarmupMute", "1")`
   in DevTools. Reload. Done. No rebuild, no deploy.
2. **All users immediate** — set `window.__STOAT_DISABLE_MIC_WARMUP_MUTE__ = "1"`
   via `docker/inject.js` (mirrors the existing `__STOAT_DEBUG_CAPTURE__` pattern).
   Rebuild and redeploy web-dev container; users pick it up next reload.
3. **Full revert** — `git revert` the J4 commit on `discord-style-voice` branch.
   Rebuild and redeploy.
