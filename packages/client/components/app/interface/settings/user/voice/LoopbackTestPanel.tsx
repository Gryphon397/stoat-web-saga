import { For, Show, createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";

import {
  buildMixGraph,
  downmixToMono,
  startAligned,
  useVoice,
} from "@revolt/rtc";
import type { LoopbackMixGraph } from "@revolt/rtc";
import { useState } from "@revolt/state";
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
  const state = useState();

  const [store, setStore] = createStore<{ sources: UISource[] }>({ sources: [] });
  const [playing, setPlaying] = createSignal(false);
  const [recording, setRecording] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);

  // [Voice/H7] Neither DF3 node presence nor phantom-room state is a Solid
  // signal, so poll both while the panel is open. The NS toggle/level ARE
  // reactive (state.voice). The DF3/NS readout triages a "keyboard isn't
  // filtered" observation: DF3 inactive → bug (assets/init); NS OFF → turn it
  // on. But if DF3 is active and sharp keyboard CLICKS still come through at a
  // sensible level, that is NOT a tuning fault — it's the DF3-vs-Krisp ENGINE
  // gap (we have topological parity, not engine parity; clicks are DF3's weak
  // spot and Krisp's strength). One NS bump is a cheap test, but residual clicks
  // belong to engine-parity/A7, not H7. Gate interaction: a loud click can spike
  // above the input-gate threshold and pop the gate open, so an undersuppressed
  // click both leaks AND trips onset — also parity/onset scope, not H7.
  const [df3Active, setDf3Active] = createSignal(!!voice?.isDf3Active());
  const [phantomActive, setPhantomActive] = createSignal(!!voice?.isPhantomActive);
  const refresh = () => {
    setDf3Active(!!voice?.isDf3Active());
    setPhantomActive(!!voice?.isPhantomActive);
  };
  const poll = setInterval(refresh, 1500);
  onCleanup(() => clearInterval(poll));

  // Live playback nodes. Closure-scoped (the component body runs once in Solid)
  // — not reactive, just bookkeeping. The real-mic mute is owned by Voice (it
  // holds/releases around injection + phantom), so the panel doesn't manage it.
  let active: LoopbackMixGraph | null = null;
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
    const graph = buildMixGraph(ctx, store.sources);
    active = graph;
    // The summed master is the H5 injected head; wire it BEFORE starting so
    // the gate rebuild settles, then schedule every source on one aligned
    // start(when) with a small lead. setInjectedTxSource also mutes the real
    // publication (mixer rule #5) so the injected signal can't leak into the
    // channel under your identity — the phantom's independent clone stays
    // audible, so you still hear the round trip.
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
    // Reverting injection releases Voice's mic hold — but only if the phantom
    // isn't still active (it keeps the real mic muted while the bot is present).
    await voice?.setInjectedTxSource(null);
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
        Start the phantom to hear the full round trip. While the bot is in the
        channel your real mic is muted to everyone else, and what you hear is the
        phantom playing back your processed pipeline output (your live mic, or an
        injected clip if you Play one). This is what other people would actually
        hear you sound like — including how well noise suppression removes
        keyboard/fan noise. Use headphones to avoid an echo loop.
      </Text>

      {/* [Voice/H7] Noise-suppression status — the thing that removes keyboard
          noise from what the phantom plays back. */}
      <Text class="label">
        Noise suppression:{" "}
        {df3Active() ? "DF3 active" : "⚠ DF3 INACTIVE"} ·{" "}
        {state.voice.noiseSupression ?? true
          ? `on (level ${state.voice.noiseSupressionLevel ?? 25})`
          : "⚠ OFF"}
      </Text>
      <Show when={df3Active() && (state.voice.noiseSupression ?? true)}>
        <Text class="label">
          Keyboard clicks: DF3 is weak on sharp transients (Krisp's strength).
          One NS-level bump is a fair test, but if clicks persist at a sensible
          level that's the engine-parity gap (A7), not a tuning fix — and loud
          clicks can also pop the input gate open.
        </Text>
      </Show>

      {/* Phantom (H6) — the second identity that makes the round trip audible */}
      <Show
        when={phantomActive()}
        fallback={
          <Button
            onPress={async () => {
              await voice?.startPhantom();
              refresh();
            }}
          >
            Start phantom (mutes your real mic, hear round trip)
          </Button>
        }
      >
        <Button
          variant="_error"
          onPress={async () => {
            await voice?.stopPhantom();
            refresh();
          }}
        >
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
