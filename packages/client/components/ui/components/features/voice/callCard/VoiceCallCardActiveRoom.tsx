import { Match, Show, Switch } from "solid-js";
import {
  TrackLoop,
  TrackReference,
  VideoTrack,
  isTrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useMaybeTrackRefContext,
  useTrackRefContext,
  useTracks,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { InRoom } from "@revolt/rtc";
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

  const isSpeaking = useIsSpeaking(participant);

  const user = useUser(participant.identity);

  let videoRef: HTMLDivElement | undefined;

  const toggleFullscreen = () => {
    if (!videoRef) return;
    if (!document.fullscreenElement) {
      videoRef.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

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
        <Match when={isTrackReference(track)}>
          <VideoTrack
            style={{ "grid-area": "1/1", "object-fit": "contain", width: "100%", height: "100%" }}
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
          <Show when={isTrackReference(track)}>
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

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  let videoRef: HTMLDivElement | undefined;

  const toggleFullscreen = () => {
    if (!videoRef) return;
    if (!document.fullscreenElement) {
      videoRef.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div ref={videoRef} class={tile() + " group"} onClick={toggleFullscreen} style={{ cursor: "pointer" }}>
      <VideoTrack
        style={{ "grid-area": "1/1", "object-fit": "contain", width: "100%", height: "100%" }}
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
            <Show when={isMuted()}>
              <Symbol size={18}>no_sound</Symbol>
            </Show>
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
