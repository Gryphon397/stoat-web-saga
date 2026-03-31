import { For, JSX, Show, splitProps } from "solid-js";

import { useState } from "@revolt/state";
import {
  TrackLoop,
  useConnectionQuality,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTracks,
} from "solid-livekit-components";

import { ConnectionQuality, Track } from "livekit-client";
import { Channel, VoiceParticipant } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { InRoom } from "@revolt/rtc";

import { Avatar, Ripple, typography } from "../../design";
import { Row } from "../../layout";
import { Symbol } from "../../utils/Symbol";

import { VoiceStatefulUserIcons } from "./VoiceStatefulUserIcons";

/**
 * Render a preview of users (or the active participants) for a given channel
 *
 * Designed for the server sidebar to be below channels
 */
export function VoiceChannelPreview(props: { channel: Channel }) {
  return (
    <InRoom
      channelId={props.channel.id}
      fallback={<VariantPreview channel={props.channel} />}
    >
      {/* When in room, show live participants, but also fall back to preview if no tracks */}
      <VariantLive fallback={<VariantPreview channel={props.channel} />} />
    </InRoom>
  );
}

/**
 * Use API as the source of truth when connected
 */
function VariantLive(props: { fallback?: JSX.Element }) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );

  return (
    <Show when={tracks().length > 0} fallback={props.fallback}>
      <Base>
        <TrackLoop tracks={tracks}>{() => <ParticipantLive />}</TrackLoop>
      </Base>
    </Show>
  );
}

/**
 * Use API as the source of truth when not connected
 */
function VariantPreview(props: { channel: Channel }) {
  const participants = () => [...props.channel.voiceParticipants.values()];
  
  return (
    <Base>
      <For each={participants()}>
        {(participant) => <ParticipantPreview participant={participant} />}
      </For>
    </Base>
  );
}

/**
 * Live variant of participant
 */
function ParticipantLive() {
  const participant = useEnsureParticipant();

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isSpeaking = useIsSpeaking(participant);
  const quality = useConnectionQuality(participant);

  const screenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const isScreensharing = () =>
    screenShareTracks().some(
      (t) => t.participant.identity === participant.identity,
    );

  return (
    <CommonUser
      userId={participant.identity}
      speaking={isSpeaking()}
      muted={isMuted()}
      deafened={false}
      camera={false}
      screenshare={isScreensharing()}
      quality={quality()}
      isLive
    />
  );
}

/**
 * Preview variant of participant
 */
function ParticipantPreview(props: { participant: VoiceParticipant }) {
  return (
    <CommonUser
      userId={props.participant.userId}
      speaking={false}
      muted={!props.participant.isPublishing()}
      deafened={!props.participant.isReceiving()}
      camera={props.participant.isCamera()}
      screenshare={props.participant.isScreensharing()}
    />
  );
}

/**
 * Component used for both variants
 */
function qualityIcon(q: ConnectionQuality | undefined): { icon: string; color: string; label: string } | null {
  switch (q) {
    case ConnectionQuality.Excellent: return { icon: "signal_cellular_4_bar", color: "#4caf50", label: "Excellent connection" };
    case ConnectionQuality.Good:      return { icon: "signal_cellular_3_bar", color: "#8bc34a", label: "Good connection" };
    case ConnectionQuality.Poor:      return { icon: "network_check",         color: "#ff9800", label: "Poor connection" };
    case ConnectionQuality.Lost:      return { icon: "wifi_off",              color: "#f44336", label: "Connection lost" };
    default:                          return null;
  }
}

function CommonUser(props: {
  userId: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screenshare: boolean;
  quality?: ConnectionQuality;
  isLive?: boolean;
}) {
  const [iconProps, rest] = splitProps(props, [
    "muted",
    "deafened",
    "camera",
    "screenshare",
  ]);

  const user = useUser(() => rest.userId);
  const state = useState();
  const nameplateUrl = () => state.nameplates.getNameplateUrl(rest.userId);

  return (
    <Show when={user().user}>
      <div
        class={previewUser({ speaking: rest.speaking })}
        style={nameplateUrl() ? {
          "background-image": `url(${nameplateUrl()})`,
          "background-size": "100% 100%",
          "background-repeat": "no-repeat",
        } : {}}
        use:floating={{
          userCard: {
            user: user().user!,
            member: user().member,
          },
          contextMenu: () => (
            <UserContextMenu
              user={user().user!}
              member={user().member}
              inVoice={rest.isLive}
            />
          ),
        }}
      >
        <Ripple />
        <Avatar size={24} src={user().avatar} fallback={user().username} />{" "}
        <PreviewUsername>{user().username}</PreviewUsername>
        <Row gap="sm">
          <Show when={iconProps.screenshare}>
            <LiveBadge>LIVE</LiveBadge>
          </Show>
          <Show when={qualityIcon(rest.quality)}>
            {(_) => {
              const q = qualityIcon(rest.quality)!;
              return (
                <span title={q.label} style={{ color: q.color, display: "flex", "align-items": "center" }}>
                  <Symbol size={14}>{q.icon}</Symbol>
                </span>
              );
            }}
          </Show>
          <VoiceStatefulUserIcons {...iconProps} userId={rest.userId} />
        </Row>
      </div>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",

    marginBlock: "var(--gap-sm)",
    marginInlineStart: "var(--gap-xl)",
    marginInlineEnd: "var(--gap-md)",

    color: "var(--md-sys-color-outline)",

    borderRadius: "var(--borderRadius-md)",
  },
});

const previewUser = cva({
  base: {
    padding: "var(--gap-sm)",
    position: "relative", // ... <Ripple />
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    borderRadius: "var(--borderRadius-md)",
  },
  variants: {
    speaking: {
      true: {
        color: "var(--md-sys-color-on-surface)",

        "& svg": {
          outlineOffset: "1px",
          outline: "2px solid var(--md-sys-color-primary)",
          borderRadius: "var(--borderRadius-circle)",
        },
      },
    },
  },
});

const PreviewUsername = styled("span", {
  base: {
    ...typography.raw(),

    flexGrow: 1,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const LiveBadge = styled("span", {
  base: {
    background: "#e53935",
    color: "#ffffff",
    fontSize: "10px",
    fontWeight: "bold",
    padding: "1px 4px",
    borderRadius: "var(--borderRadius-sm)",
    letterSpacing: "0.5px",
    lineHeight: "1.4",
    flexShrink: 0,
  },
});
