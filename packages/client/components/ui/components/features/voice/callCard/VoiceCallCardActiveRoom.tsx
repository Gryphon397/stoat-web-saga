import { createEffect, Match, Show, Switch } from "solid-js";
import {
  isTrackReference,
  TrackLoop,
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useMaybeTrackRefContext,
  useTrackRefContext,
  useTracks,
  VideoTrack,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { InRoom, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Slider } from "@revolt/ui";
import { Avatar } from "@revolt/ui/components/design";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom() {
  return (
    <View>
      <Call>
        <InRoom>
          <Participants />
        </InRoom>
      </Call>

      <VoiceCallCardStatus />
      {/* Voice controls moved to sidebar - Discord-like UI */}
      {/* <VoiceCallCardActions size="sm" /> */}
    </View>
  );
}

const View = styled("div", {
  base: {
    minHeight: 0,
    height: "100%",
    width: "100%",

    gap: "var(--gap-md)",
    padding: "var(--gap-md)",

    display: "flex",
    flexDirection: "column",
  },
});

const Call = styled("div", {
  base: {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
  },
});

/**
 * Show a grid of participants
 */
function Participants() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  return (
    <Grid>
      <TrackLoop tracks={tracks}>{() => <ParticipantTile />}</TrackLoop>
      {/* <div class={tile()} />
      <div class={tile()} />
      <div class={tile()} />
      <div class={tile()} />
      <div class={tile()} /> */}
    </Grid>
  );
}

const Grid = styled("div", {
  base: {
    height: "100%",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignContent: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    overflow: "hidden",
  },
});

/**
 * Individual participant tile
 */
function ParticipantTile() {
  const track = useTrackRefContext();

  return (
    <Switch fallback={<UserTile />}>
      <Match when={track.source === Track.Source.ScreenShare}>
        <ScreenshareTile />
      </Match>
    </Switch>
  );
}

/**
 * Shown when the track source is a camera or placeholder
 */
function UserTile() {
  const participant = useEnsureParticipant();
  const track = useMaybeTrackRefContext();

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isSpeaking = useIsSpeaking(participant);

  const user = useUser(participant.identity);

  let videoRef: HTMLDivElement | undefined;

  function toggleFullscreen() {
    if (!videoRef || !isTrackReference(track) || isVideoMuted()) return;
    if (!document.fullscreenElement) {
      videoRef.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  createEffect(() => {
    if (isVideoMuted() && document.fullscreenElement) {
      document.exitFullscreen();
    }
  });

  return (
    <div
      ref={videoRef}
      class={tile({
        speaking: isSpeaking(),
      })}
      onClick={toggleFullscreen}
      style={{ cursor: "pointer" }}
      use:floating={{
        userCard: {
          user: user().user!,
          member: user().member,
        },
        contextMenu: () => (
          <UserContextMenu user={user().user!} member={user().member} inVoice />
        ),
      }}
    >
      <Switch
        fallback={
          <AvatarOnly>
            <Avatar
              src={user().avatar}
              fallback={user().username}
              size={48}
              interactive={false}
            />
          </AvatarOnly>
        }
      >
        <Match when={isTrackReference(track) && !isVideoMuted()}>
          <VideoTrack
            style={{
              "grid-area": "1/1",
              "object-fit": "contain",
              width: "100%",
              height: "100%",
            }}
            trackRef={track as TrackReference}
            manageSubscription={true}
          />
        </Match>
      </Switch>

      <Overlay>
        <OverlayInner>
          <OverflowingText>{user().username}</OverflowingText>
          <VoiceStatefulUserIcons
            userId={participant.identity}
            muted={isMuted()}
          />
          <Show when={isTrackReference(track) && !isVideoMuted()}>
            <Symbol size={18}>fullscreen</Symbol>
          </Show>
        </OverlayInner>
      </Overlay>
    </div>
  );
}

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
  },
});

/**
 * Shown when the track source is a screenshare
 */
function ScreenshareTile() {
  const participant = useEnsureParticipant();
  const track = useMaybeTrackRefContext();
  const user = useUser(participant.identity);
  const state = useState();
  const voice = useVoice();

  const popOut = async (e: MouseEvent) => {
    e.stopPropagation();

    // Electron pop-out: relay screenshare via captureStream + local WebRTC
    if (window.stoatPopout) {
      const room = voice.room();
      if (!room) return;

      const target = room.getParticipantByIdentity(participant.identity);
      if (!target) return;

      const videoMST = target.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
      if (!videoMST || videoMST.readyState !== "live") return;
      const audioMST = target.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;

      // Render remote tracks in a hidden <video> and use captureStream() to
      // produce a fresh local stream.  Directly re-sending a remote WebRTC
      // track through a second PeerConnection silently drops frames in some
      // Chromium builds; captureStream() avoids that entirely.
      const tempVideo = document.createElement("video");
      const src = new MediaStream([videoMST]);
      if (audioMST) src.addTrack(audioMST);
      tempVideo.srcObject = src;
      tempVideo.volume = 0;
      tempVideo.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:-9999;";
      document.body.appendChild(tempVideo);
      await tempVideo.play();

      const relayStream: MediaStream = (tempVideo as any).captureStream();
      console.log("[popOut] captureStream tracks:", relayStream.getTracks().map(t => t.kind));

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      for (const t of relayStream.getTracks()) {
        pc.addTrack(t, relayStream);
      }

      pc.oniceconnectionstatechange = () => {
        console.log("[popOut] ICE state:", pc.iceConnectionState);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        const timeout = setTimeout(resolve, 5000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const offerSdp = pc.localDescription!.sdp;

      const cleanupAnswer = window.stoatPopout.onAnswer(async (identity, answerSdp) => {
        if (identity !== participant.identity) return;
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
          console.log("[popOut] WebRTC connection established");
        } catch (err) {
          console.error("[popOut] Failed to set answer:", err);
        }
      });

      const cleanup = () => {
        pc.close();
        cleanupAnswer();
        cleanupClosed();
        for (const t of relayStream.getTracks()) t.stop();
        tempVideo.srcObject = null;
        tempVideo.remove();
      };

      const cleanupClosed = window.stoatPopout.onPopoutClosed((closedIdentity) => {
        if (closedIdentity === participant.identity) cleanup();
      });

      videoMST.addEventListener("ended", () => {
        cleanup();
        window.stoatPopout?.close(participant.identity);
      });

      window.stoatPopout.open({
        identity: participant.identity,
        username: user().username ?? participant.identity,
        offerSdp,
      });
      return;
    }

    // Web fallback: documentPiP or standard PiP
    const mediaStreamTrack = (track as any)?.publication?.track?.mediaStreamTrack as MediaStreamTrack | undefined;
    if (!mediaStreamTrack) return;
    const stream = new MediaStream([mediaStreamTrack]);

    const openDocumentPiP = async () => {
      const pipWindow = await (window as any).documentPictureInPicture.requestWindow({
        width: 854,
        height: 480,
      });

      const doc = pipWindow.document;

      // Inject hover styles
      const style = doc.createElement("style");
      style.textContent = "button:hover{background:rgba(255,255,255,0.3)!important;}body{margin:0;}";
      doc.head.appendChild(style);

      doc.body.style.cssText = "background:#000;width:100vw;height:100vh;overflow:hidden;position:relative;";

      const pipVideo = doc.createElement("video") as HTMLVideoElement;
      pipVideo.srcObject = stream;
      pipVideo.autoplay = true;
      pipVideo.muted = true;
      pipVideo.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
      doc.body.appendChild(pipVideo);

      const controls = doc.createElement("div");
      controls.style.cssText = "position:absolute;bottom:0;left:0;right:0;padding:12px 16px;background:linear-gradient(transparent,rgba(0,0,0,0.75));display:flex;align-items:center;gap:12px;";

      const muteBtn = doc.createElement("button");
      muteBtn.style.cssText = "background:rgba(255,255,255,0.15);border:none;border-radius:6px;color:#fff;cursor:pointer;padding:6px 10px;font-size:18px;flex-shrink:0;transition:background 0.15s;";

      const slider = doc.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "3";
      slider.step = "0.1";
      slider.style.cssText = "flex:1;cursor:pointer;accent-color:#fff;";

      const label = doc.createElement("span");
      label.style.cssText = "color:#fff;font-size:12px;min-width:36px;text-align:right;font-family:sans-serif;";

      const syncControls = () => {
        const muted = state.voice.getScreenshareMuted(participant.identity);
        const vol = state.voice.getScreenshareVolume(participant.identity);
        muteBtn.textContent = muted ? "\u{1F507}" : "\u{1F50A}";
        muteBtn.title = muted ? "Unmute" : "Mute";
        slider.value = String(vol);
        label.textContent = Math.round(vol * 100) + "%";
      };

      muteBtn.onclick = () => {
        state.voice.setScreenshareMuted(participant.identity, !state.voice.getScreenshareMuted(participant.identity));
        syncControls();
      };

      slider.oninput = () => {
        const vol = parseFloat(slider.value);
        state.voice.setScreenshareVolume(participant.identity, vol);
        label.textContent = Math.round(vol * 100) + "%";
      };

      syncControls();
      controls.appendChild(muteBtn);
      controls.appendChild(slider);
      controls.appendChild(label);
      doc.body.appendChild(controls);

      const syncInterval = setInterval(syncControls, 500);
      pipWindow.addEventListener("pagehide", () => {
        clearInterval(syncInterval);
        pipVideo.srcObject = null;
      });
    };

    const openStandardPiP = async () => {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      const tempVideo = document.createElement("video") as HTMLVideoElement;
      tempVideo.srcObject = stream;
      tempVideo.muted = true;
      tempVideo.style.cssText = "position:fixed;bottom:0;right:0;width:1px;height:1px;pointer-events:none;opacity:0;";
      document.body.appendChild(tempVideo);
      await tempVideo.play();
      await tempVideo.requestPictureInPicture();
      tempVideo.addEventListener("leavepictureinpicture", () => {
        document.body.removeChild(tempVideo);
        tempVideo.srcObject = null;
      });
    };

    if ("documentPictureInPicture" in window) {
      try {
        await openDocumentPiP();
        return;
      } catch (err) {
        console.warn("[popOut] documentPiP failed:", err);
      }
    }
    try {
      await openStandardPiP();
    } catch (err2) {
      console.error("[popOut] Standard PiP failed:", err2);
    }
  };

  let videoRef: HTMLDivElement | undefined;

  const toggleFullscreen = () => {
    if (!videoRef) return;
    if (!isTrackReference(track)) return;
    if (!document.fullscreenElement) {
      videoRef.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div
      ref={videoRef}
      class={tile() + " group"}
      onClick={toggleFullscreen}
      style={{ cursor: "pointer" }}
    >
      <VideoTrack
        style={{
          "grid-area": "1/1",
          "object-fit": "contain",
          width: "100%",
          height: "100%",
        }}
        trackRef={track as TrackReference}
        manageSubscription={true}
      />

      <Overlay showOnHover>
        <div style={{ display: "flex", "flex-direction": "column", width: "100%", gap: "var(--gap-sm)" }}>
          <div
            style={{ display: "flex", "align-items": "center", gap: "var(--gap-sm)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <Symbol size={16}>volume_up</Symbol>
            <Slider
              min={0}
              max={3}
              step={0.1}
              value={state.voice.getScreenshareVolume(participant.identity)}
              onInput={(e) =>
                state.voice.setScreenshareVolume(
                  participant.identity,
                  e.currentTarget.value,
                )
              }
              labelFormatter={(v) => (v * 100).toFixed(0) + "%"}
            />
          </div>
          <OverlayInner>
            <OverflowingText>{user().username}</OverflowingText>
            <OverlayIconButton
              title={state.voice.getScreenshareMuted(participant.identity) ? "Unmute screenshare audio" : "Mute screenshare audio"}
              onClick={(e) => {
                e.stopPropagation();
                state.voice.setScreenshareMuted(
                  participant.identity,
                  !state.voice.getScreenshareMuted(participant.identity),
                );
              }}
            >
              <Show
                when={state.voice.getScreenshareMuted(participant.identity)}
                fallback={<Symbol size={18}>volume_up</Symbol>}
              >
                <Symbol size={18}>volume_off</Symbol>
              </Show>
            </OverlayIconButton>
            <OverlayIconButton
              title="Pop out"
              onClick={popOut}
            >
              <Symbol size={18}>picture_in_picture_alt</Symbol>
            </OverlayIconButton>
            <Symbol size={18}>fullscreen</Symbol>
          </OverlayInner>
        </div>
      </Overlay>
    </div>
  );
}

const tile = cva({
  base: {
    flex: "1 1 240px",
    maxWidth: "100%",
    height: "100%",
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    gridTemplateColumns: "minmax(0, 1fr)",
    transition: ".3s ease all",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface)",
    background: "#0002",

    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",
  },
  variants: {
    speaking: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
      },
    },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",
    zIndex: 1,

    padding: "var(--gap-md) var(--gap-lg)",

    opacity: 1,
    display: "flex",
    alignItems: "end",
    flexDirection: "row",

    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,

        _groupHover: {
          opacity: 1,
        },
      },
      false: {
        opacity: 1,
      },
    },
  },
  defaultVariants: {
    showOnHover: false,
  },
});

const OverlayInner = styled("div", {
  base: {
    minWidth: 0,

    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    _first: {
      flexGrow: 1,
    },
  },
});

const OverlayIconButton = styled("button", {
  base: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "inherit",
    display: "flex",
    padding: "2px",
    borderRadius: "var(--borderRadius-sm)",
    transition: "background var(--transitions-fast)",
    _hover: {
      background: "rgba(255,255,255,0.15)",
    },
  },
});
