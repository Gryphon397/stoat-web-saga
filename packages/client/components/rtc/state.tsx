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
import { RoomContext } from "solid-livekit-components";

import { AudioCaptureOptions, ConnectionQuality, LocalAudioTrack, Participant, RemoteAudioTrack, Room, Track, TrackPublication, VideoPresets } from "livekit-client";
import { DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import { voiceNotifications } from "./VoiceNotifications";

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
        livekitUrl: string;
        viewerToken: string;
        volume?: number;
      }) => Promise<void>;
      close: (identity: string) => Promise<void>;
      notifyMainDisconnected: () => Promise<void>;
      onPopoutClosed: (callback: (identity: string) => void) => () => void;
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
import { Voice as VoiceSettings } from "@revolt/state/stores/Voice";
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

/**
 * Print WebRTC stats for all active audio tracks to the browser console.
 * Called by window.stoatDiag() and automatically every 30s while connected.
 */
// Track previous concealed sample counts to compute per-interval deltas
const _prevConcealed = new Map<string, number>();
// Track previous byte counts + timestamps to compute kbps
const _prevBytesSent = new Map<string, { bytes: number; ts: number }>();

async function printVoiceStats(room: Room) {
  const ts = new Date().toLocaleTimeString();
  console.group(`[Voice Diagnostics] ${ts}`);

  const local = room.localParticipant;
  console.log(`Local participant: ${local.identity} | quality=${local.connectionQuality}`);

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
            const ulKbps = ulPrev
              ? (((r.bytesSent - ulPrev.bytes) * 8) / ((ulNow - ulPrev.ts) / 1000) / 1000).toFixed(1)
              : "—";
            _prevBytesSent.set(ulKey, { bytes: r.bytesSent, ts: ulNow });
            console.log(`  Upload mic: packetsSent=${r.packetsSent}, bytesSent=${r.bytesSent}, kbps=${ulKbps}`);
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
              const dlKey = `dl-${p.identity}`;
              const dlNow = Date.now();
              const dlPrev = _prevBytesSent.get(dlKey);
              const dlKbps = dlPrev
                ? (((r.bytesReceived - dlPrev.bytes) * 8) / ((dlNow - dlPrev.ts) / 1000) / 1000).toFixed(1)
                : "—";
              _prevBytesSent.set(dlKey, { bytes: r.bytesReceived, ts: dlNow });
              console.log(`  ${p.identity}: quality=${q}, jitter=${jitter}ms, loss=${loss}%, concealed/interval=${concealedDelta}, dl=${dlKbps}kbps, muted=${pub.isMuted}`);
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

  console.groupEnd();
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
  #setDeafen: Setter<boolean>;

  microphone: Accessor<boolean>;
  #setMicrophone: Setter<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  #livekitUrl = "";
  get livekitUrl() { return this.#livekitUrl; }

  // Noise floor injection AudioContext
  #noiseCtx: AudioContext | null = null;

  // Per-process audio capture state
  #appAudioCtx: AudioContext | null = null;
  #appAudioWorklet: AudioWorkletNode | null = null;
  #appAudioDestination: MediaStreamAudioDestinationNode | null = null;
  #appAudioDataHandler: ((chunk: Uint8Array) => void) | null = null;
  #appAudioSourceId: string | null = null;

  constructor(voiceSettings: VoiceSettings) {
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

    const [deafen, setDeafen] = createSignal<boolean>(false);
    this.deafen = deafen;
    this.#setDeafen = setDeafen;

    const [microphone, setMicrophone] = createSignal(false);
    this.microphone = microphone;
    this.#setMicrophone = setMicrophone;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;
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
        // Disable browser EC when DF3 is active — the two algorithms
        // running in series produce static artifacts.
        echoCancellation: this.#settings.noiseSupression ? false : (this.#settings.echoCancellation ?? true),
        noiseSuppression: false, // DF3 handles noise suppression via setProcessor
        autoGainControl: this.#settings.autoGainControl,
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

      // only auto-mute when PTT is enabled
      const pttEnabled = this.#settings.pushToTalkEnabled;
      if (pttEnabled) {
        debugLog("PTT-WEB", "PTT enabled - Setting initial mic state to OFF (muted)");
        this.#setMicrophone(false);
      } else {
        debugLog("PTT-WEB", "PTT disabled - Keeping mic state as-is");
        this.#setMicrophone(true);
      }
      this.#setDeafen(false);
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        room.localParticipant.setMicrophoneEnabled(true).then(async (track) => {
          this.#setMicrophone(typeof track !== "undefined");
          if (track?.audioTrack && this.#settings.noiseSupression) {
            try {
              await track.audioTrack.setProcessor(
                new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" } }),
              );
              console.log("[Voice] ✅ DeepFilterNet3 noise suppression active");
            } catch (e) {
              console.warn("[Voice] ❌ DeepFilterNet3 failed to start:", e);
            }
          }
          await this.#applyNoiseFloor();
        });
      debugLog("PTT-WEB", "Room connected");
      this.#setState("CONNECTED");
      voiceNotifications.playSelfJoin();
    });

    room.addListener("reconnecting", () => {
      debugLog("PTT-WEB", "Room reconnecting");
      this.#setState("RECONNECTING");
    });

    room.addListener("reconnected", async () => {
      debugLog("PTT-WEB", "Room reconnected");
      this.#setState("CONNECTED");
      // Small delay to let LiveKit fully re-negotiate senders before tapping them.
      // Without this, #applyNoiseFloor() can return early (no sender yet) and
      // leave DTX active for the remainder of the call.
      await new Promise((r) => setTimeout(r, 500));
      await this.#applyNoiseFloor();
    });

    room.addListener("disconnected", () => {
      debugLog("PTT-WEB", "Room disconnected");
      this.#setState("DISCONNECTED");
      _prevConcealed.clear();
      _prevBytesSent.clear();
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
    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
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
      // Disable browser EC when DF3 is active — the two algorithms
      // running in series produce static artifacts.
      const options: AudioCaptureOptions = {
        noiseSuppression: false,
        echoCancellation: nsEnabled ? false : ecEnabled,
        autoGainControl: this.#settings.autoGainControl,
        deviceId: this.#settings.preferredAudioInputDevice,
      };
      await track.restartTrack(options);
    } catch (e) {
      console.warn("[Voice] restartTrack failed:", e);
    }

    try {
      if (nsEnabled) {
        await track.setProcessor(
          new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" } }),
        );
        console.log("[Voice] ✅ DeepFilterNet3 noise suppression active");
      } else {
        await track.stopProcessor();
        console.log("[Voice] DeepFilterNet3 noise suppression disabled");
      }
    } catch (e) {
      console.warn("[Voice] ❌ DF3 processor error:", e);
    }

    await this.#applyNoiseFloor();
  }

  async #applyNoiseFloor() {
    // Clean up any previous noise context
    if (this.#noiseCtx) {
      await this.#noiseCtx.close().catch(() => {});
      this.#noiseCtx = null;
    }

    const room = this.room();
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;
    const sender = track.sender;
    if (!sender) return;

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.#noiseCtx = ctx;

    // Tap the current track output (raw mic, or DF3-processed if active)
    const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);

    // Looping 0.5s broadband white noise at ~-73 dBFS.
    // This keeps the Opus encoder's VAD active so DTX never fires during silence.
    // NOTE: the previous sub-bass (<80 Hz, gain=0.0002) approach had a math bug —
    // the 80 Hz LPF attenuated the signal by ~26 dB before the gain node, producing
    // ~-104 dBFS output (below the Opus VAD threshold of ~-78 dBFS), so DTX was
    // still activating. Broadband noise at 0.0004 gain gives ~-73 dBFS RMS, safely
    // above the threshold. At -73 dBFS it is masked by speech and inaudible during
    // calls; there may be a faint hiss during extended silence but this is acceptable.
    const buf = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buf;
    noiseSource.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.0004; // ~-73 dBFS RMS (above Opus DTX threshold)
    noiseSource.connect(noiseGain);
    noiseGain.connect(destination);
    noiseSource.start();

    await sender.replaceTrack(destination.stream.getAudioTracks()[0]);
    console.log("[Voice] ✅ Noise floor active (broadband, ~-73 dBFS)");
  }

  disconnect() {
    const room = this.room();
    if (!room) return;

    // Stop noise floor AudioContext
    if (this.#noiseCtx) {
      this.#noiseCtx.close().catch(() => {});
      this.#noiseCtx = null;
    }

    // Stop per-process audio capture if active
    this.#stopAppAudioCapture();

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
    });
  }

  async toggleDeafen() {
    this.#setDeafen((s) => !s);
  }

  async toggleMute() {
    const room = this.room();
    if (!room) throw "invalid state";
    await room.localParticipant.setMicrophoneEnabled(
      !room.localParticipant.isMicrophoneEnabled,
    );

    this.#setMicrophone(room.localParticipant.isMicrophoneEnabled);

    // Re-apply noise floor after unmute — setMicrophoneEnabled(true) creates a
    // new sender, wiping the previous replaceTrack() and re-enabling DTX.
    if (room.localParticipant.isMicrophoneEnabled) {
      await this.#applyNoiseFloor();
    }

    // only play sounds if PTT is disabled, or if PTT is enabled with notification sounds on
    const shouldPlaySound = !this.#settings.pushToTalkEnabled || this.#settings.pushToTalkNotificationSounds;

    if (shouldPlaySound) {
      if (room.localParticipant.isMicrophoneEnabled) {
        voiceNotifications.playUnmute();
      } else {
        voiceNotifications.playMute();
      }
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
      this.#setMicrophone(enabled);
      debugLog("PTT-WEB", "setMute() - mic state updated to:", enabled);

      // Re-apply noise floor after unmute — new sender wipes the previous replaceTrack().
      if (enabled) {
        await this.#applyNoiseFloor();
      }
      
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
    const room = this.room();
    if (!room) throw "invalid state";
    await room.localParticipant.setCameraEnabled(
      !room.localParticipant.isCameraEnabled,
    );

    this.#setVideo(room.localParticipant.isCameraEnabled);
  }

  setAppAudioSourceId(id: string | null) {
    this.#appAudioSourceId = id;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";
    const enabling = !room.localParticipant.isScreenShareEnabled;

    if (!enabling) {
      await this.#stopAppAudioCapture();
    }

    try {
      await room.localParticipant.setScreenShareEnabled(
        enabling,
        { audio: true, video: enabling ? { frameRate: this.#settings.screenshareFrameRate } : undefined },
        enabling ? {
          screenShareEncoding: {
            maxBitrate: 3_000_000,
            maxFramerate: this.#settings.screenshareFrameRate,
          },
          simulcast: false,
        } : undefined,
      );
    } catch (e: any) {
      if (enabling) {
        console.warn("[Voice] screenshare cancelled or failed:", e?.message ?? e);
        this.#appAudioSourceId = null;
        return;
      }
      throw e;
    }

    this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

    if (room.localParticipant.isScreenShareEnabled) {
      voiceNotifications.playScreenshareStart();
    } else {
      voiceNotifications.playScreenshareEnd();
    }

    // After successful enable: publish per-process audio if a window source was selected
    if (enabling && room.localParticipant.isScreenShareEnabled && this.#appAudioSourceId) {
      await this.#publishAppAudioTrack(room);
    }
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

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const voice = new Voice(state.voice);
  const client = useClient();

  const [pickSources, setPickSources] = createSignal<
    Array<{ id: string; name: string; thumbnail: string }>
  >([]);

  onMount(() => {
    if (typeof window !== "undefined" && window.desktopCapture) {
      window.desktopCapture.onSourcesAvailable((sources) => {
        setPickSources(sources);
      });
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
      await printVoiceStats(room);
    };
    console.log("[Voice] 🔍 Type window.stoatDiag() in the console to print voice stats");

    // Auto-print stats every 30s while connected
    const statsInterval = setInterval(async () => {
      const room = voice.room();
      if (room && voice.state() === "CONNECTED") {
        await printVoiceStats(room);
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

  // live-update mic constraints when noise suppression / echo cancellation / AGC changes
  createEffect(() => {
    state.voice.noiseSupression;
    state.voice.echoCancellation;
    state.voice.autoGainControl;
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
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
        <Show when={pickSources().length > 0}>
          <ScreenSharePicker
            sources={pickSources()}
            onSelect={(id) => {
              window.desktopCapture!.selectSource(id);
              setPickSources([]);
            }}
            onCancel={() => {
              window.desktopCapture!.cancel();
              setPickSources([]);
            }}
          />
        </Show>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
