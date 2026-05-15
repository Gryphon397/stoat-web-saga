import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { ConnectionQuality } from "livekit-client";
import { styled } from "styled-system/jsx";

import { useClient, useUser } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { DecoratedAvatar, IconButton, UserStatus } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { UserMenu } from "../../../../../src/interface/navigation/servers/UserMenu";

// =============================================================================
// Personal Plex jukebox — shown in sidebar when not in a voice call
// =============================================================================

const PLEX_PROXY_URL = (import.meta.env.VITE_PLEX_PROXY_URL as string) ?? "";

type PersonalJukeboxState = {
  trackKey?: string;
  trackTitle?: string;
  trackArtist?: string;
  thumbUrl?: string;
  trackFormat?: string;
  duration?: number;
  position?: number;
  playing?: boolean;
  updatedAt?: number;
  currentTrack?: PersonalPlexTrack;
  queue?: PersonalPlexTrack[];
  history?: PersonalPlexTrack[];
};

type PersonalPlexTrack = {
  key: string;
  title: string;
  grandparentTitle?: string;
  parentTitle?: string;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  duration?: number;
  ratingKey?: string;
  Media?: Array<{ audioCodec?: string; bitrate?: number; Part: Array<{ key: string }> }>;
};

function PersonalPlexCard(props: { userId: string }) {
  const channelKey = `personal:${props.userId}`;
  const jbUrl = (path: string) =>
    `${PLEX_PROXY_URL}${path}?channel=${encodeURIComponent(channelKey)}`;

  const [view, setView] = createSignal<"player" | "search">("player");
  const [jukebox, setJukebox] = createSignal<PersonalJukeboxState>({});
  const [tick, setTick] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<PersonalPlexTrack[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [volume, setVolume] = createSignal(0.5);

  let audioRef: HTMLAudioElement | undefined;
  let currentStreamKey = "";
  let _latestSentAt = 0;
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const voice = useVoice();

  const isPlaying = createMemo(() => jukebox().playing ?? false);

  createEffect(() => { if (audioRef) audioRef.volume = volume() * volume(); });
  createEffect(() => { if (audioRef) audioRef.muted = voice?.deafen() ?? false; });

  createEffect(() => {
    if (!isPlaying()) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  createEffect(() => {
    if (view() === "search") setTimeout(() => searchInputRef?.focus(), 50);
  });

  onMount(async () => {
    try {
      const r = await fetch(jbUrl("/jukebox/state"));
      if (r.ok) {
        const state: PersonalJukeboxState | null = await r.json();
        if (state) { setJukebox(state); syncAudio(state); }
      }
    } catch {}
    if (audioRef) {
      audioRef.onended = async () => {
        const current = jukebox();
        const [next, ...remaining] = current.queue ?? [];
        if (next) {
          const update = buildTrackUpdate(next);
          if (update.trackKey) {
            await updateJukebox({ ...update, currentTrack: next, queue: remaining, history: pushHistory(current) });
          }
        } else {
          updateJukebox({ playing: false, position: 0 });
        }
      };
    }
  });

  onMount(() => {
    const es = new EventSource(jbUrl("/jukebox/events"));
    es.onmessage = (e) => {
      const state: PersonalJukeboxState = JSON.parse(e.data);
      if (state.updatedAt != null && state.updatedAt < _latestSentAt) return;
      setJukebox(state);
      syncAudio(state);
    };
    onCleanup(() => es.close());
  });

  function syncAudio(state: PersonalJukeboxState) {
    if (!audioRef || !state.trackKey) return;
    const streamUrl = `${PLEX_PROXY_URL}/plex/stream${state.trackKey}`;
    if (currentStreamKey !== state.trackKey) {
      currentStreamKey = state.trackKey;
      audioRef.src = streamUrl;
    }
    if (state.playing && state.position != null && state.updatedAt) {
      const targetSec = (Date.now() - state.updatedAt + state.position) / 1000;
      if (Math.abs(audioRef.currentTime - targetSec) > 2) audioRef.currentTime = targetSec;
      audioRef.play().catch(() => {});
    } else if (!state.playing) {
      audioRef.pause();
      if (state.position != null) audioRef.currentTime = state.position / 1000;
    }
  }

  async function updateJukebox(patch: Partial<PersonalJukeboxState>) {
    if (patch.updatedAt != null) _latestSentAt = patch.updatedAt;
    else _latestSentAt = Math.max(_latestSentAt, Date.now());
    const nextState = { ...jukebox(), ...patch } as PersonalJukeboxState;
    setJukebox(nextState);
    syncAudio(nextState);
    await fetch(jbUrl("/jukebox/update"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  function buildTrackUpdate(track: PersonalPlexTrack): Partial<PersonalJukeboxState> {
    const media = track.Media?.[0];
    const partKey = media?.Part?.[0]?.key;
    if (!partKey) return {};
    const codec = media?.audioCodec?.toUpperCase();
    const bitrate = media?.bitrate;
    return {
      trackKey: partKey,
      trackTitle: track.title,
      trackArtist: track.grandparentTitle,
      thumbUrl: track.parentThumb ?? track.thumb ?? track.grandparentThumb,
      trackFormat: codec ? (bitrate ? `${codec} · ${Math.round(bitrate)} kbps` : codec) : undefined,
      duration: track.duration,
      position: 0,
      playing: true,
      updatedAt: Date.now(),
    };
  }

  function pushHistory(current: PersonalJukeboxState): PersonalPlexTrack[] {
    if (!current.currentTrack) return current.history ?? [];
    return [...(current.history ?? []), current.currentTrack].slice(-50);
  }

  const currentPosition = createMemo(() => {
    tick();
    const j = jukebox();
    if (j.position == null || !j.updatedAt) return 0;
    const pos = j.playing
      ? (Date.now() - j.updatedAt + j.position) / 1000
      : j.position / 1000;
    return Math.min(pos, (j.duration ?? 0) / 1000);
  });

  const dur = () => (jukebox().duration ?? 0) / 1000;

  function formatTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  function handleToggle() {
    const j = jukebox();
    const nowPlaying = !isPlaying();
    const pos = Math.round(currentPosition() * 1000);
    if (audioRef) {
      if (nowPlaying) audioRef.play().catch(() => {});
      else { audioRef.pause(); audioRef.currentTime = currentPosition(); }
    }
    updateJukebox({ playing: nowPlaying, position: pos, updatedAt: Date.now(), trackKey: j.trackKey, duration: j.duration });
  }

  async function playNext() {
    const current = jukebox();
    const [next, ...remaining] = current.queue ?? [];
    if (!next) return;
    const update = buildTrackUpdate(next);
    if (!update.trackKey) return;
    await updateJukebox({ ...update, currentTrack: next, queue: remaining, history: pushHistory(current) });
  }

  function handleSeek(e: Event & { currentTarget: HTMLInputElement }) {
    const posSec = parseFloat(e.currentTarget.value);
    if (audioRef) audioRef.currentTime = posSec;
    updateJukebox({ position: Math.round(posSec * 1000), updatedAt: Date.now(), playing: isPlaying() });
  }

  function handleSearchInput(q: string) {
    setQuery(q);
    clearTimeout(searchTimeout);
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    searchTimeout = setTimeout(async () => {
      try {
        const r = await fetch(`${PLEX_PROXY_URL}/plex/search?q=${encodeURIComponent(q)}&type=10`);
        if (r.ok) {
          const data = await r.json();
          setResults((data.Metadata ?? []).slice(0, 10));
        }
      } catch {} finally {
        setSearching(false);
      }
    }, 350);
  }

  async function playNow(track: PersonalPlexTrack) {
    const update = buildTrackUpdate(track);
    if (!update.trackKey) return;
    setView("player");
    await updateJukebox({ ...update, currentTrack: track, history: pushHistory(jukebox()) });
  }

  async function queueTrack(track: PersonalPlexTrack) {
    await updateJukebox({ queue: [...(jukebox().queue ?? []), track] });
  }

  return (
    <MusicCard>
      <audio ref={audioRef} style={{ display: "none" }} />
      <Show
        when={view() === "player"}
        fallback={
          <>
            <MusicCardHeader>
              <MusicMiniBtn onClick={() => { setView("player"); setQuery(""); setResults([]); }} title="Back">
                <Symbol size={14}>arrow_back</Symbol>
              </MusicMiniBtn>
              <MusicSearchInputEl
                ref={searchInputRef}
                type="text"
                placeholder="Search music..."
                value={query()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
              <Show when={searching()}><Symbol size={12}>hourglass_empty</Symbol></Show>
            </MusicCardHeader>
            <MusicSearchList>
              <Show
                when={results().length > 0}
                fallback={
                  <MusicSearchEmpty>
                    {query().trim() ? (searching() ? "Searching..." : "No results") : "Type to search"}
                  </MusicSearchEmpty>
                }
              >
                <For each={results()}>
                  {(track) => (
                    <MusicSearchRow>
                      <MusicSearchInfo>
                        <MusicSearchTrackName>{track.title}</MusicSearchTrackName>
                        <MusicSearchTrackArtist>
                          {[track.grandparentTitle, track.parentTitle].filter(Boolean).join(" · ")}
                        </MusicSearchTrackArtist>
                      </MusicSearchInfo>
                      <MusicSearchBtns>
                        <MusicMiniBtn onClick={() => queueTrack(track)} title="Queue">
                          <Symbol size={12}>queue_music</Symbol>
                        </MusicMiniBtn>
                        <MusicMiniBtn onClick={() => playNow(track)} title="Play">
                          <Symbol size={12}>play_arrow</Symbol>
                        </MusicMiniBtn>
                      </MusicSearchBtns>
                    </MusicSearchRow>
                  )}
                </For>
              </Show>
            </MusicSearchList>
          </>
        }
      >
        <>
          <MusicCardHeader>
            <MusicCardLabel>
              <Symbol size={12}>music_note</Symbol>
              Personal Music
            </MusicCardLabel>
            <MusicMiniBtn onClick={() => setView("search")} title="Search music">
              <Symbol size={14}>search</Symbol>
            </MusicMiniBtn>
          </MusicCardHeader>

          <MusicTrackRow>
            <Show
              when={jukebox().thumbUrl}
              fallback={<MusicThumbFallback><Symbol size={14}>music_note</Symbol></MusicThumbFallback>}
            >
              <MusicThumb src={`${PLEX_PROXY_URL}/plex/art${jukebox().thumbUrl!}`} alt="" />
            </Show>
            <MusicTrackDetails>
              <MusicTrackTitle>{jukebox().trackTitle ?? "Nothing playing"}</MusicTrackTitle>
              <MusicTrackArtist>{jukebox().trackArtist ?? "Search to queue music"}</MusicTrackArtist>
            </MusicTrackDetails>
          </MusicTrackRow>

          <MusicControls>
            <MusicMiniBtn onClick={handleToggle} disabled={!jukebox().trackKey} title={isPlaying() ? "Pause" : "Play"}>
              <Show when={isPlaying()} fallback={<Symbol size={16}>play_arrow</Symbol>}>
                <Symbol size={16}>pause</Symbol>
              </Show>
            </MusicMiniBtn>
            <MusicMiniBtn onClick={playNext} disabled={(jukebox().queue ?? []).length === 0} title="Next">
              <Symbol size={14}>skip_next</Symbol>
            </MusicMiniBtn>
            <MusicScrubberRow>
              <MusicTime>{formatTime(currentPosition())}</MusicTime>
              <MusicScrubber
                type="range"
                min={0}
                max={dur() || 1}
                step={1}
                value={currentPosition()}
                onInput={handleSeek}
              />
              <MusicTime>{formatTime(dur())}</MusicTime>
            </MusicScrubberRow>
          </MusicControls>

          <MusicVolumeRow>
            <Symbol size={12}>volume_mute</Symbol>
            <MusicVolSlider
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume()}
              onInput={(e) => setVolume(parseFloat(e.currentTarget.value))}
              title={`Volume: ${Math.round(volume() * 100)}%`}
            />
            <Symbol size={12}>volume_up</Symbol>
          </MusicVolumeRow>
        </>
      </Show>
    </MusicCard>
  );
}

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
  const [showNsSlider, setShowNsSlider] = createSignal(false);

  createEffect(() => {
    if (!state.voice.noiseSupression) setShowNsSlider(false);
  });

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

            <NoiseButtonGroup>
              <Show when={showNsSlider()}>
                <NsSliderPopup>
                  <NsSliderLabel>Suppression Level — {state.voice.noiseSupressionLevel}</NsSliderLabel>
                  <NsRangeInput
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={state.voice.noiseSupressionLevel}
                    onInput={(e) =>
                      (state.voice.noiseSupressionLevel = Number(e.currentTarget.value))
                    }
                  />
                </NsSliderPopup>
              </Show>
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
              <Show when={state.voice.noiseSupression}>
                <ChevronBtn
                  onClick={() => setShowNsSlider((v) => !v)}
                >
                  <Symbol size={12}>{showNsSlider() ? "expand_more" : "expand_less"}</Symbol>
                </ChevronBtn>
              </Show>
            </NoiseButtonGroup>
          </VoiceCardActions>
        </VoiceCard>
      </Show>

      {/* Personal music player — only when not in a call */}
      <Show when={!voice.room() && !!PLEX_PROXY_URL && !!user()}>
        <PersonalPlexCard userId={user()!.id} />
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
              when={voice.room()}
              fallback={
                <Show
                  when={user()?.statusMessage()}
                  fallback={<StatusText>{user()?.presence}</StatusText>}
                >
                  <StatusText>{user()!.statusMessage()}</StatusText>
                </Show>
              }
            >
              <VoiceStateRow>
                <StatusText style={{ "font-size": "10px" }}>In Voice</StatusText>
              </VoiceStateRow>
            </Show>
          </UserDetails>
        </UserInfo>

        <UserControls>
          {/* Mic button — functional only while in a call */}
          <IconButton
            size="sm"
            variant="standard"
            voiceIcon={!!voice.room()}
            danger={!!(voice.room() && !voice.microphone())}
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
            variant="standard"
            voiceIcon={!!voice.room()}
            danger={!!(voice.room() && (voice.deafen() || !voice.listenPermission))}
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

const VoiceStateRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    height: "16px",
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

const NoiseButtonGroup = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "1px",
  },
});

const NsSliderPopup = styled("div", {
  base: {
    position: "absolute",
    bottom: "calc(100% + 8px)",
    left: "50%",
    transform: "translateX(-50%)",
    width: "200px",
    padding: "12px 16px",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    zIndex: 100,
  },
});

const NsSliderLabel = styled("div", {
  base: {
    fontSize: "11px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface-variant)",
    marginBottom: "6px",
  },
});

const NsRangeInput = styled("input", {
  base: {
    width: "100%",
    accentColor: "var(--md-sys-color-primary)",
    cursor: "pointer",
  },
});

const ChevronBtn = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "28px",
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    borderRadius: "var(--borderRadius-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
    "&:hover": {
      background: "color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)",
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

/* ── Personal music card ─────────────────────────────────────────────────── */

const MusicCard = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container)",
  },
});

const MusicCardHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const MusicCardLabel = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexGrow: 1,
    fontSize: "12px",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const MusicMiniBtn = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "3px",
    borderRadius: "var(--borderRadius-sm)",
    flexShrink: 0,
    transition: "color var(--transitions-fast), background var(--transitions-fast)",
    _disabled: { opacity: 0.38, cursor: "default" },
    _hover: {
      color: "var(--md-sys-color-on-surface)",
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const MusicTrackRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    minWidth: 0,
  },
});

const MusicThumb = styled("img", {
  base: {
    width: "32px",
    height: "32px",
    borderRadius: "var(--borderRadius-sm)",
    objectFit: "cover",
    flexShrink: 0,
  },
});

const MusicThumbFallback = styled("div", {
  base: {
    width: "32px",
    height: "32px",
    borderRadius: "var(--borderRadius-sm)",
    background: "var(--md-sys-color-surface-container-high)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const MusicTrackDetails = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  },
});

const MusicTrackTitle = styled("div", {
  base: {
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const MusicTrackArtist = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const MusicControls = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

const MusicScrubberRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexGrow: 1,
    minWidth: 0,
  },
});

const MusicScrubber = styled("input", {
  base: {
    flexGrow: 1,
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
    height: "3px",
    minWidth: 0,
  },
});

const MusicTime = styled("span", {
  base: {
    fontSize: "10px",
    color: "var(--md-sys-color-on-surface-variant)",
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0,
  },
});

const MusicVolumeRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const MusicVolSlider = styled("input", {
  base: {
    flexGrow: 1,
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
    height: "3px",
  },
});

const MusicSearchInputEl = styled("input", {
  base: {
    flexGrow: 1,
    background: "none",
    border: "none",
    outline: "none",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface)",
    _placeholder: { color: "var(--md-sys-color-on-surface-variant)" },
  },
});

const MusicSearchList = styled("div", {
  base: {
    maxHeight: "160px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const MusicSearchRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    padding: "4px var(--gap-xs)",
    borderRadius: "var(--borderRadius-sm)",
    _hover: { background: "var(--md-sys-color-surface-container-high)" },
  },
});

const MusicSearchInfo = styled("div", {
  base: { flexGrow: 1, minWidth: 0 },
});

const MusicSearchTrackName = styled("div", {
  base: {
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const MusicSearchTrackArtist = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const MusicSearchBtns = styled("div", {
  base: {
    display: "flex",
    gap: "2px",
    flexShrink: 0,
  },
});

const MusicSearchEmpty = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    fontStyle: "italic",
    padding: "var(--gap-sm) 0",
    textAlign: "center",
  },
});
