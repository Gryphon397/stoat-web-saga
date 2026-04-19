import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  TrackLoop,
  TrackReference,
  VideoTrack,
  useEnsureParticipant,
  useTrackRefContext,
  useTracks,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/markdown/users";
import { InRoom, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Slider } from "@revolt/ui";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ChannelPageProps } from "./ChannelPage";

const PLEX_PROXY = (import.meta.env.VITE_PLEX_PROXY_URL as string) ?? "";

// =============================================================================
// Voice channel content — rendered inside TextChannel's layout so the member
// sidebar and theming are inherited automatically.
// =============================================================================

export function VoiceChannelContent(props: ChannelPageProps) {
  return (
    <PageGrid>
      <PlexSection channelId={props.channel.id} />
      <ScreenshareArea>
        <InRoom channelId={props.channel.id}>
          <ScreenshareContent />
        </InRoom>
      </ScreenshareArea>
    </PageGrid>
  );
}

// =============================================================================
// Types
// =============================================================================

type JukeboxState = {
  trackKey?: string;
  trackTitle?: string;
  trackArtist?: string;
  trackAlbum?: string;
  thumbUrl?: string;
  duration?: number;
  position?: number;
  playing?: boolean;
  updatedAt?: number;
  trackFormat?: string;
  currentTrack?: PlexTrack;
  queue?: PlexTrack[];
  history?: PlexTrack[];
};

type PlexTrack = {
  key: string;
  title: string;
  grandparentTitle?: string;
  parentTitle?: string;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  duration?: number;
  Media?: Array<{ audioCodec?: string; bitrate?: number; Part: Array<{ key: string }> }>;
};

// =============================================================================
// Plex section — collapsible player bar + expanded overlay
// =============================================================================

function PlexSection(props: { channelId: string }) {
  // Detect duplicate mounts — if you see two of these in console, there are two instances
  const _instanceId = Math.random().toString(36).slice(2, 6);
  console.log(`[jukebox:${_instanceId}] PlexSection mounted`);
  onCleanup(() => console.log(`[jukebox:${_instanceId}] PlexSection unmounted`));

  const jbUrl = (path: string) =>
    `${PLEX_PROXY}${path}?channel=${encodeURIComponent(props.channelId)}`;
  const [view, setView] = createSignal<"player" | "search">("player");
  const [jukebox, setJukebox] = createSignal<JukeboxState>({});
  const [tick, setTick] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal(true);

  let audioRef: HTMLAudioElement | undefined;
  let currentStreamKey = "";
  // Track the updatedAt of the most recent patch we sent so stale SSE echoes
  // from earlier actions can be ignored.
  let _latestSentAt = 0;

  const [volume, setVolume] = createSignal(0.5);
  createEffect(() => { if (audioRef) audioRef.volume = volume() * volume(); });

  // Memo so the tick interval only restarts on actual play/pause transitions,
  // not on every unrelated jukebox field update.
  const isPlaying = createMemo(() => jukebox().playing ?? false);

  createEffect(() => {
    if (!isPlaying()) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  onMount(async () => {
    if (!PLEX_PROXY) return;
    try {
      const r = await fetch(jbUrl("/jukebox/state"));
      if (r.ok) {
        const state: JukeboxState | null = await r.json();
        if (state) { setJukebox(state); syncAudio(state); }
      }
    } catch { /* proxy not up */ }

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

  // SSE in onMount (not createEffect) so it never reconnects due to reactive tracking
  onMount(() => {
    if (!PLEX_PROXY) return;
    const es = new EventSource(jbUrl("/jukebox/events"));
    es.onmessage = (e) => {
      const state: JukeboxState = JSON.parse(e.data);
      // Skip SSEs that are older than our most recent local update.
      // Without this guard, a stale SSE echo can overwrite a newer optimistic
      // state — e.g. clicking pause then immediately getting the SSE from the
      // preceding play re-starts the audio.
      if (state.updatedAt != null && state.updatedAt < _latestSentAt) {
        console.log(`[jukebox:${_instanceId}] SSE skipped (stale: ${state.updatedAt} < ${_latestSentAt})`);
        return;
      }
      console.log(`[jukebox:${_instanceId}] SSE applied playing=${state.playing}`);
      setJukebox(state);
      syncAudio(state);
    };
    onCleanup(() => es.close());
  });

  function syncAudio(state: JukeboxState) {
    if (!audioRef || !state.trackKey) return;
    const streamUrl = `${PLEX_PROXY}/plex/stream${state.trackKey}`;
    if (currentStreamKey !== state.trackKey) {
      currentStreamKey = state.trackKey;
      audioRef.src = streamUrl;
    }
    if (state.playing && state.position != null && state.updatedAt) {
      const targetSec = (Date.now() - state.updatedAt + state.position) / 1000;
      if (Math.abs(audioRef.currentTime - targetSec) > 2) {
        audioRef.currentTime = targetSec;
      }
      audioRef.play().catch(() => {});
    } else if (!state.playing) {
      audioRef.pause();
      if (state.position != null) audioRef.currentTime = state.position / 1000;
    }
  }

  async function updateJukebox(patch: Partial<JukeboxState>) {
    if (!PLEX_PROXY) return;
    if (patch.updatedAt != null) _latestSentAt = patch.updatedAt;
    else _latestSentAt = Math.max(_latestSentAt, Date.now());
    // Build the full next state so we can drive audio immediately without
    // waiting for the SSE echo (which may now be filtered as stale).
    const nextState = { ...jukebox(), ...patch } as JukeboxState;
    setJukebox(nextState);
    syncAudio(nextState);
    await fetch(jbUrl("/jukebox/update"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  function buildTrackUpdate(track: PlexTrack): Partial<JukeboxState> {
    const media = track.Media?.[0];
    const partKey = media?.Part?.[0]?.key;
    if (!partKey) return {};
    const codec = media?.audioCodec?.toUpperCase();
    const bitrate = media?.bitrate;
    return {
      trackKey: partKey,
      trackTitle: track.title,
      trackArtist: track.grandparentTitle,
      trackAlbum: track.parentTitle,
      thumbUrl: track.parentThumb ?? track.thumb ?? track.grandparentThumb,
      trackFormat: codec ? (bitrate ? `${codec} · ${Math.round(bitrate)} kbps` : codec) : undefined,
      duration: track.duration,
      position: 0,
      playing: true,
      updatedAt: Date.now(),
    };
  }

  function pushHistory(current: JukeboxState): PlexTrack[] {
    if (!current.currentTrack) return current.history ?? [];
    const history = [...(current.history ?? []), current.currentTrack];
    return history.slice(-50);
  }

  async function playNow(track: PlexTrack) {
    const update = buildTrackUpdate(track);
    if (!update.trackKey) return;
    setView("player");
    await updateJukebox({ ...update, currentTrack: track, history: pushHistory(jukebox()) });
  }

  async function playNext() {
    const current = jukebox();
    const [next, ...remaining] = current.queue ?? [];
    if (!next) return;
    const update = buildTrackUpdate(next);
    if (!update.trackKey) return;
    await updateJukebox({ ...update, currentTrack: next, queue: remaining, history: pushHistory(current) });
  }

  async function playPrevious() {
    const current = jukebox();
    const history = current.history ?? [];
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    const newHistory = history.slice(0, -1);
    const queue = current.currentTrack
      ? [current.currentTrack, ...(current.queue ?? [])]
      : (current.queue ?? []);
    const update = buildTrackUpdate(prev);
    if (!update.trackKey) return;
    await updateJukebox({ ...update, currentTrack: prev, queue, history: newHistory });
  }

  async function queueTrack(track: PlexTrack) {
    const current = jukebox();
    const queue = [...(current.queue ?? []), track];
    await updateJukebox({ queue });
  }

  const duration = () => (jukebox().duration ?? 0) / 1000;
  const currentPosition = createMemo(() => {
    tick();
    const j = jukebox();
    if (j.position == null || !j.updatedAt) return 0;
    const pos = j.playing
      ? (Date.now() - j.updatedAt + j.position) / 1000
      : j.position / 1000;
    return Math.min(pos, (j.duration ?? 0) / 1000);
  });

  function formatTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  // Per-action debounce: each action has its own timestamp so clicking different
  // buttons in quick succession is still allowed, but a single button cannot
  // fire twice within 250 ms (catches spurious double-fires from any source).
  function makeGuarded(label: string, fn: () => void): (e: MouseEvent) => void {
    let lastMs = 0;
    return (e: MouseEvent) => {
      e.stopPropagation();
      const now = Date.now();
      console.log(`[jukebox:${_instanceId}] ${label} raw click — gap=${now - lastMs}ms`);
      if (now - lastMs < 250) {
        console.warn(`[jukebox:${_instanceId}] ${label} BLOCKED by debounce`);
        return;
      }
      lastMs = now;
      fn();
    };
  }

  const handleToggle = makeGuarded("toggle", () => {
    const j = jukebox();
    const nowPlaying = !isPlaying();
    const position = Math.round(currentPosition() * 1000);
    console.log(`[jukebox:${_instanceId}] toggle → playing=${nowPlaying}`);
    if (audioRef) {
      if (nowPlaying) audioRef.play().catch(() => {});
      else { audioRef.pause(); audioRef.currentTime = currentPosition(); }
    }
    updateJukebox({
      playing: nowPlaying,
      position,
      updatedAt: Date.now(),
      trackKey: j.trackKey,
      duration: j.duration,
    });
  });

  const handleNext = makeGuarded("next", playNext);
  const handlePrev = makeGuarded("prev", playPrevious);

  // Native range input — no custom element, no synthetic event concerns.
  function handleSeek(e: Event & { currentTarget: HTMLInputElement }) {
    const posSec = parseFloat(e.currentTarget.value);
    if (audioRef) audioRef.currentTime = posSec;
    updateJukebox({ position: Math.round(posSec * 1000), updatedAt: Date.now(), playing: isPlaying() });
  }

  return (
    <PlayerWrapper>
      <audio ref={audioRef} style={{ display: "none" }} />

      <CollapsedBar>
        <CollapsedMainRow>
          <AlbumArtSmall>
            <Show
              when={jukebox().thumbUrl}
              fallback={
                <AlbumArtFallback>
                  <Symbol size={20}>music_note</Symbol>
                </AlbumArtFallback>
              }
            >
              <img
                src={`${PLEX_PROXY}/plex/art${jukebox().thumbUrl!}`}
                style={{ width: "100%", height: "100%", "object-fit": "cover" }}
                alt=""
              />
            </Show>
          </AlbumArtSmall>

          <CollapsedTrackInfo>
            <CollapsedTrackLine secondary>
              {[jukebox().trackArtist, jukebox().trackAlbum].filter(Boolean).join(" — ") ||
                (PLEX_PROXY ? "Search to find music" : "Not connected to Plex")}
            </CollapsedTrackLine>
            <CollapsedTrackLine>
              {jukebox().trackTitle ?? (PLEX_PROXY ? "Nothing playing" : "")}
              <Show when={jukebox().trackFormat}>
                <CollapsedFormat>{jukebox().trackFormat}</CollapsedFormat>
              </Show>
            </CollapsedTrackLine>
          </CollapsedTrackInfo>

          <PlayerControls compact>
            <ControlButton title="Shuffle" disabled>
              <Symbol size={18}>shuffle</Symbol>
            </ControlButton>
            <ControlButton
              title="Previous"
              disabled={!PLEX_PROXY || (jukebox().history ?? []).length === 0}
              onClick={handlePrev}
            >
              <Symbol size={22}>skip_previous</Symbol>
            </ControlButton>
            <PlayButton
              onClick={handleToggle}
              disabled={!PLEX_PROXY || !jukebox().trackKey}
            >
              <Show when={isPlaying()} fallback={<Symbol size={24}>play_arrow</Symbol>}>
                <Symbol size={24}>pause</Symbol>
              </Show>
            </PlayButton>
            <ControlButton
              title="Next"
              disabled={!PLEX_PROXY || (jukebox().queue ?? []).length === 0}
              onClick={handleNext}
            >
              <Symbol size={22}>skip_next</Symbol>
            </ControlButton>
            <ControlButton title="Repeat" disabled>
              <Symbol size={18}>repeat</Symbol>
            </ControlButton>
          </PlayerControls>

          <CollapsedVolumeRow>
            <Symbol size={14}>volume_up</Symbol>
            <CollapsedVolumeSlider
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume()}
              onInput={(e) => setVolume(parseFloat(e.currentTarget.value))}
              title={`Volume: ${Math.round(volume() * 100)}%`}
            />
          </CollapsedVolumeRow>

          <CollapsedActions>
            <NavButton
              title="Search music"
              onClick={(e) => { e.stopPropagation(); setCollapsed(false); setView("search"); }}
            >
              <Symbol size={16}>search</Symbol>
            </NavButton>
            <NavButton
              title={collapsed() ? "Expand player" : "Collapse player"}
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
            >
              <Symbol size={18}>{collapsed() ? "expand_more" : "expand_less"}</Symbol>
            </NavButton>
          </CollapsedActions>
        </CollapsedMainRow>

        <ScrubberRow>
          <TimeLabel>{formatTime(currentPosition())}</TimeLabel>
          <ScrubberInput
            type="range"
            min={0}
            max={duration() || 1}
            step={1}
            value={currentPosition()}
            onInput={handleSeek}
            title={formatTime(currentPosition())}
          />
          <TimeLabel>{formatTime(duration())}</TimeLabel>
        </ScrubberRow>
      </CollapsedBar>

      <ExpandedPanel style={{
        "grid-template-rows": collapsed() ? "0fr" : "1fr",
        visibility: collapsed() ? "hidden" : "visible",
        transition: collapsed()
          ? "grid-template-rows 0.25s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s linear 0.25s"
          : "grid-template-rows 0.25s cubic-bezier(0.4, 0, 0.2, 1), visibility 0s",
      }}>
        <ExpandedPanelInner>
          <Show
            when={view() === "player"}
            fallback={
              <SearchView
                onBack={() => setView("player")}
                onPlayNow={playNow}
                onQueue={queueTrack}
              />
            }
          >
            <MusicOuter>
              <PlayerPanel>
                <PlayerNavRow>
                  <NavButton title="Search music" onClick={(e) => { e.stopPropagation(); setView("search"); }}>
                    <Symbol size={18}>search</Symbol>
                  </NavButton>
                </PlayerNavRow>

                <PlayerArtWrap>
                  <AlbumArt>
                    <Show
                      when={jukebox().thumbUrl}
                      fallback={
                        <AlbumArtFallback>
                          <Symbol size={32}>music_note</Symbol>
                        </AlbumArtFallback>
                      }
                    >
                      <img
                        src={`${PLEX_PROXY}/plex/art${jukebox().thumbUrl!}`}
                        style={{ width: "100%", height: "100%", "object-fit": "cover" }}
                        alt="Album art"
                      />
                    </Show>
                  </AlbumArt>
                </PlayerArtWrap>

                <TrackInfo>
                  <TrackTitle>
                    {jukebox().trackTitle ?? (PLEX_PROXY ? "Nothing playing" : "Not connected to Plex")}
                  </TrackTitle>
                  <TrackMeta>
                    {jukebox().trackArtist ?? (PLEX_PROXY ? "Search to find music" : "Not connected to Plex")}
                  </TrackMeta>
                  <Show when={jukebox().trackAlbum}>
                    <TrackMeta>{jukebox().trackAlbum}</TrackMeta>
                  </Show>
                  <Show when={jukebox().trackFormat}>
                    <TrackFormat>{jukebox().trackFormat}</TrackFormat>
                  </Show>
                </TrackInfo>
              </PlayerPanel>

              <QueuePanel>
                <QueueHeader>Queue</QueueHeader>
                <QueueList>
                  <Show
                    when={(jukebox().queue ?? []).length > 0}
                    fallback={<QueueEmpty>No tracks queued</QueueEmpty>}
                  >
                    <For each={jukebox().queue ?? []}>
                      {(track, i) => (
                        <QueueItem>
                          <QueueItemInfo>
                            <QueueItemTitle>{track.title}</QueueItemTitle>
                            <QueueItemMeta>
                              {[track.grandparentTitle, track.parentTitle]
                                .filter(Boolean)
                                .join(" — ")}
                            </QueueItemMeta>
                          </QueueItemInfo>
                          <QueueItemRemove
                            title="Remove from queue"
                            onClick={() => {
                              const q = [...(jukebox().queue ?? [])];
                              q.splice(i(), 1);
                              updateJukebox({ queue: q });
                            }}
                          >
                            <Symbol size={14}>close</Symbol>
                          </QueueItemRemove>
                        </QueueItem>
                      )}
                    </For>
                  </Show>
                </QueueList>
              </QueuePanel>

              <VolumePanel>
                <Symbol size={16}>volume_up</Symbol>
                <VolumeSliderInput
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume()}
                  onInput={(e) => setVolume(parseFloat(e.currentTarget.value))}
                  title={`Volume: ${Math.round(volume() * 100)}%`}
                />
                <Symbol size={16}>volume_mute</Symbol>
              </VolumePanel>
            </MusicOuter>
          </Show>
        </ExpandedPanelInner>
      </ExpandedPanel>
    </PlayerWrapper>
  );
}

// =============================================================================
// Search view
// =============================================================================

function SearchView(props: {
  onBack: () => void;
  onPlayNow: (track: PlexTrack) => void;
  onQueue: (track: PlexTrack) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<PlexTrack[]>([]);
  const [searching, setSearching] = createSignal(false);
  let searchTimeout: ReturnType<typeof setTimeout> | undefined;
  let inputRef: HTMLInputElement | undefined;

  onMount(() => inputRef?.focus());

  function handleInput(q: string) {
    setQuery(q);
    clearTimeout(searchTimeout);
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    searchTimeout = setTimeout(async () => {
      try {
        const r = await fetch(
          `${PLEX_PROXY}/plex/search?q=${encodeURIComponent(q)}&type=10`
        );
        if (r.ok) {
          const data = await r.json();
          setResults((data.Metadata ?? []).slice(0, 20));
        }
      } catch { /* ignore */ } finally {
        setSearching(false);
      }
    }, 350);
  }

  return (
    <SearchViewOuter>
      <SearchHeader>
        <NavButton title="Back to player" onClick={props.onBack}>
          <Symbol size={18}>arrow_back</Symbol>
        </NavButton>
        <SearchInputWrap>
          <Symbol size={16}>search</Symbol>
          <SearchInputEl
            ref={inputRef}
            type="text"
            placeholder="Search artist, song, album..."
            value={query()}
            onInput={(e) => handleInput(e.currentTarget.value)}
          />
          <Show when={searching()}>
            <Symbol size={16}>hourglass_empty</Symbol>
          </Show>
        </SearchInputWrap>
      </SearchHeader>

      <SearchResultsList>
        <Show
          when={results().length > 0}
          fallback={
            <SearchEmpty>
              {query().trim()
                ? searching() ? "Searching..." : "No results found"
                : "Start typing to search your Plex library"}
            </SearchEmpty>
          }
        >
          <For each={results()}>
            {(track) => (
              <SearchResultRow>
                <SearchResultIcon>
                  <Symbol size={16}>music_note</Symbol>
                </SearchResultIcon>
                <SearchResultText>
                  <SearchResultTitle>{track.title}</SearchResultTitle>
                  <SearchResultMeta>
                    {[track.grandparentTitle, track.parentTitle]
                      .filter(Boolean)
                      .join(" — ")}
                  </SearchResultMeta>
                </SearchResultText>
                <SearchResultActions>
                  <SearchActionButton
                    onClick={() => props.onQueue(track)}
                    title="Add to queue"
                  >
                    <Symbol size={14}>queue_music</Symbol>
                    Queue
                  </SearchActionButton>
                  <SearchActionButton
                    onClick={() => props.onPlayNow(track)}
                    title="Play now"
                    primary
                  >
                    <Symbol size={14}>play_arrow</Symbol>
                    Play
                  </SearchActionButton>
                </SearchResultActions>
              </SearchResultRow>
            )}
          </For>
        </Show>
      </SearchResultsList>
    </SearchViewOuter>
  );
}

// =============================================================================
// Screenshare tiles
// =============================================================================

function ScreenshareContent() {
  const tracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const remoteTracks = () => tracks().filter((t) => !t.participant.isLocal);

  return (
    <Show
      when={remoteTracks().length > 0}
      fallback={
        <ScreenEmpty>
          <Symbol size={32}>personal_injury</Symbol>
          No one is streaming anything
        </ScreenEmpty>
      }
    >
      <ScreenGrid>
        <TrackLoop tracks={remoteTracks}>
          {() => <VoiceScreenshareTile />}
        </TrackLoop>
      </ScreenGrid>
    </Show>
  );
}

function VoiceScreenshareTile() {
  const track = useTrackRefContext();
  const participant = useEnsureParticipant();
  const state = useState();
  const voice = useVoice();
  const user = useUser(participant.identity);

  const audioTracks = useTracks(
    [{ source: Track.Source.ScreenShareAudio, withPlaceholder: false }],
    { onlySubscribed: false },
  );
  const hasScreenshareAudio = () =>
    audioTracks().some((t) => t.participant.identity === participant.identity);

  let tileRef: HTMLDivElement | undefined;
  const [isPopped, setIsPopped] = createSignal(false);

  const toggleFullscreen = () => {
    if (!tileRef) return;
    if (!document.fullscreenElement) {
      tileRef.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const popOut = async (e: MouseEvent) => {
    e.stopPropagation();

    if (window.stoatPopout) {
      const room = voice.room();
      if (!room) return;

      // Fetch a subscribe-only viewer token + LiveKit URL from plex-proxy
      let viewerToken: string;
      let livekitUrl: string;
      try {
        const r = await fetch(
          `${PLEX_PROXY}/livekit/viewer-token?room=${encodeURIComponent(room.name)}`
        );
        if (!r.ok) throw new Error(`viewer-token ${r.status}`);
        ({ token: viewerToken, url: livekitUrl } = await r.json());
      } catch (err) {
        console.error("[popOut] failed to get viewer token:", err);
        return;
      }

      // Mute the screenshare audio in the main window so it only plays in the popout
      const wasScreenshareMuted = state.voice.getScreenshareMuted(participant.identity);
      state.voice.setScreenshareMuted(participant.identity, true);

      const cleanupClosed = window.stoatPopout.onPopoutClosed((closedIdentity) => {
        if (closedIdentity === participant.identity) {
          setIsPopped(false);
          state.voice.setScreenshareMuted(participant.identity, wasScreenshareMuted);
          cleanupClosed();
        }
      });

      const currentVolume = Math.min(1, Math.max(0, state.voice.getScreenshareVolume(participant.identity)));
      window.stoatPopout.open({
        identity: participant.identity,
        username: user().username ?? participant.identity,
        livekitUrl,
        viewerToken,
        volume: currentVolume,
      });
      setIsPopped(true);
      return;
    }

    const mediaStreamTrack = (track as any)?.publication?.track
      ?.mediaStreamTrack as MediaStreamTrack | undefined;
    if (!mediaStreamTrack) return;
    const stream = new MediaStream([mediaStreamTrack]);

    if ("documentPictureInPicture" in window) {
      try {
        const pipWindow = await (window as any).documentPictureInPicture
          .requestWindow({ width: 854, height: 480 });
        const doc = pipWindow.document;
        doc.body.style.cssText =
          "background:#000;width:100vw;height:100vh;overflow:hidden;margin:0;";
        const pipVideo = doc.createElement("video") as HTMLVideoElement;
        pipVideo.srcObject = stream;
        pipVideo.autoplay = true;
        pipVideo.muted = true;
        pipVideo.style.cssText =
          "width:100%;height:100%;object-fit:contain;display:block;";
        doc.body.appendChild(pipVideo);
        setIsPopped(true);
        pipWindow.addEventListener("pagehide", () => { pipVideo.srcObject = null; setIsPopped(false); });
        return;
      } catch { /* fall through */ }
    }

    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    const tempVideo = document.createElement("video") as HTMLVideoElement;
    tempVideo.srcObject = stream;
    tempVideo.muted = true;
    tempVideo.style.cssText =
      "position:fixed;bottom:0;right:0;width:1px;height:1px;pointer-events:none;opacity:0;";
    document.body.appendChild(tempVideo);
    await tempVideo.play();
    await tempVideo.requestPictureInPicture();
    setIsPopped(true);
    tempVideo.addEventListener("leavepictureinpicture", () => {
      document.body.removeChild(tempVideo);
      tempVideo.srcObject = null;
      setIsPopped(false);
    });
  };

  return (
    <div
      ref={tileRef}
      class={screenshareTile() + " group"}
      onClick={isPopped() ? undefined : toggleFullscreen}
      style={{ cursor: isPopped() ? "default" : "pointer" }}
    >
      <Show
        when={!isPopped()}
        fallback={
          <div
            style={{
              "grid-area": "1/1",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "rgba(255,255,255,0.5)",
              "font-size": "14px",
              "font-family": "inherit",
              gap: "8px",
            }}
          >
            <Symbol size={18}>picture_in_picture_alt</Symbol>
            Stream is popped out
          </div>
        }
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
      </Show>

      <TileOverlay showOnHover>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            width: "100%",
            gap: "var(--gap-sm)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "var(--gap-sm)" }}>
            <Symbol size={16}>volume_up</Symbol>
            <Slider
              min={0}
              max={3}
              step={0.1}
              value={state.voice.getScreenshareVolume(participant.identity)}
              onInput={(e) =>
                state.voice.setScreenshareVolume(participant.identity, e.currentTarget.value)
              }
              labelFormatter={(v) => (v * 100).toFixed(0) + "%"}
            />
          </div>

          <TileOverlayInner>
            <OverflowingText>{user().username}</OverflowingText>
            <TileIconButton
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
            </TileIconButton>
            <TileIconButton title="Pop out" onClick={popOut}>
              <Symbol size={18}>picture_in_picture_alt</Symbol>
            </TileIconButton>
            <Symbol size={18}>fullscreen</Symbol>
          </TileOverlayInner>
        </div>
      </TileOverlay>

      <Show when={!hasScreenshareAudio()}>
        <div
          style={{
            "grid-area": "1/1",
            "z-index": 2,
            display: "flex",
            "align-items": "end",
            "justify-content": "end",
            padding: "8px 10px",
            "pointer-events": "none",
          }}
        >
          <div
            style={{
              color: "rgba(255,255,255,0.45)",
              "font-size": "11px",
              "font-family": "inherit",
              display: "flex",
              "align-items": "center",
              gap: "4px",
            }}
          >
            <Symbol size={13}>volume_off</Symbol>
            Game audio incompatible
          </div>
        </div>
      </Show>
    </div>
  );
}

// =============================================================================
// Styled components
// =============================================================================

// ── Page layout ───────────────────────────────────────────────────────────────

const PageGrid = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    marginInline: "var(--gap-md)",
    marginBlockEnd: "var(--gap-md)",
    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-lowest)",
    overflow: "hidden",
  },
});

// ── Collapsed bar ─────────────────────────────────────────────────────────────

const CollapsedBar = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    padding: "var(--gap-sm) var(--gap-md)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    zIndex: 1,
  },
});

const CollapsedMainRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    minWidth: 0,
  },
});

const AlbumArtSmall = styled("div", {
  base: {
    flexShrink: 0,
    width: "48px",
    height: "48px",
    borderRadius: "var(--borderRadius-sm)",
    overflow: "hidden",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const CollapsedTrackInfo = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const CollapsedTrackLine = styled("div", {
  base: {
    fontSize: "13px",
    fontWeight: "500",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    display: "flex",
    alignItems: "baseline",
    gap: "4px",
  },
  variants: {
    secondary: {
      true: {
        fontSize: "11px",
        fontWeight: "400",
        color: "var(--md-sys-color-on-surface-variant)",
      },
    },
  },
});

const CollapsedFormat = styled("span", {
  base: {
    fontSize: "11px",
    fontWeight: "500",
    color: "var(--md-sys-color-primary)",
    letterSpacing: "0.04em",
    flexShrink: 0,
  },
});

const CollapsedVolumeRow = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const CollapsedVolumeSlider = styled("input", {
  base: {
    width: "80px",
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
  },
});

const CollapsedActions = styled("div", {
  base: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});

// ── Player wrapper + animated expand panel ────────────────────────────────────

const PlayerWrapper = styled("div", {
  base: {
    flexShrink: 0,
    position: "relative",
    zIndex: 5,
  },
});

const ExpandedPanel = styled("div", {
  base: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 10,
    display: "grid",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
  },
});

const ExpandedPanelInner = styled("div", {
  base: {
    minHeight: 0,
    overflow: "hidden",
    background: "var(--md-sys-color-surface-container-lowest)",
  },
});

// ── Music section — 3-column grid: player | queue | volume ───────────────────

const MusicOuter = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 48px",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
  },
});

const PlayerPanel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const PlayerNavRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "flex-end",
    flexShrink: 0,
    gap: "var(--gap-xs)",
  },
});

const PlayerArtWrap = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
  },
});

// ── Queue panel ───────────────────────────────────────────────────────────────

const QueuePanel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderLeft: "1px solid var(--md-sys-color-outline-variant)",
    paddingLeft: "var(--gap-md)",
  },
});

const QueueHeader = styled("div", {
  base: {
    fontSize: "11px",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    flexShrink: 0,
    paddingBottom: "var(--gap-xs)",
  },
});

const QueueList = styled("div", {
  base: {
    maxHeight: "220px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const QueueEmpty = styled("div", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
    fontStyle: "italic",
    padding: "var(--gap-sm) 0",
  },
});

const QueueItem = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    padding: "4px var(--gap-xs)",
    borderRadius: "var(--borderRadius-sm)",
    _hover: { background: "var(--md-sys-color-surface-container)" },
  },
});

const QueueItemInfo = styled("div", {
  base: { flexGrow: 1, minWidth: 0 },
});

const QueueItemTitle = styled("div", {
  base: {
    fontSize: "12px",
    fontWeight: "500",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const QueueItemMeta = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const QueueItemRemove = styled("button", {
  base: {
    flexShrink: 0,
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    display: "flex",
    padding: "2px",
    borderRadius: "var(--borderRadius-sm)",
    opacity: 0.4,
    transition: "opacity var(--transitions-fast), background var(--transitions-fast), color var(--transitions-fast)",
    _hover: {
      opacity: 1,
      background: "var(--md-sys-color-surface-container-high)",
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

// ── Volume panel ──────────────────────────────────────────────────────────────

const VolumePanel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBlock: "var(--gap-sm)",
    borderLeft: "1px solid var(--md-sys-color-outline-variant)",
    paddingLeft: "var(--gap-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const VolumeSliderInput = styled("input", {
  base: {
    writingMode: "vertical-lr",
    direction: "rtl",
    flexGrow: 1,
    width: "20px",
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
  },
});

// ── Circular nav button (search / back / collapse) ────────────────────────────

const NavButton = styled("button", {
  base: {
    flexShrink: 0,
    width: "32px",
    height: "32px",
    borderRadius: "var(--borderRadius-circle)",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface-variant)",
    transition: "background var(--transitions-fast), color var(--transitions-fast)",
    _hover: {
      background: "var(--md-sys-color-surface-container-high)",
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

// ── Player view ───────────────────────────────────────────────────────────────

const AlbumArt = styled("div", {
  base: {
    flexShrink: 0,
    width: "90px",
    height: "90px",
    borderRadius: "var(--borderRadius-md)",
    overflow: "hidden",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const AlbumArtFallback = styled("div", {
  base: {
    width: "100%",
    height: "100%",
    display: "grid",
    placeItems: "center",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const TrackInfo = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    minWidth: 0,
    flexShrink: 0,
  },
});

const TrackTitle = styled("div", {
  base: {
    fontSize: "14px",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    textAlign: "center",
    width: "100%",
  },
});

const TrackMeta = styled("div", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    textAlign: "center",
    width: "100%",
  },
});

const TrackFormat = styled("div", {
  base: {
    fontSize: "11px",
    fontWeight: "500",
    color: "var(--md-sys-color-primary)",
    textAlign: "center",
    letterSpacing: "0.04em",
    marginTop: "2px",
  },
});

const PlayerControls = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",
    flexShrink: 0,
    marginTop: "auto",
  },
  variants: {
    compact: {
      true: { marginTop: "0" },
    },
  },
});

const ControlButton = styled("button", {
  base: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "4px",
    borderRadius: "var(--borderRadius-sm)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "color var(--transitions-fast), background var(--transitions-fast)",
    _disabled: { opacity: 0.38, cursor: "default" },
    _hover: {
      color: "var(--md-sys-color-on-surface)",
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const PlayButton = styled("button", {
  base: {
    background: "var(--md-sys-color-primary)",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-primary)",
    width: "44px",
    height: "44px",
    flexShrink: 0,
    borderRadius: "var(--borderRadius-circle)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "opacity var(--transitions-fast)",
    _disabled: { opacity: 0.38, cursor: "default" },
  },
});

const ScrubberRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexShrink: 0,
  },
});

const ScrubberInput = styled("input", {
  base: {
    flexGrow: 1,
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
    height: "4px",
  },
});

const TimeLabel = styled("span", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0,
  },
});

// ── Search view ───────────────────────────────────────────────────────────────

const SearchViewOuter = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    gap: "var(--gap-sm)",
    padding: "var(--gap-md) var(--gap-lg)",
  },
});

const SearchHeader = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const SearchInputWrap = styled("div", {
  base: {
    flexGrow: 1,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const SearchInputEl = styled("input", {
  base: {
    background: "none",
    border: "none",
    outline: "none",
    flexGrow: 1,
    fontSize: "14px",
    color: "var(--md-sys-color-on-surface)",
    "::placeholder": { color: "var(--md-sys-color-on-surface-variant)" },
  },
});

const SearchResultsList = styled("div", {
  base: {
    flexGrow: 1,
    overflowY: "auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
});

const SearchEmpty = styled("div", {
  base: {
    padding: "var(--gap-lg)",
    textAlign: "center",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const SearchResultRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px var(--gap-sm)",
    borderRadius: "var(--borderRadius-sm)",
    _hover: { background: "var(--md-sys-color-surface-container)" },
  },
});

const SearchResultIcon = styled("div", {
  base: {
    flexShrink: 0,
    color: "var(--md-sys-color-on-surface-variant)",
    display: "flex",
  },
});

const SearchResultText = styled("div", {
  base: {
    flexGrow: 1,
    minWidth: 0,
  },
});

const SearchResultTitle = styled("div", {
  base: {
    fontSize: "13px",
    fontWeight: "500",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const SearchResultMeta = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const SearchResultActions = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    gap: "var(--gap-xs)",
  },
});

const SearchActionButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    padding: "3px 8px",
    border: "none",
    borderRadius: "var(--borderRadius-sm)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: "500",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
    transition: "background var(--transitions-fast), color var(--transitions-fast)",
    _hover: {
      background: "var(--md-sys-color-surface-container-highest)",
      color: "var(--md-sys-color-on-surface)",
    },
  },
  variants: {
    primary: {
      true: {
        background: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary)",
        _hover: {
          background: "var(--md-sys-color-primary)",
          color: "var(--md-sys-color-on-primary)",
          opacity: 0.9,
        },
      },
    },
  },
});

// ── Screenshare section ───────────────────────────────────────────────────────

const ScreenshareArea = styled("div", {
  base: {
    flex: 1,
    minHeight: 0,
  },
});

const ScreenEmpty = styled("div", {
  base: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "13px",
    opacity: 0.5,
  },
});

const ScreenGrid = styled("div", {
  base: {
    width: "100%",
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

const screenshareTile = cva({
  base: {
    flex: "1 1 300px",
    maxWidth: "100%",
    height: "100%",
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    gridTemplateColumns: "minmax(0, 1fr)",
    borderRadius: "var(--borderRadius-lg)",
    background: "#0002",
    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",
  },
});

const TileOverlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",
    zIndex: 1,
    padding: "var(--gap-md) var(--gap-lg)",
    display: "flex",
    alignItems: "end",
    transition: "var(--transitions-fast) opacity",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,
        _groupHover: { opacity: 1 },
      },
    },
  },
});

const TileOverlayInner = styled("div", {
  base: {
    minWidth: 0,
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    "& > *:first-child": { flexGrow: 1 },
  },
});

const TileIconButton = styled("button", {
  base: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "inherit",
    display: "flex",
    padding: "2px",
    borderRadius: "var(--borderRadius-sm)",
    transition: "background var(--transitions-fast)",
    _hover: { background: "rgba(255,255,255,0.15)" },
  },
});
