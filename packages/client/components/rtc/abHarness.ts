// [Voice/H2] A/B harness for blind comparison of processing-chain configs.
//
// Records two 10-second passes from the stage 5 (post-DF3) tap — what
// listeners would actually hear — into in-memory Float32 buffers. Randomises
// the order so the user can listen blind and reveal the mapping afterwards.
//
// Separate from the 30-second debug capture (`armDebugCapture` / `debugCapture.ts`):
//   • Captures stage 5 only (transmitted audio), not all 5 stages.
//   • In-memory only; no WAV encode, no disk write, no metadata bundle.
//   • Designed for ear-comparison rounds, not archival analysis.
// The two flows share the `stoat-capture-recorder` worklet and the
// `#inputGateCtx` AudioContext but do not share session state.

export type ABHarnessState =
  | "idle"           // no recording yet, or fully reset
  | "recording-a"    // pass A in progress
  | "ready-b"        // pass A done, waiting for user to start pass B
  | "recording-b"    // pass B in progress
  | "compare"        // both recorded; blind playback available
  | "revealed"       // labels disclosed
  | "error";

export type ABHarnessClip = "clip1" | "clip2";
export type ABHarnessPass = "A" | "B";

/**
 * Mapping from blind labels to the recording pass. After both passes are
 * recorded, exactly one of the two arrangements is used (random 50/50).
 */
export interface ABHarnessLabeling {
  clip1: ABHarnessPass;
  clip2: ABHarnessPass;
}

export interface ABHarnessSession {
  state: () => ABHarnessState;
  /** Remaining ms during recording states; 0 otherwise. */
  remainingMs: () => number;
  error: () => string | null;
  /** Which pass is currently being recorded (recording-a/b only). */
  currentPass: () => ABHarnessPass | null;
  /** Tap source actually used for the recording. */
  tapSource: () => "post-dfn3" | "post-agc" | null;
  /** Available once both passes are captured. */
  labeling: () => ABHarnessLabeling | null;
  /** Which clip is currently playing back, if any. */
  playing: () => ABHarnessClip | null;
  /** True after `reveal()` is called. */
  revealed: () => boolean;
  /** User's preference vote, if cast. */
  vote: () => ABHarnessClip | null;

  /** Begin pass A. Idle → recording-a → ready-b. */
  startPassA: () => Promise<void>;
  /** Begin pass B. ready-b → recording-b → compare. */
  startPassB: () => Promise<void>;
  /** Play one of the blind clips. Stops any in-flight playback first. */
  playClip: (clip: ABHarnessClip) => void;
  stopPlayback: () => void;
  reveal: () => void;
  castVote: (clip: ABHarnessClip) => void;
  /** Cancel any in-flight recording or playback and free buffers. */
  cancel: () => void;
}

/**
 * Cryptographically random fair coin flip. Avoids Math.random bias on short
 * test runs — relevant because the harness might be run a handful of times
 * per session and we don't want detectable patterns in label assignments.
 */
export function cryptoCoinFlip(): 0 | 1 {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] & 1) as 0 | 1;
}
