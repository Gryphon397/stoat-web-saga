import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import { ConnectionQuality } from "livekit-client";
import { styled } from "styled-system/jsx";

import { useClient, useUser } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { DecoratedAvatar, IconButton, UserStatus } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { UserMenu } from "../../../../../src/interface/navigation/servers/UserMenu";

/**
 * Discord-style persistent bottom panel.
 *
 * Rendered in Sidebar.tsx so it spans the full width of the sidebar area.
 *
 * Always visible:
 *   Avatar | Username | Mic | Deafen | Settings
 *
 * When in a voice channel (card above user panel):
 *   [signal bars] Voice Connected / Connecting…
 *   [channel name]
 *   [Camera] [Screenshare] [Noise]   [Disconnect]
 */
export function PersistentVoiceControls() {
  const voice = useVoice();
  const client = useClient();
  const user = useUser();
  const state = useState();
  const { openModal } = useModals();

  const [cardRef, setCardRef] = createSignal<HTMLDivElement>();

  const decorationUrl = () =>
    user() ? state.decorations.getDecorationUrl(user()!.id) : undefined;
  const nameplateUrl = () =>
    user() ? state.nameplates.getNameplateUrl(user()!.id) : undefined;

  // Track local participant's connection quality reactively
  const [quality, setQuality] = createSignal<ConnectionQuality>(
    ConnectionQuality.Unknown,
  );

  createEffect(() => {
    const room = voice.room();
    if (!room) {
      setQuality(ConnectionQuality.Unknown);
      return;
    }

    setQuality(room.localParticipant.connectionQuality);

    const onQualityChanged = (newQuality: ConnectionQuality) => {
      setQuality(newQuality);
    };

    room.localParticipant.on("connectionQualityChanged", onQualityChanged);
    onCleanup(() => {
      room.localParticipant.off("connectionQualityChanged", onQualityChanged);
    });
  });

  const qualityIcon = () => {
    switch (quality()) {
      case ConnectionQuality.Excellent:
        return "signal_wifi_4_bar";
      case ConnectionQuality.Good:
        return "signal_wifi_2_bar";
      case ConnectionQuality.Poor:
        return "signal_wifi_1_bar";
      case ConnectionQuality.Lost:
        return "wifi_off";
      default:
        return "signal_wifi_0_bar";
    }
  };

  const qualityColor = () => {
    switch (quality()) {
      case ConnectionQuality.Excellent:
        return "#4caf50";
      case ConnectionQuality.Good:
        return "#8bc34a";
      case ConnectionQuality.Poor:
        return "#ff9800";
      case ConnectionQuality.Lost:
        return "#f44336";
      default:
        return "var(--md-sys-color-outline)";
    }
  };

  const connectionLabel = () => {
    switch (voice.state()) {
      case "CONNECTED":
        return "Voice Connected";
      case "CONNECTING":
        return "Connecting…";
      case "RECONNECTING":
        return "Reconnecting…";
      default:
        return "Voice";
    }
  };

  return (
    <>
    <UserMenu anchor={cardRef} />
    <OuterContainer>
      {/* Voice connected card — only visible while in a call */}
      <Show when={voice.room()}>
        <VoiceCard>
          <VoiceCardTop>
            <VoiceCardStatus>
              <Symbol
                size={16}
                style={{ color: qualityColor() }}
              >
                {qualityIcon()}
              </Symbol>
              <VoiceCardTitle>{connectionLabel()}</VoiceCardTitle>
            </VoiceCardStatus>

            <IconButton
              size="sm"
              variant="_error"
              onPress={() => voice.disconnect()}
              use:floating={{
                tooltip: { placement: "top", content: "Disconnect" },
              }}
            >
              <Symbol>call_end</Symbol>
            </IconButton>
          </VoiceCardTop>

          <VoiceCardChannel>
            <Symbol size={12}>headset_mic</Symbol>
            {voice.channel()?.name ?? "Voice Channel"}
          </VoiceCardChannel>

          <VoiceCardActions>
            <IconButton
              size="sm"
              variant={voice.video() ? "filled" : "tonal"}
              onPress={() => voice.toggleCamera()}
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: voice.video() ? "Stop Camera" : "Start Camera",
                },
              }}
            >
              <Show
                when={voice.video()}
                fallback={<Symbol>videocam_off</Symbol>}
              >
                <Symbol>videocam</Symbol>
              </Show>
            </IconButton>

            <IconButton
              size="sm"
              variant={voice.screenshare() ? "filled" : "tonal"}
              onPress={() => voice.toggleScreenshare()}
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: voice.screenshare()
                    ? "Stop Sharing"
                    : "Share Screen",
                },
              }}
            >
              <Show
                when={voice.screenshare()}
                fallback={<Symbol>stop_screen_share</Symbol>}
              >
                <Symbol>screen_share</Symbol>
              </Show>
            </IconButton>

            <IconButton
              size="sm"
              variant={state.voice.noiseSupression ? "filled" : "tonal"}
              onPress={() => {
                state.voice.noiseSupression = !state.voice.noiseSupression;
              }}
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: state.voice.noiseSupression
                    ? "Disable Noise Suppression"
                    : "Enable Noise Suppression",
                },
              }}
            >
              <Show
                when={state.voice.noiseSupression}
                fallback={<Symbol>noise_control_off</Symbol>}
              >
                <Symbol>noise_aware</Symbol>
              </Show>
            </IconButton>
          </VoiceCardActions>
        </VoiceCard>
      </Show>

      {/* User panel — always visible */}
      <UserPanel
        style={
          nameplateUrl()
            ? {
                "background-image": `url(${nameplateUrl()})`,
                "background-size": "100% 100%",
                "background-repeat": "no-repeat",
              }
            : {}
        }
      >
        <UserInfo ref={setCardRef}>
          <DecoratedAvatar
            size={32}
            src={user()?.animatedAvatarURL}
            holepunch="bottom-right"
            overlay={<UserStatus.Graphic status={user()?.presence} />}
            interactive
            decorationUrl={decorationUrl()}
          />
          <UserDetails>
            <Username>{user()?.displayName}</Username>
            <Show
              when={user()?.status?.text}
              fallback={
                <StatusText>{user()?.presence}</StatusText>
              }
            >
              <StatusText>{user()!.status!.text}</StatusText>
            </Show>
          </UserDetails>
        </UserInfo>

        <UserControls>
          {/* Mic button — functional only while in a call */}
          <IconButton
            size="sm"
            variant={
              !voice.room()
                ? "standard"
                : voice.microphone()
                ? "filled"
                : "tonal"
            }
            onPress={() =>
              voice.room() && voice.speakingPermission && voice.toggleMute()
            }
            isDisabled={!voice.room() || !voice.speakingPermission}
            use:floating={{
              tooltip: !voice.room()
                ? { placement: "top", content: "Not in a call" }
                : !voice.speakingPermission
                ? { placement: "top", content: "Missing permission" }
                : {
                    placement: "top",
                    content: voice.microphone() ? "Mute" : "Unmute",
                  },
            }}
          >
            <Show
              when={voice.room() && !voice.microphone()}
              fallback={<Symbol>mic</Symbol>}
            >
              <Symbol>mic_off</Symbol>
            </Show>
          </IconButton>

          {/* Deafen button — functional only while in a call */}
          <IconButton
            size="sm"
            variant={
              !voice.room()
                ? "standard"
                : voice.deafen() || !voice.listenPermission
                ? "tonal"
                : "filled"
            }
            onPress={() =>
              voice.room() && voice.listenPermission && voice.toggleDeafen()
            }
            isDisabled={!voice.room() || !voice.listenPermission}
            use:floating={{
              tooltip: !voice.room()
                ? { placement: "top", content: "Not in a call" }
                : !voice.listenPermission
                ? { placement: "top", content: "Missing permission" }
                : {
                    placement: "top",
                    content: voice.deafen() ? "Undeafen" : "Deafen",
                  },
            }}
          >
            <Show
              when={
                voice.room() && (voice.deafen() || !voice.listenPermission)
              }
              fallback={<Symbol>headset</Symbol>}
            >
              <Symbol>headset_off</Symbol>
            </Show>
          </IconButton>

          {/* User settings */}
          <IconButton
            size="sm"
            variant="standard"
            onPress={() => openModal({ type: "settings", config: "user" })}
            use:floating={{
              tooltip: { placement: "top", content: "User Settings" },
            }}
          >
            <Symbol>settings</Symbol>
          </IconButton>
        </UserControls>
      </UserPanel>
    </OuterContainer>
    </>
  );
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** Full-width strip at the bottom of the sidebar; background covers the server rail */
const OuterContainer = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    background: "var(--md-sys-color-surface-container-low)",
  },
});

/* ── Voice Connected Card ───────────────────────────────────────────────── */

const VoiceCard = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container)",
  },
});

const VoiceCardTop = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const VoiceCardStatus = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const VoiceCardTitle = styled("span", {
  base: {
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
  },
});

const VoiceCardChannel = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",

    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const VoiceCardActions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-xs)",
    marginTop: "var(--gap-xs)",
  },
});

/* ── User Panel ─────────────────────────────────────────────────────────── */

const UserPanel = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    backgroundColor: "var(--md-sys-color-surface-container)",
    overflow: "hidden",
  },
});

const UserInfo = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minWidth: 0,
    cursor: "pointer",
    borderRadius: "var(--borderRadius-md)",
    padding: "var(--gap-xs)",
    transition: "background var(--transitions-fast)",
    "&:hover": {
      background: "color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)",
    },
  },
});

const UserDetails = styled("div", {
  base: {
    minWidth: 0,
    flexGrow: 1,
  },
});

const StatusText = styled("span", {
  base: {
    display: "block",
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const Username = styled("span", {
  base: {
    display: "block",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const UserControls = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-xs)",
    flexShrink: 0,
  },
});
