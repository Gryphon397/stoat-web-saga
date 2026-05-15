import { createEffect, onCleanup } from "solid-js";
import {
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteTrack,
  RemoteTrackPublication,
} from "livekit-client";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-core";

interface CompressedAudioTrackProps {
  trackRef: TrackReferenceOrPlaceholder;
  volume: number;
  muted: boolean;
  outputDeviceId?: string;
}

/**
 * [VAD-IMPROVEMENT-#9] Renders a remote audio track through a per-participant
 * dynamics compressor + gain stage. Discord-style normalisation: participants
 * with mismatched mic levels arrive at similar perceived loudness without the
 * user manually balancing volume sliders. Necessary even though everyone now
 * publishes with AGC enabled (#1) — we can't enforce that other clients have
 * AGC on (forks, opt-outs), and inter-participant residual variance remains
 * even when they do.
 *
 * Lifecycle invariants:
 *   - One AudioContext + chain per <CompressedAudioTrack> instance.
 *   - RoomAudioManager wraps each track in <Key by={getTrackReferenceId(...)}>
 *     so a fresh mount happens on participant join / track publish, and
 *     onCleanup runs on participant leave / track removal.
 *   - The chain is built lazily once the track resolves to a RemoteAudioTrack
 *     and torn down on unsubscribe; rebuilt on resubscribe to the same
 *     publication. Build/teardown are idempotent.
 *   - Participant event listeners are removed on unmount — no references leak
 *     after disconnect.
 *
 * Compressor settings: soft-knee, threshold -24 dB, ratio 4:1, knee 30 dB,
 * attack 3 ms, release 250 ms. Tuned to catch loud transients without pumping
 * on conversational rhythm. Make-up gain is intentionally absent — combined
 * with state.voice.outputVolume (default 2.0) and per-user volume the GainNode
 * provides ample post-compressor headroom.
 *
 * To revert: in RoomAudioManager.tsx swap CompressedAudioTrack back to
 * <AudioTrack> from solid-livekit-components.
 */
export function CompressedAudioTrack(props: CompressedAudioTrackProps) {
  let audioCtx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let compressor: DynamicsCompressorNode | undefined;
  let gain: GainNode | undefined;
  let attachedTrack: RemoteAudioTrack | undefined;
  // Chromium bug: MediaStreamAudioSourceNode produces zero samples for remote
  // WebRTC tracks unless the same MediaStream is also attached to an
  // HTMLMediaElement. The element below is muted (audio plays through Web
  // Audio's destination), but its presence keeps the WebRTC pipeline live.
  let keepaliveEl: HTMLAudioElement | undefined;

  const applySinkId = (ctx: AudioContext, deviceId?: string) => {
    if (!deviceId || !("setSinkId" in AudioContext.prototype)) return;
    (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> })
      .setSinkId(deviceId)
      .catch(() => { /* device gone or unsupported */ });
  };

  const buildChain = (track: RemoteAudioTrack) => {
    if (audioCtx) return;
    const ctx = new AudioContext();
    audioCtx = ctx;
    attachedTrack = track;
    void ctx.resume();
    applySinkId(ctx, props.outputDeviceId);

    const stream = new MediaStream([track.mediaStreamTrack]);

    keepaliveEl = document.createElement("audio");
    keepaliveEl.autoplay = true;
    keepaliveEl.muted = true;
    keepaliveEl.srcObject = stream;
    keepaliveEl.play().catch(() => { /* autoplay policy — element still primes pipeline */ });

    source = ctx.createMediaStreamSource(stream);

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.ratio.value = 4;
    compressor.knee.value = 30;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    gain = ctx.createGain();
    gain.gain.value = props.volume;

    source.connect(compressor);
    compressor.connect(gain);
    gain.connect(ctx.destination);
  };

  const teardownChain = () => {
    try { source?.disconnect(); } catch { /* ignore */ }
    try { compressor?.disconnect(); } catch { /* ignore */ }
    try { gain?.disconnect(); } catch { /* ignore */ }
    if (keepaliveEl) {
      try { keepaliveEl.pause(); } catch { /* ignore */ }
      keepaliveEl.srcObject = null;
    }
    if (audioCtx) audioCtx.close().catch(() => { /* ignore */ });
    source = undefined;
    compressor = undefined;
    gain = undefined;
    audioCtx = undefined;
    attachedTrack = undefined;
    keepaliveEl = undefined;
  };

  const sync = () => {
    const t = props.trackRef.publication.track;
    if (t instanceof RemoteAudioTrack) {
      if (t !== attachedTrack) {
        teardownChain();
        buildChain(t);
      }
    } else if (audioCtx) {
      teardownChain();
    }
  };

  // Initial pass — autoSubscribe=true (VAD-#10) means the track is usually
  // already a RemoteAudioTrack by the time we mount.
  sync();

  // Subscribe / unsubscribe events — covers reconnects and the brief gap
  // between filteredTracks emitting the publication and LiveKit attaching
  // the RemoteAudioTrack.
  const participant = props.trackRef.participant;
  const onSubscribed = (_t: RemoteTrack, p: RemoteTrackPublication) => {
    if (p === props.trackRef.publication) sync();
  };
  const onUnsubscribed = (_t: RemoteTrack, p: RemoteTrackPublication) => {
    if (p === props.trackRef.publication) sync();
  };
  participant.on(ParticipantEvent.TrackSubscribed, onSubscribed);
  participant.on(ParticipantEvent.TrackUnsubscribed, onUnsubscribed);

  // Live volume — no chain rebuild.
  createEffect(() => {
    if (gain) gain.gain.value = props.volume;
  });

  // Live mute — server stops sending audio for this track.
  createEffect(() => {
    const pub = props.trackRef.publication;
    if (pub instanceof RemoteTrackPublication) pub.setEnabled(!props.muted);
  });

  // Live output device.
  createEffect(() => {
    if (audioCtx) applySinkId(audioCtx, props.outputDeviceId);
  });

  onCleanup(() => {
    participant.off(ParticipantEvent.TrackSubscribed, onSubscribed);
    participant.off(ParticipantEvent.TrackUnsubscribed, onUnsubscribed);
    teardownChain();
  });

  return null;
}
