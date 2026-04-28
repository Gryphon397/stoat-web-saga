import { createEffect, createMemo } from "solid-js";
import { useTracks } from "solid-livekit-components";

import { getTrackReferenceId, isLocal } from "@livekit/components-core";
import { Key } from "@solid-primitives/keyed";
import { RemoteTrackPublication, Track } from "livekit-client";

import { useState } from "@revolt/state";

import { useVoice } from "../state";
import { CompressedAudioTrack } from "./CompressedAudioTrack";

export function RoomAudioManager() {
  const voice = useVoice();
  const state = useState();

  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  const filteredTracks = createMemo(() =>
    tracks().filter(
      (track) =>
        !isLocal(track.participant) &&
        track.publication.kind === Track.Kind.Audio,
    ),
  );

  createEffect(() => {
    for (const track of filteredTracks()) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
      // [VAD-IMPROVEMENT-#11] Lower jitter buffer target from LiveKit's
      // ~120 ms default to ~50 ms. Tighter conversational feel for LAN /
      // WireGuard / generally healthy connections; a slight reduction in
      // jitter robustness on bad networks (NetEq still adapts upward when
      // late packets arrive). The hint is unsupported in some Firefox
      // builds — assignment is wrapped to avoid runtime errors.
      // To revert: delete this block.
      try {
        const receiver = (track.publication.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver;
        if (receiver) {
          (receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint = 0.05;
        }
      } catch {
        // Non-fatal — playoutDelayHint is a hint, not required for correctness.
      }
    }
  });

  return (
    <div style={{ display: "none" }}>
      {/* [VAD-IMPROVEMENT-#9] CompressedAudioTrack replaces solid-livekit-components'
          AudioTrack for receive-side normalization. Wrapping in <Key> by the stable
          trackRefId ensures one component instance — and one AudioContext +
          DynamicsCompressorNode — per remote track. onCleanup runs on participant
          leave / track removal, tearing down the chain so nothing leaks. */}
      <Key each={filteredTracks()} by={(item) => getTrackReferenceId(item)}>
        {(track) => (
          <CompressedAudioTrack
            trackRef={track()}
            volume={
              state.voice.outputVolume *
              (track().publication.source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenshareVolume(track().participant.identity)
                : state.voice.getUserVolume(track().participant.identity))
            }
            muted={
              (track().publication.source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenshareMuted(track().participant.identity)
                : state.voice.getUserMuted(track().participant.identity)) ||
              voice.deafen()
            }
            outputDeviceId={state.voice.preferredAudioOutputDevice}
          />
        )}
      </Key>
    </div>
  );
}
