import { createSignal, onCleanup, onMount } from "solid-js";
import { Room, RoomEvent, Track } from "livekit-client";

export default function Popout() {
  const params = new URLSearchParams(window.location.search);
  const identity = params.get("identity") || "unknown";
  const username = params.get("username") || identity;
  const livekitUrl = params.get("livekitUrl") || "";
  const viewerToken = params.get("viewerToken") || "";

  const rawVolume = parseFloat(params.get("volume") || "1");
  const [volume, setVolume] = createSignal(isNaN(rawVolume) ? 1 : Math.min(1, Math.max(0, rawVolume)));
  const [muted, setMuted] = createSignal(false);
  const [status, setStatus] = createSignal("Connecting...");

  let videoEl: HTMLVideoElement | undefined;
  let audioEl: HTMLAudioElement | undefined;
  let room: Room | undefined;

  onMount(async () => {
    if (!livekitUrl || !viewerToken) {
      setStatus("Error: missing connection parameters");
      return;
    }

    room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (participant.identity !== identity) return;

      if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare && videoEl) {
        track.attach(videoEl);
        setStatus("");
      }
      if (track.kind === Track.Kind.Audio && track.source === Track.Source.ScreenShareAudio && audioEl) {
        track.attach(audioEl);
        audioEl.volume = muted() ? 0 : volume();
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      if (participant.identity !== identity) return;
      track.detach();
      if (track.source === Track.Source.ScreenShare) {
        setStatus("Stream ended");
        setTimeout(() => window.close(), 2000);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === identity) {
        setStatus("Presenter left");
        setTimeout(() => window.close(), 2000);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      setStatus("Disconnected");
    });

    try {
      await room.connect(livekitUrl, viewerToken, { autoSubscribe: true });

      // Subscribe to any already-published screenshare tracks from this participant
      const target = room.getParticipantByIdentity(identity);
      if (target) {
        for (const pub of target.trackPublications.values()) {
          if (
            (pub.source === Track.Source.ScreenShare ||
              pub.source === Track.Source.ScreenShareAudio) &&
            !pub.isSubscribed
          ) {
            pub.setSubscribed(true);
          }
        }
      }
    } catch (err) {
      console.error("[Popout] LiveKit connect failed:", err);
      setStatus("Error: " + (err as Error).message);
    }
  });

  onCleanup(() => {
    room?.disconnect();
  });

  const handleVolume = (val: number) => {
    setVolume(val);
    if (audioEl && !muted()) audioEl.volume = val;
  };

  const toggleMute = () => {
    const next = !muted();
    setMuted(next);
    if (audioEl) audioEl.volume = next ? 0 : volume();
  };

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; overflow: hidden; background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .vol-bar { opacity: 0; transition: opacity 0.2s; }
        .popout-root:hover .vol-bar { opacity: 1; }
        .vol-btn:hover { background: rgba(255,255,255,0.3) !important; }
      `}</style>
      <div
        class="popout-root"
        style={{
          width: "100vw",
          height: "100vh",
          background: "#000",
          overflow: "hidden",
          position: "relative",
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
          }}
        />
        <audio ref={audioEl} autoplay />

        {status() && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              color: "#aaa",
              "font-size": "14px",
            }}
          >
            {status()}
          </div>
        )}

        {/* Username — bottom left */}
        <div
          class="vol-bar"
          style={{
            position: "absolute",
            bottom: "8px",
            left: "12px",
            color: "#fff",
            "font-size": "13px",
            "text-shadow": "0 1px 4px rgba(0,0,0,0.8)",
            "max-width": "40%",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
        >
          {username}
        </div>

        {/* Volume control — bottom right */}
        <div
          class="vol-bar"
          style={{
            position: "absolute",
            bottom: "8px",
            right: "12px",
            display: "flex",
            "align-items": "center",
            gap: "6px",
            background: "rgba(0,0,0,0.65)",
            "border-radius": "6px",
            padding: "4px 8px",
          }}
        >
          <button
            class="vol-btn"
            onClick={toggleMute}
            title={muted() ? "Unmute" : "Mute"}
            style={{
              background: "none",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              padding: "2px 4px",
              "font-size": "16px",
              "line-height": "1",
              "border-radius": "4px",
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
            onInput={(e) => handleVolume(parseFloat(e.currentTarget.value))}
            style={{ width: "90px", cursor: "pointer", "accent-color": "#fff" }}
          />
          <span style={{ color: "#fff", "font-size": "11px", "min-width": "30px", "text-align": "right" }}>
            {Math.round(volume() * 100)}%
          </span>
        </div>
      </div>
    </>
  );
}
