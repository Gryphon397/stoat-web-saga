// [Voice/H7] Layered source mixer for the loopback test harness.
//
// Pure audio-graph helpers — no Solid, no DOM, no Voice coupling — so the test
// panel (LoopbackTestPanel.tsx) stays thin and these can be reasoned about /
// unit-tested in isolation. The panel decodes files into mono AudioBuffers on
// the live input-gate AudioContext (per the H5 reuse rule — never a parallel
// context), builds a mix graph here, and hands the summed master GainNode to
// Voice.setInjectedTxSource() as the head of the TX chain.
//
// Mixer rules (from docs/voice/loopback-test-harness.md — non-negotiable):
//   • decodeAudioData resamples to the 48 kHz ctx automatically (caller's job).
//   • Mono downmix every source — the chain is single-channel.
//   • Headroom-aware summing — pad the mix so it cannot clip past 0 dBFS.
//   • Loop beds outlast the one-shot voice clip (node.loop on bed sources).
//   • Caller mutes the real mic publication + warns headphones while playing.

/** One layer in the mix: a decoded mono buffer plus its playback controls. */
export interface LoopbackSourceSpec {
  /** Mono AudioBuffer on the target (input-gate) AudioContext. */
  buffer: AudioBuffer;
  /** User linear gain, 0..1, before headroom scaling. */
  gain: number;
  /** Loop indefinitely (noise/typing beds) vs play once (voice take). */
  loop: boolean;
  /** Excluded from the mix when false. */
  enabled: boolean;
}

/** Live nodes for one playback run, returned by buildMixGraph for teardown. */
export interface LoopbackMixGraph {
  /** Summed head node — pass this to setInjectedTxSource(). */
  master: GainNode;
  /** One source node per enabled spec, in spec order. */
  sources: AudioBufferSourceNode[];
  /** The safety scalar applied to the master (1.0 = no attenuation needed). */
  headroomScalar: number;
}

/**
 * Downmix a (possibly multi-channel) decoded buffer to a single mono buffer on
 * the same context. The TX chain is single-channel, so every source collapses
 * to mono on the way in — matching the seam's stage-01 fidelity assertion
 * (a clean inject reproduces the file mono @ 48 kHz). Equal-weight average of
 * the source channels; a mono input is copied through unchanged.
 */
export function downmixToMono(
  ctx: BaseAudioContext,
  decoded: AudioBuffer,
): AudioBuffer {
  const mono = ctx.createBuffer(1, decoded.length, decoded.sampleRate);
  const out = mono.getChannelData(0);
  const channels = decoded.numberOfChannels;
  for (let ch = 0; ch < channels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      out[i] += data[i] / channels;
    }
  }
  return mono;
}

/** Peak absolute sample amplitude of a buffer's first channel (0 if empty). */
export function bufferPeakAmplitude(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Master safety scalar so the summed mix cannot clip past 0 dBFS. We bound the
 * worst case — every enabled source hitting its peak in the same sample —
 * Σ(peak·gain). If that sum exceeds 1.0 we attenuate the whole mix by its
 * reciprocal, preserving the relative balance the user dialled in (a clipped
 * mix tests garbage). Returns 1.0 when there's nothing enabled or the sum is
 * already within headroom.
 */
export function computeHeadroomScalar(specs: LoopbackSourceSpec[]): number {
  let worstCaseSum = 0;
  for (const s of specs) {
    if (!s.enabled) continue;
    worstCaseSum += bufferPeakAmplitude(s.buffer) * s.gain;
  }
  return worstCaseSum > 1 ? 1 / worstCaseSum : 1;
}

/**
 * Build the mix graph for the enabled specs on the given context:
 *   each source → per-source GainNode(spec.gain) → master GainNode(headroom)
 * Nothing is started here — call startAligned() so every source shares one
 * start(when) and lands sample-aligned. The master is the injected head.
 */
export function buildMixGraph(
  ctx: AudioContext,
  specs: LoopbackSourceSpec[],
): LoopbackMixGraph {
  const headroomScalar = computeHeadroomScalar(specs);
  const master = ctx.createGain();
  master.gain.value = headroomScalar;
  const sources: AudioBufferSourceNode[] = [];
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const node = ctx.createBufferSource();
    node.buffer = spec.buffer;
    node.loop = spec.loop;
    const g = ctx.createGain();
    g.gain.value = spec.gain;
    node.connect(g);
    g.connect(master);
    sources.push(node);
  }
  return { master, sources, headroomScalar };
}

/**
 * Start every source at the same context time so they're sample-aligned (one
 * Play button, one schedule). `leadSeconds` gives the graph a small lead so the
 * injection rebuild and mic mute settle before the first sample plays.
 */
export function startAligned(
  sources: AudioBufferSourceNode[],
  ctx: AudioContext,
  leadSeconds = 0.1,
): void {
  const when = ctx.currentTime + leadSeconds;
  for (const s of sources) s.start(when);
}
