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
        console.log("[Popout] Received track:", event.track.kind);
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
        const state = pc?.iceConnectionState;
        console.log("[Popout] ICE state:", state);
        if (state === "connected" || state === "completed") {
          setStatus("");
        } else if (state === "disconnected" || state === "failed") {
          setStatus("Connection lost");
          setTimeout(() => window.close(), 2000);
        }
      };

      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering with timeout
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
    <>
      <style>{`
        html, body { margin: 0; padding: 0; overflow: hidden; background: #000; }
        .popout-controls { opacity: 0; transition: opacity 0.2s; }
        .popout-container:hover .popout-controls { opacity: 1; }
        .popout-btn:hover { background: rgba(255,255,255,0.3) !important; }
      `}</style>
      <div
        class="popout-container"
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

        {/* Status overlay */}
        {status() && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              color: "#aaa",
              "font-family": "sans-serif",
              "font-size": "14px",
            }}
          >
            {status()}
          </div>
        )}

        {/* Bottom controls — hover to reveal */}
        <div
          class="popout-controls"
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
          }}
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
            class="popout-btn"
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
            onInput={(e) =>
              handleVolumeChange(parseFloat(e.currentTarget.value))
            }
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
        </div>
      </div>
    </>
  );
}
