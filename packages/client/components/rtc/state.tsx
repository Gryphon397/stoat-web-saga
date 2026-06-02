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
import { DeepFilterNet3Core, DeepFilterNoiseFilterProcessor } from "deepfilternet3-noise-filter";
import { voiceNotifications } from "./VoiceNotifications";
import { ModalController, useModals } from "@revolt/modal";
// [VOICE-DEBUG-CAPTURE] dev-only outgoing pipeline capture
import {
  CaptureMetadata,
  DebugCaptureSession,
  DebugCaptureState,
  encodeWavMono16,
  ensureCaptureRecorderRegistered,
  formatBundleTimestamp,
  isDebugCaptureBuild,
} from "./debugCapture";
// [Voice/H2] dev-only A/B harness for blind comparisons
import {
  ABHarnessClip,
  ABHarnessLabeling,
  ABHarnessPass,
  ABHarnessSession,
  ABHarnessState,
  cryptoCoinFlip,
} from "./abHarness";
import { K1, K2, measureLoudness } from "./loudness";
import { BUILD as STOAT_BUILD } from "../../src/build";

const debugLog = (prefix: string, ...args: unknown[]) => {
  if (import.meta.env.DEV) {
    console.log(`[${prefix}]`, ...args);
  }
};

// [Voice/J4] Hidden kill-switch for the mic-warmup mute fix. Default: fix on.
// Disable (revert to legacy behavior) by either:
//   • setting `window.__STOAT_DISABLE_MIC_WARMUP_MUTE__ = "1"` before app load, OR
//   • running `localStorage.setItem("stoat.disableMicWarmupMute", "1")` in DevTools, then reload.
// Not surfaced in settings UI by design — if toggling becomes routine, the fix
// needs revisiting, not the toggle made more prominent.
function isMicWarmupMuteDisabled(): boolean {
  const env = (globalThis as { __STOAT_DISABLE_MIC_WARMUP_MUTE__?: string })
    .__STOAT_DISABLE_MIC_WARMUP_MUTE__;
  if (env === "1") return true;
  return isStoatFixDisabled("disableMicWarmupMute");
}

// [Voice/J5/J6/J7] Shared kill-switch reader for the 2026-05-11 state-machine
// fixes. Default for every flag: fix on. To revert any individual fix to legacy
// behavior, set the matching key in DevTools and reload:
//   localStorage.setItem("stoat.disableDeafenAutoMute", "1");      // J5
//   localStorage.setItem("stoat.disablePttMidCallMute", "1");      // J6
//   localStorage.setItem("stoat.disableMidCallDeviceChange", "1"); // J7
//   localStorage.setItem("stoat.disableA2Architecture", "1");      // A2
// Not surfaced in settings UI; if toggling becomes routine the fix needs
// revisiting, not the toggle made more prominent.
function isStoatFixDisabled(key: string): boolean {
  try {
    if (typeof localStorage !== "undefined" &&
        localStorage.getItem(`stoat.${key}`) === "1") return true;
  } catch {
    /* sandbox / privacy mode — fall through */
  }
  return false;
}

// [Voice/A2] Print which audio pipeline is active at module load. Cheap log
// so the dev test rig can confirm which architecture is being measured.
console.log(
  `[Voice/A2] ${isStoatFixDisabled("disableA2Architecture") ? "disabled via kill switch" : "active"}`,
);

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
    // [VAD-IMPROVEMENT-#8-fix] Silero is a HOLD-EXTENDER, not an AND-gate.
    // Original AND-gate held output closed for ~150-300 ms while Silero
    // confirmed speech, swallowing sentence onsets. New rule: RMS alone
    // controls onset; when Silero confirms ongoing speech (vadActive=true)
    // it refreshes the hold counter so the gate stays open through brief
    // pauses. When Silero is inactive (or disabled), the gate decays
    // naturally after HOLD_FRAMES — brief sneeze leakage is acceptable;
    // clipping onsets is not. Original behavior superseded.
    this._sileroEnabled = false;
    this._vadActive = false;
    // [Voice/A2] When true, the gate outputs true silence during closed
    // periods. Set by Voice when the A2 architecture is active — DF3 then
    // runs upstream of the gate, so the gate no longer needs to keep DF3
    // warm via a bleed floor. Default false preserves legacy behavior
    // when the kill switch is set.
    this._disableBleed = false;
    this.port.onmessage = (e) => {
      if (typeof e.data.threshold === 'number') this._threshold = e.data.threshold;
      if (typeof e.data.sileroEnabled === 'boolean') this._sileroEnabled = e.data.sileroEnabled;
      if (typeof e.data.vadActive === 'boolean') this._vadActive = e.data.vadActive;
      if (typeof e.data.disableBleed === 'boolean') this._disableBleed = e.data.disableBleed;
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
    // _threshold) is a dead-zone — hold counter does not change unless
    // Silero refreshes it (see #8-fix below).
    const closeThresh = this._threshold * this._CLOSE_RATIO;
    if (rms >= this._threshold) {
      this._holdCounter = this._HOLD_FRAMES;
    } else if (this._sileroEnabled && this._vadActive) {
      // [VAD-IMPROVEMENT-#8-fix] Hold-extender: Silero keeps the gate open
      // through speech pauses without ever blocking onset.
      this._holdCounter = this._HOLD_FRAMES;
    } else if (rms < closeThresh) {
      this._holdCounter = this._holdCounter > 0 ? this._holdCounter - 1 : 0;
    }
    const targetGain = this._holdCounter > 0 ? 1.0 : 0.0;
    this._gateGain += targetGain > this._gateGain ? this._ATTACK : -this._RELEASE;
    this._gateGain = this._gateGain < 0.0 ? 0.0 : this._gateGain > 1.0 ? 1.0 : this._gateGain;
    // [Voice/D4] In the legacy pipeline, DF3 runs AFTER the gate as a
    // LiveKit track processor. Pure silence causes DF3 to adapt its noise
    // model to zero-signal; on the next speech onset it briefly treats
    // voice as noise (gargling — 31 dB attenuation in first 50 ms,
    // ramping to ~5 dB over 250 ms with the prior -54 dBFS floor). A
    // -45 dBFS bleed (~0.0056 linear) keeps DF3 acclimated so the onset
    // ramp is shallower. Audible up close but acceptable.
    //
    // [Voice/A2] Under the A2 architecture DF3 runs UPSTREAM of the gate
    // as a Web Audio node, so the gate has nothing to keep warm. Voice
    // sends { disableBleed: true } in that case and the closed-gate
    // output is true silence.
    const bleedFloor = this._disableBleed ? 0.0 : 0.0056;
    const g = this._gateGain > bleedFloor ? this._gateGain : bleedFloor;
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

// [STOAT-AGC] Custom AGC AudioWorklet — sliding-window RMS envelope, holds
// gain when input is below silentThreshold (no noise pumping during gate-
// closed silences), 5 ms lookahead so the attack phase precedes the loud
// sample. Sits between the input gate and the publish destination so the
// gain control happens BEFORE DF3 sees the signal.
//
// Live config via port.postMessage:
//   { enabled: bool, targetDbfs, maxGainDb, minGainDb,
//     silentThresholdDbfs, attackMs, releaseMs }
const agcWorkletCode = `
class StoatAgcProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._enabled = false;
    this._targetLin = Math.pow(10, -18 / 20);
    this._maxGain = Math.pow(10, 18 / 20);
    this._minGain = Math.pow(10, -12 / 20);
    this._silentThresholdLin = Math.pow(10, -50 / 20);
    this._currentGain = 1.0;
    this._rmsSquared = 0.0;

    const sr = sampleRate;
    this._rmsAlpha = 1 - Math.exp(-1 / (0.150 * sr));
    this._attackAlpha = 1 - Math.exp(-1 / (0.010 * sr));
    this._releaseAlpha = 1 - Math.exp(-1 / (0.200 * sr));

    this._lookaheadSize = Math.max(1, Math.round(0.005 * sr));
    this._delayBuf = new Float32Array(this._lookaheadSize);
    this._delayPos = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this._enabled = d.enabled;
      if (typeof d.targetDbfs === 'number') this._targetLin = Math.pow(10, d.targetDbfs / 20);
      if (typeof d.maxGainDb === 'number') this._maxGain = Math.pow(10, d.maxGainDb / 20);
      if (typeof d.minGainDb === 'number') this._minGain = Math.pow(10, d.minGainDb / 20);
      if (typeof d.silentThresholdDbfs === 'number') {
        this._silentThresholdLin = Math.pow(10, d.silentThresholdDbfs / 20);
      }
      if (typeof d.attackMs === 'number' && d.attackMs > 0) {
        this._attackAlpha = 1 - Math.exp(-1 / ((d.attackMs / 1000) * sampleRate));
      }
      if (typeof d.releaseMs === 'number' && d.releaseMs > 0) {
        this._releaseAlpha = 1 - Math.exp(-1 / ((d.releaseMs / 1000) * sampleRate));
      }
    };
  }

  process(inputs, outputs) {
    const inCh = inputs[0] && inputs[0][0];
    const outCh = outputs[0] && outputs[0][0];
    if (!inCh || !outCh) return true;

    if (!this._enabled) {
      // Bypass — but route through the same delay line so toggling on/off
      // doesn't introduce a 5 ms phase pop in the middle of a phrase.
      for (let i = 0; i < inCh.length; i++) {
        const delayed = this._delayBuf[this._delayPos];
        this._delayBuf[this._delayPos] = inCh[i];
        this._delayPos = (this._delayPos + 1) % this._lookaheadSize;
        outCh[i] = delayed;
      }
      return true;
    }

    for (let i = 0; i < inCh.length; i++) {
      const x = inCh[i];

      // EMA of squared sample → RMS estimate over ~150 ms
      this._rmsSquared += this._rmsAlpha * (x * x - this._rmsSquared);
      const rms = Math.sqrt(this._rmsSquared);

      let desired;
      if (rms < this._silentThresholdLin) {
        // Hold during silence — prevents the noise-floor pumping that
        // makes Chrome's AGC sound "breathy" between phrases.
        desired = this._currentGain;
      } else {
        desired = this._targetLin / rms;
        if (desired > this._maxGain) desired = this._maxGain;
        else if (desired < this._minGain) desired = this._minGain;
      }

      // Attack = fast (gain coming down to catch a peak),
      // Release = slow (gain coming up to fill quiet speech).
      const alpha = desired < this._currentGain ? this._attackAlpha : this._releaseAlpha;
      this._currentGain += alpha * (desired - this._currentGain);

      // Lookahead delay line — gain decided from the new sample, applied
      // to the 5 ms-older sample at the read head.
      const delayed = this._delayBuf[this._delayPos];
      this._delayBuf[this._delayPos] = x;
      this._delayPos = (this._delayPos + 1) % this._lookaheadSize;

      outCh[i] = delayed * this._currentGain;
    }
    return true;
  }
}
registerProcessor('stoat-agc', StoatAgcProcessor);
`;
let agcWorkletUrl: string | null = null;
function getAgcWorkletUrl(): string {
  if (!agcWorkletUrl) {
    agcWorkletUrl = URL.createObjectURL(
      new Blob([agcWorkletCode], { type: "application/javascript" }),
    );
  }
  return agcWorkletUrl;
}

// [Voice/B4] K-weighted leveler + sample-peak limiter. Replaces the
// envelope-follower AGC above for users opting in via useStoatAgc=true
// when the B4 kill switch is not set.
//
// Detector: BS.1770-4 K-weighting (high-shelf + RLB high-pass) over a
// 400 ms sliding window of squared samples. The window approximates
// short-term loudness (LUFS-S). Target -20 LUFS-S.
//
// Dynamics:
//   • Attack 50 ms — smoother than transient-grabbing AGC.
//   • Release 1500 ms — slow recovery, avoids pumping between phrases.
//   • Gain bounded to [-6, +12] dB from unity.
//   • Frozen during silence (input RMS below silentThresholdLin) so the
//     leveler does not pump up room tone between utterances. Under A2
//     "silence" arrives as gate-closed true zero; the freeze branch
//     just keeps gain at its last value until speech resumes.
//
// Peak limiter: sample-peak (not true-peak — see note below) at -1 dBFS,
// applied after the leveler so transients that pushed the leveler over
// target loudness are tamed before publish. 2 ms attack / 100 ms release.
//
// True-peak vs sample-peak: BS.1770-4 true-peak requires 4× oversampled
// detection (see loudness.ts computeTruePeakDbfs). In a per-sample
// worklet that adds Catmull-Rom evaluation and a small forward-peek
// buffer — feasible but adds complexity. Sample-peak is within ~0.3-1 dB
// of true-peak for voice content; can be upgraded if downstream
// measurement shows ISP excursions above 0 dBFS.
//
// Diagnostic gain reporting: posts { type:'gain', levelerDb, limiterDb }
// to the main thread every ~107 ms (40 process() calls at 128 frames).
// Main caches the latest values for window.stoatDiag.
const levelerWorkletCode = `
const K1_B0 = ${K1.b0};
const K1_B1 = ${K1.b1};
const K1_B2 = ${K1.b2};
const K1_A1 = ${K1.a1};
const K1_A2 = ${K1.a2};
const K2_B0 = ${K2.b0};
const K2_B1 = ${K2.b1};
const K2_B2 = ${K2.b2};
const K2_A1 = ${K2.a1};
const K2_A2 = ${K2.a2};

class StoatLevelerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._enabled = false;
    // -20 LUFS-S target — commercial voice-chat reference. Hardcoded;
    // see CLAUDE.md for the rationale.
    this._targetLin = Math.pow(10, -20 / 20);
    this._maxGain = Math.pow(10, 12 / 20);
    this._minGain = Math.pow(10, -6 / 20);
    this._silentThresholdLin = Math.pow(10, -50 / 20);
    this._currentGain = 1.0;

    const sr = sampleRate;
    // Single-pole smoother time constants.
    this._attackAlpha = 1 - Math.exp(-1 / (0.050 * sr));   // 50 ms
    this._releaseAlpha = 1 - Math.exp(-1 / (1.500 * sr));  // 1500 ms

    // K-weighting filter state.
    this._k1x1 = 0; this._k1x2 = 0; this._k1y1 = 0; this._k1y2 = 0;
    this._k2x1 = 0; this._k2x2 = 0; this._k2y1 = 0; this._k2y2 = 0;

    // 400 ms sliding window of K-weighted squared samples — approximates
    // BS.1770 short-term loudness. The window size is the LUFS-S block
    // length per EBU R128 (3 s) shortened to 400 ms because the leveler
    // needs to react in conversational time. 400 ms is the BS.1770 block
    // length used for momentary loudness.
    this._stWindowSize = Math.max(1, Math.round(0.400 * sr));
    this._stEnergyBuf = new Float32Array(this._stWindowSize);
    this._stPos = 0;
    this._stSum = 0;

    // Peak limiter — sample-peak at -1 dBFS.
    this._peakThreshLin = Math.pow(10, -1 / 20);
    this._peakGain = 1.0;
    this._peakAttackAlpha = 1 - Math.exp(-1 / (0.002 * sr));  // 2 ms
    this._peakReleaseAlpha = 1 - Math.exp(-1 / (0.100 * sr)); // 100 ms

    // 5 ms lookahead, same as the legacy AGC, so the toggle off/on path
    // is byte-equivalent in delay terms (no phase pop on swap).
    this._lookaheadSize = Math.max(1, Math.round(0.005 * sr));
    this._delayBuf = new Float32Array(this._lookaheadSize);
    this._delayPos = 0;

    // Heartbeat counter for diagnostic gain posts.
    this._gainPostCounter = 0;
    this._gainPostInterval = 40; // ~107 ms at 128-sample render quanta

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.enabled === 'boolean') this._enabled = d.enabled;
      if (typeof d.silentThresholdDbfs === 'number') {
        this._silentThresholdLin = Math.pow(10, d.silentThresholdDbfs / 20);
      }
    };
  }

  process(inputs, outputs) {
    const inCh = inputs[0] && inputs[0][0];
    const outCh = outputs[0] && outputs[0][0];
    if (!inCh || !outCh) return true;

    if (!this._enabled) {
      // Bypass — route samples through the same delay line so toggling
      // on/off doesn't introduce a 5 ms phase pop.
      for (let i = 0; i < inCh.length; i++) {
        const delayed = this._delayBuf[this._delayPos];
        this._delayBuf[this._delayPos] = inCh[i];
        this._delayPos = (this._delayPos + 1) % this._lookaheadSize;
        outCh[i] = delayed;
      }
      return true;
    }

    for (let i = 0; i < inCh.length; i++) {
      const x = inCh[i];

      // K-weighting filter: stage 1 (high-shelf) → stage 2 (RLB HP).
      const k1y0 = K1_B0 * x + K1_B1 * this._k1x1 + K1_B2 * this._k1x2
                 - K1_A1 * this._k1y1 - K1_A2 * this._k1y2;
      this._k1x2 = this._k1x1; this._k1x1 = x;
      this._k1y2 = this._k1y1; this._k1y1 = k1y0;
      const k2y0 = K2_B0 * k1y0 + K2_B1 * this._k2x1 + K2_B2 * this._k2x2
                 - K2_A1 * this._k2y1 - K2_A2 * this._k2y2;
      this._k2x2 = this._k2x1; this._k2x1 = k1y0;
      this._k2y2 = this._k2y1; this._k2y1 = k2y0;

      // Sliding-window mean square on K-weighted samples.
      const newSq = k2y0 * k2y0;
      const oldSq = this._stEnergyBuf[this._stPos];
      this._stSum += newSq - oldSq;
      this._stEnergyBuf[this._stPos] = newSq;
      this._stPos = (this._stPos + 1) % this._stWindowSize;
      // Guard against tiny negative drift from float accumulation.
      const meanSq = this._stSum > 0 ? this._stSum / this._stWindowSize : 0;
      const stRms = Math.sqrt(meanSq);

      // Compute desired gain. Freeze during silence so the leveler
      // does not chase noise during gate-closed periods.
      let desired;
      if (stRms < this._silentThresholdLin) {
        desired = this._currentGain;
      } else {
        desired = this._targetLin / stRms;
        if (desired > this._maxGain) desired = this._maxGain;
        else if (desired < this._minGain) desired = this._minGain;
      }

      // Attack vs release direction. Attack = gain coming DOWN (catching
      // a transient), release = gain coming UP (filling quiet speech).
      const alpha = desired < this._currentGain ? this._attackAlpha : this._releaseAlpha;
      this._currentGain += alpha * (desired - this._currentGain);

      // Lookahead delay line. The gain decision was made on the new
      // sample; apply it to the 5 ms-older sample at the read head.
      const delayed = this._delayBuf[this._delayPos];
      this._delayBuf[this._delayPos] = x;
      this._delayPos = (this._delayPos + 1) % this._lookaheadSize;

      const leveled = delayed * this._currentGain;

      // Peak limiter — react instantly to keep sample peak ≤ -1 dBFS.
      const peakAbs = leveled < 0 ? -leveled : leveled;
      const peakDesired = peakAbs > this._peakThreshLin
        ? this._peakThreshLin / peakAbs
        : 1.0;
      const peakAlpha = peakDesired < this._peakGain
        ? this._peakAttackAlpha
        : this._peakReleaseAlpha;
      this._peakGain += peakAlpha * (peakDesired - this._peakGain);

      outCh[i] = leveled * this._peakGain;
    }

    // Diagnostic gain heartbeat.
    this._gainPostCounter++;
    if (this._gainPostCounter >= this._gainPostInterval) {
      this._gainPostCounter = 0;
      this.port.postMessage({
        type: 'gain',
        levelerDb: 20 * Math.log10(this._currentGain > 1e-12 ? this._currentGain : 1e-12),
        limiterDb: 20 * Math.log10(this._peakGain > 1e-12 ? this._peakGain : 1e-12),
      });
    }
    return true;
  }
}
registerProcessor('stoat-leveler', StoatLevelerProcessor);
`;
let levelerWorkletUrl: string | null = null;
function getLevelerWorkletUrl(): string {
  if (!levelerWorkletUrl) {
    levelerWorkletUrl = URL.createObjectURL(
      new Blob([levelerWorkletCode], { type: "application/javascript" }),
    );
  }
  return levelerWorkletUrl;
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

// [Voice/H3] Rolling in-memory ring buffer of voice diagnostic snapshots.
// At the default 30 s cadence this is ~30 minutes of history; bumped to 120
// to comfortably cover most user reports of "I missed what they said." The
// buffer drains on disconnect so memory does not grow unboundedly across
// multiple sessions in one tab. Reachable via window.stoatDiag.history().
export interface VoiceDiagSnapshot {
  ts: number;                                       // Date.now() at capture
  localIdentity?: string;
  localQuality?: string;
  pipeline: { df3Active: boolean };
  upload: {
    pps: number | null;
    kbps: number | null;
    rtt: number | null;
    jitterMs: number | null;
    lossPct: number | null;
  };
  screenshare?: {
    width?: number;
    height?: number;
    fps: number | null;
    kbps: number | null;
    limitReason?: string;
  };
  remotes: Array<{
    identity: string;
    quality: string;
    jitterMs: number | null;
    lossPct: number | null;
    concealedPct: number | null;
    kbps: number | null;
    muted: boolean;
  }>;
  levels: Record<string, string>;                   // label -> "X dBFS"|"-∞"|"err"
}

const VOICE_DIAG_HISTORY_CAPACITY = 120;
const _voiceDiagHistory: VoiceDiagSnapshot[] = [];

function pushVoiceDiagSnapshot(snap: VoiceDiagSnapshot): void {
  _voiceDiagHistory.push(snap);
  if (_voiceDiagHistory.length > VOICE_DIAG_HISTORY_CAPACITY) {
    _voiceDiagHistory.splice(0, _voiceDiagHistory.length - VOICE_DIAG_HISTORY_CAPACITY);
  }
}

export function getVoiceDiagHistory(): VoiceDiagSnapshot[] {
  return _voiceDiagHistory.slice();
}

export function clearVoiceDiagHistory(): void {
  _voiceDiagHistory.length = 0;
}

async function printVoiceStats(
  room: Room,
  df3Active: boolean,
  rawMicTrack: MediaStreamTrack | null,
  // [Voice/B4] Latest leveler heartbeat. Null on each axis means the
  // leveler isn't running for one of the documented reasons (kill
  // switch set, useStoatAgc off, or no heartbeat yet).
  levelerStats?: { gainDb: number | null; limiterDb: number | null },
) {
  const ts = new Date().toLocaleTimeString();
  console.group(`[Voice Diagnostics] ${ts}`);
  // [Voice/H3] Built up alongside the console.log output so the snapshot
  // semantics never drift from what the user sees logged. Emitted at the
  // end of the function via pushVoiceDiagSnapshot.
  const snap: VoiceDiagSnapshot = {
    ts: Date.now(),
    pipeline: { df3Active },
    upload: { pps: null, kbps: null, rtt: null, jitterMs: null, lossPct: null },
    remotes: [],
    levels: {},
  };

  const local = room.localParticipant;
  console.log(`Local participant: ${local.identity} | quality=${local.connectionQuality}`);
  console.log(`  Pipeline: DF3=${df3Active ? "✅ active" : "❌ inactive"}`);
  // [Voice/B4] Surface the leveler's current gain so tuning rounds can
  // see whether it's hitting the +12/-6 dB rails or sitting near unity.
  if (levelerStats && (levelerStats.gainDb !== null || levelerStats.limiterDb !== null)) {
    const lev = levelerStats.gainDb !== null
      ? `${levelerStats.gainDb >= 0 ? "+" : ""}${levelerStats.gainDb.toFixed(1)} dB`
      : "—";
    const lim = levelerStats.limiterDb !== null
      ? `${levelerStats.limiterDb.toFixed(1)} dB`
      : "—";
    console.log(`  Leveler (B4): gain=${lev}, peak-limiter=${lim}`);
  }
  snap.localIdentity = local.identity;
  snap.localQuality = String(local.connectionQuality);

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
            snap.upload.pps = ulPpsPrev ? Number(ulPps) : null;
            snap.upload.kbps = ulPrev ? Number(ulKbps) : null;
          }
          if (r.type === "remote-inbound-rtp") {
            const jitter = ((r.jitter ?? 0) * 1000).toFixed(1);
            const rttRaw = (r.roundTripTime ?? 0) * 1000;
            const rtt = rttRaw > 0 && rttRaw < 5000 ? `${rttRaw.toFixed(0)}ms` : "pending";
            const loss = ((r.fractionLost ?? 0) * 100).toFixed(1);
            console.log(`  Upload quality (server sees): RTT=${rtt}, jitter=${jitter}ms, loss=${loss}%`);
            snap.upload.jitterMs = Number(jitter);
            snap.upload.rtt = rttRaw > 0 && rttRaw < 5000 ? Math.round(rttRaw) : null;
            snap.upload.lossPct = Number(loss);
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
            snap.screenshare = {
              width: r.frameWidth,
              height: r.frameHeight,
              fps: Number(fps),
              kbps: ssPrev ? Number(ssKbps) : null,
              limitReason: String(limitReason),
            };
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
              snap.remotes.push({
                identity: p.identity,
                quality: String(q),
                jitterMs: Number(jitter),
                lossPct: Number(loss),
                concealedPct: Number(concealPct),
                kbps: dlPrev ? Number(dlKbps) : null,
                muted: pub.isMuted,
              });
            }
          });
        }
      } catch (e) {
        console.warn(`  Could not get receiver stats for ${p.identity}:`, e);
      }
    } else {
      console.log(`  ${p.identity}: quality=${q}, no audio track`);
      snap.remotes.push({
        identity: p.identity,
        quality: String(q),
        jitterMs: null,
        lossPct: null,
        concealedPct: null,
        kbps: null,
        muted: false,
      });
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
    levelChecks.forEach(({ label }, i) => {
      console.log(`    ${label}: ${levels[i]}`);
      snap.levels[label] = levels[i];
    });
  }

  pushVoiceDiagSnapshot(snap);
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

  // [Voice/J3] Reactive flag that flips true when the Silero VAD assets fail
  // to load (network blip, 404 on /silero/*, ONNX runtime error). The gate
  // falls back to RMS-only when this happens; the UI surfaces a small notice
  // so users know smart detection isn't running. Cleared on the next
  // successful #startSileroVad.
  sileroLoadFailed: Accessor<boolean>;
  #setSileroLoadFailed: Setter<boolean>;

  private openModal: ModalController["openModal"];
  private getClient: ReturnType<typeof useClient>;

  #livekitUrl = "";
  get livekitUrl() { return this.#livekitUrl; }
  // Input sensitivity gate AudioContext + worklet node
  #inputGateCtx: AudioContext | null = null;
  #inputGateNode: AudioWorkletNode | null = null;
  // [STOAT-AGC] Custom AGC node — always present in the graph when the gate
  // is, with `enabled` toggled live via port. Inserted between gate and dest
  // so it runs pre-DF3.
  #agcNode: AudioWorkletNode | null = null;
  // [Voice/A2] HPF biquad inserted at the start of the AudioContext graph
  // when A2 is active. 80 Hz / Q=0.707 — removes AC hum, rumble, plosive
  // thumps. Null when A2 is disabled via kill switch. Recreated on every
  // graph rebuild because its upstream `src` is recreated.
  #hpfRumbleNode: BiquadFilterNode | null = null;
  // [Voice/A2] DF3 instantiated as a Web Audio node in our own AudioContext
  // instead of as a LiveKit track processor. Created lazily on the first
  // #applyInputGate after the AudioContext exists; reused across graph
  // rebuilds so the model stays warm and continuous across track restarts.
  // Destroyed only when #cleanupInputGate closes the AudioContext.
  // Null when A2 is disabled via kill switch.
  #df3Core: DeepFilterNet3Core | null = null;
  #df3Node: AudioWorkletNode | null = null;
  // [Voice/B4] Latest leveler gain heartbeats from the stoat-leveler
  // worklet. Updated every ~107 ms when the leveler is active; null when
  // the leveler isn't in the graph (B4 kill switch set, or useStoatAgc
  // off and the legacy worklet is bypassed). Surfaced via getLevelerStats
  // for window.stoatDiag and the 30 s diagnostic auto-print.
  #levelerGainDb: number | null = null;
  #levelerLimiterDb: number | null = null;
  // The MediaStreamDestination node lives across rebuilds so its track
  // (the one published via replaceTrack) is never stopped or replaced. This
  // also keeps the audio graph "pulled" continuously, which prevents Chrome
  // from auto-suspending the AudioContext during the window between
  // disconnect-old-nodes and connect-new-nodes on a settings change.
  #inputGateDest: MediaStreamAudioDestinationNode | null = null;
  // [VOICE-DEBUG-CAPTURE] Tap-point handles into the existing input gate
  // graph. Set by #applyInputGate, cleared by #cleanupInputGate. Only used
  // when a debug capture is armed — no impact on the live audio path.
  // [Voice/H5] Widened to AudioNode: the head of the graph is normally a
  // MediaStreamAudioSourceNode (live mic) but may be an injected AudioNode
  // under the dev test harness. Stage-01 (01_raw_mic.wav) taps this node, so
  // an injected run records the injected signal pre-bandpass — that is the
  // STEP 4 confidence check.
  #tapRawSrc: AudioNode | null = null;
  #tapBandpass: BiquadFilterNode | null = null;
  // [Voice/H5] TX injection seam. When non-null, #applyInputGate uses this
  // node as the HEAD of the input-gate graph instead of the live mic — the
  // entire downstream chain (bandpass detector, 80 Hz HPF, DF3, gate, AGC,
  // dest) is identical; only the head differs. A normal call never sets this
  // (stays null), so the mic path is byte-identical to pre-H5. The node MUST
  // be created on #inputGateCtx by the test harness (H7) and is owned by it —
  // #applyInputGate / teardown never stop() or close() it, only disconnect
  // its outputs on rebuild. Cleared on full teardown so the next join reverts
  // to the mic. Dev-only (gated at the public setter).
  #injectedSource: AudioNode | null = null;
  // [Voice/H5] Bridge node that turns the injected AudioNode into a
  // MediaStreamTrack, so everything that branches off the mic TRACK (Silero
  // VAD, the auto-calibrator, the "raw mic" diag tap — all read #rawMicTrack)
  // sees the injected signal too. Without this they stay bound to the real
  // hardware mic and the harness misrepresents the post-A2 pipeline. Owned by
  // us (unlike #injectedSource): recreated per injected build, torn down on
  // cleanup. Null when injection is inactive.
  #injectedMicTapDest: MediaStreamAudioDestinationNode | null = null;
  // [Voice/H6] Second LiveKit Room connected under the test-bot identity. It
  // publishes the TX-chain output (#inputGateDest track) so the REAL client
  // subscribes to it like any remote participant and plays it through the
  // normal RX path — the "phantom participant" loopback. Connected with
  // autoSubscribe:false (the phantom is headless — it never plays audio and
  // must not subscribe to itself or anyone). Null when not running. Dev-only.
  #phantomRoom: Room | null = null;
  // Active debug-capture session (null when none in progress).
  #captureSession: DebugCaptureSession | null = null;
  // Set by debug capture if applyMicConstraints fires while a capture is
  // running; the rebuild then runs once after capture ends.
  #micConstraintsDeferredDuringCapture = false;
  // [Voice/H2] Active A/B harness session (null when none in progress).
  // Mutually-exclusive with #captureSession — they share the input-gate
  // AudioContext and the capture-recorder worklet, and serialising them
  // sidesteps any race over which session "owns" the rebuild-defer flag.
  #abHarnessSession: ABHarnessSession | null = null;
  // Public read accessor for diagnostics — returns the pre-gate mic track.
  get rawMicTrack(): MediaStreamTrack | null { return this.#rawMicTrack; }
  // [Voice/A2] True when DF3 is running, regardless of whether it's a Web
  // Audio node (A2 active) or a LiveKit TrackProcessor (legacy). Used by
  // printVoiceStats so the diagnostic banner reflects reality under A2.
  isDf3Active(): boolean {
    if (this.#df3Node) return true;
    const room = this.room();
    const micPub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    // Dodge the protected `processor` accessor on LocalAudioTrack the same
    // way the debug-capture stage-5 tap does.
    return !!((micPub?.track as unknown as { processor?: unknown })?.processor);
  }
  // [Voice/B4] Latest leveler gain heartbeat snapshot for diagnostics.
  // Both values are null when the leveler isn't running (kill switch set,
  // useStoatAgc off, or before the first heartbeat lands).
  getLevelerStats(): { gainDb: number | null; limiterDb: number | null } {
    return { gainDb: this.#levelerGainDb, limiterDb: this.#levelerLimiterDb };
  }
  // [VOICE-DEBUG-CAPTURE] Surface the active session to the settings UI.
  get debugCaptureSession(): DebugCaptureSession | null { return this.#captureSession; }
  // [Voice/H2] Surface the active A/B harness session to the settings UI.
  get abHarnessSession(): ABHarnessSession | null { return this.#abHarnessSession; }
  // [VAD-IMPROVEMENT-#8] Silero VAD second-pass classifier (loaded on demand
  // via dynamic import). null when disabled or not yet running.
  // Type kept loose because the package's MicVAD type isn't re-exported cleanly.
  #sileroVad: { destroy(): void; start?(): void; pause?(): void } | null = null;
  // [VAD-IMPROVEMENT-#8-fix] In-flight start promise. Concurrent callers of
  // #startSileroVad await the same instantiation instead of each spawning a
  // MicVAD — the original `if (this.#sileroVad) return;` check raced across
  // `await import` and `await MicVAD.new`, producing duplicate ONNX workers
  // on the same default AudioContext that contended with DF3.
  #sileroStartInFlight: Promise<void> | null = null;
  // Raw (pre-gate) mic track, kept for periodic auto-calibration
  #rawMicTrack: MediaStreamTrack | null = null;
  // [Voice/J4] Tracks whether the mic publish-warmup sequence has run for this
  // Room session. Set true at the end of the localTrackPublished handler;
  // reset to false on disconnect. Used to gate the warmup-mute window to
  // initial connect only — PTT first-press and post-reconnect republish skip
  // the mute (their UX contracts differ; DF3 is also warm-cached by then).
  #hasMicWarmedUp = false;
  // [Voice/J5] Snapshot of #settings.micOn taken at the moment of self-deafen,
  // restored on undeafen. null when not currently deafened. PTT users: this
  // captures whatever mic state PTT had at deafen-time (typically false between
  // keypresses); the next keypress overrides as normal.
  #preDeafenMicOn: boolean | null = null;
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

    const [sileroLoadFailed, setSileroLoadFailed] = createSignal(false);
    this.sileroLoadFailed = sileroLoadFailed;
    this.#setSileroLoadFailed = setSileroLoadFailed;

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
        // [STOAT-AGC] Chrome AGC is now opt-in via setting. The Stoat AGC
        // worklet handles dynamics afterwards in the gate AudioContext.
        autoGainControl: this.#settings.chromeAgcEnabled ?? true,
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
      // [Voice/J4] Re-arm the warmup-mute on next connect.
      this.#hasMicWarmedUp = false;
      // [Voice/J5] Drop any stale pre-deafen snapshot from this session.
      this.#preDeafenMicOn = null;
    });

    // Attach input gate + DF3 to any newly published mic track — covers initial
    // connect, PTT first-press (track created on demand), and post-reconnect republish.
    room.addListener("localTrackPublished", async (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.Microphone) return;
      const track = publication.track as LocalAudioTrack | undefined;
      if (!track) return;

      // [Voice/J4] On initial connect, mute the publication at the WebRTC layer
      // for the duration of #applyInputGate + DF3 attach. Without this, the SFU
      // forwards raw mic (Window A: ~5–50 ms before replaceTrack swaps in the
      // dest-node track) and then gate-output-without-DF3 (Window B: up to
      // ~500 ms while DF3 model loads) — audible to listeners as the original
      // "scratchy / garbled / sudden cut-in at the very start" complaint.
      //
      // Skip on subsequent publishes (PTT first-press, post-reconnect republish):
      //   • PTT users pressed a key expecting immediate transmission — mute
      //     would be perceptible.
      //   • DF3 is already model-cached by then; Window B collapses to <50 ms.
      //
      // Skip when DF3 is disabled — no Window B exists; Window A alone is
      // sub-detection, and the user explicitly opted out of NS.
      const wantDF3 = (this.#settings.noiseSupression ?? true)
        && DeepFilterNoiseFilterProcessor.isSupported();
      const shouldMute = !this.#hasMicWarmedUp
        && wantDF3
        && !isMicWarmupMuteDisabled();

      if (shouldMute) {
        try {
          await track.mute();
        } catch (e) {
          // If mute fails we degrade to legacy behavior — don't abort the publish.
          console.warn("[Voice/J4] mic warmup mute failed (degrading to legacy):", e);
        }
      }

      try {
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
        // [Voice/A2] When the new architecture is active, DF3 is already
        // wired in the AudioContext graph by #applyInputGate above —
        // skip the legacy LiveKit setProcessor attach. Under the kill
        // switch, fall through to the original setProcessor path.
        if (!isStoatFixDisabled("disableA2Architecture")) return;
        if (!DeepFilterNoiseFilterProcessor.isSupported()) {
          console.warn("[Voice] DF3 not supported in this browser");
          return;
        }
        try {
          await track.setProcessor(
            new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" }, noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 25 }),
          );
          console.log("[Voice] ✅ DeepFilterNet3 noise suppression active");
        } catch (e) {
          console.warn("[Voice] ❌ DeepFilterNet3 failed to start:", e);
        }
      } finally {
        // [Voice/J4] Mark warmup complete *before* the unmute, so any
        // republish triggered during/after unmute also skips the mute path.
        this.#hasMicWarmedUp = true;
        if (shouldMute && track.isMuted) {
          // Honor settings that may have changed during warmup. If PTT is
          // enabled, post-connect logic at line ~991 will call
          // setMicrophoneEnabled(false) anyway — unmuting here would leak
          // ~tens-of-ms of audio between unmute and re-mute.
          // (`deafen` is intentionally not checked: deafen controls local
          // audio output, not mic state, matching the existing setMute() /
          // post-connect mic plumbing.)
          if (this.#settings.micOn && !this.#settings.pushToTalkEnabled) {
            try {
              await track.unmute();
            } catch (e) {
              console.warn("[Voice/J4] mic warmup unmute failed:", e);
            }
          }
        }
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

  // [VAD-IMPROVEMENT-#8-fix] Re-entry guard for applyMicConstraints.
  // The createEffect that watches noiseSupression / noiseSupressionLevel /
  // echoCancellation can fire several times in rapid succession (settings
  // hydration on connect, slider drags). Each unguarded call rebuilt the
  // input gate and re-armed Silero before the previous attach finished,
  // stacking MicVAD instances on the audio thread. Pattern: last-write-wins
  // coalescing — at most one constraints op runs at a time, and a single
  // pending re-run is queued. Multiple calls during one in-flight op
  // collapse into one trailing run with the latest settings.
  #micConstraintsInFlight: Promise<void> | null = null;
  #micConstraintsPending = false;

  async applyMicConstraints(): Promise<void> {
    // [VOICE-DEBUG-CAPTURE] Defer mic-graph rebuilds while a capture is
    // running — restartTrack would replace the gate AudioContext mid-record
    // and corrupt the bundle. The deferred flag triggers one trailing run
    // when the capture ends.
    if (this.#captureSession) {
      this.#micConstraintsDeferredDuringCapture = true;
      return;
    }
    // [Voice/H2] Same protection while the A/B harness is actively
    // recording a pass — settings changes between passes are intentional
    // and must propagate, but mid-record rebuilds would replace the
    // tap node mid-buffer and produce a torn recording.
    const abState = this.#abHarnessSession?.state();
    if (abState === "recording-a" || abState === "recording-b") {
      this.#micConstraintsDeferredDuringCapture = true;
      return;
    }
    if (this.#micConstraintsInFlight) {
      this.#micConstraintsPending = true;
      return this.#micConstraintsInFlight;
    }
    this.#micConstraintsInFlight = (async () => {
      try {
        await this.#runMicConstraints();
        while (this.#micConstraintsPending) {
          this.#micConstraintsPending = false;
          await this.#runMicConstraints();
        }
      } finally {
        this.#micConstraintsInFlight = null;
      }
    })();
    return this.#micConstraintsInFlight;
  }

  async #runMicConstraints(): Promise<void> {
    const room = this.room();
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;

    const nsEnabled = this.#settings.noiseSupression ?? true;
    const ecEnabled = this.#settings.echoCancellation ?? true;

    // Skip livekit-client's restartTrack — it misbehaves on tracks that
    // were previously user-provided via replaceTrack(track, true). Instead
    // of acquiring fresh getUserMedia, it ends our destination track and
    // sets track.mediaStreamTrack to a phantom destination-node track,
    // breaking the entire downstream pipeline. Diagnostic logs caught this
    // (rawLabel: "MediaStreamAudioDestinationNode" + destTrackReady:
    // "ended" on rebuild). #applyInputGate now does its own getUserMedia
    // call so we control the mic acquisition lifecycle end-to-end.
    await this.#applyInputGate(track);

    // [Voice/A2] Under the new architecture, DF3 lives as a node inside
    // #applyInputGate's graph. The rebuild above already re-applied the
    // current noiseSupression toggle and noiseSupressionLevel slider to
    // the DF3 core, so the LiveKit setProcessor / stopProcessor path is
    // intentionally a no-op here. The kill-switch path keeps the
    // original behavior unchanged.
    if (!isStoatFixDisabled("disableA2Architecture")) return;

    try {
      if (nsEnabled) {
        await track.setProcessor(
          new DeepFilterNoiseFilterProcessor({ assetConfig: { cdnUrl: "/df3-assets" }, noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 25 }),
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

    // [VOICE-DEBUG-CAPTURE] Cancel any active capture session — its nodes
    // live in the input gate's AudioContext which is about to close.
    if (this.#captureSession) {
      try { this.#captureSession.cancel(); } catch { /* ignore */ }
    }
    // [Voice/H2] Same teardown for the A/B harness — its recorder and
    // playback nodes also depend on the gate AudioContext.
    if (this.#abHarnessSession) {
      try { this.#abHarnessSession.cancel(); } catch { /* ignore */ }
    }

    // [Voice/H6] Tear down the phantom loopback Room if it's running — it's
    // bound to this call's channel and pipeline output.
    void this.stopPhantom();

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
    const room = this.room();
    room?.localParticipant.setAttributes({ deafened: newDeafened ? "true" : "false" });

    // [Voice/J5] Auto-mute mic on deafen, restore prior state on undeafen.
    // Bypasses setMute() so the mute/unmute notification sound doesn't double up
    // with playDeafen/playUndeafen. PTT semantics: undeafen restores micOn to
    // its pre-deafen value (typically false for PTT users between keypresses);
    // the next PTT keypress takes over as normal.
    if (room && !isStoatFixDisabled("disableDeafenAutoMute")) {
      if (!wasDeafened) {
        this.#preDeafenMicOn = this.#settings.micOn;
        if (this.#settings.micOn) {
          try {
            await room.localParticipant.setMicrophoneEnabled(false);
            this.#settings.micOn = false;
          } catch (e) {
            console.warn("[Voice/J5] auto-mute on deafen failed:", e);
          }
        }
      } else {
        const restoreTo = this.#preDeafenMicOn;
        this.#preDeafenMicOn = null;
        if (restoreTo === true && !this.#settings.micOn) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
            this.#settings.micOn = true;
          } catch (e) {
            console.warn("[Voice/J5] auto-restore on undeafen failed:", e);
          }
        }
      }
    }

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
    // Reuse the existing AudioContext across rebuilds. Chrome puts new
    // AudioContexts in 'suspended' state and only auto-resumes when they
    // were created within a user-gesture call stack (e.g. clicking "join
    // voice"). Settings-change rebuilds happen later, outside the gesture
    // chain, so a fresh context stays suspended forever — and resume()
    // called outside a gesture resolves successfully but does NOT actually
    // run the context. Symptom: post-toggle voice transmission AND debug
    // captures both go silent across the whole audio graph until reload.
    //
    // Fix: build the context once at first join (inside the gesture) and
    // rewire only the worklet nodes / source on later rebuilds. Worklet
    // module URLs are blob: URLs deduped by addModule() — calling them
    // again on the same context is a cheap no-op.
    const isRebuild = !!this.#inputGateCtx && this.#inputGateCtx.state !== "closed";
    console.log("[Voice/diag] applyInputGate enter:", {
      isRebuild,
      ctxState: this.#inputGateCtx?.state ?? "none",
      ctxStartTime: this.#inputGateCtx?.currentTime,
      hasDest: !!this.#inputGateDest,
      trackMSTrackId: track.mediaStreamTrack?.id,
      trackMSTrackReady: track.mediaStreamTrack?.readyState,
    });
    await this.#disconnectGateNodes();
    console.log("[Voice/diag] after disconnect:", { ctxState: this.#inputGateCtx?.state });
    const dbfs = this.#settings.inputSensitivity ?? -60;
    const threshold = Math.pow(10, dbfs / 20);
    try {
      let ctx = this.#inputGateCtx;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext({ sampleRate: 48000 });
        // resume() inside the user gesture (initial join) succeeds; on a
        // settings rebuild it's a no-op but doesn't hurt.
        await ctx.resume().catch(() => { /* ignore */ });
        this.#inputGateCtx = ctx;
        console.log("[Voice/diag] created new ctx:", { state: ctx.state });
      } else {
        console.log("[Voice/diag] reusing ctx:", { state: ctx.state });
      }
      await ctx.audioWorklet.addModule(getInputGateWorkletUrl());
      // [STOAT-AGC] Register the AGC worklet alongside the gate so we can
      // wire the node in below; the bypass path is byte-equivalent (5 ms
      // delay only) when the user has Stoat AGC disabled.
      await ctx.audioWorklet.addModule(getAgcWorkletUrl());
      // [Voice/B4] Register the leveler worklet alongside the legacy AGC.
      // Both modules load idempotently per AudioContext (addModule dedupes
      // by URL). We pick which AudioWorkletNode to instantiate below
      // based on the B4 kill switch — keeping both registrations means a
      // future toggle path (if we wanted to expose it in settings rather
      // than only via reload) is just an instantiation choice.
      await ctx.audioWorklet.addModule(getLevelerWorkletUrl());
      console.log("[Voice/diag] modules loaded:", { state: ctx.state });

      // [Voice/A2] One-time DF3 init for the lifetime of this AudioContext.
      // The wrapper hides its own worklet module registration inside
      // createAudioWorkletNode, so we don't need a parallel addModule call.
      // setNoiseSuppressionEnabled / setSuppressionLevel are reapplied on
      // every rebuild from the current settings so the toggle and slider
      // stay live without touching the model state.
      const a2Disabled = isStoatFixDisabled("disableA2Architecture");
      if (!a2Disabled && !this.#df3Core) {
        try {
          const core = new DeepFilterNet3Core({
            sampleRate: 48000,
            noiseReductionLevel: this.#settings.noiseSupressionLevel ?? 25,
            assetConfig: { cdnUrl: "/df3-assets" },
          });
          await core.initialize();
          const df3Node = await core.createAudioWorkletNode(ctx);
          core.setNoiseSuppressionEnabled(this.#settings.noiseSupression ?? true);
          this.#df3Core = core;
          this.#df3Node = df3Node;
          console.log("[Voice/A2] ✅ DeepFilterNet3 continuous node active");
        } catch (e) {
          // Non-fatal — graph wiring below will route src directly to the
          // gate, skipping DF3. The user gets HPF + gate + AGC but no NS.
          console.warn("[Voice/A2] ❌ DeepFilterNet3 init failed — running without NS:", e);
        }
      } else if (!a2Disabled && this.#df3Core) {
        // Sync DF3 config with current settings on rebuild — the slider /
        // toggle may have moved since the previous build.
        try {
          this.#df3Core.setNoiseSuppressionEnabled(this.#settings.noiseSupression ?? true);
          this.#df3Core.setSuppressionLevel(this.#settings.noiseSupressionLevel ?? 25);
        } catch { /* ignore */ }
      }
      // First build: trust track.mediaStreamTrack — LiveKit just acquired
      // it via getUserMedia during the initial publish flow, before any
      // user-provided-track flag has been set, so it's a real mic.
      // Rebuild: do our own getUserMedia so we can apply the new EC /
      // chrome-AGC constraints; restartTrack misbehaves on user-provided
      // tracks and ends up handing back a destination-node track instead
      // of a mic (caught in diagnostics).
      const isFirstBuild = !this.#inputGateDest;
      // [Voice/H5] TX injection seam. When an injected source is set (dev test
      // harness), the HEAD of the graph is that node instead of the live mic.
      // The MIC branch below is byte-identical to pre-H5 — a normal call never
      // enters the injection branch (#injectedSource stays null), which is the
      // guarantee that protects normal calls. The injected branch skips mic
      // acquisition entirely; everything downstream of `src` (detector, HPF,
      // DF3, gate, AGC, dest) is the same node graph, so the output differs
      // only because the input differs.
      const usingInjectedSource = !!this.#injectedSource;
      let src: AudioNode;
      if (usingInjectedSource) {
        // The injected node was created on this same #inputGateCtx by the test
        // harness. We do NOT own it — never stop()/close() it here. No
        // getUserMedia, no clone.
        src = this.#injectedSource!;
        // [Voice/H5] Bridge the injected node into a MediaStreamTrack and treat
        // it as the raw mic, so Silero VAD, the auto-calibrator and the "raw
        // mic" diag tap (all read #rawMicTrack) see the injected signal — not
        // the real hardware mic. The detector/clean path already consume `src`
        // directly above; this closes the gap for the track-based consumers so
        // the harness faithfully represents the post-A2 pipeline.
        if (this.#injectedMicTapDest) {
          try { this.#injectedMicTapDest.disconnect(); } catch { /* ignore */ }
        }
        const prevRaw = this.#rawMicTrack;
        const injectedMicDest = ctx.createMediaStreamDestination();
        this.#injectedSource!.connect(injectedMicDest);
        this.#injectedMicTapDest = injectedMicDest;
        this.#rawMicTrack = injectedMicDest.stream.getAudioTracks()[0];
        // Drop the previous track (a prior bridge, or the real mic we're
        // displacing for the test) so we don't leak a live capture track.
        // Revert re-acquires a fresh mic via getUserMedia, so this is safe.
        if (prevRaw && prevRaw !== this.#rawMicTrack) {
          try { prevRaw.stop(); } catch { /* ignore */ }
        }
        console.log("[Voice/H5] input gate head = INJECTED source (mic, Silero & auto-cal bridged to injection)");
      } else {
        // [Voice/H5] Reverting to the live mic — drop any stale injection
        // bridge. No-op in a normal call (#injectedMicTapDest is always null
        // there), so the mic path stays byte-identical.
        if (this.#injectedMicTapDest) {
          try { this.#injectedMicTapDest.disconnect(); } catch { /* ignore */ }
          this.#injectedMicTapDest = null;
        }
        let newMic: MediaStreamTrack;
        if (isFirstBuild) {
          newMic = track.mediaStreamTrack;
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: this.#settings.preferredAudioInputDevice,
              echoCancellation: this.#settings.echoCancellation ?? true,
              noiseSuppression: false, // DF3 handles NS as a track processor
              autoGainControl: this.#settings.chromeAgcEnabled ?? true,
            },
          });
          newMic = stream.getAudioTracks()[0];
          const prevMic = this.#rawMicTrack;
          if (prevMic && prevMic !== newMic) {
            try { prevMic.stop(); } catch { /* ignore */ }
          }
        }
        this.#rawMicTrack = newMic;
        const cloned = newMic.clone();
        console.log("[Voice/diag] raw mic + clone:", {
          isFirstBuild,
          rawId: newMic.id,
          rawReady: newMic.readyState,
          rawEnabled: newMic.enabled,
          rawMuted: newMic.muted,
          rawLabel: newMic.label,
          cloneId: cloned.id,
          cloneReady: cloned.readyState,
        });
        src = ctx.createMediaStreamSource(new MediaStream([cloned]));
      }

      // [VAD-IMPROVEMENT-#5] Build a 300-3400 Hz speech-band side-chain via
      // cascaded high-pass + low-pass biquads (Butterworth Q≈0.707). Only the
      // detector input sees the filter — clean audio path is untouched.
      // [Voice/A2] Detector stays on raw mic in both architectures. The
      // existing threshold tuning and auto-calibration are anchored to raw
      // mic levels; piping the detector through DF3 would invalidate them.
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
      // [Voice/A2] When the new pipeline is active, tell the gate to skip
      // its legacy -45 dBFS bleed floor — DF3 sits upstream and no longer
      // needs to be kept warm by the gate.
      gate.port.postMessage({ threshold, disableBleed: !a2Disabled });

      // [Voice/A2 / A4] Gate signal input wiring differs by architecture.
      //   A2 active: src → HPF 80 Hz → DF3 (continuous) → gate input 0.
      //              DF3 runs on raw post-AEC mic, before the gate, so
      //              its noise model is always warm. HPF stays wired even
      //              if DF3 init failed earlier — the rumble cut is
      //              strictly an improvement and doesn't need NS.
      //   A2 disabled (kill switch): src → gate input 0 directly, matching
      //              the legacy pipeline where DF3 ran as a LiveKit
      //              setProcessor downstream of the gate+AGC.
      // The detector path (src → hp → lp → gate input 1) is identical in
      // both modes so the existing gate tuning is preserved.
      if (!a2Disabled) {
        const hpfRumble = new BiquadFilterNode(ctx, {
          type: "highpass",
          frequency: 80,
          Q: 0.707,
        });
        src.connect(hpfRumble);
        if (this.#df3Node) {
          hpfRumble.connect(this.#df3Node);
          this.#df3Node.connect(gate, 0, 0);
        } else {
          // DF3 init failed — route HPF straight to the gate. User gets
          // rumble cut + gate + AGC but no NS until DF3 recovers on the
          // next rebuild. The warning was already logged at init time.
          hpfRumble.connect(gate, 0, 0);
        }
        this.#hpfRumbleNode = hpfRumble;
      } else {
        src.connect(gate, 0, 0); // input 0 = clean audio (legacy path)
      }
      lp.connect(gate, 0, 1);  // input 1 = bandpass-filtered detector (raw mic)

      // [STOAT-AGC / Voice/B4] Always insert an AGC-class node; toggle
      // the `enabled` flag via port so changing useStoatAgc doesn't
      // require rebuilding the AudioContext. Bypass path is 5 ms delay
      // only — byte-equivalent across both worklet implementations so
      // swapping has no audible click.
      //
      // B4 kill switch (stoat.disableB4Leveler) selects which worklet
      // instance is used:
      //   • Unset (default): stoat-leveler — K-weighted LUFS-S leveler
      //     with -1 dBFS sample-peak limiter. Target -20 LUFS-S
      //     hardcoded; the stoatAgcTargetDbfs slider is inert.
      //   • Set: stoat-agc — legacy envelope-follower AGC. The slider
      //     drives its target as before.
      const useLeveler = !isStoatFixDisabled("disableB4Leveler");
      const agc = new AudioWorkletNode(
        ctx,
        useLeveler ? "stoat-leveler" : "stoat-agc",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      if (useLeveler) {
        agc.port.postMessage({
          enabled: this.#settings.useStoatAgc ?? false,
          silentThresholdDbfs: -50,
        });
        // Heartbeats from the leveler land here every ~107 ms. Cleared on
        // disconnect via #disconnectGateNodes (the node is disconnected
        // and re-created on every rebuild, so its onmessage handler
        // goes with it).
        agc.port.onmessage = (ev) => {
          const d = ev.data as { type?: string; levelerDb?: number; limiterDb?: number };
          if (d?.type === "gain") {
            this.#levelerGainDb = typeof d.levelerDb === "number" ? d.levelerDb : null;
            this.#levelerLimiterDb = typeof d.limiterDb === "number" ? d.limiterDb : null;
          }
        };
      } else {
        agc.port.postMessage({
          enabled: this.#settings.useStoatAgc ?? false,
          targetDbfs: this.#settings.stoatAgcTargetDbfs ?? -18,
          maxGainDb: 18,
          minGainDb: -12,
          silentThresholdDbfs: -50,
        });
        // Legacy worklet doesn't emit gain heartbeats — clear any stale
        // values from a previous build that ran the leveler.
        this.#levelerGainDb = null;
        this.#levelerLimiterDb = null;
      }

      // Reuse the existing dest node across rebuilds. The published
      // MediaStreamTrack (dest.stream.getAudioTracks()[0]) is created once
      // on first build and never swapped — that means LiveKit doesn't
      // re-negotiate the publication on every settings change, and Chrome
      // doesn't briefly suspend the AudioContext during a tear-down/rewire
      // window. Both rebuild bugs (silent post-toggle bundles, voice
      // cutting out for listeners) collapse to this single fix.
      let dest = this.#inputGateDest;
      if (!dest) {
        dest = ctx.createMediaStreamDestination();
        this.#inputGateDest = dest;
      }
      gate.connect(agc);
      agc.connect(dest);
      const dt = dest.stream.getAudioTracks()[0];
      console.log("[Voice/diag] dest state:", {
        isFirstBuild,
        destTrackId: dt?.id,
        destTrackReady: dt?.readyState,
        destTrackEnabled: dt?.enabled,
        destTrackMuted: dt?.muted,
      });
      if (isFirstBuild) {
        // userProvidedTrack=true — we manage this track's lifecycle, LiveKit
        // doesn't try to stop or replace it.
        await track.replaceTrack(dt, true);
        console.log("[Voice/diag] first replaceTrack done:", {
          nowMSTrackId: track.mediaStreamTrack?.id,
          match: track.mediaStreamTrack === dt,
        });
      } else {
        console.log("[Voice/diag] dest reused, skipping replaceTrack");
      }
      this.#inputGateCtx = ctx;
      this.#inputGateNode = gate;
      this.#agcNode = agc;
      // [VOICE-DEBUG-CAPTURE] Expose the tap points for the dev capture flow.
      // Disconnecting these references would alter the live audio path —
      // they are only ever read, never disconnected. Cleared in #cleanupInputGate.
      this.#tapRawSrc = src;
      this.#tapBandpass = lp;
      console.log(`[Voice] ✅ Input gate active, threshold=${dbfs.toFixed(1)} dBFS`);

      // [Voice/diag] Probe the live src signal 250 ms after wiring so we
      // can see whether the AudioContext is actually producing samples
      // through the rebuilt graph. -∞ here means the graph is connected
      // but the source isn't flowing audio (most likely cause of the
      // post-toggle silent-bundle bug).
      void (async () => {
        try {
          await new Promise(r => setTimeout(r, 250));
          const probe = ctx.createAnalyser();
          probe.fftSize = 2048;
          src.connect(probe);
          await new Promise(r => setTimeout(r, 100));
          const buf = new Float32Array(probe.fftSize);
          probe.getFloatTimeDomainData(buf);
          let ss = 0;
          for (const v of buf) ss += v * v;
          const probeRms = Math.sqrt(ss / buf.length);
          const probeDb = probeRms > 1e-7 ? (20 * Math.log10(probeRms)).toFixed(1) : "-∞";
          src.disconnect(probe);
          console.log("[Voice/diag] post-build src probe:", {
            ctxState: ctx.state,
            currentTime: ctx.currentTime,
            srcRmsDbfs: probeDb,
            destTrackReady: this.#inputGateDest?.stream.getAudioTracks()[0]?.readyState,
          });
        } catch (e) {
          console.warn("[Voice/diag] post-build probe failed:", e);
        }
      })();

      // [VAD-IMPROVEMENT-#8] Silero second-pass classifier (default on).
      // Loads onnxruntime-web (~5 MB cached) + silero_vad.onnx (~1 MB) on first
      // attach. Falls back gracefully to RMS-only if the package fails to load.
      // To revert: delete this block (gate already supports sileroEnabled=false).
      // [Voice/H5] Under injection, #rawMicTrack is the bridged injected track
      // (set above), so Silero classifies the injected signal — exactly what a
      // live mic would feed it. No injection-specific guard.
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
  // [VAD-IMPROVEMENT-#8-fix] Promise-locked: concurrent callers share a
  // single in-flight init instead of each constructing a MicVAD.
  #startSileroVad(): Promise<void> {
    if (this.#sileroVad) return Promise.resolve();
    if (this.#sileroStartInFlight) return this.#sileroStartInFlight;
    const p = (async () => {
      if (!this.#rawMicTrack || !this.#inputGateNode) return;
      // Snapshot the gate node we're attaching to. If it gets replaced
      // mid-init (e.g. applyMicConstraints rebuilt the gate), we discard
      // the constructed MicVAD instead of bonding it to a stale gate.
      const targetGateNode = this.#inputGateNode;
      const targetRawTrack = this.#rawMicTrack;
      try {
        const { MicVAD } = await import("@ricky0123/vad-web");
        if (this.#inputGateNode !== targetGateNode || this.#rawMicTrack !== targetRawTrack) {
          return;
        }
        const vad = await MicVAD.new({
          baseAssetPath: "/silero/",
          onnxWASMBasePath: "/silero/",
          getStream: async () => new MediaStream([targetRawTrack.clone()]),
          onSpeechStart: () => {
            this.#inputGateNode?.port.postMessage({ vadActive: true });
          },
          onSpeechEnd: () => {
            this.#inputGateNode?.port.postMessage({ vadActive: false });
          },
        });
        if (this.#inputGateNode !== targetGateNode || this.#rawMicTrack !== targetRawTrack) {
          try { (vad as unknown as { destroy(): void }).destroy(); } catch { /* ignore */ }
          return;
        }
        await vad.start();
        this.#sileroVad = vad as unknown as { destroy(): void };
        this.#inputGateNode.port.postMessage({ sileroEnabled: true });
        this.#setSileroLoadFailed(false);
        console.log("[Voice] ✅ Silero VAD second-pass active (self-hosted assets)");
      } catch (e) {
        console.warn("[Voice] ❌ Silero VAD failed to load — falling back to RMS-only gate:", e);
        this.#inputGateNode?.port.postMessage({ sileroEnabled: false });
        this.#setSileroLoadFailed(true);
      }
    })();
    this.#sileroStartInFlight = p.finally(() => {
      if (this.#sileroStartInFlight === p) this.#sileroStartInFlight = null;
    });
    return this.#sileroStartInFlight;
  }

  // [VAD-IMPROVEMENT-#8] Stop and tear down Silero VAD. Idempotent.
  // [VAD-IMPROVEMENT-#8-fix] Awaits any in-flight start so we never leak a
  // MicVAD that finishes initializing after teardown.
  async #stopSileroVad(): Promise<void> {
    if (this.#sileroStartInFlight) {
      try { await this.#sileroStartInFlight; } catch { /* ignore */ }
    }
    if (!this.#sileroVad) {
      this.#inputGateNode?.port.postMessage({ sileroEnabled: false, vadActive: false });
      return;
    }
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

  /**
   * Disconnect the gate/AGC graph nodes WITHOUT closing the AudioContext.
   * Called at the start of every #applyInputGate to discard the previous
   * build before constructing the new one. The context survives so that
   * its 'running' state — which was won during the user-gesture chain at
   * voice-join time — is preserved across settings changes.
   */
  async #disconnectGateNodes(): Promise<void> {
    // Silero is bound to the previous #rawMicTrack which the upcoming
    // restartTrack/applyInputGate will replace. Stop it here so the next
    // build can attach a fresh instance to the new track.
    await this.#stopSileroVad();
    try { this.#tapRawSrc?.disconnect(); } catch { /* ignore */ }
    try { this.#tapBandpass?.disconnect(); } catch { /* ignore */ }
    try { this.#inputGateNode?.disconnect(); } catch { /* ignore */ }
    try { this.#agcNode?.disconnect(); } catch { /* ignore */ }
    // [Voice/A2] HPF biquad is recreated per build, but DF3 is reused — we
    // disconnect both so the upcoming wiring step can re-route them through
    // the freshly-created src / gate. The DF3 node itself stays alive on
    // #df3Node so its worklet-side noise model state survives the rebuild.
    try { this.#hpfRumbleNode?.disconnect(); } catch { /* ignore */ }
    try { this.#df3Node?.disconnect(); } catch { /* ignore */ }
    this.#tapRawSrc = null;
    this.#tapBandpass = null;
    this.#inputGateNode = null;
    this.#agcNode = null;
    this.#hpfRumbleNode = null;
    // intentionally do NOT null #df3Node / #df3Core — they persist across rebuilds.
  }

  async #cleanupInputGate(): Promise<void> {
    // [VOICE-DEBUG-CAPTURE] Cancel any active capture before tearing down
    // its underlying AudioContext — capture nodes live inside #inputGateCtx.
    if (this.#captureSession) {
      try { this.#captureSession.cancel(); } catch { /* ignore */ }
    }
    // [Voice/H2] Same for the A/B harness.
    if (this.#abHarnessSession) {
      try { this.#abHarnessSession.cancel(); } catch { /* ignore */ }
    }
    await this.#disconnectGateNodes();
    // [Voice/A2] Destroy DF3 alongside the AudioContext — its WASM and
    // worklet processor live inside that context. Must run before
    // ctx.close() so the wrapper can release its handles cleanly.
    if (this.#df3Core) {
      try { this.#df3Core.destroy(); } catch { /* ignore */ }
      this.#df3Core = null;
      this.#df3Node = null;
    }
    // [Voice/B4] Drop stale leveler heartbeat values now that the
    // worklet is gone. Avoids the diagnostic reporting a frozen reading
    // from the previous session.
    this.#levelerGainDb = null;
    this.#levelerLimiterDb = null;
    if (this.#inputGateCtx) {
      try { await this.#inputGateCtx.close(); } catch { /* ignore */ }
      this.#inputGateCtx = null;
    }
    this.#inputGateDest = null;
    if (this.#rawMicTrack) {
      try { this.#rawMicTrack.stop(); } catch { /* ignore */ }
      this.#rawMicTrack = null;
    }
    // [Voice/H5] Drop the injection ref on full teardown so the next join
    // reverts to the live mic. The harness owns #injectedSource's lifecycle —
    // we do not stop()/close() it here, only release our reference. The bridge
    // dest IS ours: disconnect it (its derived track was the just-stopped
    // #rawMicTrack).
    this.#injectedSource = null;
    if (this.#injectedMicTapDest) {
      try { this.#injectedMicTapDest.disconnect(); } catch { /* ignore */ }
      this.#injectedMicTapDest = null;
    }
  }

  /** Send a new threshold to the running gate worklet without restarting the track. */
  updateGateThreshold(dbfs: number): void {
    if (this.#inputGateNode) {
      this.#inputGateNode.port.postMessage({ threshold: Math.pow(10, dbfs / 20) });
    }
  }

  // ─── [Voice/H5] TX injection seam (dev-only) ──────────────────────────────
  // The loopback test harness (H6/H7) builds its source nodes on this exact
  // AudioContext (per the reuse rule — no parallel context) and hands the
  // summed head node to setInjectedTxSource(). These accessors are the only
  // public surface of the seam; the wiring lives in #applyInputGate.

  /**
   * The live input-gate AudioContext (48 kHz), or null before the first join.
   * The harness must create its injected source node on THIS context so it
   * shares the clock with the rest of the graph. Returns null until the gate
   * has been built once (i.e. the user has joined voice at least once).
   */
  get inputGateContext(): AudioContext | null {
    return this.#inputGateCtx;
  }

  /** True while an injected source is driving the head of the graph. */
  get isTxInjectionActive(): boolean {
    return !!this.#injectedSource;
  }

  /**
   * [Voice/H5] Swap the HEAD of the input-gate graph between the live mic and
   * an arbitrary injected AudioNode, then rebuild the gate so the change takes
   * effect. Pass a node (created on inputGateContext) to inject; pass null to
   * revert to the live mic.
   *
   * Invariants:
   *  - MIC path stays byte-identical to a pre-H5 build — reverting clears the
   *    flag and the next rebuild runs the unmodified getUserMedia path.
   *  - The injected node's lifecycle is owned by the caller (the harness). We
   *    only read it, wire its output downstream, and disconnect that output on
   *    rebuild/teardown — we never stop() or close() it.
   *
   * Dev-gated behind isDebugCaptureBuild() (DEV or __STOAT_DEBUG_CAPTURE__),
   * the same gate as debug capture. No-ops (and warns) outside a live call
   * because there is no published track to rebuild against.
   *
   * NOTE: while injecting into the *local* room's pipeline, the caller is
   * responsible for muting the real mic publication so the injected signal
   * does not leak into the channel (enforced by the H7 panel). H6 publishes
   * the dest output on the phantom connection instead.
   */
  async setInjectedTxSource(node: AudioNode | null): Promise<void> {
    if (!isDebugCaptureBuild()) {
      console.warn("[Voice/H5] setInjectedTxSource ignored — not a debug build");
      return;
    }
    if (node && this.#inputGateCtx && node.context !== this.#inputGateCtx) {
      // A node from a different AudioContext cannot connect into our graph —
      // fail loudly rather than silently producing a dead head.
      console.error(
        "[Voice/H5] injected node belongs to a different AudioContext — " +
        "create it on voice.inputGateContext",
      );
      return;
    }
    // [Voice/H8] On ENABLING injection, snapshot the real room floor right now
    // — the mic is still live and injection isn't active yet — and clear the
    // rolling history so the held threshold reflects the actual room, not a
    // value polluted by a prior injection run or a stale persisted setting.
    // The early-return guard in #calibrateInputSensitivity keys off
    // #injectedSource (still unset here), so this one cal runs on the real mic;
    // every later cal during injection is held. Skipped on revert (node null)
    // and on re-inject (already active → don't sample the bridge).
    if (node && !this.#injectedSource && (this.#settings.inputSensitivityAuto ?? true) && this.#rawMicTrack) {
      this.#calibrationHistory = [];
      await this.#calibrateInputSensitivity(this.#rawMicTrack);
    }
    this.#injectedSource = node;
    const room = this.room();
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) {
      console.warn(
        "[Voice/H5] injected source set but no live mic publication to rebuild " +
        "against — join voice first; it will apply on the next gate build",
      );
      return;
    }
    // Rebuild the gate against the current published track. The injected head
    // replaces the mic; everything downstream is rewired unchanged.
    await this.#applyInputGate(track);
    console.log(
      `[Voice/H5] TX injection ${node ? "ENABLED" : "reverted to mic"}`,
    );
  }

  // ─── [Voice/H6] Phantom-participant loopback (dev-only) ───────────────────
  // A second Room under the test-bot identity publishes the TX-chain output so
  // the REAL client receives it as a remote participant and plays it through
  // the normal RX path — the only way to hear your own round trip (LiveKit
  // never sends your own published track back to you).

  /**
   * Fetch the loopback-bot token from the dev server's live endpoint, or null
   * if unset/unavailable. Served per-request from the container env (not baked
   * into the bundle), so it's immune to service-worker / index.html caching.
   */
  async #readVoiceTestBotToken(): Promise<string | null> {
    try {
      const resp = await fetch("/voice-test-bot-token", { cache: "no-store" });
      if (!resp.ok) return null;
      const { token } = (await resp.json()) as { token?: string };
      return token && typeof token === "string" ? token : null;
    } catch {
      return null;
    }
  }

  /** True while the phantom Room is connected. */
  get isPhantomActive(): boolean {
    return !!this.#phantomRoom;
  }

  /**
   * [Voice/H6] Connect a second Room as the test-bot and publish the
   * input-gate pipeline output (#inputGateDest track) into the SAME channel
   * you're in, so you hear the full round trip. Publishes whatever the pipeline
   * currently outputs — the injected source if H5 injection is active, else the
   * live mic. Headless: autoSubscribe:false, so the phantom never plays audio
   * or subscribes to itself/others. Dev-gated.
   *
   * Caveat: the pipeline output also leaves under YOUR identity on the main
   * room (shared track), so run solo in a test channel or mute your real
   * publication (H7 automates the mute) to avoid doubling the round trip for
   * other participants.
   */
  async startPhantom(): Promise<void> {
    if (!isDebugCaptureBuild()) {
      console.warn("[Voice/H6] startPhantom ignored — not a debug build");
      return;
    }
    if (this.#phantomRoom) {
      console.warn("[Voice/H6] phantom already running — stopPhantom() first");
      return;
    }
    const channel = this.channel();
    if (!channel) {
      console.warn("[Voice/H6] join a voice channel first");
      return;
    }
    const botToken = await this.#readVoiceTestBotToken();
    if (!botToken) {
      console.warn("[Voice/H6] no bot token from /voice-test-bot-token — set VITE_VOICE_TEST_BOT_TOKEN in .env and restart web-dev");
      return;
    }
    const track = this.#inputGateDest?.stream.getAudioTracks()[0];
    if (!track) {
      console.warn("[Voice/H6] no pipeline output track — input gate not built (join voice first)");
      return;
    }
    // Mint a LiveKit token for the bot via the same join_call endpoint the real
    // client uses, authenticated with x-bot-token. force_disconnect MUST be
    // false (true -> 403 IsBot) and node MUST be supplied (or inherited from an
    // existing call), else 400 UnknownNode.
    const baseURL = this.getClient().options.baseURL;
    let url: string;
    let token: string;
    try {
      const resp = await fetch(`${baseURL}/channels/${channel.id}/join_call`, {
        method: "POST",
        headers: { "x-bot-token": botToken, "content-type": "application/json" },
        body: JSON.stringify({ node: "worldwide", force_disconnect: false }),
      });
      if (!resp.ok) {
        console.error(`[Voice/H6] join_call failed ${resp.status}:`, await resp.text());
        return;
      }
      ({ url, token } = await resp.json());
    } catch (e) {
      console.error("[Voice/H6] join_call request error:", e);
      return;
    }
    // Match the main room's Opus settings so the phantom transmits exactly what
    // a real participant would (DTX off, FEC + RED on, 128 kbps).
    const room = new Room({
      publishDefaults: {
        audioPreset: { maxBitrate: 128_000 },
        dtx: false,
        red: true,
        codecOptions: { opusFec: true, opusDtx: false, opusMaxPlaybackRate: 48000 },
      },
    });
    // Publish a CLONE of the pipeline output, not the track itself: the
    // original is the user's main-room publication, and LiveKit may stop a
    // published MediaStreamTrack on unpublish/disconnect — stopping the shared
    // track would kill the user's real audio. The clone carries the same
    // dest-node output but its lifecycle is the phantom's alone.
    const phantomTrack = track.clone();
    try {
      await room.connect(url, token, { autoSubscribe: false });
      await room.localParticipant.publishTrack(phantomTrack, {
        source: Track.Source.Microphone,
        dtx: false,
        red: true,
      });
    } catch (e) {
      console.error("[Voice/H6] phantom connect/publish failed:", e);
      try { phantomTrack.stop(); } catch { /* ignore */ }
      try { await room.disconnect(); } catch { /* ignore */ }
      return;
    }
    this.#phantomRoom = room;
    console.warn(
      "[Voice/H6] phantom CONNECTED as voice-test-bot, publishing the TX " +
      "output. You should hear it as a remote participant. Run solo/muted so " +
      "the round trip isn't doubled. window.stoatVoiceTest.stopPhantom() to end.",
    );
  }

  /** [Voice/H6] Disconnect the phantom Room. Idempotent. */
  async stopPhantom(): Promise<void> {
    const room = this.#phantomRoom;
    this.#phantomRoom = null;
    if (room) {
      try { await room.disconnect(); } catch { /* ignore */ }
      console.log("[Voice/H6] phantom disconnected");
    }
  }

  // ─── [Voice/H7] Loopback test-panel mic gating (dev-only) ─────────────────
  // While the mixer plays an injected test signal, the panel must silence the
  // user's REAL main-room publication so the test can't leak into the channel
  // under their identity (mixer rule #5). The phantom (H6) publishes a CLONE of
  // the pipeline output on a separate track whose `enabled` flag is independent,
  // so muting the main publication here leaves the round trip audible. These
  // helpers are the silent path: setMute()/toggleMute() emit mute/unmute chimes
  // and rewrite #settings.micOn, neither of which we want for a transient test.

  /** True if the real main-room mic publication is currently sending. */
  get isMicPublicationEnabled(): boolean {
    const room = this.room();
    return !!room?.localParticipant.isMicrophoneEnabled;
  }

  /**
   * Mute/unmute the main-room mic publication for the loopback harness WITHOUT
   * the notification chimes and WITHOUT touching #settings.micOn — so the
   * user's persisted mute preference survives the test and a normal
   * toggleMute() afterwards still behaves. No-op outside a debug build or a
   * live call, or when already in the requested state.
   */
  async setHarnessMicMuted(muted: boolean): Promise<void> {
    if (!isDebugCaptureBuild()) return;
    const room = this.room();
    if (!room) return;
    if (room.localParticipant.isMicrophoneEnabled !== muted) return; // already there
    await room.localParticipant.setMicrophoneEnabled(!muted);
  }

  /**
   * [STOAT-AGC] Live-update the AGC worklet without restarting the track.
   * No-ops when the gate isn't built yet — config will be applied on the
   * next #applyInputGate call (which reads the current settings).
   */
  updateAgcConfig(opts: { enabled?: boolean; targetDbfs?: number }): void {
    if (this.#agcNode) {
      this.#agcNode.port.postMessage(opts);
    }
  }

  /**
   * [VOICE-DEBUG-CAPTURE] Arm a 30-second sample-aligned dump of the four
   * outgoing-pipeline tap points to a user-picked directory.
   *
   *   01_raw_mic.wav        — pre-bandpass, pre-gate, post-getUserMedia
   *   02_post_bandpass.wav  — side-chain (gate detector input only)
   *   03_post_gate.wav      — gate output, pre-DF3
   *   04_post_dfn3.wav      — final transmitted audio (omitted if DF3 inactive)
   *
   * All four recorders are AudioWorkletNodes attached to the same
   * #inputGateCtx, connected synchronously so their first samples land at
   * the same render-quantum boundary (variance ≪ 1 ms). Returns a session
   * handle whose accessors drive the settings UI.
   *
   * Pre-conditions: the user is already in a voice channel (input gate is
   * active). Re-entrancy is blocked at the call site by checking
   * `voice.debugCaptureSession`.
   *
   * On success/cancel/error the session removes itself from this Voice
   * instance and runs any deferred applyMicConstraints exactly once.
   */
  async armDebugCapture(durationSec = 30): Promise<DebugCaptureSession> {
    const ctx = this.#inputGateCtx;
    const rawSrc = this.#tapRawSrc;
    const bandpass = this.#tapBandpass;
    const gate = this.#inputGateNode;
    const agc = this.#agcNode;
    console.log("[Voice/diag] armDebugCapture:", {
      ctxState: ctx?.state,
      ctxCurrentTime: ctx?.currentTime,
      hasRawSrc: !!rawSrc,
      hasBandpass: !!bandpass,
      hasGate: !!gate,
      hasAgc: !!agc,
      hasDest: !!this.#inputGateDest,
      rawMicTrackId: this.#rawMicTrack?.id,
      rawMicTrackReady: this.#rawMicTrack?.readyState,
    });

    const [state, setState] = createSignal<DebugCaptureState>("idle");
    const [remainingMs, setRemainingMs] = createSignal(durationSec * 1000);
    const [error, setError] = createSignal<string | null>(null);
    const [outputPath, setOutputPath] = createSignal<string | null>(null);

    const fail = (msg: string): DebugCaptureSession => {
      setError(msg);
      setState("error");
      return { state, remainingMs, error, outputPath, cancel: () => {} };
    };

    if (!ctx || !rawSrc || !bandpass || !gate) {
      return fail("Join a voice channel first.");
    }
    if (this.#captureSession) {
      return fail("A capture is already in progress.");
    }
    if (!window.native?.debugCapture) {
      return fail("Desktop only — file system access required.");
    }

    // Register the recorder worklet on the input-gate AudioContext. The
    // helper is idempotent per-context, so subsequent captures skip the work.
    try {
      await ensureCaptureRecorderRegistered(ctx);
    } catch (e) {
      return fail(`Failed to load capture worklet: ${(e as Error).message}`);
    }

    // Capture a snapshot of inputs for the session closure.
    const sampleRate = ctx.sampleRate;
    const totalFrames = Math.round(sampleRate * durationSec);
    const settings = this.#settings;

    // Resolve DF3 output for stage 5. Two paths:
    //   • A2 active: DF3 is an AudioWorkletNode in our context (#df3Node).
    //     Tap it directly — no MediaStream round-trip. Under A2 the DF3
    //     output is upstream of gate+AGC, so the "transmitted" semantics
    //     of stage 5 shift slightly (final transmitted audio is stage 4 /
    //     post-AGC). metadata.a2Active records this so downstream
    //     analysis can branch.
    //   • A2 disabled (legacy): DF3 is a LiveKit TrackProcessor — find its
    //     processedTrack and build a MediaStreamSource on it.
    // When neither path yields a source, stage 5 is omitted entirely so
    // bundle filenames never lie about what they contain.
    const a2Active = !isStoatFixDisabled("disableA2Architecture");
    const room = this.room();
    const micPub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const dfn3Track = a2Active
      ? null
      : (((micPub?.track as unknown as { processor?: { processedTrack?: MediaStreamTrack } })
          ?.processor?.processedTrack) ?? null);
    const df3WorkletNode = a2Active ? this.#df3Node : null;

    type RecorderEntry = {
      filename: string;
      label: string;
      node: AudioWorkletNode;
      // Source node we connect from. For tap 04 we additionally hold the
      // MediaStreamAudioSourceNode so we can disconnect it on cleanup.
      sourceForCleanup?: AudioNode;
      buffer: Float32Array | null;
      framesRecorded: number;
      done: Promise<void>;
    };

    const recorders: RecorderEntry[] = [];
    let canceled = false;

    const buildRecorder = (
      filename: string,
      label: string,
      source: AudioNode,
      ownsSource: boolean,
    ): RecorderEntry => {
      const node = new AudioWorkletNode(ctx, "stoat-capture-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { capacity: totalFrames },
      });
      const entry: RecorderEntry = {
        filename,
        label,
        node,
        sourceForCleanup: ownsSource ? source : undefined,
        buffer: null,
        framesRecorded: 0,
        done: new Promise<void>((resolve) => {
          node.port.onmessage = (ev) => {
            const data = ev.data as { type: string; buffer?: Float32Array; framesRecorded?: number };
            if (data?.type === "done") {
              entry.buffer = data.buffer ?? null;
              entry.framesRecorded = data.framesRecorded ?? 0;
              resolve();
            }
          };
        }),
      };
      // Bind the recorder to the audio path. The connect() takes effect at
      // the next render quantum; calling these synchronously across all four
      // recorders puts them on the same boundary.
      source.connect(node);
      return entry;
    };

    // Atomic wiring block — all connect() calls happen in the same JS tick
    // so they share a render-quantum boundary.
    const audioContextStartTime = ctx.currentTime;
    try {
      // [STOAT-AGC] captureVersion 2 layout — file numbers reflect signal
      // flow order. AGC sits between gate and DF3 so it gets slot 04,
      // pushing DF3 to 05. Bundle readers should branch on captureVersion.
      // [Voice/H1] captureVersion 3 keeps the same file layout but adds
      // metadata.loudness keyed by the leading "NN" of each filename.
      // [Voice/H5] captureVersion 4 keeps the file layout but adds
      // metadata.processingOrder (true A2 signal-flow order — the 01..05
      // numbering is legacy pre-A2 with DF3 last) and metadata.injectionActive.
      recorders.push(buildRecorder("01_raw_mic.wav", "raw mic", rawSrc, false));
      recorders.push(buildRecorder("02_post_bandpass.wav", "post bandpass", bandpass, false));
      recorders.push(buildRecorder("03_post_gate.wav", "post gate", gate, false));
      // Tap the AGC worklet's output even when bypassed — when disabled the
      // node passes audio through a 5 ms delay line, so 04_post_agc lets you
      // confirm the bypass is clean and isolate gain from DF3's contribution.
      if (agc) {
        recorders.push(buildRecorder("04_post_agc.wav", "post AGC", agc, false));
      }
      if (df3WorkletNode) {
        // [Voice/A2] Direct tap from the DF3 worklet output. The node
        // outputs continuously regardless of LiveKit publish state, so
        // the recorder sees samples from t=0 of this capture window.
        recorders.push(buildRecorder("05_post_dfn3.wav", "post DF3", df3WorkletNode, false));
      } else if (dfn3Track) {
        const df3Source = ctx.createMediaStreamSource(new MediaStream([dfn3Track]));
        recorders.push(buildRecorder("05_post_dfn3.wav", "post DF3", df3Source, true));
      }
    } catch (e) {
      // Tear down anything we managed to wire up before the throw.
      for (const r of recorders) {
        try { r.node.disconnect(); } catch { /* ignore */ }
        if (r.sourceForCleanup) try { r.sourceForCleanup.disconnect(); } catch { /* ignore */ }
      }
      return fail(`Failed to start capture: ${(e as Error).message}`);
    }

    setState("recording");

    // Countdown ticker for UI; not load-bearing for the recording itself
    // (the worklet self-finalises when the buffer is full).
    const startedAt = performance.now();
    const tick = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const left = Math.max(0, durationSec * 1000 - elapsed);
      setRemainingMs(left);
      if (left <= 0) clearInterval(tick);
    }, 100);

    const teardown = () => {
      clearInterval(tick);
      for (const r of recorders) {
        try { r.node.port.onmessage = null; } catch { /* ignore */ }
        try { r.node.disconnect(); } catch { /* ignore */ }
        if (r.sourceForCleanup) try { r.sourceForCleanup.disconnect(); } catch { /* ignore */ }
      }
    };

    const finalise = async (allDone: boolean) => {
      if (canceled || !allDone) {
        teardown();
        if (this.#captureSession === sessionRef) {
          this.#captureSession = null;
          this.#runDeferredMicConstraints();
        }
        return;
      }
      try {
        setState("encoding");
        // [Voice/H1] Compute loudness BEFORE we encode/null the buffers.
        // Each entry is keyed by the leading "NN" of the filename so the
        // mapping survives WAV reencoding and metadata-only consumers.
        const loudness: Record<string, { lufsIntegrated: number; truePeakDbfs: number }> = {};
        for (const r of recorders) {
          if (!r.buffer) continue;
          const m = measureLoudness(r.buffer);
          loudness[r.filename.slice(0, 2)] = m;
        }

        const wavs = recorders
          .filter((r) => r.buffer)
          .map((r) => ({
            name: r.filename,
            buffer: encodeWavMono16(r.buffer!, sampleRate),
          }));

        const ts = new Date();
        const subfolder = `stoat-capture-${formatBundleTimestamp(ts)}`;
        // [Voice/H5] True signal-flow order for this architecture, so bundle
        // readers stop interpreting the stages in the legacy filename order
        // (01..05 with DF3 last). Under A2 the main path is 01 → 05(DF3) →
        // 03(gate) → 04(AGC)=transmit, with 02 a detector sidechain off the
        // head. Only files actually recorded this run are included.
        const presentFiles = new Set(wavs.map((w) => w.name));
        const roleByFile: Record<string, string> = a2Active
          ? {
              "01_raw_mic.wav": "head (live mic or injected source), pre-HPF",
              "02_post_bandpass.wav": "gate detector sidechain (300-3400 Hz off head; not transmitted)",
              "05_post_dfn3.wav": "DF3 output (continuous, upstream of gate) = gate input 0",
              "03_post_gate.wav": "post input-gate",
              "04_post_agc.wav": "post AGC/leveler = transmitted",
            }
          : {
              "01_raw_mic.wav": "raw mic, pre-bandpass/pre-gate",
              "02_post_bandpass.wav": "gate detector sidechain (not transmitted)",
              "03_post_gate.wav": "post input-gate",
              "04_post_agc.wav": "post AGC",
              "05_post_dfn3.wav": "DF3 output = transmitted (legacy: DF3 last)",
            };
        const orderSeq = a2Active
          ? ["01_raw_mic.wav", "02_post_bandpass.wav", "05_post_dfn3.wav", "03_post_gate.wav", "04_post_agc.wav"]
          : ["01_raw_mic.wav", "02_post_bandpass.wav", "03_post_gate.wav", "04_post_agc.wav", "05_post_dfn3.wav"];
        const processingOrder = orderSeq
          .filter((f) => presentFiles.has(f))
          .map((f) => ({
            file: f,
            role: roleByFile[f] ?? "",
            // 02 (bandpass) is the only sidechain tap; everything else is on
            // the transmit path.
            mainPath: f !== "02_post_bandpass.wav",
          }));

        const metadata: CaptureMetadata = {
          captureVersion: 4,
          timestampIso: ts.toISOString(),
          audioContextStartTime,
          captureDurationSec: durationSec,
          framesRecorded: Object.fromEntries(
            recorders.map((r) => [r.filename.slice(0, 2), r.framesRecorded]),
          ),
          sampleRate,
          channels: 1,
          bitDepth: 16,
          build: STOAT_BUILD,
          dfn3Active: !!(df3WorkletNode || dfn3Track),
          // [Voice/A2] Architecture flag for downstream analysis. When
          // true, stages 03/04/05 in the bundle mean: post-gate where DF3
          // already ran upstream / post-AGC = final transmitted /
          // post-DF3-pre-gate (upstream tap). When false (legacy), stage
          // 05 is post-gate-post-AGC-post-DF3 i.e. final transmitted.
          a2Active,
          // Empirical: gate→DF3 cross-correlation peaks at -72 ms in
          // captured bundles. The model spec claims 20 ms but the wrapper
          // adds ~52 ms of buffering. Tracked by StoatData-0dv follow-up.
          dfn3LatencyMs: 72,
          settings: {
            inputSensitivity: settings.inputSensitivity,
            inputSensitivityAuto: settings.inputSensitivityAuto,
            useSileroVad: settings.useSileroVad,
            noiseSupression: settings.noiseSupression,
            noiseSupressionLevel: settings.noiseSupressionLevel,
            echoCancellation: settings.echoCancellation,
            chromeAgcEnabled: settings.chromeAgcEnabled,
            useStoatAgc: settings.useStoatAgc,
            stoatAgcTargetDbfs: settings.stoatAgcTargetDbfs,
            preferredAudioInputDevice: settings.preferredAudioInputDevice,
            pushToTalkEnabled: settings.pushToTalkEnabled,
          },
          gateConstants: {
            holdFrames: 30,
            attack: 0.3,
            release: 0.03,
            closeRatioDb: -10,
          },
          files: wavs.map((w) => w.name),
          loudness,
          processingOrder,
          injectionActive: this.isTxInjectionActive,
        };

        // Free recorder buffers before IPC ships ArrayBuffers to main.
        for (const r of recorders) r.buffer = null;

        setState("writing");
        const pick = await window.native!.debugCapture!.pickDir();
        if (pick.canceled || !pick.path) {
          setState("canceled");
          teardown();
          if (this.#captureSession === sessionRef) {
            this.#captureSession = null;
            this.#runDeferredMicConstraints();
          }
          return;
        }
        const result = await window.native!.debugCapture!.writeBundle({
          parentDir: pick.path,
          subfolderName: subfolder,
          files: wavs,
          metadata: metadata as unknown as Record<string, unknown>,
        });
        setOutputPath(result.path);
        setState("done");
      } catch (e) {
        setError((e as Error).message ?? String(e));
        setState("error");
      } finally {
        teardown();
        if (this.#captureSession === sessionRef) {
          this.#captureSession = null;
          this.#runDeferredMicConstraints();
        }
      }
    };

    // Wait for all recorders to finalise (buffer-full self-stop) OR a manual
    // stop signalled by cancel(). Each .done is constructed by us and never
    // rejects, but the .catch is defensive.
    Promise.all(recorders.map((r) => r.done))
      .then(() => { if (!canceled) void finalise(true); })
      .catch(() => { if (!canceled) void finalise(false); });

    const sessionRef: DebugCaptureSession = {
      state,
      remainingMs,
      error,
      outputPath,
      cancel: () => {
        if (canceled) return;
        canceled = true;
        // Tell each worklet to stop without producing more output.
        for (const r of recorders) {
          try { r.node.port.postMessage({ type: "stop" }); } catch { /* ignore */ }
        }
        setState("canceled");
        void finalise(false);
      },
    };
    this.#captureSession = sessionRef;
    return sessionRef;
  }

  /**
   * [VOICE-DEBUG-CAPTURE] Run a single deferred applyMicConstraints if one
   * was queued during a capture. Idempotent.
   */
  #runDeferredMicConstraints(): void {
    if (this.#micConstraintsDeferredDuringCapture) {
      this.#micConstraintsDeferredDuringCapture = false;
      void this.applyMicConstraints();
    }
  }

  /**
   * [Voice/H2] Arm the dev-only A/B harness. Records two 10-second passes
   * from the stage 5 tap (post-DF3 when active, post-AGC when DF3 is off),
   * randomises blind labels, and serves them back to the UI for playback.
   *
   * Settings changes between passes are intentional (they are the
   * comparison variable). The harness defers `applyMicConstraints` only
   * while a pass is actively recording, so the inter-pass tweak the user
   * makes does propagate before pass B begins.
   *
   * Buffers stay in memory — no disk write, no metadata bundle. They are
   * released on session end, on the next harness arm, or on voice
   * disconnect / input-gate teardown.
   *
   * Kill-switch: `localStorage.setItem("stoat.disableABHarness", "1")` —
   * checked at the UI layer; this method itself does not gate.
   */
  armABHarness(durationSec = 10): ABHarnessSession {
    const [state, setState] = createSignal<ABHarnessState>("idle");
    const [remainingMs, setRemainingMs] = createSignal(0);
    const [error, setError] = createSignal<string | null>(null);
    const [currentPass, setCurrentPass] = createSignal<ABHarnessPass | null>(null);
    const [tapSource, setTapSource] = createSignal<"post-dfn3" | "post-agc" | null>(null);
    const [labeling, setLabeling] = createSignal<ABHarnessLabeling | null>(null);
    const [playing, setPlaying] = createSignal<ABHarnessClip | null>(null);
    const [revealed, setRevealed] = createSignal(false);
    const [vote, setVote] = createSignal<ABHarnessClip | null>(null);

    let passABuffer: Float32Array | null = null;
    let passBBuffer: Float32Array | null = null;
    let activeRecorder: AudioWorkletNode | null = null;
    let activeSource: AudioNode | null = null;
    let activeSourceOwned = false;
    let activeTick: ReturnType<typeof setInterval> | null = null;
    let activePlayback: AudioBufferSourceNode | null = null;
    let sessionSampleRate = 48000;
    let cancelled = false;

    const fail = (msg: string) => {
      setError(msg);
      setState("error");
    };

    const teardownActiveRecording = () => {
      if (activeTick) {
        clearInterval(activeTick);
        activeTick = null;
      }
      if (activeRecorder) {
        try { activeRecorder.port.onmessage = null; } catch { /* ignore */ }
        try { activeRecorder.disconnect(); } catch { /* ignore */ }
        activeRecorder = null;
      }
      if (activeSourceOwned && activeSource) {
        try { activeSource.disconnect(); } catch { /* ignore */ }
      }
      activeSource = null;
      activeSourceOwned = false;
    };

    const teardownPlayback = () => {
      if (activePlayback) {
        try { activePlayback.stop(); } catch { /* ignore */ }
        try { activePlayback.disconnect(); } catch { /* ignore */ }
        activePlayback = null;
      }
      setPlaying(null);
    };

    /**
     * Resolve the latest stage-5 source for the current pass and run the
     * recorder for `durationSec`. Each pass re-resolves so a settings
     * change between passes is reflected.
     */
    const recordPass = async (pass: ABHarnessPass): Promise<Float32Array | null> => {
      const ctx = this.#inputGateCtx;
      if (!ctx) {
        fail("Join a voice channel first.");
        return null;
      }
      try {
        await ensureCaptureRecorderRegistered(ctx);
      } catch (e) {
        fail(`Failed to load capture worklet: ${(e as Error).message}`);
        return null;
      }

      // Resolve the "what listeners hear" tap. The harness exists to
      // compare perceived output, so it always taps the LAST stage of the
      // outgoing graph rather than a specific algorithm's output.
      //   • A2 active: graph ends src→HPF→DF3→gate→AGC→dest. AGC node
      //     output IS what gets published (post-DF3, post-gate, post-AGC).
      //   • A2 disabled + NS on (legacy): DF3 runs as a LiveKit processor
      //     downstream of AGC; tap its processedTrack.
      //   • A2 disabled + NS off: AGC node is the final stage (no DF3
      //     wrap). Same as A2-active in practice.
      const a2Active = !isStoatFixDisabled("disableA2Architecture");
      const room = this.room();
      const micPub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      const dfn3Track = a2Active
        ? null
        : (((micPub?.track as unknown as { processor?: { processedTrack?: MediaStreamTrack } })
            ?.processor?.processedTrack) ?? null);

      let source: AudioNode;
      let ownsSource = false;
      if (dfn3Track) {
        source = ctx.createMediaStreamSource(new MediaStream([dfn3Track]));
        ownsSource = true;
        setTapSource("post-dfn3");
      } else if (this.#agcNode) {
        source = this.#agcNode;
        setTapSource("post-agc");
      } else {
        fail("Neither DF3 nor AGC node is available — try rejoining the channel.");
        return null;
      }

      const sampleRate = ctx.sampleRate;
      sessionSampleRate = sampleRate;
      const totalFrames = Math.round(sampleRate * durationSec);
      const node = new AudioWorkletNode(ctx, "stoat-capture-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { capacity: totalFrames },
      });

      const done = new Promise<Float32Array | null>((resolve) => {
        node.port.onmessage = (ev) => {
          const data = ev.data as { type: string; buffer?: Float32Array };
          if (data?.type === "done") {
            resolve(data.buffer ?? null);
          }
        };
      });

      activeRecorder = node;
      activeSource = source;
      activeSourceOwned = ownsSource;

      source.connect(node);

      setCurrentPass(pass);
      setState(pass === "A" ? "recording-a" : "recording-b");
      const startedAt = performance.now();
      setRemainingMs(durationSec * 1000);
      activeTick = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        const left = Math.max(0, durationSec * 1000 - elapsed);
        setRemainingMs(left);
        if (left <= 0 && activeTick) {
          clearInterval(activeTick);
          activeTick = null;
        }
      }, 100);

      const buffer = await done;
      teardownActiveRecording();
      setCurrentPass(null);
      setRemainingMs(0);
      if (cancelled) return null;
      return buffer;
    };

    const startPassA = async () => {
      if (cancelled) return;
      if (this.#captureSession) {
        fail("A 30s debug capture is already in progress — cancel it first.");
        return;
      }
      const cur = state();
      if (cur !== "idle" && cur !== "error" && cur !== "revealed" && cur !== "compare") {
        return; // recording in progress or unreachable state — ignore
      }
      passABuffer = null;
      passBBuffer = null;
      setLabeling(null);
      setRevealed(false);
      setVote(null);
      setError(null);
      teardownPlayback();

      const buf = await recordPass("A");
      if (cancelled) return;
      if (!buf) return; // fail() was called
      passABuffer = buf;
      setState("ready-b");
      // Run any deferred mic-constraints rebuild that piled up while we
      // were recording (typically none — settings changes are between
      // passes, not during).
      this.#runDeferredMicConstraints();
    };

    const startPassB = async () => {
      if (cancelled) return;
      if (state() !== "ready-b") return;
      if (!passABuffer) {
        fail("Pass A buffer was lost — restart the harness.");
        return;
      }
      const buf = await recordPass("B");
      if (cancelled) return;
      if (!buf) return;
      passBBuffer = buf;

      // Crypto-random label assignment. coin=0 → clip1=A, clip2=B.
      const coin = cryptoCoinFlip();
      const map: ABHarnessLabeling =
        coin === 0
          ? { clip1: "A", clip2: "B" }
          : { clip1: "B", clip2: "A" };
      setLabeling(map);
      setState("compare");
      this.#runDeferredMicConstraints();
    };

    /**
     * Decode an in-memory Float32 buffer into an AudioBuffer on the
     * input-gate context and play it through ctx.destination. Reuses the
     * input-gate context so we don't pile up extra AudioContexts; output
     * routes through default device regardless of input-gate routing.
     */
    const playClip = (clip: ABHarnessClip) => {
      if (state() !== "compare" && state() !== "revealed") return;
      const map = labeling();
      if (!map) return;
      const buf = map[clip] === "A" ? passABuffer : passBBuffer;
      const ctx = this.#inputGateCtx;
      if (!buf || !ctx) return;
      teardownPlayback();

      const ab = ctx.createBuffer(1, buf.length, sessionSampleRate);
      ab.getChannelData(0).set(buf);
      const node = ctx.createBufferSource();
      node.buffer = ab;
      node.connect(ctx.destination);
      node.onended = () => {
        if (activePlayback === node) {
          activePlayback = null;
          setPlaying(null);
        }
      };
      activePlayback = node;
      setPlaying(clip);
      try {
        node.start();
      } catch (e) {
        teardownPlayback();
        fail(`Playback failed: ${(e as Error).message}`);
      }
    };

    const stopPlayback = () => {
      teardownPlayback();
    };

    const reveal = () => {
      if (state() !== "compare") return;
      const map = labeling();
      if (!map) return;
      console.log(
        `[Voice/H2] reveal: clip1=Pass ${map.clip1}, clip2=Pass ${map.clip2}, vote=${vote() ?? "none"}`,
      );
      setState("revealed");
      setRevealed(true);
    };

    const castVote = (clip: ABHarnessClip) => {
      if (state() !== "compare" && state() !== "revealed") return;
      setVote(clip);
      const map = labeling();
      if (map) {
        console.log(
          `[Voice/H2] vote: clip ${clip} (Pass ${map[clip]}) preferred — revealed=${revealed()}`,
        );
      }
    };

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (activeRecorder) {
        try { activeRecorder.port.postMessage({ type: "stop" }); } catch { /* ignore */ }
      }
      teardownActiveRecording();
      teardownPlayback();
      passABuffer = null;
      passBBuffer = null;
      setLabeling(null);
      setRevealed(false);
      setVote(null);
      setCurrentPass(null);
      setRemainingMs(0);
      if (state() !== "error") setState("idle");
      if (this.#abHarnessSession === sessionRef) {
        this.#abHarnessSession = null;
        this.#runDeferredMicConstraints();
      }
    };

    const sessionRef: ABHarnessSession = {
      state,
      remainingMs,
      error,
      currentPass,
      tapSource,
      labeling,
      playing,
      revealed,
      vote,
      startPassA,
      startPassB,
      playClip,
      stopPlayback,
      reveal,
      castVote,
      cancel,
    };
    this.#abHarnessSession = sessionRef;
    return sessionRef;
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
    // [Voice/H8] Never adapt the threshold while TX injection is active. Under
    // H5, #rawMicTrack is bridged to the injected (often looping) signal, which
    // has no quiet frames — the P25 floor estimator would sample sustained
    // speech, learn it as the noise floor, and ratchet the threshold up
    // (observed -20 → -15 dBFS) until it gates the speech out. Hold the last
    // real-mic-derived threshold for the duration; auto-cal resumes on revert.
    // (The harness measures the pipeline, not the room floor — calibrating off
    // the injected signal is meaningless anyway.)
    if (this.#injectedSource) return;
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
      //
      // [Voice/F17] Upper bound is -15 dBFS (relaxed from -20). In moderately
      // noisy rooms the +12 dB headroom can push the threshold up against the
      // ceiling, and conversational speech on common mics typically lands at
      // -25 to -30 dBFS — a -20 ceiling was clipping normal speech and
      // forcing users to speak unusually loud to open the gate. -15 leaves
      // enough margin to still gate out loud ambient noise while letting
      // typical voice through. To revert F17: change -15 back to -20.
      // To revert -60 floor: change -60 back to -100.
      const dbfs = Math.max(-60, Math.min(-15, 20 * Math.log10(floorRms) + 12));
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

    // Voice diagnostic helper: window.stoatDiag() in browser console.
    // [Voice/H3] history() and clearHistory() expose the rolling ring buffer
    // populated by every printVoiceStats invocation.
    const stoatDiagFn = async () => {
      const room = voice.room();
      if (!room) {
        console.log("[Voice Diagnostics] Not connected to a voice channel");
        return;
      }
      await printVoiceStats(room, voice.isDf3Active(), voice.rawMicTrack, voice.getLevelerStats());
    };
    (stoatDiagFn as unknown as { history: typeof getVoiceDiagHistory }).history = getVoiceDiagHistory;
    (stoatDiagFn as unknown as { clearHistory: typeof clearVoiceDiagHistory }).clearHistory = clearVoiceDiagHistory;
    (window as any).stoatDiag = stoatDiagFn;
    console.log("[Voice] 🔍 Type window.stoatDiag() to print voice stats, window.stoatDiag.history() for the rolling buffer");

    // [Voice/H5] Dev-only console hook for the injection seam, so the STEP 4
    // stage-01 confidence check can run before H7's UI exists. H7 supersedes
    // this with a proper test panel. Gated behind the debug-capture build.
    //   window.stoatVoiceTest.injectUrl("/assets/audio/join_call.mp3", {loop:true})
    //   window.stoatVoiceTest.revert()
    // CAUTION: injecting routes the test signal into the LOCAL room's publish
    // track — run solo in a test channel or pre-mute before injecting.
    if (isDebugCaptureBuild()) {
      const injectUrl = async (
        url: string,
        opts: { loop?: boolean } = {},
      ): Promise<AudioBufferSourceNode | null> => {
        const ctx = voice.inputGateContext;
        if (!ctx) {
          console.warn("[Voice/H5] join voice first — no input-gate context yet");
          return null;
        }
        const arr = await (await fetch(url)).arrayBuffer();
        // decodeAudioData resamples to the 48 kHz ctx automatically.
        const decoded = await ctx.decodeAudioData(arr);
        // Downmix to mono (the chain is single-channel) so stage-01 should
        // reproduce the file mono @ 48 kHz — the seam-fidelity assertion.
        const mono = ctx.createBuffer(1, decoded.length, ctx.sampleRate);
        const out = mono.getChannelData(0);
        for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
          const data = decoded.getChannelData(ch);
          for (let i = 0; i < data.length; i++) {
            out[i] += data[i] / decoded.numberOfChannels;
          }
        }
        const node = ctx.createBufferSource();
        node.buffer = mono;
        node.loop = !!opts.loop;
        // Wire the node as the graph head BEFORE starting it.
        await voice.setInjectedTxSource(node);
        node.start();
        console.warn(
          `[Voice/H5] INJECTING ${url} (loop=${!!opts.loop}). This is going ` +
          `out the local publish track — you should be solo/muted. ` +
          `Call window.stoatVoiceTest.revert() to restore the mic.`,
        );
        return node;
      };
      const revert = async () => { await voice.setInjectedTxSource(null); };
      (window as any).stoatVoiceTest = {
        injectUrl,
        revert,
        // [Voice/H6] phantom loopback controls
        startPhantom: () => voice.startPhantom(),
        stopPhantom: () => voice.stopPhantom(),
      };
      console.log("[Voice/H5] 🧪 window.stoatVoiceTest.injectUrl(url,{loop}) / .revert()");
      console.log("[Voice/H6] 🧪 window.stoatVoiceTest.startPhantom() / .stopPhantom()");
    }

    // Auto-print stats every 30s while connected
    const statsInterval = setInterval(async () => {
      const room = voice.room();
      if (room && voice.state() === "CONNECTED") {
        await printVoiceStats(room, voice.isDf3Active(), voice.rawMicTrack, voice.getLevelerStats());
      }
    }, 30_000);

    onCleanup(() => {
      clearInterval(statsInterval);
      delete (window as any).stoatDiag;
      // [Voice/H5] tear down the dev injection hook
      delete (window as any).stoatVoiceTest;
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

  // live-update mic constraints when noise suppression / echo cancellation
  // / Chrome AGC changes (all three require restartTrack on the publication)
  // [Voice/J7] Also re-acquires the track when the user picks a different
  // mic in settings mid-call — #applyInputGate already reads
  // preferredAudioInputDevice inside its getUserMedia call, it just wasn't
  // being triggered. Kill switch (off by default): localStorage
  // stoat.disableMidCallDeviceChange = "1" — falls back to legacy behavior
  // where the device only takes effect on next connect.
  const enableMidCallDeviceChange = !isStoatFixDisabled("disableMidCallDeviceChange");
  createEffect(() => {
    state.voice.noiseSupression;
    state.voice.noiseSupressionLevel;
    state.voice.echoCancellation;
    state.voice.chromeAgcEnabled;
    if (enableMidCallDeviceChange) {
      state.voice.preferredAudioInputDevice;
    }
    voice.applyMicConstraints();
  });

  // [Voice/J6] When PTT is toggled on mid-call, mute the mic so the gating
  // contract actually takes effect. The initial-connect path at line ~1188
  // handles first-join already; this createEffect only fires on subsequent
  // transitions. Kill switch (off by default): localStorage
  // stoat.disablePttMidCallMute = "1".
  // We capture the value on mount so the first run of the effect is a
  // baseline read, not a transition (no spurious mute on mount).
  let prevPttEnabled = state.voice.pushToTalkEnabled;
  const enablePttMidCallMute = !isStoatFixDisabled("disablePttMidCallMute");
  createEffect(() => {
    const pttEnabled = state.voice.pushToTalkEnabled;
    if (pttEnabled !== prevPttEnabled && enablePttMidCallMute && voice.room()) {
      if (pttEnabled) {
        // Toggled on mid-call — gate transmission until the user presses PTT.
        void voice.setMute(false);
      }
      // Toggling off mid-call: leave mic in current state. If PTT was being
      // held, the user can release; if not, mic stays muted until manually
      // unmuted. No automatic unmute (avoids surprise open-mic).
    }
    prevPttEnabled = pttEnabled;
  });

  // [STOAT-AGC] Live-toggle the AGC worklet without restarting the track.
  createEffect(() => {
    voice.updateAgcConfig({
      enabled: state.voice.useStoatAgc,
      targetDbfs: state.voice.stoatAgcTargetDbfs,
    });
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
