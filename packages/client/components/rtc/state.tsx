import {
  Accessor,
  JSX,
  Setter,
  Show,
  batch,
  createContext,
  createEffect,
  createSignal,
  useContext,
  onMount,
  onCleanup,
} from "solid-js";
import { RoomContext } from "solid-livekit-components";

import { Room, VideoPresets } from "livekit-client";
import { DenoiseTrackProcessor } from "livekit-rnnoise-processor";
import { voiceNotifications } from "./VoiceNotifications";

const debugLog = (prefix: string, ...args: unknown[]) => {
  if (import.meta.env.DEV) {
    console.log(`[${prefix}]`, ...args);
  }
};

// Type declarations for Stoat Desktop screenshare picker API
declare global {
  interface Window {
    desktopCapture?: {
      onSourcesAvailable: (
        callback: (
          sources: Array<{ id: string; name: string; thumbnail: string }>,
        ) => void,
      ) => void;
      selectSource: (id: string) => void;
      cancel: () => void;
    };
  }
}

// Type declarations for Stoat Desktop push-to-talk API
declare global {
  interface Window {
    pushToTalk?: {
      onStateChange: (callback: (state: { active: boolean }) => void) => void;
      offStateChange: (callback: (state: { active: boolean }) => void) => void;
      setManualState: (active: boolean) => void;
      getCurrentState: () => { active: boolean };
      getConfig: () => {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      };
      onConfigChange: (callback: (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => void) => void;
      offConfigChange: (callback: (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => void) => void;
      updateSettings: (settings: {
        enabled?: boolean;
        keybind?: string;
        mode?: "hold" | "toggle";
        releaseDelay?: number;
        notificationSounds?: boolean;
      }) => void;
    };
  }
}

import { Channel } from "stoat.js";

import { useState } from "@revolt/state";
import { Voice as VoiceSettings } from "@revolt/state/stores/Voice";
import { useClient } from "@revolt/client";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { ScreenSharePicker } from "./components/ScreenSharePicker";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

class Voice {
  #settings: VoiceSettings;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  state: Accessor<State>;
  #setState: Setter<State>;

  deafen: Accessor<boolean>;
  #setDeafen: Setter<boolean>;

  microphone: Accessor<boolean>;
  #setMicrophone: Setter<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  constructor(voiceSettings: VoiceSettings) {
    this.#settings = voiceSettings;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    const [deafen, setDeafen] = createSignal<boolean>(false);
    this.deafen = deafen;
    this.#setDeafen = setDeafen;

    const [microphone, setMicrophone] = createSignal(false);
    this.microphone = microphone;
    this.#setMicrophone = setMicrophone;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    debugLog("PTT-WEB", "Voice.connect() called for channel:", channel.id);
    this.disconnect();

    const room = new Room({
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression,
      },
      videoCaptureDefaults: {
        resolution: VideoPresets.h1080.resolution,
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
    });

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");

      // only auto-mute when PTT is enabled
      const pttEnabled = this.#settings.pushToTalkEnabled;
      if (pttEnabled) {
        debugLog("PTT-WEB", "PTT enabled - Setting initial mic state to OFF (muted)");
        this.#setMicrophone(false);
      } else {
        debugLog("PTT-WEB", "PTT disabled - Keeping mic state as-is");
        this.#setMicrophone(true);
      }
      this.#setDeafen(false);
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        room.localParticipant.setMicrophoneEnabled(true).then((track) => {
          this.#setMicrophone(typeof track !== "undefined");
          if (this.#settings.rnnoise)
            track?.audioTrack?.setProcessor(new DenoiseTrackProcessor());
        });
      debugLog("PTT-WEB", "Room connected");
      this.#setState("CONNECTED");
      console.log("[VoiceNotifications] Playing self join sound");
      voiceNotifications.playSelfJoin();
    });

    room.addListener("disconnected", () => {
      debugLog("PTT-WEB", "Room disconnected");
      this.#setState("DISCONNECTED");
    });

    if (!auth) {
      let voiceServer = "worldwide";
      console.log(channel);
      console.log(channel.server);
      console.log(channel.server?.description);
      if (channel.server?.description) {
        const descSplits = channel.server.description.split("\n");
        const lastLine = descSplits[descSplits?.length - 1];
        if (lastLine.startsWith("voice-server:")) {
          voiceServer = lastLine.replace("voice-server:", "");
          console.log(voiceServer);
        }
      }
      auth = await channel.joinCall(voiceServer);
    }

    debugLog("PTT-WEB", "Connecting to room...");
    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
    });
    debugLog("PTT-WEB", "Room connected successfully, mic state:", room.localParticipant.isMicrophoneEnabled);
    
    // Handle mic state based on PTT setting
    if (this.#settings.pushToTalkEnabled) {
      // PTT enabled - mute mic so user must press key to speak
      if (room.localParticipant.isMicrophoneEnabled) {
        debugLog("PTT-WEB", "PTT enabled and mic was auto-enabled by LiveKit, explicitly muting...");
        await room.localParticipant.setMicrophoneEnabled(false);
        debugLog("PTT-WEB", "Mic explicitly muted, state:", room.localParticipant.isMicrophoneEnabled);
      }
    } else {
      // PTT disabled - unmute mic so user can speak immediately
      if (!room.localParticipant.isMicrophoneEnabled) {
        debugLog("PTT-WEB", "PTT disabled and mic is muted, explicitly unmuting...");
        await room.localParticipant.setMicrophoneEnabled(true);
        debugLog("PTT-WEB", "Mic explicitly unmuted, state:", room.localParticipant.isMicrophoneEnabled);
      }
    }
  }

  disconnect() {
    const room = this.room();
    if (!room) return;

    voiceNotifications.playSelfLeave();

    room.removeAllListeners();
    room.disconnect();

    batch(() => {
      this.#setState("READY");
      this.#setRoom(undefined);
      this.#setChannel(undefined);
    });
  }

  async toggleDeafen() {
    this.#setDeafen((s) => !s);
  }

  async toggleMute() {
    const room = this.room();
    if (!room) throw "invalid state";
    await room.localParticipant.setMicrophoneEnabled(
      !room.localParticipant.isMicrophoneEnabled,
    );

    this.#setMicrophone(room.localParticipant.isMicrophoneEnabled);

    // only play sounds if PTT is disabled, or if PTT is enabled with notification sounds on
    const shouldPlaySound = !this.#settings.pushToTalkEnabled || this.#settings.pushToTalkNotificationSounds;
    
    if (shouldPlaySound) {
      if (room.localParticipant.isMicrophoneEnabled) {
        voiceNotifications.playUnmute();
      } else {
        voiceNotifications.playMute();
      }
    }
  }

  /**
   * Set microphone mute state directly (for push-to-talk)
   * @param enabled true to unmute, false to mute
   */
  async setMute(enabled: boolean) {
    debugLog("PTT-WEB", "setMute() called:", enabled);
    const room = this.room();
    if (!room) {
      debugLog("PTT-WEB", "setMute() - no room, returning");
      return;
    }
    
    const currentState = room.localParticipant.isMicrophoneEnabled;
    debugLog("PTT-WEB", "setMute() - current mic state:", currentState, "target:", enabled);
    
    if (currentState !== enabled) {
      debugLog("PTT-WEB", "setMute() - calling setMicrophoneEnabled(", enabled, ")");
      await room.localParticipant.setMicrophoneEnabled(enabled);
      this.#setMicrophone(enabled);
      debugLog("PTT-WEB", "setMute() - mic state updated to:", enabled);
      
      // only play sounds if PTT is disabled, or if PTT is enabled with notification sounds on
      const shouldPlaySound = !this.#settings.pushToTalkEnabled || this.#settings.pushToTalkNotificationSounds;
      
      if (shouldPlaySound) {
        if (enabled) {
          voiceNotifications.playUnmute();
        } else {
          voiceNotifications.playMute();
        }
      }
    } else {
      debugLog("PTT-WEB", "setMute() - no change needed, already:", enabled);
    }
  }

  async toggleCamera() {
    const room = this.room();
    if (!room) throw "invalid state";
    await room.localParticipant.setCameraEnabled(
      !room.localParticipant.isCameraEnabled,
    );

    this.#setVideo(room.localParticipant.isCameraEnabled);
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";
    const enabling = !room.localParticipant.isScreenShareEnabled;
    try {
      await room.localParticipant.setScreenShareEnabled(
        enabling,
        { audio: true, video: enabling ? { frameRate: this.#settings.screenshareFrameRate } : undefined },
      );
    } catch (e: any) {
      // Swallow all errors when enabling — covers user cancel, permission denied,
      // device errors, and any Electron-specific rejection reasons.
      if (enabling) {
        console.warn("[Voice] screenshare cancelled or failed:", e?.message ?? e);
        return;
      }
      throw e;
    }

    this.#setScreenshare(room.localParticipant.isScreenShareEnabled);
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const voice = new Voice(state.voice);
  const client = useClient();

  const [pickSources, setPickSources] = createSignal<
    Array<{ id: string; name: string; thumbnail: string }>
  >([]);

  onMount(() => {
    if (typeof window !== "undefined" && window.desktopCapture) {
      window.desktopCapture.onSourcesAvailable((sources) => {
        setPickSources(sources);
      });
    }
    debugLog("PTT-WEB", "VoiceContext mounted, checking for desktop PTT API...");
    debugLog("PTT-WEB", "window.pushToTalk exists:", typeof window !== "undefined" && !!window.pushToTalk);
    
    if (typeof window !== "undefined" && window.pushToTalk) {
      debugLog("PTT-WEB", "✓ Desktop PTT API found, initializing integration");

      // Check current state immediately (in case we missed the initial signal)
      const currentState = window.pushToTalk.getCurrentState();
      debugLog("PTT-WEB", "Current PTT state from desktop:", currentState.active ? "ON" : "OFF");

      const handleStateChange = (e: { active: boolean }) => {
        debugLog("PTT-WEB", "Received state change from desktop:", e.active ? "ON" : "OFF");
        debugLog("PTT-WEB", "Current room:", voice.room() ? "connected" : "not connected");
        
        // e.active = true means PTT key is pressed (mic should be ON/unmuted)
        // e.active = false means PTT key is released (mic should be OFF/muted)
        if (voice.room()) {
          const shouldEnableMic = e.active;
          debugLog("PTT-WEB", "PTT active:", e.active, "-> Mic enabled:", shouldEnableMic);
          voice.setMute(shouldEnableMic);
        } else {
          debugLog("PTT-WEB", "⚠ No active room, cannot mute/unmute");
        }
      };
      
      handleStateChange(currentState);

      debugLog("PTT-WEB", "Registering onStateChange listener...");
      window.pushToTalk.onStateChange(handleStateChange);
      debugLog("PTT-WEB", "✓ Listener registered");

      // Sync initial config from desktop to web client (config file is source of truth)
      debugLog("PTT-WEB", "Syncing PTT config from desktop...");
      const handleConfigChange = (config: {
        enabled: boolean;
        keybind: string;
        mode: "hold" | "toggle";
        releaseDelay: number;
      }) => {
        debugLog("PTT-WEB", "Received config from desktop:", config);
        state.voice.setPushToTalkConfig(config);
      };

      // get initial config
      const initialConfig = window.pushToTalk.getConfig();
      debugLog("PTT-WEB", "Initial config from desktop:", initialConfig);
      state.voice.setPushToTalkConfig(initialConfig);

      // listen for future config changes
      window.pushToTalk.onConfigChange(handleConfigChange);
      debugLog("PTT-WEB", "✓ Config sync initialized");

      onCleanup(() => {
        debugLog("PTT-WEB", "Cleaning up PTT listener");
        window.pushToTalk?.offStateChange(handleStateChange);
        window.pushToTalk?.offConfigChange(handleConfigChange);
      });
    } else {
      debugLog("PTT-WEB", "✗ Desktop PTT API not available (running in browser?)");
    }

    // setup voice notification sounds
    const currentClient = client();
    console.log("[VoiceNotifications] Setting up notifications, client available:", !!currentClient);
    
    if (!currentClient) {
      console.log("[VoiceNotifications] Client not available yet, skipping setup");
    } else {
      // console.log("[VoiceNotifications] Registering event listeners");
      
      const onJoin = (channel: Channel, participant: { userId: string }) => {
        // console.log("[VoiceNotifications] VoiceChannelJoin event received:", {
        //   channelId: channel.id,
        //   participantId: participant.userId,
        //   currentChannelId: voice.channel()?.id,
        //   currentUserId: currentClient.user?.id,
        //   shouldPlay: voice.channel()?.id === channel.id && participant.userId !== currentClient.user?.id
        // });
        if (voice.channel()?.id === channel.id && participant.userId !== currentClient.user?.id) {
          console.log("[VoiceNotifications] Playing join sound");
          voiceNotifications.playJoin();
        }
      };

      const onLeave = (channel: Channel, userId: string) => {
        // console.log("[VoiceNotifications] VoiceChannelLeave event received:", {
        //   channelId: channel.id,
        //   userId: userId,
        //   currentChannelId: voice.channel()?.id,
        //   currentUserId: currentClient.user?.id,
        //   shouldPlay: voice.channel()?.id === channel.id && userId !== currentClient.user?.id
        // });
        if (voice.channel()?.id === channel.id && userId !== currentClient.user?.id) {
          console.log("[VoiceNotifications] Playing leave sound");
          voiceNotifications.playLeave();
        }
      };

      currentClient.on("voiceChannelJoin", onJoin);
      currentClient.on("voiceChannelLeave", onLeave);
      console.log("[VoiceNotifications] Event listeners registered");

      onCleanup(() => {
        console.log("[VoiceNotifications] Cleaning up event listeners");
        currentClient.off("voiceChannelJoin", onJoin);
        currentClient.off("voiceChannelLeave", onLeave);
      });
    }
  });

  // sync notification settings reactively
  createEffect(() => {
    // track master settings
    const enabled = state.voice.notificationSoundsEnabled;
    const volume = state.voice.notificationVolume;
    
    // track individual sound toggles (force reactivity)
    const soundJoinCall = state.voice.soundJoinCall;
    const soundLeaveCall = state.voice.soundLeaveCall;
    const soundSomeoneJoined = state.voice.soundSomeoneJoined;
    const soundSomeoneLeft = state.voice.soundSomeoneLeft;
    const soundMute = state.voice.soundMute;
    const soundUnmute = state.voice.soundUnmute;
    const soundReceiveMessage = state.voice.soundReceiveMessage;
    
    console.log("[VoiceNotifications] Settings updated - enabled:", enabled, "volume:", volume);
    
    // apply settings to notification manager
    voiceNotifications.setEnabled(enabled);
    voiceNotifications.setVolume(volume);
    
    // sync individual sound toggles
    voiceNotifications.setSoundEnabled("join_call", soundJoinCall);
    voiceNotifications.setSoundEnabled("leave_call", soundLeaveCall);
    voiceNotifications.setSoundEnabled("someone_joined", soundSomeoneJoined);
    voiceNotifications.setSoundEnabled("someone_left", soundSomeoneLeft);
    voiceNotifications.setSoundEnabled("mute", soundMute);
    voiceNotifications.setSoundEnabled("unmute", soundUnmute);
    voiceNotifications.setSoundEnabled("receive_message", soundReceiveMessage);
  });

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
        <Show when={pickSources().length > 0}>
          <ScreenSharePicker
            sources={pickSources()}
            onSelect={(id) => {
              window.desktopCapture!.selectSource(id);
              setPickSources([]);
            }}
            onCancel={() => {
              window.desktopCapture!.cancel();
              setPickSources([]);
            }}
          />
        </Show>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
