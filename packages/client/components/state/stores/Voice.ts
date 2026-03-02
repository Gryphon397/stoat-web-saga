import { State } from "..";

import { AbstractStore } from ".";

export interface TypeVoice {
  preferredAudioInputDevice?: string;
  preferredAudioOutputDevice?: string;

  echoCancellation: boolean;
  noiseSupression: boolean;
  rnnoise: boolean;

  inputVolume: number;
  outputVolume: number;

  userVolumes: Record<string, number>;
  userMutes: Record<string, boolean>;
  screenshareVolumes: Record<string, number>;
  screenshareMutes: Record<string, boolean>;

  pushToTalkEnabled: boolean;
  pushToTalkKeybind: string;
  pushToTalkMode: "hold" | "toggle";
  pushToTalkReleaseDelay: number;
  pushToTalkNotificationSounds: boolean;

  notificationSoundsEnabled: boolean;
  notificationVolume: number;
  
  // Individual sound toggles
  soundJoinCall: boolean;
  soundLeaveCall: boolean;
  soundSomeoneJoined: boolean;
  soundSomeoneLeft: boolean;
  soundMute: boolean;
  soundUnmute: boolean;
  soundReceiveMessage: boolean;
}

/**
 * Voice settings store
 */
export class Voice extends AbstractStore<"voice", TypeVoice> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "voice");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeVoice {
    return {
      echoCancellation: true,
      noiseSupression: true,
      rnnoise: false,
      inputVolume: 1.0,
      outputVolume: 1.0,
      userVolumes: {},
      userMutes: {},
      screenshareVolumes: {},
      screenshareMutes: {},
      pushToTalkEnabled: false,
      pushToTalkKeybind: "V",
      pushToTalkMode: "hold",
      pushToTalkReleaseDelay: 250,
      pushToTalkNotificationSounds: false,
      notificationSoundsEnabled: true,
      notificationVolume: 0.3,
      soundJoinCall: true,
      soundLeaveCall: true,
      soundSomeoneJoined: true,
      soundSomeoneLeft: true,
      soundMute: true,
      soundUnmute: true,
      soundReceiveMessage: true,
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeVoice>): TypeVoice {
    const data = this.default();

    if (typeof input.preferredAudioInputDevice === "string") {
      data.preferredAudioInputDevice = input.preferredAudioInputDevice;
    }

    if (typeof input.preferredAudioOutputDevice === "string") {
      data.preferredAudioOutputDevice = input.preferredAudioOutputDevice;
    }

    if (typeof input.echoCancellation === "boolean") {
      data.echoCancellation = input.echoCancellation;
    }

    if (typeof input.noiseSupression === "boolean") {
      data.noiseSupression = input.noiseSupression;
    }

    if (typeof input.rnnoise === "boolean") {
      data.rnnoise = input.rnnoise;
    }

    if (typeof input.inputVolume === "number") {
      data.inputVolume = input.inputVolume;
    }

    if (typeof input.outputVolume === "number") {
      data.outputVolume = input.outputVolume;
    }

    if (typeof input.userVolumes === "object") {
      Object.entries(input.userVolumes)
        .filter(
          ([userId, volume]) =>
            typeof userId === "string" && typeof volume === "number",
        )
        .forEach(([k, v]) => (data.userVolumes[k] = v));
    }

    if (typeof input.userMutes === "object") {
      Object.entries(input.userMutes)
        .filter(
          ([userId, muted]) => typeof userId === "string" && muted === true,
        )
        .forEach(([k, v]) => (data.userMutes[k] = v));
    }

    if (typeof input.screenshareVolumes === "object") {
      Object.entries(input.screenshareVolumes)
        .filter(
          ([userId, volume]) =>
            typeof userId === "string" && typeof volume === "number",
        )
        .forEach(([k, v]) => (data.screenshareVolumes[k] = v));
    }

    if (typeof input.screenshareMutes === "object") {
      Object.entries(input.screenshareMutes)
        .filter(
          ([userId, muted]) => typeof userId === "string" && muted === true,
        )
        .forEach(([k, v]) => (data.screenshareMutes[k] = v));
    }

    // push to talk settings
    if (typeof input.pushToTalkEnabled === "boolean") {
      data.pushToTalkEnabled = input.pushToTalkEnabled;
    }

    if (typeof input.pushToTalkKeybind === "string") {
      data.pushToTalkKeybind = input.pushToTalkKeybind;
    }

    if (input.pushToTalkMode === "hold" || input.pushToTalkMode === "toggle") {
      data.pushToTalkMode = input.pushToTalkMode;
    }

    if (
      typeof input.pushToTalkReleaseDelay === "number" &&
      input.pushToTalkReleaseDelay >= 0 &&
      input.pushToTalkReleaseDelay <= 5000
    ) {
      data.pushToTalkReleaseDelay = input.pushToTalkReleaseDelay;
    }

    if (typeof input.pushToTalkNotificationSounds === "boolean") {
      data.pushToTalkNotificationSounds = input.pushToTalkNotificationSounds;
    }


    // notification settings
    if (typeof input.notificationSoundsEnabled === "boolean") {
      data.notificationSoundsEnabled = input.notificationSoundsEnabled;
    }

    if (typeof input.notificationVolume === "number") {
      data.notificationVolume = Math.max(0, Math.min(1, input.notificationVolume));
    }

    // individual sound toggles
    if (typeof input.soundJoinCall === "boolean") {
      data.soundJoinCall = input.soundJoinCall;
    }
    if (typeof input.soundLeaveCall === "boolean") {
      data.soundLeaveCall = input.soundLeaveCall;
    }
    if (typeof input.soundSomeoneJoined === "boolean") {
      data.soundSomeoneJoined = input.soundSomeoneJoined;
    }
    if (typeof input.soundSomeoneLeft === "boolean") {
      data.soundSomeoneLeft = input.soundSomeoneLeft;
    }
    if (typeof input.soundMute === "boolean") {
      data.soundMute = input.soundMute;
    }
    if (typeof input.soundUnmute === "boolean") {
      data.soundUnmute = input.soundUnmute;
    }
    if (typeof input.soundReceiveMessage === "boolean") {
      data.soundReceiveMessage = input.soundReceiveMessage;
    }

    return data;
  }

  /**
   * Set a user's volume
   * @param userId User ID
   * @param volume Volume
   */
  setUserVolume(userId: string, volume: number) {
    this.set("userVolumes", userId, volume);
  }

  /**
   * Get a user's volume
   * @param userId User ID
   * @returns Volume or default
   */
  getUserVolume(userId: string): number {
    return this.get().userVolumes[userId] || 1.0;
  }

  /**
   * Set whether a user is muted
   * @param userId User ID
   * @param muted Whether they should be muted
   */
  setUserMuted(userId: string, muted: boolean) {
    this.set("userMutes", userId, muted);
  }

  /**
   * Get whether a user is muted
   * @param userId User ID
   * @returns Whether muted
   */
  getUserMuted(userId: string): boolean {
    return this.get().userMutes[userId] || false;
  }

  /**
   * Set a user's screenshare audio volume
   * @param userId User ID
   * @param volume Volume
   */
  setScreenshareVolume(userId: string, volume: number) {
    this.set("screenshareVolumes", userId, volume);
  }

  /**
   * Get a user's screenshare audio volume
   * @param userId User ID
   * @returns Volume or default
   */
  getScreenshareVolume(userId: string): number {
    return this.get().screenshareVolumes[userId] ?? 1.5;
  }

  /**
   * Set whether a user's screenshare audio is muted
   * @param userId User ID
   * @param muted Whether it should be muted
   */
  setScreenshareMuted(userId: string, muted: boolean) {
    this.set("screenshareMutes", userId, muted);
  }

  /**
   * Get whether a user's screenshare audio is muted
   * @param userId User ID
   * @returns Whether muted
   */
  getScreenshareMuted(userId: string): boolean {
    return this.get().screenshareMutes[userId] ?? false;
  }

  /**
   * Set the preferred audio input device
   */
  set preferredAudioInputDevice(value: string) {
    this.set("preferredAudioInputDevice", value);
  }

  /**
   * Set the preferred audio output device
   */
  set preferredAudioOutputDevice(value: string) {
    this.set("preferredAudioOutputDevice", value);
  }

  /**
   * Set echo cancellation
   */
  set echoCancellation(value: boolean) {
    this.set("echoCancellation", value);
  }

  /**
   * Set noise cancellation
   */
  set noiseSupression(value: boolean) {
    this.set("noiseSupression", value);
  }

  /**
   * Set RNNoise
   */
  set rnnoise(value: boolean) {
    this.set("rnnoise", value);
    console.log("[Voice] rnnoise setter called:", value);
  }

  /**
   * Set input volume
   */
  set inputVolume(value: number) {
    this.set("inputVolume", value);
  }

  /**
   * Set output volume
   */
  set outputVolume(value: number) {
    this.set("outputVolume", value);
  }

  /**
   * Get the preferred audio input device
   */
  get preferredAudioInputDevice(): string | undefined {
    return this.get().preferredAudioInputDevice;
  }

  /**
   * Get the preferred audio output device
   */
  get preferredAudioOutputDevice(): string | undefined {
    return this.get().preferredAudioInputDevice;
  }

  /**
   * Get echo cancellation
   */
  get echoCancellation(): boolean | undefined {
    return this.get().echoCancellation;
  }

  /**
   * Get noise supression
   */
  get noiseSupression(): boolean | undefined {
    return this.get().noiseSupression;
  }

  /**
   * Get rnnoise
   */
  get rnnoise(): boolean | undefined {
    return this.get().rnnoise;
  }

  /**
   * Get input volume
   */
  get inputVolume(): number {
    return this.get().inputVolume;
  }

  /**
   * Get noise supression
   */
  get outputVolume(): number {
    return this.get().outputVolume;
  }

  /**
   * Set push to talk enabled
   */
  set pushToTalkEnabled(value: boolean) {
    this.set("pushToTalkEnabled", value);
  }

  /**
   * Get push to talk enabled
   */
  get pushToTalkEnabled(): boolean {
    return this.get().pushToTalkEnabled;
  }

  /**
   * Set push to talk keybind
   */
  set pushToTalkKeybind(value: string) {
    this.set("pushToTalkKeybind", value);
  }

  /**
   * Get push to talk keybind
   */
  get pushToTalkKeybind(): string {
    return this.get().pushToTalkKeybind;
  }

  /**
   * Set push to talk mode
   */
  set pushToTalkMode(value: "hold" | "toggle") {
    this.set("pushToTalkMode", value);
  }

  /**
   * Get push to talk mode
   */
  get pushToTalkMode(): "hold" | "toggle" {
    return this.get().pushToTalkMode;
  }

  /**
   * Set push to talk release delay
   */
  set pushToTalkReleaseDelay(value: number) {
    this.set("pushToTalkReleaseDelay", value);
  }

  /**
   * Get push to talk release delay
   */
  get pushToTalkReleaseDelay(): number {
    return this.get().pushToTalkReleaseDelay;
  }

  /**
   * Get push to talk notification sounds
   */
  get pushToTalkNotificationSounds(): boolean {
    return this.get().pushToTalkNotificationSounds;
  }

  /**
   * Set push to talk notification sounds
   */
  set pushToTalkNotificationSounds(value: boolean) {
    this.set("pushToTalkNotificationSounds", value);
  }

  /**
   * Set all push to talk config at once (from external source like desktop app)
   */
  setPushToTalkConfig(config: {
    enabled?: boolean;
    keybind?: string;
    mode?: "hold" | "toggle";
    releaseDelay?: number;
    notificationSounds?: boolean;
  }) {
    if (import.meta.env.DEV) {
      console.log("[Voice] Setting PTT config from external source:", config);
    }
    if (typeof config.enabled === "boolean") {
      this.set("pushToTalkEnabled", config.enabled);
    }
    if (typeof config.keybind === "string") {
      this.set("pushToTalkKeybind", config.keybind);
    }
    if (config.mode === "hold" || config.mode === "toggle") {
      this.set("pushToTalkMode", config.mode);
    }
    if (typeof config.releaseDelay === "number") {
      this.set("pushToTalkReleaseDelay", config.releaseDelay);
    }
    if (typeof config.notificationSounds === "boolean") {
      this.set("pushToTalkNotificationSounds", config.notificationSounds);
    }
  }

  /**
   * Get notification sounds enabled
   */
  get notificationSoundsEnabled(): boolean {
    return this.get().notificationSoundsEnabled;
  }

  /**
   * Set notification sounds enabled
   */
  set notificationSoundsEnabled(value: boolean) {
    this.set("notificationSoundsEnabled", value);
  }

  /**
   * Get notification volume
   */
  get notificationVolume(): number {
    return this.get().notificationVolume;
  }

  /**
   * Set notification volume
   */
  set notificationVolume(value: number) {
    this.set("notificationVolume", value);
  }

  /**
   * Get sound: join call
   */
  get soundJoinCall(): boolean {
    return this.get().soundJoinCall;
  }

  /**
   * Set sound: join call
   */
  set soundJoinCall(value: boolean) {
    this.set("soundJoinCall", value);
  }

  /**
   * Get sound: leave call
   */
  get soundLeaveCall(): boolean {
    return this.get().soundLeaveCall;
  }

  /**
   * Set sound: leave call
   */
  set soundLeaveCall(value: boolean) {
    this.set("soundLeaveCall", value);
  }

  /**
   * Get sound: someone joined
   */
  get soundSomeoneJoined(): boolean {
    return this.get().soundSomeoneJoined;
  }

  /**
   * Set sound: someone joined
   */
  set soundSomeoneJoined(value: boolean) {
    this.set("soundSomeoneJoined", value);
  }

  /**
   * Get sound: someone left
   */
  get soundSomeoneLeft(): boolean {
    return this.get().soundSomeoneLeft;
  }

  /**
   * Set sound: someone left
   */
  set soundSomeoneLeft(value: boolean) {
    this.set("soundSomeoneLeft", value);
  }

  /**
   * Get sound: mute
   */
  get soundMute(): boolean {
    return this.get().soundMute;
  }

  /**
   * Set sound: mute
   */
  set soundMute(value: boolean) {
    this.set("soundMute", value);
  }

  /**
   * Get sound: unmute
   */
  get soundUnmute(): boolean {
    return this.get().soundUnmute;
  }

  /**
   * Set sound: unmute
   */
  set soundUnmute(value: boolean) {
    this.set("soundUnmute", value);
  }

  /**
   * Get sound: receive message
   */
  get soundReceiveMessage(): boolean {
    return this.get().soundReceiveMessage;
  }

  /**
   * Set sound: receive message
   */
  set soundReceiveMessage(value: boolean) {
    this.set("soundReceiveMessage", value);
  }
}
