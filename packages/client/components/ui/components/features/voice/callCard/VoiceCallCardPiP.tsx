import { createEffect, onCleanup } from "solid-js";

import { styled } from "styled-system/jsx";

import { Track } from "livekit-client";

import { useVoice } from "@revolt/rtc";

/**
 * Screenshare preview PiP — shows the local user's own screen share
 * so they can confirm what's being shared.
 */
export function VoiceCallCardPiP() {
  const voice = useVoice();
  let videoRef: HTMLVideoElement | undefined;

  createEffect(() => {
    const room = voice.room();
    if (!room || !videoRef) return;

    const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track;

    if (track?.mediaStreamTrack) {
      const stream = new MediaStream([track.mediaStreamTrack]);
      videoRef.srcObject = stream;
      videoRef.play().catch(() => {});
    }

    onCleanup(() => {
      if (videoRef) {
        videoRef.srcObject = null;
      }
    });
  });

  return (
    <Preview>
      <video
        ref={videoRef}
        muted
        style={{
          width: "100%",
          height: "100%",
          "object-fit": "contain",
          "border-radius": "var(--borderRadius-lg)",
          background: "#000",
          display: "block",
        }}
      />
      <Label>Your screen</Label>
    </Preview>
  );
}

const Preview = styled("div", {
  base: {
    pointerEvents: "all",
    width: "100%",
    height: "100%",
    position: "relative",
    borderRadius: "var(--borderRadius-lg)",
    overflow: "hidden",
    background: "#000",
    boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
});

const Label = styled("div", {
  base: {
    position: "absolute",
    bottom: "6px",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "11px",
    fontWeight: "600",
    color: "rgba(255,255,255,0.7)",
    background: "rgba(0,0,0,0.5)",
    padding: "2px 8px",
    borderRadius: "999px",
    pointerEvents: "none",
    userSelect: "none",
  },
});
