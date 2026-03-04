import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";

export default function Popout() {
  const params = new URLSearchParams(window.location.search);
  const livekitUrl = params.get("url")!;
  const token = params.get("token")!;
  const identity = params.get("identity")!;
  const trackSource = params.get("trackSource") || "screen_share";
  const username = params.get("username") || identity;

  const [volume, setVolume] = createSignal(1);
  const [muted, setMuted] = createSignal(false);
  const [connected, setConnected] = createSignal(false);

  let videoEl: HTMLVideoElement | undefined;
  let audioEl: HTMLAudioElement | undefined;
  let room: Room | undefined;

  const closeWindow = () => {
    room?.disconnect();
    window.close();
  };

  const attachTrack = (participant: RemoteParticipant) => {
    // Find screenshare video track
    for (const pub of participant.trackPublications.values()) {
      if (
        pub.source === Track.Source.ScreenShare &&
        pub.track &&
        pub.isSubscribed
      ) {
        pub.track.attach(videoEl!);
      }
      if (
        pub.source === Track.Source.ScreenShareAudio &&
        pub.track &&
        pub.isSubscribed
      ) {
        pub.track.attach(audioEl!);
        audioEl!.volume = volume();
        audioEl!.muted = muted();
      }
    }
  };

  onMount(async () => {
    room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (participant.identity !== identity) return;
      if (
        publication.source === Track.Source.ScreenShare &&
        videoEl
      ) {
        track.attach(videoEl);
      }
      if (
        publication.source === Track.Source.ScreenShareAudio &&
        audioEl
      ) {
        track.attach(audioEl);
        audioEl.volume = volume();
        audioEl.muted = muted();
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (participant.identity !== identity) return;
      track.detach();
      if (publication.source === Track.Source.ScreenShare) {
        // Screenshare ended, close window
        closeWindow();
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === identity) {
        closeWindow();
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      closeWindow();
    });

    try {
      await room.connect(livekitUrl, token, { autoSubscribe: false });
      setConnected(true);

      // Disable local mic/camera — this is a view-only window
      await room.localParticipant.setCameraEnabled(false);
      await room.localParticipant.setMicrophoneEnabled(false);

      // Find target participant and subscribe to their screenshare
      const target = room.getParticipantByIdentity(identity);
      if (target) {
        for (const pub of target.trackPublications.values()) {
          if (
            pub.source === Track.Source.ScreenShare ||
            pub.source === Track.Source.ScreenShareAudio
          ) {
            (pub as RemoteTrackPublication).setSubscribed(true);
          }
        }
        // Attach already-subscribed tracks
        setTimeout(() => attachTrack(target as RemoteParticipant), 500);
      } else {
        // Participant not found — they may have left
        closeWindow();
      }
    } catch (err) {
      console.error("[Popout] Failed to connect:", err);
      closeWindow();
    }
  });

  onCleanup(() => {
    room?.disconnect();
  });

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    if (audioEl) audioEl.volume = val;
  };

  const toggleMute = () => {
    const next = !muted();
    setMuted(next);
    if (audioEl) audioEl.muted = next;
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#000",
        overflow: "hidden",
        position: "relative",
        margin: "0",
      }}
    >
      <video
        ref={videoEl}
        autoplay
        muted
        style={{
          width: "100%",
          height: "100%",
          "object-fit": "contain",
          display: "block",
          "-webkit-app-region": "drag",
        }}
      />
      <audio ref={audioEl} autoplay />

      {/* Hover overlay with controls */}
      <div
        style={{
          position: "absolute",
          bottom: "0",
          left: "0",
          right: "0",
          padding: "12px 16px",
          background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
          display: "flex",
          "align-items": "center",
          gap: "12px",
          opacity: "0",
          transition: "opacity 0.2s",
          "-webkit-app-region": "no-drag",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
      >
        <span
          style={{
            color: "#fff",
            "font-size": "13px",
            "font-family": "sans-serif",
            "flex-shrink": "0",
            "max-width": "200px",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {username}
        </span>

        <button
          onClick={toggleMute}
          title={muted() ? "Unmute" : "Mute"}
          style={{
            background: "rgba(255,255,255,0.15)",
            border: "none",
            "border-radius": "6px",
            color: "#fff",
            cursor: "pointer",
            padding: "6px 10px",
            "font-size": "16px",
            "flex-shrink": "0",
            transition: "background 0.15s",
          }}
        >
          {muted() ? "\u{1F507}" : "\u{1F50A}"}
        </button>

        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume()}
          onInput={(e) => handleVolumeChange(parseFloat(e.currentTarget.value))}
          style={{
            flex: "1",
            cursor: "pointer",
            "accent-color": "#fff",
          }}
        />

        <span
          style={{
            color: "#fff",
            "font-size": "12px",
            "min-width": "36px",
            "text-align": "right",
            "font-family": "sans-serif",
          }}
        >
          {Math.round(volume() * 100)}%
        </span>

        <button
          onClick={closeWindow}
          title="Close"
          style={{
            background: "rgba(255,80,80,0.7)",
            border: "none",
            "border-radius": "6px",
            color: "#fff",
            cursor: "pointer",
            padding: "6px 10px",
            "font-size": "16px",
            "flex-shrink": "0",
            transition: "background 0.15s",
          }}
        >
          ✕
        </button>
      </div>

      {/* Always-visible drag hint at top */}
      <div
        style={{
          position: "absolute",
          top: "0",
          left: "0",
          right: "0",
          height: "32px",
          "-webkit-app-region": "drag",
        }}
      />
    </div>
  );
}
