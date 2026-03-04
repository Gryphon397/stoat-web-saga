import { createSignal, onCleanup, onMount } from "solid-js";

export default function Popout() {
  const params = new URLSearchParams(window.location.search);
  const identity = params.get("identity") || "unknown";
  const username = params.get("username") || identity;

  const [volume, setVolume] = createSignal(1);
  const [muted, setMuted] = createSignal(false);
  const [status, setStatus] = createSignal("Connecting...");

  let videoEl: HTMLVideoElement | undefined;
  let audioEl: HTMLAudioElement | undefined;
  let pc: RTCPeerConnection | undefined;

  onMount(async () => {
    try {
      if (!window.stoatPopout) {
        setStatus("Error: not running in Electron");
        return;
      }

      const offerSdp = await window.stoatPopout.getOffer(identity);
      if (!offerSdp) {
        setStatus("Error: no offer received");
        return;
      }

      setStatus("Setting up connection...");
      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      pc.ontrack = (event) => {
        console.log("[Popout] Received track:", event.track.kind, event.track.readyState);
        if (event.track.kind === "video" && videoEl) {
          videoEl.srcObject = new MediaStream([event.track]);
          videoEl.play().catch(() => {});
        }
        if (event.track.kind === "audio" && audioEl) {
          audioEl.srcObject = new MediaStream([event.track]);
          audioEl.volume = volume();
          audioEl.muted = muted();
          audioEl.play().catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc?.iceConnectionState;
        console.log("[Popout] ICE state:", s);
        if (s === "connected" || s === "completed") {
          setStatus("");
        } else if (s === "disconnected" || s === "failed") {
          setStatus("Connection lost");
          setTimeout(() => window.close(), 2000);
        }
      };

      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await new Promise<void>((resolve) => {
        if (pc!.iceGatheringState === "complete") { resolve(); return; }
        const timeout = setTimeout(resolve, 5000);
        pc!.addEventListener("icegatheringstatechange", () => {
          if (pc!.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const fullAnswer = pc.localDescription!.sdp;
      await window.stoatPopout.sendAnswer(identity, fullAnswer);
      console.log("[Popout] Answer sent, waiting for media...");
    } catch (err) {
      console.error("[Popout] Setup failed:", err);
      setStatus("Error: " + (err as Error).message);
    }
  });

  onCleanup(() => {
    pc?.close();
  });

  const handleVolume = (val: number) => {
    setVolume(val);
    if (audioEl) audioEl.volume = val;
  };

  const toggleMute = () => {
    const next = !muted();
    setMuted(next);
    if (audioEl) audioEl.muted = next;
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
