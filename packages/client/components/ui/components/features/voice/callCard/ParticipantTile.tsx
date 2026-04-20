import { createSignal, Show } from "solid-js";
import {
  TrackReference,
  TrackReferenceOrPlaceholder,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Slider } from "@revolt/ui";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

type TileProps = {
  focus?: boolean;
};

export function ParticipantTile(props: TileProps) {
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participant.identity);

  let videoRef: HTMLVideoElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isScreenShareMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isVideo = () => !isVideoMuted();
  const isScreenShare = () => track.source === Track.Source.ScreenShare;
  const isSpeaking = useIsSpeaking(participant);

  const getHeight = () => {
    if (!props.focus || videoDims().height == 0) return {};
    const ratio = videoDims().width / videoDims().height;
    return ratio > 1
      ? { height: `min(var(--vc-w) / ${ratio}, 100%)` }
      : { height: "100%" };
  };

  const popOut = async (e: MouseEvent) => {
    e.stopPropagation();

    if (window.stoatPopout) {
      const room = voice.room();
      if (!room) return;

      const target = room.getParticipantByIdentity(participant.identity);
      if (!target) return;

      const videoMST = target.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
      if (!videoMST || videoMST.readyState !== "live") return;
      const audioMST = target.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;

      const videoClone = videoMST.clone();
      const audioClone = audioMST?.clone() ?? null;
      const relayStream = new MediaStream([videoClone, ...(audioClone ? [audioClone] : [])]);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      for (const t of relayStream.getTracks()) {
        pc.addTrack(t, relayStream);
      }

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
        } catch (err) {
          console.error("[popOut] Failed to set answer:", err);
        }
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        pc.close();
        cleanupAnswer();
        cleanupClosed();
        videoMST.removeEventListener("ended", onEnded);
        videoClone.stop();
        if (audioClone) audioClone.stop();
      };

      const cleanupClosed = window.stoatPopout.onPopoutClosed((closedIdentity) => {
        if (closedIdentity === participant.identity) cleanup();
      });

      const onEnded = () => {
        cleanup();
        window.stoatPopout?.close(participant.identity);
      };
      videoMST.addEventListener("ended", onEnded);

      window.stoatPopout.open({
        identity: participant.identity,
        username: user().username ?? participant.identity,
        offerSdp,
      });
      return;
    }

    const mediaStreamTrack = (track as any)?.publication?.track?.mediaStreamTrack as MediaStreamTrack | undefined;
    if (!mediaStreamTrack) return;
    const stream = new MediaStream([mediaStreamTrack]);

    const openDocumentPiP = async () => {
      const pipWindow = await (window as any).documentPictureInPicture.requestWindow({
        width: 854,
        height: 480,
      });
      const doc = pipWindow.document;
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

  return (
    <div
      class={
        tile({
          speaking: !isScreenShare() && isSpeaking(),
          video: isVideo() || isScreenShare(),
          fullscreen: voice.fullscreen(),
          ...props,
        }) + (isScreenShare() ? " vc_tile group" : " vc_tile")
      }
      onClick={() => !isScreenShare() && voice.toggleFocus(track)}
      use:floating={
        isScreenShare()
          ? undefined
          : {
              contextMenu: () => (
                <UserContextMenu
                  user={user().user!}
                  member={user().member}
                  inVoice
                />
              ),
            }
      }
      style={{ ...getHeight() }}
    >
      <Show
        when={isVideo() || isScreenShare()}
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
        <VideoTrack
          style={{
            "grid-area": "1/1",
            "object-fit": "contain",
            width: "100%",
            height: "100%",
            overflow: "hidden",
          }}
          trackRef={track as TrackReference}
          manageSubscription={true}
          ref={videoRef}
          on:resize={() => {
            setVideoDims({
              height: videoRef?.videoHeight || 0,
              width: videoRef?.videoWidth || 0,
            });
          }}
        />
      </Show>

      <Show when={isScreenShare()} fallback={
        <Overlay>
          <OverlayInner>
            <OverflowingText>{user().username}</OverflowingText>
            <Row gap="md">
              <VoiceStatefulUserIcons
                userId={participant.identity}
                muted={isMuted()}
                camera={isVideo()}
              />
            </Row>
          </OverlayInner>
        </Overlay>
      }>
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
              <Show when={isScreenShareMuted()}>
                <Symbol size={18}>no_sound</Symbol>
              </Show>
              <OverlayIconButton title="Pop out" onClick={popOut}>
                <Symbol size={18}>picture_in_picture_alt</Symbol>
              </OverlayIconButton>
            </OverlayInner>
          </div>
        </Overlay>
      </Show>
    </div>
  );
}

export const tile = cva({
  base: {
    display: "grid",
    aspectRatio: "16/9",
    transition: "all .3s ease, width 0s, height 0s",
    borderRadius: "var(--borderRadius-lg)",
    width: "var(--vc-tile-width)",
    maxWidth: "calc(var(--vc-h) * 16 / 9)",
    cursor: "pointer",

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
    focus: {
      true: {
        width: "auto",
        maxWidth: "none",
      },
    },
    video: {
      true: {},
    },
    fullscreen: {
      true: {
        minWidth: "20%",
      },
    },
  },
  compoundVariants: [
    {
      video: [false],
      focus: [true],
      css: {
        height: "100%",
        maxHeight: "calc(var(--vc-w) * 9 / 16)",
      },
    },
    {
      video: [true],
      focus: [true],
      css: {
        aspectRatio: "auto",
      },
    },
  ],
});

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",

    "& > *": {
      width: "auto !important",
      height: "30% !important",
      minHeight: "48px",
    },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",

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
    width: "100%",

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
