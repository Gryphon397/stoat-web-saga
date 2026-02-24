/**
 * Voice notification sound manager
 * Uses preloaded .wav files for voice channel events
 */

type SoundName =
  | "join_call"
  | "leave_call"
  | "someone_joined"
  | "someone_left"
  | "mute"
  | "unmute"
  | "receive_message";

const SOUND_FILES: Record<SoundName, string> = {
  join_call: "/assets/audio/join_call.wav",
  leave_call: "/assets/audio/leave_call.wav",
  someone_joined: "/assets/audio/someone_joined.wav",
  someone_left: "/assets/audio/someone_left.wav",
  mute: "/assets/audio/mute.wav",
  unmute: "/assets/audio/unmute.wav",
  receive_message: "/assets/audio/receive_message.wav",
};

class VoiceNotificationManager {
  private enabled = true;
  private volume = 0.25; 
  private audioBuffers = new Map<SoundName, AudioBuffer>();
  private audioContext: AudioContext | null = null;
  private hasUserInteracted = false;
  private currentlyPlaying = new Set<SoundName>(); 

  constructor() {
    this.handleUserInteraction = this.handleUserInteraction.bind(this);

    if (typeof window !== "undefined") {
      const events = ["click", "keydown", "touchstart"];
      events.forEach((event) => {
        document.addEventListener(event, this.handleUserInteraction, {
          once: true,
        });
      });
    }
  }

  private handleUserInteraction() {
    this.hasUserInteracted = true;
    if (this.audioContext?.state === "suspended") {
      this.audioContext.resume();
    }
    this.preloadAll();
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;

    if (!this.audioContext) {
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return null;
      this.audioContext = new AudioContextClass();
    }

    return this.audioContext;
  }

  private async preloadAll() {
    const ctx = this.getAudioContext();
    if (!ctx) return;

    const entries = Object.entries(SOUND_FILES) as [SoundName, string][];
    await Promise.all(
      entries.map(async ([name, path]) => {
        if (this.audioBuffers.has(name)) return;
        try {
          const response = await fetch(path);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          this.audioBuffers.set(name, audioBuffer);
        } catch (e) {
          console.warn(`[VoiceNotifications] Failed to preload ${name}:`, e);
        }
      }),
    );
  }

  // individual sound toggles
  private soundToggles: Record<SoundName, boolean> = {
    join_call: true,
    leave_call: true,
    someone_joined: true,
    someone_left: true,
    mute: true,
    unmute: true,
    receive_message: true,
  };

  /**
   * Set individual sound toggle
   */
  setSoundEnabled(name: SoundName, enabled: boolean): void {
    this.soundToggles[name] = enabled;
  }

  /**
   * Get individual sound toggle
   */
  isSoundEnabled(name: SoundName): boolean {
    return this.enabled && this.soundToggles[name];
  }

  private async playSound(name: SoundName): Promise<void> {
    if (!this.isSoundEnabled(name)) return;
    
    // prevent overlapping sounds
    if (this.currentlyPlaying.has(name)) return;

    const ctx = this.getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended" && this.hasUserInteracted) {
      await ctx.resume();
    }
    if (ctx.state === "suspended") return;

    let buffer = this.audioBuffers.get(name);
    if (!buffer) {
      try {
        const response = await fetch(SOUND_FILES[name]);
        const arrayBuffer = await response.arrayBuffer();
        buffer = await ctx.decodeAudioData(arrayBuffer);
        this.audioBuffers.set(name, buffer);
      } catch (e) {
        console.warn(`[VoiceNotifications] Failed to load ${name}:`, e);
        return;
      }
    }

    // mark as playing
    this.currentlyPlaying.add(name);

    const source = ctx.createBufferSource();
    const gainNode = ctx.createGain();
    source.buffer = buffer;
    gainNode.gain.value = this.volume;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start();

    source.onended = () => {
      source.disconnect();
      gainNode.disconnect();
      this.currentlyPlaying.delete(name);
    };
  }

  /** Self joining a voice channel */
  playSelfJoin(): void {
    this.playSound("join_call");
  }

  /** Self leaving a voice channel */
  playSelfLeave(): void {
    this.playSound("leave_call");
  }

  /** Someone else joined the voice channel */
  playJoin(): void {
    this.playSound("someone_joined");
  }

  /** Someone else left the voice channel */
  playLeave(): void {
    this.playSound("someone_left");
  }

  /** Local user muted */
  playMute(): void {
    this.playSound("mute");
  }

  /** Local user unmuted */
  playUnmute(): void {
    this.playSound("unmute");
  }

  /** Received a message notification */
  playMessageReceived(): void {
    this.playSound("receive_message");
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getVolume(): number {
    return this.volume;
  }

  destroy(): void {
    if (this.audioContext?.state !== "closed") {
      this.audioContext?.close();
    }
    this.audioContext = null;
    this.audioBuffers.clear();
  }
}

export const voiceNotifications = new VoiceNotificationManager();
