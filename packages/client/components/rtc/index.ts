export { VoiceContext, useVoice } from "./state";

export { InRoom } from "./components/InRoom";
export { RoomAudioManager } from "./components/RoomAudioManager";

// [VOICE-DEBUG-CAPTURE]
export { isDebugCaptureBuild } from "./debugCapture";
export type { DebugCaptureSession, DebugCaptureState } from "./debugCapture";

// [Voice/H2] A/B harness
export type {
  ABHarnessClip,
  ABHarnessLabeling,
  ABHarnessPass,
  ABHarnessSession,
  ABHarnessState,
} from "./abHarness";

// [Voice/H3] Rolling diagnostic ring buffer accessors.
export { getVoiceDiagHistory, clearVoiceDiagHistory } from "./state";
export type { VoiceDiagSnapshot } from "./state";
