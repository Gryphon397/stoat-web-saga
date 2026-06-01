// [VOICE-DEBUG-CAPTURE] Helpers for the dev-only outgoing voice pipeline
// capture: AudioWorklet processor source, WAV encoding, and shared types.
//
// The orchestration itself lives on Voice (state.tsx) so it can reach the
// existing tap nodes (#inputGateCtx, src, lp, gate, DF3 processedTrack)
// without exposing internals. This file is pure data/encoding helpers.

// AudioWorklet that captures Float32 input frames into a preallocated buffer.
// Sends the buffer back to main when full, or when {type:"stop"} is received.
// numberOfInputs: 1, numberOfOutputs: 0 — recording-only, no audio passthrough.
//
// The processor stays silent (process() returns true with no outputs) once
// the buffer is full, but the worklet stays alive so its `port` keeps a
// stable identity until main disconnects it.
export const captureRecorderWorkletCode = `
class StoatCaptureRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const cap = (options && options.processorOptions && options.processorOptions.capacity) || 0;
    this._buffer = new Float32Array(cap);
    this._pos = 0;
    this._capacity = cap;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "stop") {
        if (this._stopped) return;
        this._stopped = true;
        const out = this._buffer.slice(0, this._pos);
        this.port.postMessage({ type: "done", buffer: out, framesRecorded: this._pos }, [out.buffer]);
      }
    };
  }
  process(inputs) {
    if (this._stopped) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const remaining = this._capacity - this._pos;
    if (remaining <= 0) {
      // Buffer full — auto-finalise.
      this._stopped = true;
      const out = this._buffer.slice(0, this._pos);
      this.port.postMessage({ type: "done", buffer: out, framesRecorded: this._pos }, [out.buffer]);
      return true;
    }
    const n = Math.min(ch.length, remaining);
    this._buffer.set(n === ch.length ? ch : ch.subarray(0, n), this._pos);
    this._pos += n;
    return true;
  }
}
registerProcessor("stoat-capture-recorder", StoatCaptureRecorderProcessor);
`;

let captureRecorderWorkletUrl: string | null = null;
export function getCaptureRecorderWorkletUrl(): string {
  if (!captureRecorderWorkletUrl) {
    captureRecorderWorkletUrl = URL.createObjectURL(
      new Blob([captureRecorderWorkletCode], { type: "application/javascript" }),
    );
  }
  return captureRecorderWorkletUrl;
}

// Tracks AudioContexts that already have the recorder worklet registered.
// addModule is loosely idempotent for a given URL but registerProcessor inside
// the worklet throws if called twice — so we only load it once per context.
const registeredContexts = new WeakSet<AudioContext>();

export async function ensureCaptureRecorderRegistered(ctx: AudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return;
  await ctx.audioWorklet.addModule(getCaptureRecorderWorkletUrl());
  registeredContexts.add(ctx);
}

/**
 * Encode a Float32 mono PCM buffer at 48 kHz to a 16-bit RIFF/WAVE file.
 * Hard-clips out-of-range samples; lossless within ±1.0.
 */
export function encodeWavMono16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);

  // RIFF header
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, "WAVE");

  // fmt chunk
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);          // chunk size
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);           // block align
  v.setUint16(34, 16, true);          // bits per sample

  // data chunk
  writeAscii(v, 36, "data");
  v.setUint32(40, dataBytes, true);

  // PCM samples
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = samples[i];
    let n = Math.round(s * 32768);
    if (n > 32767) n = 32767;
    else if (n < -32768) n = -32768;
    v.setInt16(off, n, true);
    off += 2;
  }
  return buf;
}

function writeAscii(v: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
}

export interface CaptureMetadata {
  captureVersion: number;
  timestampIso: string;
  audioContextStartTime: number;
  captureDurationSec: number;
  framesRecorded: Record<string, number>;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  build: number;
  dfn3Active: boolean;
  // DeepFilterNet3 has no public latency API. Per the published model spec
  // (10 ms frame + 1 frame lookahead) this is ~20 ms. Update if the upstream
  // package changes its frame topology.
  dfn3LatencyMs: number;
  // [Voice/A2] When true, DF3 ran as a continuous Web Audio node upstream
  // of the gate. Stage layout in the bundle is the same, but the semantic
  // of stage 05 shifts: it is DF3 output pre-gate-pre-AGC, not final
  // transmitted audio. Final transmitted audio in A2 mode is stage 04
  // (post-AGC). Optional for backward-compat with older bundles.
  a2Active?: boolean;
  settings: Record<string, unknown>;
  gateConstants: {
    holdFrames: number;
    attack: number;
    release: number;
    closeRatioDb: number;
  };
  files: string[];
  // [Voice/H1] BS.1770-4 K-weighted integrated loudness (LUFS) and true-peak
  // (dBFS) per captured stage, keyed by the leading two-character file index
  // ("01", "02", ...). Added in captureVersion 3. Older bundles won't have
  // this; downstream readers must guard with `metadata.loudness?.["NN"]`.
  loudness?: Record<string, { lufsIntegrated: number; truePeakDbfs: number }>;
  // [Voice/H5] True signal-flow order of the captured stages for THIS
  // capture's architecture. The file numbering (01..05) is legacy pre-A2
  // (DF3 was last); under A2 the real main-path order is 01 → 05 (DF3) → 03
  // (gate) → 04 (AGC), and 02 (bandpass) is a detector SIDE-CHAIN off the
  // head, not in the transmit path. Downstream readers should order by this
  // array, not by filename index, so captures stop reading in the stale
  // pre-A2 order. Each entry: { file, role, mainPath }. mainPath=false marks
  // sidechain/diagnostic taps. Added in captureVersion 4; guard for older
  // bundles. The transmitted stage is the last mainPath entry.
  processingOrder?: Array<{ file: string; role: string; mainPath: boolean }>;
  // [Voice/H5] True when this bundle was captured with an injected TX source
  // (loopback test harness) instead of the live mic. Added in captureVersion 4.
  injectionActive?: boolean;
}

/**
 * Format a Date as YYYYMMDD-HHMMSS for the bundle subfolder name.
 */
export function formatBundleTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * True when the dev gate is open (Vite dev server OR explicit env opt-in).
 *
 * The env-var path reads a window global injected by docker/inject.js into
 * index.html, NOT import.meta.env. Vite/Rollup constant-fold any
 * `import.meta.env.VITE_STOAT_DEBUG_CAPTURE === "1"` comparison at build time
 * using the placeholder string — yielding `false` and dead-code-eliminating
 * the entire gated section before inject.js can substitute the real value.
 * Reading from globalThis keeps the comparison alive until runtime.
 */
export function isDebugCaptureBuild(): boolean {
  if (import.meta.env.DEV) return true;
  const flag = (globalThis as { __STOAT_DEBUG_CAPTURE__?: string })
    .__STOAT_DEBUG_CAPTURE__;
  return flag === "1";
}

/**
 * UI-facing session handle returned by Voice.armDebugCapture(). All fields
 * are SolidJS Accessors so the settings panel reacts to them directly. The
 * session manages its own lifecycle — UI may call cancel() at any time.
 */
export interface DebugCaptureSession {
  state: () => DebugCaptureState;
  remainingMs: () => number;
  error: () => string | null;
  outputPath: () => string | null;
  cancel: () => void;
}

export type DebugCaptureState =
  | "idle"
  | "recording"
  | "encoding"
  | "writing"
  | "done"
  | "canceled"
  | "error";
