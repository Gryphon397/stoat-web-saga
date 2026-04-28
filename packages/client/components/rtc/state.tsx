import {
  Accessor,
  JSX,
  Setter,
  Show,
  batch,
  createContext,
  createEffect,
  createSignal,
  useContext,
  onMount,
  onCleanup,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import { AudioCaptureOptions, ConnectionQuality, LocalAudioTrack, LocalTrackPublication, LocalVideoTrack, Participant, RemoteAudioTrack, Room, ScreenSharePresets, Track, TrackPublication, VideoPresets, VideoResolution } from "livekit-client";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import { voiceNotifications } from "./VoiceNotifications";
import { ModalController, useModals } from "@revolt/modal";

const debugLog = (prefix: string, ...args: unknown[]) => {
  if (import.meta.env.DEV) {
    console.log(`[${prefix}]`, ...args);
  }
};

// Type declarations for Stoat Desktop screenshare picker API
declare global {
  interface Window {
    desktopCapture?: {
      onSourcesAvailable: (
        callback: (
          sources: Array<{ id: string; name: string; thumbnail: string }>,
        ) => void,
      ) => void;
      selectSource: (id: string) => void;
      cancel: () => void;
      onWindowSelected: (callback: (sourceId: string) => void) => void;
      listSources?: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
    };
    appAudioCapture?: {
      start: (sourceId: string) => Promise<boolean>;
      stop: () => Promise<void>;
      onData: (callback: (chunk: Uint8Array) => void) => void;
      offData: (callback: (chunk: Uint8Array) => void) => void;
      onStopped: (callback: () => void) => void;
      offStopped: (callback: () => void) => void;
    };
  }
}

// Type declarations for Stoat Desktop pop-out window API
declare global {
  interface Window {
    stoatPopout?: {
      open: (params: {
        identity: string;
        username: string;
        livekitUrl?: string;
        viewerToken?: string;
        offerSdp?: string;
        volume?: number;
      }) => Promise<void>;
      close: (identity: string) => Promise<void>;
      notifyMainDisconnected: () => Promise<void>;
      onPopoutClosed: (callback: (identity: string) => void) => () => void;
      onAnswer: (callback: (identity: string, answerSdp: string) => void) => () => void;
    };
  }
}

// Type declarations for Stoat Desktop push-to-talk API
declare global {
  interface Window {
    pushToTalk?: {
      onStateChange: (callback: (state: { active: boolean }) => void) => void;
      offStateChange: (callback: (state: { active: boolean }) => void) => void;
      setManualState: (active: boolean) => void;
      getCurrentState: () => { active: boolean };
      getConfig: () => {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      };
      onConfigChange: (callback: (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => void) => void;
      offConfigChange: (callback: (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => void) => void;
      updateSettings: (settings: {
        enabled?: boolean;
        keybind?: string;
        mode?: "hold" | "toggle";
        releaseDelay?: number;
        notificationSounds?: boolean;
      }) => void;
    };
  }
}


import { Channel } from "stoat.js";

import { useState } from "@revolt/state";
import { ScreenShareQualityName, Voice as VoiceSettings } from "@revolt/state/stores/Voice";
import { useClient } from "@revolt/client";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { CONFIGURATION } from "@revolt/common";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { ScreenSharePicker } from "./components/ScreenSharePicker";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

type ScreenShareQuality = {
  name: ScreenShareQualityName;
  resolution: VideoResolution;
  fullName: string;
  contentHint: string;
};

// AudioWorklet processor for per-process audio capture (inline blob URL)
const pcmFeederWorkletCode = `
class PcmFeederProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._readOffset = 0;
    this.port.onmessage = (e) => { this._buffer.push(e.data); };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const L = out[0], R = out[1];
    for (let i = 0; i < L.length; i++) {
      while (this._buffer.length > 0 && this._readOffset >= this._buffer[0].length) {
        this._buffer.shift();
        this._readOffset = 0;
      }
      if (this._buffer.length > 0) {
        L[i] = this._buffer[0][this._readOffset] / 32768;
        R[i] = this._buffer[0][this._readOffset + 1] / 32768;
        this._readOffset += 2;
      } else {
        L[i] = 0; R[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-feeder", PcmFeederProcessor);
`;
let pcmFeederWorkletUrl: string | null = null;
function getPcmFeederWorkletUrl(): string {
  if (!pcmFeederWorkletUrl) {
    pcmFeederWorkletUrl = URL.createObjectURL(
      new Blob([pcmFeederWorkletCode], { type: "application/javascript" }),
    );
  }
  return pcmFeederWorkletUrl;
}

// Discord-style input sensitivity gate AudioWorklet.
// Fixed threshold (set from stored settings or auto-calibration) — not adaptive.
// Threshold is updated live via port.postMessage({ threshold: <linear RMS> }).
// No comfort noise injection — DTX is disabled at both signaling and codec level.
//
// Each VAD-IMPROVEMENT-#N block below is independently revertable; grep for the
// marker to find the original behavior to restore.
const inputGateWorkletCode = `
class StoatInputGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._threshold = 0.001; // -60 dBFS default; overwritten immediately via port
    this._gateGain = 0.0;
    this._holdCounter = 0;
    this._HOLD_FRAMES = 30;
    // [VAD-IMPROVEMENT-#6] Slower attack: was 0.8 (~2.7 ms), clipped plosives.
    // 0.3 ≈ 10 ms — preserves "p"/"t"/"k" onsets without losing snap.
    // To revert: set _ATTACK back to 0.8.
    this._ATTACK = 0.3;
    this._RELEASE = 0.03;
    // [VAD-IMPROVEMENT-#4] Amplitude hysteresis: open at threshold, close 10 dB
    // lower. Single-threshold gates chatter at the boundary on breath/HVAC.
    // To revert: set _CLOSE_RATIO to 1.0 (collapses to single threshold).
    this._CLOSE_RATIO = Math.pow(10, -10 / 20); // ≈ 0.3162
    // [VAD-IMPROVEMENT-#8] Silero VAD AND-gate. When sileroEnabled=true, the
    // worklet output also requires vadActive=true (set via main thread from
    // @ricky0123/vad-web onSpeechStart/onSpeechEnd). When sileroEnabled=false,
    // the worklet behaves as RMS-only.
    // To revert: ignore vadActive entirely in the targetGain calc.
    this._sileroEnabled = false;
    this._vadActive = false;
    this.port.onmessage = (e) => {
      if (typeof e.data.threshold === 'number') this._threshold = e.data.threshold;
      if (typeof e.data.sileroEnabled === 'boolean') this._sileroEnabled = e.data.sileroEnabled;
      if (typeof e.data.vadActive === 'boolean') this._vadActive = e.data.vadActive;
    };
  }
  process(inputs, outputs) {
    // [VAD-IMPROVEMENT-#5] Two-input worklet:
    //   input 0 = clean audio (passed through gate, never bandpassed)
    //   input 1 = bandpass-filtered side-chain (used only for RMS detection)
    // Bandpass keeps HVAC/rumble (<300 Hz) and hiss (>3.4 kHz) out of the
    // gate decision without colouring the audio that gets transmitted.
    // To revert: connect the same source to both inputs in #applyInputGate.
    const audioIn = inputs[0] && inputs[0][0];
    const detectorIn = (inputs[1] && inputs[1][0]) || audioIn;
    const out = outputs[0];
    if (!audioIn || !out || !out[0]) return true;
    const outCh = out[0];
    let ss = 0;
    for (let i = 0; i < detectorIn.length; i++) ss += detectorIn[i] * detectorIn[i];
    const rms = Math.sqrt(ss / detectorIn.length);
    // [VAD-IMPROVEMENT-#4] Dual-threshold hysteresis. RMS in [closeThresh,
    // _threshold) is a dead-zone — hold counter does not change.
    const closeThresh = this._threshold * this._CLOSE_RATIO;
    if (rms >= this._threshold) {
      this._holdCounter = this._HOLD_FRAMES;
    } else if (rms < closeThresh) {
      this._holdCounter = this._holdCounter > 0 ? this._holdCounter - 1 : 0;
    }
    const rmsOpen = this._holdCounter > 0;
    // [VAD-IMPROVEMENT-#8] Combine RMS gate with Silero veto (AND mode).
    const sileroOk = !this._sileroEnabled || this._vadActive;
    const targetGain = (rmsOpen && sileroOk) ? 1.0 : 0.0;
    this._gateGain += targetGain > this._gateGain ? this._ATTACK : -this._RELEASE;
    this._gateGain = this._gateGain < 0.0 ? 0.0 : this._gateGain > 1.0 ? 1.0 : this._gateGain;
    // DF3 runs after the gate. Pure silence causes DF3 to adapt its noise model to
    // zero-signal; on the next speech onset it briefly treats voice as noise (gargling).
    // A -54 dBFS bleed (~0.002 linear) keeps DF3 "warm" without transmitting audible audio.
    const g = this._gateGain > 0.002 ? this._gateGain : 0.002;
    for (let i = 0; i < audioIn.length; i++) {
      outCh[i] = audioIn[i] * g;
    }
    return true;
  }
}
registerProcessor('stoat-input-gate', StoatInputGateProcessor);
`;
let inputGateWorkletUrl: string | null = null;
function getInputGateWorkletUrl(): string {
  if (!inputGateWorkletUrl) {
    inputGateWorkletUrl = URL.createObjectURL(
      new Blob([inputGateWorkletCode], { type: "application/javascript" }),
    );
  }
  return inputGateWorkletUrl;
}

/** Tap a MediaStreamTrack for ~150 ms and return its RMS level as a dBFS string. */
async function measureDbfs(track: MediaStreamTrack): Promise<string> {
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    // Modern Chrome creates AudioContexts in 'suspended' state — without
    // resume() the analyser never sees data and every measurement reads -∞.
    await ctx.resume().catch(() => { /* ignore */ });
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    await new Promise<void>(r => setTimeout(r, 150));
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let ss = 0;
    for (const v of buf) ss += v * v;
    const rms = Math.sqrt(ss / buf.length);
    await ctx.close();
    return rms > 1e-7 ? `${(20 * Math.log10(rms)).toFixed(1)} dBFS` : "-∞";
  } catch {
    return "err";
  }
}

/**
 * Print WebRTC stats for all active audio tracks to the browser console.
 * Called by window.stoatDiag() and automatically every 30s while connected.
 */
const _prevConcealed = new Map<string, number>();
const _prevTotalSamples = new Map<string, number>();
const _prevBytesSent = new Map<string, { bytes: number; ts: number }>();
const _prevPacketsSent = new Map<string, { packets: number; ts: number }>();

async function printVoiceStats(room: Room, df3Active: boolean, rawMicTrack: MediaStreamTrack | null) {
  const ts = new Date().toLocaleTimeString();
  console.group(`[Voice Diagnostics] ${ts}`);

  const local = room.localParticipant;
  console.log(`Local participant: ${local.identity} | quality=${local.connectionQuality}`);
  console.log(`  Pipeline: DF3=${df3Active ? "✅ active" : "❌ inactive"}`);

  // Upload: local microphone RTCRtpSender stats
  const micPub = local.getTrackPublication(Track.Source.Microphone);
  if (micPub?.track) {
    try {
      const sender = (micPub.track as any)?.sender as RTCRtpSender | undefined;
      if (sender) {
        const stats = await sender.getStats();
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && r.kind === "audio") {
            const ulKey = "local-upload";
            const ulNow = Date.now();
            const ulPrev = _prevBytesSent.get(ulKey);
            const ulPpsPrev = _prevPacketsSent.get(ulKey);
            const ulKbps = ulPrev
              ? (((r.bytesSent - ulPrev.bytes) * 8) / ((ulNow - ulPrev.ts) / 1000) / 1000).toFixed(1)
              : "—";
            const ulPps = ulPpsPrev
              ? ((r.packetsSent - ulPpsPrev.packets) / ((ulNow - ulPpsPrev.ts) / 1000)).toFixed(1)
              : "—";
            _prevBytesSent.set(ulKey, { bytes: r.bytesSent, ts: ulNow });
            _prevPacketsSent.set(ulKey, { packets: r.packetsSent, ts: ulNow });
            console.log(`  Upload mic: pps=${ulPps} (expect ~50), kbps=${ulKbps}, packetsSent=${r.packetsSent}`);
          }
          if (r.type === "remote-inbound-rtp") {
            const jitter = ((r.jitter ?? 0) * 1000).toFixed(1);
            const rttRaw = (r.roundTripTime ?? 0) * 1000;
            const rtt = rttRaw > 0 && rttRaw < 5000 ? `${rttRaw.toFixed(0)}ms` : "pending";
            const loss = ((r.fractionLost ?? 0) * 100).toFixed(1);
            console.log(`  Upload quality (server sees): RTT=${rtt}, jitter=${jitter}ms, loss=${loss}%`);
          }
        });
      }
    } catch (e) {
      console.warn("  Could not get mic sender stats:", e);
    }
  } else {
    console.log("  Mic: not publishing");
  }

  // Upload: screenshare video track sender stats
  const ssPub = local.getTrackPublication(Track.Source.ScreenShare);
  if (ssPub?.track) {
    try {
      const sender = (ssPub.track as any)?.sender as RTCRtpSender | undefined;
      if (sender) {
        const stats = await sender.getStats();
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && r.kind === "video") {
            const ssKey = "local-screenshare";
            const ssNow = Date.now();
            const ssPrev = _prevBytesSent.get(ssKey);
            const ssKbps = ssPrev
              ? (((r.bytesSent - ssPrev.bytes) * 8) / ((ssNow - ssPrev.ts) / 1000) / 1000).toFixed(1)
              : "—";
            _prevBytesSent.set(ssKey, { bytes: r.bytesSent, ts: ssNow });
            const fps = (r.framesPerSecond ?? 0).toFixed(1);
            const limitReason = r.qualityLimitationReason ?? "unknown";
            console.log(`  Upload screenshare: ${r.frameWidth ?? "?"}×${r.frameHeight ?? "?"}@${fps}fps, ${ssKbps}kbps | limit=${limitReason}`);
          }
        });
      }
    } catch (e) {
      console.warn("  Could not get screenshare sender stats:", e);
    }
  }

  // Download: per-remote-participant audio receiver stats
  const remotes = Array.from(room.remoteParticipants.values());
  if (remotes.length === 0) {
    console.log("  No remote participants");
  }
  for (const p of remotes) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    const q = p.connectionQuality;
    if (pub?.track) {
      try {
        const receiver = (pub.track as RemoteAudioTrack)?.receiver as RTCRtpReceiver | undefined;
        if (receiver) {
          const stats = await receiver.getStats();
          stats.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
              const jitter = ((r.jitter ?? 0) * 1000).toFixed(1);
              const total = (r.packetsReceived ?? 0) + (r.packetsLost ?? 0);
              const loss = total > 0 ? ((r.packetsLost ?? 0) / total * 100).toFixed(1) : "0.0";
              const concealedNow = r.concealedSamples ?? 0;
              const concealedPrev = _prevConcealed.get(p.identity) ?? concealedNow;
              const concealedDelta = concealedNow - concealedPrev;
              _prevConcealed.set(p.identity, concealedNow);
              const totalNow = r.totalSamplesReceived ?? 0;
              const totalPrev = _prevTotalSamples.get(p.identity) ?? totalNow;
              const totalDelta = totalNow - totalPrev;
              const concealPct = totalDelta > 0 ? ((concealedDelta / totalDelta) * 100).toFixed(1) : "0.0";
              _prevTotalSamples.set(p.identity, totalNow);
              const dlKey = `dl-${p.identity}`;
              const dlNow = Date.now();
              const dlPrev = _prevBytesSent.get(dlKey);
              const dlKbps = dlPrev
                ? (((r.bytesReceived - dlPrev.bytes) * 8) / ((dlNow - dlPrev.ts) / 1000) / 1000).toFixed(1)
                : "—";
              _prevBytesSent.set(dlKey, { bytes: r.bytesReceived, ts: dlNow });
              console.log(`  ${p.identity}: quality=${q}, jitter=${jitter}ms, loss=${loss}%, concealed=${concealPct}%, dl=${dlKbps}kbps, muted=${pub.isMuted}`);
            }
          });
        }
      } catch (e) {
        console.warn(`  Could not get receiver stats for ${p.identity}:`, e);
      }
    } else {
      console.log(`  ${p.identity}: quality=${q}, no audio track`);
    }
  }

  // Level metering: all tracks measured in parallel (single ~150 ms sample)
  const levelChecks: Array<{ label: string; track: MediaStreamTrack }> = [];
  const micPubLevel = local.getTrackPublication(Track.Source.Microphone);
  // Raw mic level — true pre-gate signal. Comes from Voice.rawMicTrack, which
  // is captured before #applyInputGate's replaceTrack swaps the publication.
  if (rawMicTrack) {
    levelChecks.push({ label: "local (raw mic, pre-gate)", track: rawMicTrack });
  }
  if (micPubLevel?.track) {
    // After replaceTrack, micPubLevel.track.mediaStreamTrack is the gated
    // worklet output — pre-DF3, post-gate. Useful to verify the gate is
    // actually opening when you speak.
    levelChecks.push({ label: "local (post-gate, pre-DF3)", track: micPubLevel.track.mediaStreamTrack });
    const proc = (micPubLevel.track as any).processor;
    if (df3Active && proc?.processedTrack) {
      levelChecks.push({ label: "local (post-DF3, transmitted)", track: proc.processedTrack as MediaStreamTrack });
    }
  }
  for (const p of remotes) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    if (pub?.track) {
      levelChecks.push({
        label: `${p.identity}${pub.isMuted ? " [muted]" : ""}`,
        track: (pub.track as RemoteAudioTrack).mediaStreamTrack,
      });
    }
  }
  if (levelChecks.length > 0) {
    const levels = await Promise.all(levelChecks.map(({ track }) => measureDbfs(track)));
    console.log("  Signal levels (150 ms sample):");
    levelChecks.forEach(({ label }, i) => console.log(`    ${label}: ${levels[i]}`));
  }

  console.groupEnd();
}

// Inject x-google-start-bitrate/x-google-min-bitrate into all video codec fmtp
// lines in an SDP offer. Chrome/Electron reads these to seed its GCC bandwidth
// estimator, so the screenshare starts at ~6Mbps instead of ramping from ~300kbps.
function mungeSdpGCC(sdp: string): string {
  const videoPts = new Set<string>();
  const videoLineMatch = sdp.match(/^m=video \S+ \S+ (.+)$/m);
  if (videoLineMatch) videoLineMatch[1].split(" ").forEach(pt => videoPts.add(pt));

  let inVideo = false;
  return sdp.split("\r\n").map(line => {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video ");
    if (inVideo && line.startsWith("a=fmtp:")) {
      const pt = line.match(/^a=fmtp:(\d+)/)?.[1];
      if (pt && videoPts.has(pt) && !line.includes("x-google-start-bitrate")) {
        return line + ";x-google-start-bitrate=6000;x-google-min-bitrate=2000";
      }
    }
    return line;
  }).join("\r\n");
}

class Voice {
  #settings: VoiceSettings;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  state: Accessor<State>;
  #setState: Setter<State>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  vidTracks: Accessor<TrackReferenceOrPlaceholder[]>;

  stoppedScreenshares: Accessor<ReadonlySet<string>>;
  #setStoppedScreenshares: Setter<Set<string>>;

  fullscreen: Accessor<boolean>;
  #setFullscreen: Setter<boolean>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  private openModal: ModalController["openModal"];
  private getClient: ReturnType<typeof useClient>;

  #livekitUrl = "";
  get livekitUrl() { return this.#livekitUrl; }
  // Input sensitivity gate AudioContext + worklet node
  #inputGateCtx: AudioContext | null = null;
  #inputGateNode: AudioWorkletNode | null = null;
  // Public read accessor for diagnostics — returns the pre-gate mic track.
  get rawMicTrack(): MediaStreamTrack | null { return this.#rawMicTrack; }
  // [VAD-IMPROVEMENT-#8] Silero VAD second-pass classifier (loaded on demand
  // via dynamic import). null when disabled or not yet running.
  // Type kept loose because the package's MicVAD type isn't re-exported cleanly.
  #sileroVad: { destroy(): void; start?(): void; pause?(): void } | null = null;
  // Raw (pre-gate) mic track, kept for periodic auto-calibration
  #rawMicTrack: MediaStreamTrack | null = null;
  #calibrationInterval: ReturnType<typeof setInterval> | null = null;
  // Rolling history of per-window minimum RMS values (~10 min at 30 s cadence)
  #calibrationHistory: number[] = [];
  // Per-process audio capture state
  #appAudioCtx: AudioContext | null = null;
  #appAudioWorklet: AudioWorkletNode | null = null;
  #appAudioDestination: MediaStreamAudioDestinationNode | null = null;
  #appAudioDataHandler: ((chunk: Uint8Array) => void) | null = null;
  #appAudioSourceId: string | null = null;
  // Electron picker promise API
  #pickerResolve: ((id: string | null) => void) | null = null;
  #pickSourcesCallback: ((sources: Array<{ id: string; name: string; thumbnail: string }>) => void) | null = null;

  setPickSourcesHandler(fn: (sources: Array<{ id: string; name: string; thumbnail: string }>) => void) {
    this.#pickSourcesCallback = fn;
  }

  hasPendingPickerSelection(): boolean {
    return this.#pickerResolve !== null;
  }

  notifySourceSelected(id: string | null) {
    this.#pickerResolve?.(id);
    this.#pickerResolve = null;
  }

  constructor(voiceSettings: VoiceSettings, modals: ModalController) {
    this.#settings = voiceSettings;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    this.deafen = () => voiceSettings.deafen;
    this.microphone = () => voiceSettings.micOn;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    this.vidTracks = () => [];

    const [stoppedScreenshares, setStoppedScreenshares] = createSignal<Set<string>>(new Set(), { equals: false });
    this.stoppedScreenshares = stoppedScreenshares;
    this.#setStoppedScreenshares = setStoppedScreenshares;

    const [fullscreen, setFullscreen] = createSignal(false);
    this.fullscreen = fullscreen;
    this.#setFullscreen = setFullscreen;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    this.openModal = modals.openModal.bind(modals);
    this.getClient = useClient();
  }

  /**
   * Initialize vidTracks via useTracks — must be called within the RoomContext.Provider
   * reactive scope (i.e. from VoiceContext after the provider is established).
   */
  initTracks() {
    this.vidTracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { onlySubscribed: false },
    );
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    debugLog("PTT-WEB", "Voice.connect() called for channel:", channel.id);
    this.disconnect();

    const room = new Room({
      activeSpeakerInterval: 100,
      dynacast: true,
      publishDefaults: {
        audioPreset: { maxBitrate: 128_000 },
        dtx: false,            // Disable DTX at the signaling level (top-level v2 field)
        red: true,             // Redundant Audio Data — piggybacks previous frame for loss recovery
        codecOptions: {
          opusFec: true,       // Forward Error Correction — reconstruct dropped packets
          opusDtx: false,      // Disable DTX at the codec level (belt-and-suspenders with dtx:false above)
          opusMaxPlaybackRate: 48000,
        },
      },
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation ?? true,
        noiseSuppression: false, // DF3 handles noise suppression via setProcessor
        autoGainControl: true,
      },
      videoCaptureDefaults: {
        resolution: VideoPresets.h1080.resolution,
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
    });

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");

      // PTT always joins muted; without PTT, always join unmuted
      if (this.#settings.pushToTalkEnabled) {
        debugLog("PTT-WEB", "PTT enabled - joining muted");
        this.#settings.micOn = false;
      } else {
        this.#settings.micOn = true;
      }
      this.#settings.deafen = false;
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        room.localParticipant.setMicrophoneEnabled(this.#settings.micOn).then((track) => {
          this.#settings.micOn = track != null;
        });
      room.localParticipant.setAttributes({ deafened: this.#settings.deafen ? "true" : "false" });
      debugLog("PTT-WEB", "Room connected");
      this.#setState("CONNECTED");
      voiceNotifications.playSelfJoin();
      // Seed history with 3 copies of the stored threshold so the first real
      // measurement can't corrupt the gate if the user happens to be talking.
      const storedDbfs = this.#settings.inputSensitivity ?? -60;
      const storedRms = Math.pow(10, storedDbfs / 20);
      this.#calibrationHistory = [storedRms, storedRms, storedRms];
      // Start periodic auto-calibration (same cadence as voice diagnostics).
      this.#calibrationInterval = setInterval(() => {
        if ((this.#settings.inputSensitivityAuto ?? true) && this.#rawMicTrack) {
          void this.#calibrateInputSensitivity(this.#rawMicTrack);
        }
      }, 30_000);
    });

    room.addListener("reconnecting", () => {
      debugLog("PTT-WEB", "Room reconnecting");
      this.#setState("RECONNECTING");
    });

    room.addListener("reconnected", () => {
      debugLog("PTT-WEB", "Room reconnected");
      this.#setState("CONNECTED");
    });

    room.addListener("disconnected", () => {
      debugLog("PTT-WEB", "Room disconnected");
      this.#setState("DISCONNECTED");
      _prevConcealed.clear();
      _prevTotalSamples.clear();
      _prevBytesSent.clear();
      _prevPacketsSent.clear();
      if (this.#calibrationInterval) {
        clearInterval(this.#calibrationInterval);
        this.#calibrationInterval = null;
      }
      this.#rawMicTrack = null;
      this.#calibrationHistory = [];
    });

    // Attach input gate + DF3 to any newly published mic track — covers initial
    // connect, PTT first-press (track created on demand), and post-reconnect republish.
    room.addListener("localTrackPublished", async (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.Microphone) return;
      const track = publication.track as LocalAudioTrack | undefined;
      if (!track) return;

      // Input gate runs pre-DF3; #applyInputGate also captures #rawMicTrack.
      await this.#applyInputGate(track);

      // Initial calibration — periodic calibration is driven by #calibrationInterval.
      if ((this.#settings.inputSensitivityAuto ?? true) && this.#rawMicTrack) {
        void this.#calibrateInputSensitivity(this.#rawMicTrack);
      }

      // [VAD-IMPROVEMENT-#12] Mark outgoing voice as high network-priority so
      // QoS-aware routers / congestion controllers favor audio packets over
      // bulk traffic on the same path (e.g. screenshare on the publisher PC).
      // Applied per-encoding on the underlying RTCRtpSender — LiveKit doesn't
      // expose this via publishDefaults at v2.13.0.
      // To revert: delete this try/catch block.
      try {
        const sender = (track as unknown as { sender?: RTCRtpSender }).sender;
        if (sender) {
          const params = sender.getParameters();
          for (const enc of params.encodings ?? []) {
            (enc as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = "high";
          }
          await sender.setParameters(params);
        }
      } catch (e) {
        // Non-fatal — networkPriority is a hint.
        console.warn("[Voice] networkPriority hint not applied:", e);
      }

      if (!this.#settings.noiseSupression) return;
      if (!DeepFilterNoiseFilterProcessor.isSupported()) {
        console.warn("[Voice] DF3 not supported in this browser");
        return;
      }
      try {
        await track.setProcessor(
          new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" }, noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 20 }),
        );
        console.log("[Voice] ✅ DeepFilterNet3 noise suppression active");
      } catch (e) {
        console.warn("[Voice] ❌ DeepFilterNet3 failed to start:", e);
      }
    });

    // When the shared window closes, LiveKit unpublishes the track automatically.
    // Sync our screenshare state so the share UI clears.
    room.addListener("localTrackUnpublished", (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        this.#setScreenshare(false);
        this.#stopAppAudioCapture();
      }
    });

    // Sounds for other participants joining/leaving/screensharing
    room.addListener("participantConnected", () => {
      voiceNotifications.playJoin();
    });

    room.addListener("participantDisconnected", () => {
      voiceNotifications.playLeave();
    });

    room.addListener("trackPublished", (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        voiceNotifications.playScreenshareStart();
      }
    });

    room.addListener("trackUnpublished", (publication) => {
      if (publication.source === Track.Source.ScreenShare) {
        voiceNotifications.playScreenshareEnd();
      }
    });

    room.addListener("connectionQualityChanged", (quality: ConnectionQuality, participant: Participant) => {
      console.log(`[Voice] Quality: ${participant.identity} → ${quality}`);
    });

    room.addListener("trackMuted", (publication: TrackPublication, participant: Participant) => {
      if (publication.kind === "audio") {
        console.log(`[Voice] ${participant.identity} muted ${publication.source === Track.Source.Microphone ? "mic" : "audio"}`);
      }
    });

    room.addListener("trackUnmuted", (publication: TrackPublication, participant: Participant) => {
      if (publication.kind === "audio") {
        console.log(`[Voice] ${participant.identity} unmuted ${publication.source === Track.Source.Microphone ? "mic" : "audio"}`);
      }
    });

    if (!auth) {
      let voiceServer = "worldwide";
      if (channel.server?.description) {
        const descSplits = channel.server.description.split("\n");
        const lastLine = descSplits[descSplits?.length - 1];
        if (lastLine.startsWith("voice-server:")) {
          voiceServer = lastLine.replace("voice-server:", "");
        }
      }
      auth = await channel.joinCall(voiceServer);
    }

    this.#livekitUrl = auth.url;
    debugLog("PTT-WEB", "Connecting to room...");
    // [VAD-IMPROVEMENT-#10] autoSubscribe: true — every remote track is
    // subscribed automatically as participants publish, instead of waiting for
    // RoomAudioManager's setSubscribed loop to opt in (~50 ms × N participants
    // before first audio frame). RoomAudioManager's explicit setSubscribed call
    // remains as a safety net but is now a no-op for the fast path.
    // To revert: set autoSubscribe back to false.
    await room.connect(auth.url, auth.token, {
      autoSubscribe: true,
    });
    debugLog("PTT-WEB", "Room connected successfully, mic state:", room.localParticipant.isMicrophoneEnabled);
    
    // Handle mic state based on PTT setting
    if (this.#settings.pushToTalkEnabled) {
      // PTT enabled - mute mic so user must press key to speak
      if (room.localParticipant.isMicrophoneEnabled) {
        debugLog("PTT-WEB", "PTT enabled and mic was auto-enabled by LiveKit, explicitly muting...");
        await room.localParticipant.setMicrophoneEnabled(false);
        debugLog("PTT-WEB", "Mic explicitly muted, state:", room.localParticipant.isMicrophoneEnabled);
      }
    } else {
      // PTT disabled - unmute mic so user can speak immediately
      if (!room.localParticipant.isMicrophoneEnabled) {
        debugLog("PTT-WEB", "PTT disabled and mic is muted, explicitly unmuting...");
        await room.localParticipant.setMicrophoneEnabled(true);
        this.#settings.micOn = true;
        debugLog("PTT-WEB", "Mic explicitly unmuted, state:", room.localParticipant.isMicrophoneEnabled);
      }
    }
  }

  async applyMicConstraints() {
    const room = this.room();
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;

    const nsEnabled = this.#settings.noiseSupression ?? true;
    const ecEnabled = this.#settings.echoCancellation ?? true;

    try {
      const options: AudioCaptureOptions = {
        noiseSuppression: false,
        echoCancellation: ecEnabled,
        autoGainControl: true,
        deviceId: this.#settings.preferredAudioInputDevice,
      };
      await track.restartTrack(options);
    } catch (e) {
      console.warn("[Voice] restartTrack failed:", e);
    }

    // Reapply input gate — restartTrack resets to the raw getUserMedia track.
    await this.#applyInputGate(track);

    try {
      if (nsEnabled) {
        await track.setProcessor(
          new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" }, noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 20 }),
        );
        console.log("[Voice] ✅ DeepFilterNet3 noise suppression active");
      } else {
        await track.stopProcessor();
        console.log("[Voice] DeepFilterNet3 noise suppression disabled");
      }
    } catch (e) {
      console.warn("[Voice] ❌ DF3 processor error:", e);
    }

  }

  disconnect() {
    const room = this.room();
    if (!room) return;

    // Stop per-process audio capture if active
    this.#stopAppAudioCapture();
    void this.#cleanupInputGate();
    if (this.#calibrationInterval) {
      clearInterval(this.#calibrationInterval);
      this.#calibrationInterval = null;
    }
    this.#rawMicTrack = null;
    this.#calibrationHistory = [];

    voiceNotifications.playSelfLeave();

    // Notify Electron to close all pop-out windows
    window.stoatPopout?.notifyMainDisconnected();

    room.removeAllListeners();
    room.disconnect();

    batch(() => {
      this.#setState("READY");
      this.#setRoom(undefined);
      this.#setChannel(undefined);
      this.#setScreenshare(false);
      this.#setVideo(false);
      this.#setFullscreen(false);
      this.vidTracks = () => [];
      this.#setStoppedScreenshares(new Set());
    });
  }

  async toggleDeafen() {
    const wasDeafened = this.deafen();
    const newDeafened = !wasDeafened;
    this.#settings.deafen = newDeafened;
    this.room()?.localParticipant.setAttributes({ deafened: newDeafened ? "true" : "false" });
    if (!wasDeafened) {
      voiceNotifications.playDeafen();
    } else {
      voiceNotifications.playUndeafen();
    }
  }

  async toggleMute() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;

      const shouldPlaySound = !this.#settings.pushToTalkEnabled || this.#settings.pushToTalkNotificationSounds;

      if (shouldPlaySound) {
        if (room.localParticipant.isMicrophoneEnabled) {
          voiceNotifications.playUnmute();
        } else {
          voiceNotifications.playMute();
        }
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Set microphone mute state directly (for push-to-talk)
   * @param enabled true to unmute, false to mute
   */
  async setMute(enabled: boolean) {
    debugLog("PTT-WEB", "setMute() called:", enabled);
    const room = this.room();
    if (!room) {
      debugLog("PTT-WEB", "setMute() - no room, returning");
      return;
    }
    
    const currentState = room.localParticipant.isMicrophoneEnabled;
    debugLog("PTT-WEB", "setMute() - current mic state:", currentState, "target:", enabled);
    
    if (currentState !== enabled) {
      debugLog("PTT-WEB", "setMute() - calling setMicrophoneEnabled(", enabled, ")");
      await room.localParticipant.setMicrophoneEnabled(enabled);
      this.#settings.micOn = enabled;
      debugLog("PTT-WEB", "setMute() - mic state updated to:", enabled);

      // only play sounds if PTT is disabled, or if PTT is enabled with notification sounds on
      const shouldPlaySound = !this.#settings.pushToTalkEnabled || this.#settings.pushToTalkNotificationSounds;
      
      if (shouldPlaySound) {
        if (this.#settings.pushToTalkEnabled) {
          if (enabled) {
            voiceNotifications.playPttActivate();
          } else {
            voiceNotifications.playPttDeactivate();
          }
        } else {
          if (enabled) {
            voiceNotifications.playUnmute();
          } else {
            voiceNotifications.playMute();
          }
        }
      }
    } else {
      debugLog("PTT-WEB", "setMute() - no change needed, already:", enabled);
    }
  }

  async toggleCamera() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setCameraEnabled(
        !room.localParticipant.isCameraEnabled,
      );

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.onErr(e);
    }
  }

  toggleFullscreen(fullscreen: boolean = !this.fullscreen()) {
    this.#setFullscreen(fullscreen);
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    this.#setFocus(
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id,
    );
  }

  isFocus(t: TrackReferenceOrPlaceholder) {
    return this.trackId(t) === this.focusId();
  }

  focusTrack() {
    const id = this.focusId();
    return id
      ? this.vidTracks().find((t) => this.trackId(t) === id)
      : undefined;
  }

  toggleShowBar() {
    this.#setShowBar((s) => !s);
  }

  stopWatchingScreenshare(identity: string) {
    const focused = this.focusTrack();
    if (focused?.participant.identity === identity && focused.source === Track.Source.ScreenShare) {
      this.#setFocus(undefined);
    }
    this.#setStoppedScreenshares((prev) => {
      prev.add(identity);
      return prev;
    });
  }

  isScreenshareStopped(identity: string) {
    return this.stoppedScreenshares().has(identity);
  }

  setAppAudioSourceId(id: string | null) {
    this.#appAudioSourceId = id;
  }

  getEnabledScreenShareQualities(): Partial<Record<ScreenShareQualityName, ScreenShareQuality>> {
    const fps = this.#settings.screenshareFrameRate;
    const qualities: Partial<Record<ScreenShareQualityName, ScreenShareQuality>> = {
      low: {
        name: "low",
        resolution: { width: 1280, height: 720, frameRate: fps },
        fullName: `720p ${fps}FPS`,
        contentHint: "motion",
      },
    };

    qualities.high = {
      name: "high",
      resolution: { width: 1920, height: 1080, frameRate: fps },
      fullName: `1080p ${fps}FPS`,
      contentHint: "motion",
    };
    qualities["4k"] = {
      name: "4k",
      resolution: { width: 3840, height: 2160, frameRate: fps },
      fullName: `4K ${fps}FPS`,
      contentHint: "motion",
    };
    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      await this.#stopAppAudioCapture();
      await room.localParticipant.setScreenShareEnabled(false);
      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
      voiceNotifications.playScreenshareEnd();
      return;
    }

    // Electron: use getUserMedia with chromeMediaSource:'desktop' for proper frame rate control.
    // setDisplayMediaRequestHandler + DesktopCapturerSource delivers only ~2fps regardless of
    // the frameRate constraint because the constraint is not honored in that callback path.
    if (window.desktopCapture?.listSources) {
      const fps = this.#settings.screenshareFrameRate;
      const maxBitrate = fps >= 60 ? 8_000_000 : fps >= 30 ? 5_000_000 : 2_000_000;
      const qualities = this.getEnabledScreenShareQualities();
      const quality = qualities[this.#settings.screenShareQuality] ?? qualities.low!;
      const capWidth = quality.resolution.width || undefined;
      const capHeight = quality.resolution.height || undefined;

      // Get source list and show picker
      let sources: Array<{ id: string; name: string; thumbnail: string }>;
      try {
        sources = await window.desktopCapture.listSources();
      } catch (e: any) {
        console.warn("[Voice] Failed to list screenshare sources:", e?.message ?? e);
        return;
      }

      const sourceId = await new Promise<string | null>((resolve) => {
        this.#pickerResolve = resolve;
        this.#pickSourcesCallback?.(sources);
      });

      if (!sourceId) {
        this.#appAudioSourceId = null;
        return;
      }

      // Window captures use per-process audio; screen captures get loopback below
      this.#appAudioSourceId = sourceId.startsWith("window:") ? sourceId : null;

      // Capture video via getUserMedia with mandatory constraints — the only Electron path
      // that actually honors frameRate (setDisplayMediaRequestHandler ignores it).
      let videoStream: MediaStream;
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: sourceId,
              minFrameRate: fps,
              maxFrameRate: fps,
              minWidth: 1280,
              minHeight: 720,
              ...(capWidth && { maxWidth: capWidth }),
              ...(capHeight && { maxHeight: capHeight }),
            },
          } as any,
        });
      } catch (e: any) {
        console.warn("[Voice] screenshare getUserMedia failed:", e?.message ?? e);
        this.#appAudioSourceId = null;
        return;
      }

      // 'motion' tells Chrome to use video-mode encoding (fps-first) instead of
      // screenshot mode (resolution-first). Without it, GCC slow-start causes 1-3fps
      // for several minutes even on a local network with plenty of bandwidth.
      const videoTrack = videoStream.getVideoTracks()[0];
      videoTrack.contentHint = 'motion';

      // Pre-seed Chrome's GCC bandwidth estimator so the screenshare starts at
      // ~6Mbps instead of ~300kbps, skipping the 3+ minute slow-start ramp.
      // Intercepting createOffer on the LiveKit publisher PC for this one negotiation.
      const publisherPc = (room as any).engine?.publisher?.pc as RTCPeerConnection | undefined;
      let origCreateOffer: typeof RTCPeerConnection.prototype.createOffer | undefined;
      if (publisherPc) {
        origCreateOffer = publisherPc.createOffer.bind(publisherPc);
        (publisherPc as any).createOffer = async (...args: any[]) => {
          const offer = await origCreateOffer!(...args);
          return new RTCSessionDescription({ type: offer.type, sdp: mungeSdpGCC(offer.sdp ?? "") });
        };
      }

      try {
        await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          screenShareEncoding: { maxBitrate, maxFramerate: fps },
          simulcast: false,
        });
      } catch (e: any) {
        console.warn("[Voice] screenshare publish failed:", e?.message ?? e);
        videoStream.getTracks().forEach((t) => t.stop());
        this.#appAudioSourceId = null;
        return;
      } finally {
        if (publisherPc && origCreateOffer) publisherPc.createOffer = origCreateOffer;
      }

      // Override degradationPreference so the encoder drops resolution instead of
      // framerate when GCC bandwidth estimate is low at startup. Without this,
      // default 'maintain-resolution' causes 1-3fps at full resolution for minutes.
      try {
        const ssPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        const sender = (ssPub?.track as any)?.sender as RTCRtpSender | undefined;
        if (sender) {
          const params = sender.getParameters();
          for (const enc of params.encodings) {
            (enc as any).degradationPreference = 'maintain-framerate';
          }
          await sender.setParameters(params);
        }
      } catch {
        // Non-fatal — degradationPreference is a hint, not required for correctness
      }

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
      if (!room.localParticipant.isScreenShareEnabled) return;

      const s = videoStream.getVideoTracks()[0].getSettings();
      console.log(`[Screenshare] ${s.width ?? "?"}×${s.height ?? "?"}@${s.frameRate ?? "?"}fps | encoding: ${maxBitrate / 1_000_000}Mbps max / ${fps}fps max`);

      voiceNotifications.playScreenshareStart();

      // Per-process audio for window captures
      if (this.#appAudioSourceId) {
        await this.#publishAppAudioTrack(room);
      } else {
        // Best-effort system audio loopback for screen captures
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } } as any,
            video: false,
          });
          if (audioStream.getAudioTracks().length > 0) {
            await room.localParticipant.publishTrack(audioStream.getAudioTracks()[0], {
              source: Track.Source.ScreenShareAudio,
            });
          }
        } catch {
          // Loopback audio unavailable — silent failure is acceptable
        }
      }
      return;
    }

    // Web: use quality preset, show picker modal after stream starts
    const qualities = this.getEnabledScreenShareQualities();
    const quality = qualities[this.#settings.screenShareQuality] ?? qualities.low!;
    // When asking, capture at max available quality so user can choose without re-capture
    const captureQuality = this.#settings.screenShareQualityAsk ? (qualities.high ?? quality) : quality;
    const capFps = captureQuality.resolution.frameRate ?? 30;
    const maxBitrate = capFps >= 60 ? 8_000_000 : capFps >= 30 ? 5_000_000 : 2_000_000;

    let localTrack: Awaited<ReturnType<typeof room.localParticipant.setScreenShareEnabled>>;
    try {
      localTrack = await room.localParticipant.setScreenShareEnabled(
        true,
        { audio: true, resolution: captureQuality.resolution },
        {
          screenShareEncoding: {
            maxBitrate,
            maxFramerate: capFps,
          },
          simulcast: false,
        },
      );
    } catch (e: any) {
      console.warn("[Voice] screenshare cancelled or failed:", e?.message ?? e);
      return;
    }

    this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
    if (!room.localParticipant.isScreenShareEnabled) return;

    if (localTrack && this.#settings.screenShareQualityAsk && Object.keys(qualities).length > 1) {
      localTrack.pauseUpstream();
      this.openModal({
        type: "screen_share_settings",
        onCancel: async () => {
          await room.localParticipant.setScreenShareEnabled(false);
          this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
        },
        trackReference: {
          participant: room.localParticipant,
          publication: localTrack!,
          source: Track.Source.ScreenShare,
        },
        qualities: Object.keys(qualities).map((k) => {
          const v = qualities[k as ScreenShareQualityName]!;
          return { name: k, fullName: v.fullName };
        }),
        callback: async (qualityName: ScreenShareQualityName) => {
          const q = qualities[qualityName] ?? qualities.low!;
          if (localTrack?.videoTrack) {
            await localTrack.videoTrack.mediaStreamTrack.applyConstraints({
              frameRate: { ideal: q.resolution.frameRate },
              ...(q.resolution.width ? { width: { ideal: q.resolution.width } } : {}),
              ...(q.resolution.height ? { height: { ideal: q.resolution.height } } : {}),
            });
            localTrack.videoTrack.mediaStreamTrack.contentHint = q.contentHint;
          }
          localTrack?.resumeUpstream();
        },
      });
    }

    voiceNotifications.playScreenshareStart();
  }

  async #publishAppAudioTrack(room: Room) {
    if (!window.appAudioCapture || !this.#appAudioSourceId) return;

    const started = await window.appAudioCapture.start(this.#appAudioSourceId);
    if (!started) {
      console.warn("[Voice] Per-process audio capture failed — keeping loopback audio");
      return;
    }

    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule(getPcmFeederWorkletUrl());

      const worklet = new AudioWorkletNode(ctx, "pcm-feeder", {
        outputChannelCount: [2],
      });
      const destination = ctx.createMediaStreamDestination();
      worklet.connect(destination);

      const dataHandler = (chunk: Uint8Array) => {
        const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        worklet.port.postMessage(int16);
      };
      window.appAudioCapture.onData(dataHandler);

      // Unpublish the existing loopback ScreenShareAudio track
      const existingPub = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      if (existingPub?.track) {
        await room.localParticipant.unpublishTrack(
          existingPub.track.mediaStreamTrack,
        );
      }

      // Publish per-process audio in its place
      const audioTrack = destination.stream.getAudioTracks()[0];
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
      });

      this.#appAudioCtx = ctx;
      this.#appAudioWorklet = worklet;
      this.#appAudioDestination = destination;
      this.#appAudioDataHandler = dataHandler;

      console.log("[Voice] ✅ Per-process audio capture active (replaced loopback)");
    } catch (e) {
      console.warn("[Voice] ❌ Per-process audio pipeline failed:", e);
      await window.appAudioCapture.stop();
    }
  }

  async #stopAppAudioCapture() {
    if (this.#appAudioDataHandler) {
      window.appAudioCapture?.offData(this.#appAudioDataHandler);
      this.#appAudioDataHandler = null;
    }
    await window.appAudioCapture?.stop();

    // Unpublish the track from LiveKit before tearing down
    const room = this.room();
    if (room && this.#appAudioDestination) {
      for (const track of this.#appAudioDestination.stream.getTracks()) {
        const pub = Array.from(room.localParticipant.trackPublications.values())
          .find((p) => p.track?.mediaStreamTrack === track);
        if (pub) {
          await room.localParticipant.unpublishTrack(track);
        }
        track.stop();
      }
    }

    this.#appAudioWorklet?.disconnect();
    this.#appAudioWorklet = null;
    this.#appAudioDestination = null;

    if (this.#appAudioCtx) {
      await this.#appAudioCtx.close();
      this.#appAudioCtx = null;
    }

    this.#appAudioSourceId = null;
  }

  async #applyInputGate(track: LocalAudioTrack): Promise<void> {
    await this.#cleanupInputGate();
    const dbfs = this.#settings.inputSensitivity ?? -60;
    const threshold = Math.pow(10, dbfs / 20);
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule(getInputGateWorkletUrl());
      // Capture raw track before replaceTrack swaps track.mediaStreamTrack.
      this.#rawMicTrack = track.mediaStreamTrack;
      const src = ctx.createMediaStreamSource(new MediaStream([this.#rawMicTrack.clone()]));

      // [VAD-IMPROVEMENT-#5] Build a 300-3400 Hz speech-band side-chain via
      // cascaded high-pass + low-pass biquads (Butterworth Q≈0.707). Only the
      // detector input sees the filter — clean audio path is untouched.
      // To revert: connect src directly to gate input 1 and skip both biquads.
      const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 300, Q: 0.707 });
      const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 3400, Q: 0.707 });
      src.connect(hp);
      hp.connect(lp);

      const gate = new AudioWorkletNode(ctx, "stoat-input-gate", {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      gate.port.postMessage({ threshold });

      src.connect(gate, 0, 0); // input 0 = clean audio
      lp.connect(gate, 0, 1);  // input 1 = bandpass-filtered detector

      const dest = ctx.createMediaStreamDestination();
      gate.connect(dest);
      await track.replaceTrack(dest.stream.getAudioTracks()[0], true);
      this.#inputGateCtx = ctx;
      this.#inputGateNode = gate;
      console.log(`[Voice] ✅ Input gate active, threshold=${dbfs.toFixed(1)} dBFS`);

      // [VAD-IMPROVEMENT-#8] Silero second-pass classifier (default on).
      // Loads onnxruntime-web (~5 MB cached) + silero_vad.onnx (~1 MB) on first
      // attach. Falls back gracefully to RMS-only if the package fails to load.
      // To revert: delete this block (gate already supports sileroEnabled=false).
      if (this.#settings.useSileroVad ?? true) {
        void this.#startSileroVad();
      }
    } catch (e) {
      console.warn("[Voice] ❌ Input gate failed:", e);
    }
  }

  // [VAD-IMPROVEMENT-#8] Start Silero VAD on the raw mic track. Idempotent.
  // Assets (silero_vad_legacy.onnx, vad.worklet.bundle.min.js, ORT wasm) are
  // self-hosted under /silero/ — see scripts/copy-silero-assets.mjs which
  // mirrors them from node_modules on every pnpm install (postinstall).
  async #startSileroVad(): Promise<void> {
    if (this.#sileroVad) return;
    if (!this.#rawMicTrack || !this.#inputGateNode) return;
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");
      const rawTrack = this.#rawMicTrack;
      const vad = await MicVAD.new({
        baseAssetPath: "/silero/",
        onnxWASMBasePath: "/silero/",
        getStream: async () => new MediaStream([rawTrack.clone()]),
        onSpeechStart: () => {
          this.#inputGateNode?.port.postMessage({ vadActive: true });
        },
        onSpeechEnd: () => {
          this.#inputGateNode?.port.postMessage({ vadActive: false });
        },
      });
      await vad.start();
      this.#sileroVad = vad as unknown as { destroy(): void };
      this.#inputGateNode.port.postMessage({ sileroEnabled: true });
      console.log("[Voice] ✅ Silero VAD second-pass active (self-hosted assets)");
    } catch (e) {
      console.warn("[Voice] ❌ Silero VAD failed to load — falling back to RMS-only gate:", e);
      this.#inputGateNode?.port.postMessage({ sileroEnabled: false });
    }
  }

  // [VAD-IMPROVEMENT-#8] Stop and tear down Silero VAD. Idempotent.
  async #stopSileroVad(): Promise<void> {
    if (!this.#sileroVad) return;
    try { this.#sileroVad.destroy(); } catch { /* ignore */ }
    this.#sileroVad = null;
    this.#inputGateNode?.port.postMessage({ sileroEnabled: false, vadActive: false });
    console.log("[Voice] Silero VAD disabled");
  }

  // [VAD-IMPROVEMENT-#8] Public toggle — called by createEffect in VoiceContext.
  setSileroEnabled(enabled: boolean): void {
    if (enabled) void this.#startSileroVad();
    else void this.#stopSileroVad();
  }

  async #cleanupInputGate(): Promise<void> {
    await this.#stopSileroVad();
    if (this.#inputGateCtx) {
      try { await this.#inputGateCtx.close(); } catch { /* ignore */ }
      this.#inputGateCtx = null;
      this.#inputGateNode = null;
    }
  }

  /** Send a new threshold to the running gate worklet without restarting the track. */
  updateGateThreshold(dbfs: number): void {
    if (this.#inputGateNode) {
      this.#inputGateNode.port.postMessage({ threshold: Math.pow(10, dbfs / 20) });
    }
  }

  /**
   * Measure ambient RMS from the raw mic track for 2 seconds.
   * Takes the MINIMUM 100ms sample from the window — the quietest moment,
   * which is ambient noise even if the user was speaking the rest of the time.
   * Appends that minimum to a rolling history (up to 20 entries, ~10 min) and
   * uses the median of the history as the floor, so a single window where the
   * user never paused doesn't corrupt the threshold.
   */
  async #calibrateInputSensitivity(rawTrack: MediaStreamTrack): Promise<void> {
    try {
      const ctx = new AudioContext({ sampleRate: 48000 });
      const src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const samples: number[] = [];
      await new Promise<void>(resolve => {
        const id = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let ss = 0;
          for (const v of buf) ss += v * v;
          samples.push(Math.sqrt(ss / buf.length));
        }, 100);
        setTimeout(() => { clearInterval(id); resolve(); }, 2000);
      });
      await ctx.close();
      // [VAD-IMPROVEMENT-#7] Use the 25th percentile of this window as the
      // floor estimate, not the absolute minimum. A single freakishly-quiet
      // 100 ms sample (a momentary lull or even a buffer underrun) shouldn't
      // anchor the threshold unrealistically low. P25 is still a "quiet
      // representative" but is far more stable.
      // To revert: change p25Index to 0 (samples[0] = absolute min).
      samples.sort((a, b) => a - b);
      const p25Index = Math.floor(samples.length * 0.25);
      const windowFloor = samples[p25Index] ?? 0.0001;
      this.#calibrationHistory.push(windowFloor);
      if (this.#calibrationHistory.length > 20) this.#calibrationHistory.shift();
      // Median of rolling history — robust against windows where user never paused.
      const sorted = [...this.#calibrationHistory].sort((a, b) => a - b);
      const floorRms = sorted[Math.floor(sorted.length / 2)] ?? 0.0001;
      // [VAD-IMPROVEMENT-#7] Clamp auto-result to ≥ -60 dBFS. In very quiet
      // rooms (-90 dBFS floor) the +12 dB headroom would land around -78 dBFS,
      // which makes the gate open on every breath and HVAC tick. -60 dBFS is
      // a conservative but reliable floor — manual mode still allows -100.
      // To revert: change -60 back to -100.
      const dbfs = Math.max(-60, Math.min(-20, 20 * Math.log10(floorRms) + 12));
      this.#settings.inputSensitivity = dbfs;
      this.updateGateThreshold(dbfs);
      console.log(`[Voice] 🎚 Auto-calibrated sensitivity: ${dbfs.toFixed(1)} dBFS (n=${this.#calibrationHistory.length})`);
    } catch (e) {
      console.warn("[Voice] ❌ Input sensitivity calibration failed:", e);
    }
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }

  private onErr(e: unknown) {
    if ((e as Error).name !== "NotAllowedError")
      this.openModal({ type: "error2", error: e });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Initializes vidTracks on the voice object within the RoomContext.Provider scope.
 * Must be rendered as a child of RoomContext.Provider so useTracks can access the room.
 */
function VoiceTrackInitializer(props: { voice: Voice }) {
  props.voice.initTracks();
  // eslint-disable-next-line solid/no-react-specific-props
  return <></>;
}

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const modals = useModals();
  const voice = new Voice(state.voice, modals);
  const client = useClient();

  const [pickSources, setPickSources] = createSignal<
    Array<{ id: string; name: string; thumbnail: string }>
  >([]);

  onMount(() => {
    if (typeof window !== "undefined" && window.desktopCapture) {
      window.desktopCapture.onSourcesAvailable((sources) => {
        setPickSources(sources);
      });
      voice.setPickSourcesHandler(setPickSources);
    }
    debugLog("PTT-WEB", "VoiceContext mounted, checking for desktop PTT API...");
    debugLog("PTT-WEB", "window.pushToTalk exists:", typeof window !== "undefined" && !!window.pushToTalk);
    
    if (typeof window !== "undefined" && window.pushToTalk) {
      debugLog("PTT-WEB", "✓ Desktop PTT API found, initializing integration");

      // Check current state immediately (in case we missed the initial signal)
      const currentState = window.pushToTalk.getCurrentState();
      debugLog("PTT-WEB", "Current PTT state from desktop:", currentState.active ? "ON" : "OFF");

      const handleStateChange = (e: { active: boolean }) => {
        if (!state.voice.pushToTalkEnabled) return;
        debugLog("PTT-WEB", "Received state change from desktop:", e.active ? "ON" : "OFF");
        debugLog("PTT-WEB", "Current room:", voice.room() ? "connected" : "not connected");

        // e.active = true means PTT key is pressed (mic should be ON/unmuted)
        // e.active = false means PTT key is released (mic should be OFF/muted)
        if (voice.room()) {
          const shouldEnableMic = e.active;
          debugLog("PTT-WEB", "PTT active:", e.active, "-> Mic enabled:", shouldEnableMic);
          voice.setMute(shouldEnableMic);
        } else {
          debugLog("PTT-WEB", "⚠ No active room, cannot mute/unmute");
        }
      };
      
      handleStateChange(currentState);

      debugLog("PTT-WEB", "Registering onStateChange listener...");
      window.pushToTalk.onStateChange(handleStateChange);
      debugLog("PTT-WEB", "✓ Listener registered");

      // Sync initial config from desktop to web client (config file is source of truth)
      debugLog("PTT-WEB", "Syncing PTT config from desktop...");
      const handleConfigChange = (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => {
        debugLog("PTT-WEB", "Received config from desktop:", config);
        state.voice.setPushToTalkConfig(config);
      };

      // get initial config
      const initialConfig = window.pushToTalk.getConfig();
      debugLog("PTT-WEB", "Initial config from desktop:", initialConfig);
      state.voice.setPushToTalkConfig(initialConfig);

      // listen for future config changes
      window.pushToTalk.onConfigChange(handleConfigChange);
      debugLog("PTT-WEB", "✓ Config sync initialized");

      onCleanup(() => {
        debugLog("PTT-WEB", "Cleaning up PTT listener");
        window.pushToTalk?.offStateChange(handleStateChange);
        window.pushToTalk?.offConfigChange(handleConfigChange);
      });
    } else {
      debugLog("PTT-WEB", "✗ Desktop PTT API not available (running in browser?)");
    }

    // setup voice notification sounds
    const currentClient = client();
    console.log("[VoiceNotifications] Setting up notifications, client available:", !!currentClient);
    
    if (!currentClient) {
      console.log("[VoiceNotifications] Client not available yet, skipping setup");
    } else {
      // console.log("[VoiceNotifications] Registering event listeners");
      
      const onJoin = (channel: Channel, participant: { userId: string }) => {
        // console.log("[VoiceNotifications] VoiceChannelJoin event received:", {
        //   channelId: channel.id,
        //   participantId: participant.userId,
        //   currentChannelId: voice.channel()?.id,
        //   currentUserId: currentClient.user?.id,
        //   shouldPlay: voice.channel()?.id === channel.id && participant.userId !== currentClient.user?.id
        // });
        if (voice.channel()?.id === channel.id && participant.userId !== currentClient.user?.id) {
          console.log("[VoiceNotifications] Playing join sound");
          voiceNotifications.playJoin();
        }
      };

      const onLeave = (channel: Channel, userId: string) => {
        // console.log("[VoiceNotifications] VoiceChannelLeave event received:", {
        //   channelId: channel.id,
        //   userId: userId,
        //   currentChannelId: voice.channel()?.id,
        //   currentUserId: currentClient.user?.id,
        //   shouldPlay: voice.channel()?.id === channel.id && userId !== currentClient.user?.id
        // });
        if (voice.channel()?.id === channel.id && userId !== currentClient.user?.id) {
          console.log("[VoiceNotifications] Playing leave sound");
          voiceNotifications.playLeave();
        }
      };

      currentClient.on("voiceChannelJoin", onJoin);
      currentClient.on("voiceChannelLeave", onLeave);
      console.log("[VoiceNotifications] Event listeners registered");

      onCleanup(() => {
        console.log("[VoiceNotifications] Cleaning up event listeners");
        currentClient.off("voiceChannelJoin", onJoin);
        currentClient.off("voiceChannelLeave", onLeave);
      });
    }

    // Voice diagnostic helper: window.stoatDiag() in browser console
    (window as any).stoatDiag = async () => {
      const room = voice.room();
      if (!room) {
        console.log("[Voice Diagnostics] Not connected to a voice channel");
        return;
      }
      const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const df3Active = !!(micPub?.track as LocalAudioTrack | undefined)?.processor;
      await printVoiceStats(room, df3Active, voice.rawMicTrack);
    };
    console.log("[Voice] 🔍 Type window.stoatDiag() in the console to print voice stats");

    // Auto-print stats every 30s while connected
    const statsInterval = setInterval(async () => {
      const room = voice.room();
      if (room && voice.state() === "CONNECTED") {
        const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const df3Active = !!(micPub?.track as LocalAudioTrack | undefined)?.processor;
        await printVoiceStats(room, df3Active, voice.rawMicTrack);
      }
    }, 30_000);

    onCleanup(() => {
      clearInterval(statsInterval);
      delete (window as any).stoatDiag;
    });
  });

  // sync notification settings reactively
  createEffect(() => {
    // track master settings
    const enabled = state.voice.notificationSoundsEnabled;
    const volume = state.voice.notificationVolume;
    
    // track individual sound toggles (force reactivity)
    const soundJoinCall = state.voice.soundJoinCall;
    const soundLeaveCall = state.voice.soundLeaveCall;
    const soundSomeoneJoined = state.voice.soundSomeoneJoined;
    const soundSomeoneLeft = state.voice.soundSomeoneLeft;
    const soundMute = state.voice.soundMute;
    const soundUnmute = state.voice.soundUnmute;
    const soundReceiveMessage = state.voice.soundReceiveMessage;
    const soundScreenshareStart = state.voice.soundScreenshareStart;
    const soundScreenshareEnd = state.voice.soundScreenshareEnd;
    const soundPttActivate = state.voice.soundPttActivate;
    const soundPttDeactivate = state.voice.soundPttDeactivate;
    
    console.log("[VoiceNotifications] Settings updated - enabled:", enabled, "volume:", volume);
    
    // apply settings to notification manager
    voiceNotifications.setEnabled(enabled);
    voiceNotifications.setVolume(volume);
    
    // sync individual sound toggles
    voiceNotifications.setSoundEnabled("join_call", soundJoinCall);
    voiceNotifications.setSoundEnabled("leave_call", soundLeaveCall);
    voiceNotifications.setSoundEnabled("someone_joined", soundSomeoneJoined);
    voiceNotifications.setSoundEnabled("someone_left", soundSomeoneLeft);
    voiceNotifications.setSoundEnabled("mute", soundMute);
    voiceNotifications.setSoundEnabled("unmute", soundUnmute);
    voiceNotifications.setSoundEnabled("receive_message", soundReceiveMessage);
    voiceNotifications.setSoundEnabled("screenshare_start", soundScreenshareStart);
    voiceNotifications.setSoundEnabled("screenshare_end", soundScreenshareEnd);
    voiceNotifications.setSoundEnabled("ptt_activate", soundPttActivate);
    voiceNotifications.setSoundEnabled("ptt_deactivate", soundPttDeactivate);
  });

  // Live-update gate threshold on sensitivity slider changes — no track restart needed.
  createEffect(() => {
    const dbfs = state.voice.inputSensitivity;
    if (typeof dbfs === "number") voice.updateGateThreshold(dbfs);
  });

  // [VAD-IMPROVEMENT-#8] Live-toggle Silero VAD on setting change without
  // restarting the mic track. Safe before connect — setSileroEnabled no-ops
  // when there's no input gate yet; it gets started on next #applyInputGate.
  createEffect(() => {
    voice.setSileroEnabled(state.voice.useSileroVad);
  });

  // live-update mic constraints when noise suppression / echo cancellation changes
  createEffect(() => {
    state.voice.noiseSupression;
    state.voice.noiseSupressionLevel;
    state.voice.echoCancellation;
    voice.applyMicConstraints();
  });

  // Listen for per-process audio window selection from Electron
  onMount(() => {
    if (window.desktopCapture?.onWindowSelected) {
      window.desktopCapture.onWindowSelected((sourceId) => {
        voice.setAppAudioSourceId(sourceId);
      });
    }
  });

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceTrackInitializer voice={voice} />
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
        <Show when={pickSources().length > 0}>
          <ScreenSharePicker
            sources={pickSources()}
            onSelect={(id) => {
              if (voice.hasPendingPickerSelection()) {
                voice.notifySourceSelected(id);
              } else {
                window.desktopCapture!.selectSource(id);
              }
              setPickSources([]);
            }}
            onCancel={() => {
              if (voice.hasPendingPickerSelection()) {
                voice.notifySourceSelected(null);
              } else {
                window.desktopCapture!.cancel();
              }
              setPickSources([]);
            }}
          />
        </Show>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
