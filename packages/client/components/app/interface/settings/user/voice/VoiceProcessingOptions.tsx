import { Show, createSignal, onCleanup } from "solid-js";

import {
  clearVoiceDiagHistory,
  getVoiceDiagHistory,
  isDebugCaptureBuild,
  useVoice,
} from "@revolt/rtc";
import type { ABHarnessSession, DebugCaptureSession } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";

// [Voice/H2] Kill switch matches the J5/J6/J7 pattern. Hide the harness button
// entirely when set so the user has a clean revert path if anything below
// regresses. Default: feature on.
function isABHarnessDisabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" &&
        localStorage.getItem("stoat.disableABHarness") === "1") return true;
  } catch {
    /* sandbox / privacy mode — fall through */
  }
  return false;
}

// [Voice/B4/F15] Mirror of the same kill switch the audio path reads in
// state.tsx#applyInputGate. The UI uses this to decide whether the Target
// Loudness slider is meaningful: only under the legacy stoat-agc worklet
// does the slider value reach the audio thread. Under B4 (default) the
// leveler has a hardcoded -20 LUFS-S target and the slider is inert, so
// we hide it rather than mislead the user.
function isB4LevelerDisabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" &&
        localStorage.getItem("stoat.disableB4Leveler") === "1") return true;
  } catch {
    /* sandbox / privacy mode — fall through */
  }
  return false;
}

export function VoiceProcessingOptions() {
  const state = useState();
  const voice = useVoice();
  const showDebugSection = isDebugCaptureBuild();
  const abHarnessAvailable = !isABHarnessDisabled();

  // [VOICE-DEBUG-CAPTURE] UI-local handle to the active capture session.
  // The session lives on Voice; we only mirror its accessors here so the
  // panel rerenders against its signals.
  const [session, setSession] = createSignal<DebugCaptureSession | null>(null);
  const [arming, setArming] = createSignal(false);

  // [Voice/H2] A/B harness session — lives on Voice; same mirror pattern.
  const [abSession, setAbSession] = createSignal<ABHarnessSession | null>(null);

  // Tear down the harness if the user navigates away from settings while
  // a recording or playback is in flight. The Voice instance also self-cleans
  // on voice-channel disconnect, but the settings panel can outlive the
  // channel only by being left open across reconnects, so this is just
  // belt-and-braces for the in-channel navigation case.
  onCleanup(() => {
    const s = abSession();
    if (s) {
      try { s.cancel(); } catch { /* ignore */ }
    }
  });

  const startCapture = async () => {
    if (!voice || arming() || session()) return;
    setArming(true);
    try {
      const s = await voice.armDebugCapture(30);
      setSession(s);
    } finally {
      setArming(false);
    }
  };

  const cancel = () => session()?.cancel();

  const startAbHarness = () => {
    if (!voice) return;
    // Clear any prior session before arming a fresh one — the user
    // clicking "A/B harness" again means "discard the previous round."
    const prev = abSession();
    if (prev) {
      try { prev.cancel(); } catch { /* ignore */ }
    }
    const s = voice.armABHarness(10);
    setAbSession(s);
    void s.startPassA();
  };

  const abStatusText = () => {
    const s = abSession();
    if (!s) return "";
    switch (s.state()) {
      case "recording-a":
        return `Recording Pass A — ${(s.remainingMs() / 1000).toFixed(1)}s — speak now`;
      case "ready-b":
        return "Pass A captured. Adjust settings if you're comparing configs, then record Pass B.";
      case "recording-b":
        return `Recording Pass B — ${(s.remainingMs() / 1000).toFixed(1)}s — speak now`;
      case "compare":
        return "Two clips ready. Play each, then reveal which is which.";
      case "revealed": {
        const map = s.labeling();
        if (!map) return "Revealed.";
        return `Clip 1 = Pass ${map.clip1} · Clip 2 = Pass ${map.clip2}`;
      }
      case "error":
        return `Error: ${s.error() ?? "unknown"}`;
      default:
        return "";
    }
  };

  const abTapNote = () => {
    const s = abSession();
    const tap = s?.tapSource();
    if (tap === "post-dfn3") return "Tap: post-DF3 (transmitted)";
    if (tap === "post-agc") return "Tap: post-AGC (DF3 inactive, transmitted)";
    return "";
  };

  const statusText = () => {
    const s = session();
    if (!s) return "";
    switch (s.state()) {
      case "recording":
        return `Recording — ${(s.remainingMs() / 1000).toFixed(1)}s left`;
      case "encoding":
        return "Encoding WAVs…";
      case "writing":
        return "Pick a folder, then writing…";
      case "done":
        return `Saved to ${s.outputPath()}`;
      case "canceled":
        return "Canceled.";
      case "error":
        return `Error: ${s.error() ?? "unknown"}`;
      default:
        return "";
    }
  };

  const isRecording = () => session()?.state() === "recording";
  const isFinished = () => {
    const st = session()?.state();
    return st === "done" || st === "canceled" || st === "error";
  };

  return (
    <Column>
      <Text class="title">Input Sensitivity</Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.inputSensitivityAuto} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.inputSensitivityAuto = !state.voice.inputSensitivityAuto;
          }}
        >
          Automatically determine input sensitivity
        </CategoryButton>
      </CategoryButton.Group>
      <Show when={!state.voice.inputSensitivityAuto}>
        <Column>
          <Text class="label">Sensitivity Threshold ({(state.voice.inputSensitivity ?? -60).toFixed(0)} dBFS)</Text>
          <Slider
            min={-100}
            max={-20}
            step={1}
            value={state.voice.inputSensitivity ?? -60}
            onInput={(event) => {
              state.voice.inputSensitivity = Number(event.currentTarget.value);
            }}
            labelFormatter={(label) => `${label.toFixed(0)} dB`}
          />
        </Column>
      </Show>
      <Text class="title">Voice Processing</Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.noiseSupression} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.noiseSupression = !state.voice.noiseSupression;
          }}
        >
          Noise Suppression
        </CategoryButton>
      </CategoryButton.Group>
      <Show when={state.voice.noiseSupression}>
        <Column>
          <Text class="label">Suppression Level</Text>
          <Slider
            min={0}
            max={100}
            step={5}
            value={state.voice.noiseSupressionLevel}
            onInput={(event) =>
              (state.voice.noiseSupressionLevel = Number(event.currentTarget.value))
            }
            labelFormatter={(label) => label.toFixed(0)}
          />
        </Column>
      </Show>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.echoCancellation} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.echoCancellation = !state.voice.echoCancellation;
          }}
        >
          Echo Cancellation
        </CategoryButton>
      </CategoryButton.Group>
      {/* [STOAT-AGC] Chrome AGC + Stoat AGC toggles. Run them side-by-side for
          the A/B compare; recommended setting once tuned is Chrome off + Stoat on. */}
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.chromeAgcEnabled} style={{ "pointer-events": "none" }} />}
          description="Browser-native automatic gain control. Aggressive — pumps gain during silences. Disable for the cleanest signal into the Stoat AGC."
          onClick={() => {
            state.voice.chromeAgcEnabled = !state.voice.chromeAgcEnabled;
          }}
        >
          Chrome AGC
        </CategoryButton>
      </CategoryButton.Group>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.useStoatAgc} style={{ "pointer-events": "none" }} />}
          description="Custom AGC tuned for voice chat. Holds gain during silence so background noise doesn't pump up between phrases."
          onClick={() => {
            state.voice.useStoatAgc = !state.voice.useStoatAgc;
          }}
        >
          Stoat AGC (experimental)
        </CategoryButton>
      </CategoryButton.Group>
      {/* [Voice/B4/F15] Target Loudness slider only applies to the legacy
          stoat-agc worklet. The B4 leveler has a hardcoded -20 LUFS-S
          target (K-weighted loudness, not dBFS), and #applyInputGate
          deliberately does not forward the slider value to it. Showing
          the slider under B4 would be misleading — it does nothing.
          Show it only when the user is on Stoat AGC AND has the B4
          kill switch set to fall back to the legacy worklet. */}
      <Show when={state.voice.useStoatAgc && isB4LevelerDisabled()}>
        <Column>
          <Text class="label">Target Loudness ({state.voice.stoatAgcTargetDbfs.toFixed(0)} dBFS)</Text>
          <Slider
            min={-30}
            max={-6}
            step={1}
            value={state.voice.stoatAgcTargetDbfs}
            onInput={(event) => {
              state.voice.stoatAgcTargetDbfs = Number(event.currentTarget.value);
            }}
            labelFormatter={(label) => `${label.toFixed(0)} dB`}
          />
        </Column>
      </Show>
      {/* [VAD-IMPROVEMENT-#8] Silero VAD toggle */}
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.useSileroVad} style={{ "pointer-events": "none" }} />}
          description="Adds a neural-network voice classifier on top of the input sensitivity gate. Reduces false triggers from non-speech sounds (typing, sneezes, fans). Loads ~6 MB on first use."
          onClick={() => {
            state.voice.useSileroVad = !state.voice.useSileroVad;
          }}
        >
          Smart Voice Detection (Silero VAD)
        </CategoryButton>
      </CategoryButton.Group>
      {/* [Voice/J3] Surface Silero load failure so users know the gate has fallen
          back to RMS-only. Visible only when the user has Silero enabled and a
          load attempt has failed since the last connect. */}
      <Show when={state.voice.useSileroVad && voice?.sileroLoadFailed()}>
        <span style={{ color: "var(--md-sys-color-error, #b3261e)", "font-size": "0.875rem" }}>
          ⚠ Smart voice detection is unavailable — using simple RMS gate.
          Check that /silero/ assets are reachable, then rejoin the channel.
        </span>
      </Show>

      {/* [VOICE-DEBUG-CAPTURE] Dev-only outgoing pipeline diagnostic capture */}
      <Show when={showDebugSection}>
        <Text class="title">Diagnostics</Text>
        {/* [Voice/H3] Rolling diagnostic history exporter — pairs with the
            ring buffer populated every 30 s by printVoiceStats. Copy-as-JSON
            is sufficient for paste-into-bug-report; saves a download dialog. */}
        <Column gap="sm">
          <Text class="label">
            Voice diagnostic history (last {getVoiceDiagHistory().length} of 120 snapshots, 30 s cadence)
          </Text>
          <Button
            variant="text"
            onPress={() => {
              const json = JSON.stringify(getVoiceDiagHistory(), null, 2);
              void navigator.clipboard.writeText(json);
            }}
          >
            Copy diagnostic history (JSON)
          </Button>
          <Button
            variant="text"
            onPress={() => clearVoiceDiagHistory()}
          >
            Clear diagnostic history
          </Button>
        </Column>
        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            action={
              <Checkbox checked={state.voice.debugCaptureEnabled} style={{ "pointer-events": "none" }} />
            }
            description="Enables a button to dump 30 seconds of the outgoing voice pipeline (raw mic, post-bandpass detector, post-gate, post-DF3) as 4 WAVs for offline analysis. Desktop only."
            onClick={() => {
              state.voice.debugCaptureEnabled = !state.voice.debugCaptureEnabled;
            }}
          >
            Debug capture (dev only)
          </CategoryButton>
        </CategoryButton.Group>
        <Show when={state.voice.debugCaptureEnabled}>
          <Column gap="sm">
            <Text class="label">
              Tip: hold PTT during capture to record speech (otherwise the gate stays closed and the bundle is silent).
            </Text>
            <Show when={!session() || isFinished()}>
              <Button
                onPress={() => void startCapture()}
                isDisabled={arming() || !!session()}
              >
                {arming() ? "Arming…" : "Capture 30s debug bundle"}
              </Button>
            </Show>
            <Show when={isRecording()}>
              <Button variant="_error" onPress={cancel}>
                Cancel capture
              </Button>
            </Show>
            <Show when={statusText()}>
              <Text class="label">{statusText()}</Text>
            </Show>
            <Show when={isFinished()}>
              <Button
                variant="text"
                onPress={() => setSession(null)}
              >
                Clear status
              </Button>
            </Show>

            {/* [Voice/H2] A/B harness — two 10s passes, blind labels, in-memory. */}
            <Show when={abHarnessAvailable}>
              <Text class="label">
                A/B harness: record two short passes with different settings, then compare blind. Audio stays in memory only — clips are discarded on next run or when you leave the channel.
              </Text>
              <Show when={!abSession() || abSession()!.state() === "idle" || abSession()!.state() === "error" || abSession()!.state() === "revealed"}>
                <Button onPress={startAbHarness}>
                  A/B harness (record two passes)
                </Button>
              </Show>
              <Show when={abSession() && abSession()!.state() === "ready-b"}>
                <Button onPress={() => void abSession()!.startPassB()}>
                  Record Pass B (10s)
                </Button>
                <Button
                  variant="text"
                  onPress={() => abSession()!.cancel()}
                >
                  Cancel A/B harness
                </Button>
              </Show>
              <Show when={abSession() && (abSession()!.state() === "recording-a" || abSession()!.state() === "recording-b")}>
                <Button variant="_error" onPress={() => abSession()!.cancel()}>
                  Cancel A/B harness
                </Button>
              </Show>
              <Show when={abSession() && (abSession()!.state() === "compare" || abSession()!.state() === "revealed")}>
                <Column gap="sm">
                  <Button
                    onPress={() => abSession()!.playClip("clip1")}
                    isDisabled={abSession()!.playing() === "clip1"}
                  >
                    {abSession()!.playing() === "clip1" ? "Playing Clip 1…" : "Play Clip 1"}
                  </Button>
                  <Button
                    onPress={() => abSession()!.playClip("clip2")}
                    isDisabled={abSession()!.playing() === "clip2"}
                  >
                    {abSession()!.playing() === "clip2" ? "Playing Clip 2…" : "Play Clip 2"}
                  </Button>
                  <Show when={abSession()!.playing()}>
                    <Button variant="text" onPress={() => abSession()!.stopPlayback()}>
                      Stop playback
                    </Button>
                  </Show>
                  <Show when={abSession()!.state() === "compare"}>
                    <Button variant="text" onPress={() => abSession()!.reveal()}>
                      Reveal which clip is which
                    </Button>
                  </Show>
                  <Text class="label">Optional preference vote (logged to console):</Text>
                  <Button
                    variant="text"
                    onPress={() => abSession()!.castVote("clip1")}
                  >
                    {abSession()!.vote() === "clip1" ? "✓ Clip 1 sounds better" : "Clip 1 sounds better"}
                  </Button>
                  <Button
                    variant="text"
                    onPress={() => abSession()!.castVote("clip2")}
                  >
                    {abSession()!.vote() === "clip2" ? "✓ Clip 2 sounds better" : "Clip 2 sounds better"}
                  </Button>
                  <Button
                    variant="text"
                    onPress={() => abSession()!.cancel()}
                  >
                    Reset A/B harness
                  </Button>
                </Column>
              </Show>
              <Show when={abStatusText()}>
                <Text class="label">{abStatusText()}</Text>
              </Show>
              <Show when={abTapNote()}>
                <Text class="label">{abTapNote()}</Text>
              </Show>
              <Show when={state.voice.echoCancellation && state.voice.noiseSupression}>
                <Text class="label">
                  ⚠ With Echo Cancellation + Noise Suppression both on, the post-DF3 tap currently records silence (capture-pipeline bug, Voice/H4). The live audio path is unaffected — but the harness clips will be inaudible in this config.
                </Text>
              </Show>
            </Show>
          </Column>
        </Show>
      </Show>
    </Column>
  );
}
