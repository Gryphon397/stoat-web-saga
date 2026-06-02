import { For, Show, createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";

import {
  buildMixGraph,
  downmixToMono,
  startAligned,
  useVoice,
} from "@revolt/rtc";
import type { LoopbackMixGraph } from "@revolt/rtc";
import { Button, Column, Slider, Text } from "@revolt/ui";

// [Voice/H7] Layered source mixer + dev test panel.
//
// Records/imports WAVs (a rainbow-passage voice take, an AC-noise bed, a typing
// bed, …), mixes them, and drives the H5 injection seam so the H6 phantom can
// play the full TX→wire→RX round trip back to a single tester. Dev-gated by the
// caller (rendered only inside VoiceProcessingOptions' showDebugSection block).
//
// Mixer rules (docs/voice/loopback-test-harness.md, enforced here):
//   • decodeAudioData resamples imports to the 48 kHz input-gate ctx.
//   • every source is downmixed to mono on the way in (chain is single-channel).
//   • computeHeadroomScalar (in buildMixGraph) keeps the sum ≤ 0 dBFS.
//   • loop beds outlast the one-shot voice clip (per-source loop toggle).
//   • playing mutes the user's REAL publication + warns to use headphones.

interface UISource {
  id: number;
  name: string;
  /** Mono AudioBuffer on the input-gate context. */
  buffer: AudioBuffer;
  gain: number;
  loop: boolean;
  enabled: boolean;
}

let nextSourceId = 1;

export function LoopbackTestPanel() {
  const voice = useVoice();

  const [store, setStore] = createStore<{ sources: UISource[] }>({ sources: [] });
  const [playing, setPlaying] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);

  // Live playback nodes + the mic state to restore on stop. Closure-scoped
  // (the component body runs once in Solid) — not reactive, just bookkeeping.
  let active: LoopbackMixGraph | null = null;
  let micWasEnabled = false;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let recordStream: MediaStream | null = null;

  let fileInput: HTMLInputElement | undefined;

  const addSource = (name: string, buffer: AudioBuffer, loop: boolean) => {
    setStore("sources", store.sources.length, {
      id: nextSourceId++,
      name,
      buffer,
      gain: 1,
      loop,
      enabled: true,
    });
  };

  const importFiles = async (files: FileList) => {
    const ctx = voice?.inputGateContext;
    if (!ctx) {
      setStatus("Join a voice channel first — no input-gate context yet.");
      return;
    }
    for (const file of Array.from(files)) {
      try {
        const arr = await file.arrayBuffer();
        // decodeAudioData resamples to the 48 kHz ctx automatically; source
        // files need not match the rate. Downmix to mono — the chain is 1-ch.
        const decoded = await ctx.decodeAudioData(arr);
        addSource(file.name, downmixToMono(ctx, decoded), false);
      } catch (e) {
        console.error("[Voice/H7] failed to decode", file.name, e);
        setStatus(`Could not decode ${file.name} (unsupported format?).`);
      }
    }
  };

  const startRecording = async () => {
    const ctx = voice?.inputGateContext;
    if (!ctx) {
      setStatus("Join a voice channel first — no input-gate context yet.");
      return;
    }
    if (recording()) return;
    try {
      // Fresh capture on the default device — independent of the live call's
      // pipeline mic, so recording a take doesn't disturb the gate graph.
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("[Voice/H7] getUserMedia for recording failed", e);
      setStatus("Microphone permission denied — cannot record.");
      return;
    }
    const chunks: BlobPart[] = [];
    mediaRecorder = new MediaRecorder(recordStream);
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    mediaRecorder.onstop = async () => {
      recordStream?.getTracks().forEach((t) => t.stop());
      recordStream = null;
      setRecording(false);
      try {
        const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        addSource(`recording ${new Date().toLocaleTimeString()}`, downmixToMono(ctx, decoded), false);
        setStatus(null);
      } catch (e) {
        console.error("[Voice/H7] failed to decode recording", e);
        setStatus("Recording failed to decode.");
      }
      mediaRecorder = null;
    };
    mediaRecorder.start();
    setRecording(true);
    setStatus("Recording… click Stop recording when done.");
  };

  const stopRecording = () => {
    try { mediaRecorder?.stop(); } catch { /* ignore */ }
  };

  const play = async () => {
    if (!voice) return;
    const ctx = voice.inputGateContext;
    if (!ctx) {
      setStatus("Join a voice channel first — no input-gate context yet.");
      return;
    }
    if (playing()) return;
    if (!store.sources.some((s) => s.enabled)) {
      setStatus("Enable at least one source first.");
      return;
    }
    // Mixer rule #5: silence the REAL publication before any test audio plays
    // so nothing leaks into the channel under your identity. The phantom's
    // cloned track is independent and stays audible. Remember the prior state
    // so we restore exactly what the user had.
    micWasEnabled = voice.isMicPublicationEnabled;
    await voice.setHarnessMicMuted(true);

    const graph = buildMixGraph(ctx, store.sources);
    active = graph;
    // The summed master is the H5 injected head; wire it BEFORE starting so
    // the gate rebuild settles, then schedule every source on one aligned
    // start(when) with a small lead.
    await voice.setInjectedTxSource(graph.master);
    startAligned(graph.sources, ctx, 0.1);
    setPlaying(true);
    setStatus(
      `Playing ${graph.sources.length} source(s)` +
        (graph.headroomScalar < 1
          ? ` — headroom-limited ×${graph.headroomScalar.toFixed(2)} to avoid clipping.`
          : "."),
    );

    // If nothing loops, auto-stop once the longest one-shot has finished plus a
    // tail so the gate's release is audible. If any bed loops, stay until Stop.
    const enabled = store.sources.filter((s) => s.enabled);
    if (!enabled.some((s) => s.loop)) {
      const maxDur = Math.max(...enabled.map((s) => s.buffer.duration));
      stopTimer = setTimeout(() => void stop(), (0.1 + maxDur + 0.4) * 1000);
    }
  };

  const stop = async () => {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (active) {
      for (const s of active.sources) {
        try { s.stop(); } catch { /* already stopped */ }
      }
      try { active.master.disconnect(); } catch { /* ignore */ }
      active = null;
    }
    await voice?.setInjectedTxSource(null);
    // Restore the publication only if it was sending before we muted it.
    if (micWasEnabled) await voice?.setHarnessMicMuted(false);
    setPlaying(false);
    setStatus(null);
  };

  // Belt-and-braces: if the user leaves settings mid-test, stop everything so
  // the injection seam reverts and the real mic is restored.
  onCleanup(() => {
    if (recording()) stopRecording();
    if (playing()) void stop();
  });

  return (
    <Column gap="sm">
      <Text class="title">Loopback test (dev only)</Text>
      <Text class="label">
        Mix one or more clips and play them through the full TX chain. Start the
        phantom first to hear the round trip — Play mutes your real mic so the
        test never leaks into the channel. Use headphones.
      </Text>

      {/* Phantom (H6) — the second identity that makes the round trip audible */}
      <Show
        when={voice?.isPhantomActive}
        fallback={
          <Button onPress={() => void voice?.startPhantom()}>
            Start phantom (hear round trip)
          </Button>
        }
      >
        <Button variant="_error" onPress={() => void voice?.stopPhantom()}>
          Stop phantom
        </Button>
      </Show>

      {/* Source import / record */}
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files && files.length) void importFiles(files);
          e.currentTarget.value = "";
        }}
      />
      <Button variant="text" onPress={() => fileInput?.click()}>
        Import audio file(s)
      </Button>
      <Show
        when={recording()}
        fallback={
          <Button variant="text" onPress={() => void startRecording()}>
            Record a take
          </Button>
        }
      >
        <Button variant="_error" onPress={stopRecording}>
          Stop recording
        </Button>
      </Show>

      {/* Per-source layers */}
      <Show
        when={store.sources.length > 0}
        fallback={<Text class="label">No sources yet — import or record one.</Text>}
      >
        <For each={store.sources}>
          {(s) => (
            <Column gap="sm">
              <Text class="label">{s.name}</Text>
              <Button
                variant="text"
                onPress={() => setStore("sources", (x) => x.id === s.id, "enabled", !s.enabled)}
              >
                {s.enabled ? "✓ Enabled" : "Disabled"}
              </Button>
              <Button
                variant="text"
                onPress={() => setStore("sources", (x) => x.id === s.id, "loop", !s.loop)}
              >
                {s.loop ? "✓ Loop (bed)" : "Loop (bed)"}
              </Button>
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={s.gain}
                labelFormatter={(v) => (v * 100).toFixed(0) + "%"}
                onInput={(e) =>
                  setStore("sources", (x) => x.id === s.id, "gain", Number(e.currentTarget.value))
                }
              />
              <Button
                variant="text"
                onPress={() => setStore("sources", (cur) => cur.filter((x) => x.id !== s.id))}
              >
                Remove
              </Button>
            </Column>
          )}
        </For>
      </Show>

      {/* Transport */}
      <Show
        when={playing()}
        fallback={
          <Button onPress={() => void play()} isDisabled={store.sources.length === 0}>
            Play mix
          </Button>
        }
      >
        <Button variant="_error" onPress={() => void stop()}>
          Stop mix
        </Button>
      </Show>
      <Show when={status()}>
        <Text class="label">{status()}</Text>
      </Show>
      <Text class="label">
        Gain/enable/loop changes apply on the next Play. Loop beds keep playing
        until Stop so the gate release tail is audible underneath them.
      </Text>
    </Column>
  );
}
