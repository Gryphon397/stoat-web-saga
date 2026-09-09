import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { useState } from "@revolt/state";
import { Text } from "@revolt/ui";

// [Voice/F1] Live mic-level meter for Settings → Voice Processing.
//
// Opens its OWN getUserMedia + AudioContext on the selected input device,
// independent of any in-call mic track, and releases both the moment the
// component unmounts (settings panel closes). Per the bead's acceptance
// criteria: "Closing the panel releases the AudioContext."
//
// What it measures: the post-getUserMedia RAW mic RMS, in the same reference
// frame the gate threshold lives in. We open with the same constraints the
// in-call raw-mic capture uses (EC=user setting, NS=false, AGC=user setting —
// see state.tsx audioCaptureDefaults), so the moving bar and the threshold
// marker are directly comparable. The marker is drawn at the *current* gate
// threshold (`state.voice.inputSensitivity`), which auto-calibration writes
// to live — so this surfaces "what auto picked," which the audit flagged as
// invisible. The threshold readout is approximate: the gate's open/close
// detector runs a bandpass side-chain, not flat RMS, so treat the marker as a
// guide, not a sample-exact line.

// dBFS window the meter spans. -100 ≈ silence floor, 0 = full scale.
const METER_MIN_DB = -100;
const METER_MAX_DB = 0;

function dbToPct(db: number): number {
  const clamped = Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, db));
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
}

export function MicMeter() {
  const state = useState();

  // Current smoothed level in dBFS, and a permission/device error if gUM fails.
  const [level, setLevel] = createSignal(METER_MIN_DB);
  const [error, setError] = createSignal<string | null>(null);

  let ctx: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let raf: number | undefined;
  // Guards the async gUM resolving *after* the panel has already closed.
  let stopped = false;

  onMount(async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: state.voice.preferredAudioInputDevice
            ? { exact: state.voice.preferredAudioInputDevice }
            : undefined,
          echoCancellation: state.voice.echoCancellation ?? true,
          noiseSuppression: false,
          autoGainControl: state.voice.chromeAgcEnabled ?? true,
        },
      });
      if (stopped) {
        // Panel closed while gUM was in flight — release immediately.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      ctx = new AudioContext({ sampleRate: 48000 });
      // Autoplay policy can leave the context suspended; analyser reads zeros
      // until it's running. Opening settings is a user gesture, so this resolves.
      await ctx.resume().catch(() => undefined);

      const srcNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      srcNode.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (stopped) return;
        analyser.getFloatTimeDomainData(buf);
        let ss = 0;
        for (const v of buf) ss += v * v;
        const rms = Math.sqrt(ss / buf.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : METER_MIN_DB;
        // Fast attack (jump up instantly), slow release (ease down) so the bar
        // is readable rather than strobing on every transient.
        setLevel((prev) => (db > prev ? db : prev * 0.85 + db * 0.15));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission denied — allow mic access to see the meter."
          : "Couldn't open the microphone for the meter.",
      );
    }
  });

  onCleanup(() => {
    stopped = true;
    if (raf !== undefined) cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
  });

  const threshold = () => state.voice.inputSensitivity ?? -60;
  // Gate is "open" when the current level clears the threshold — colour the
  // fill green at that point so users get the same crossing feedback Discord
  // gives, without needing to read the dB numbers.
  const open = () => level() >= threshold();

  return (
    <Show
      when={!error()}
      fallback={
        <span
          style={{
            color: "var(--md-sys-color-error, #b3261e)",
            "font-size": "0.875rem",
          }}
        >
          {error()}
        </span>
      }
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "12px",
            "border-radius": "6px",
            overflow: "hidden",
            background: "var(--md-sys-color-surface-container-highest, #2b2b2b)",
          }}
        >
          {/* Level fill */}
          <div
            style={{
              position: "absolute",
              top: "0",
              left: "0",
              height: "100%",
              width: `${dbToPct(level())}%`,
              background: open()
                ? "var(--md-sys-color-tertiary, #4caf50)"
                : "var(--md-sys-color-primary, #6750a4)",
              transition: "background 120ms linear",
            }}
          />
          {/* Threshold marker */}
          <div
            style={{
              position: "absolute",
              top: "-1px",
              bottom: "-1px",
              left: `${dbToPct(threshold())}%`,
              width: "2px",
              background: "var(--md-sys-color-on-surface, #ffffff)",
              transform: "translateX(-1px)",
            }}
          />
        </div>
        <Text class="label">
          Input level {level() <= METER_MIN_DB ? "—" : `${level().toFixed(0)} dBFS`}
          {"  ·  "}
          Threshold {threshold().toFixed(0)} dBFS
          {state.voice.inputSensitivityAuto ? " (auto)" : ""}
        </Text>
      </div>
    </Show>
  );
}
