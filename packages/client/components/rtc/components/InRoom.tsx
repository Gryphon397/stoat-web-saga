import { JSX, Show } from "solid-js";
import { useMaybeRoomContext } from "solid-livekit-components";

import { useVoice } from "..";

/**
 * Render only if in a voice call (and optionally check if channelId matches)
 *
 * Like <Show /> exposes fallback prop
 */
export function InRoom(props: {
  channelId?: string;
  children: JSX.Element;
  fallback?: JSX.Element;
}) {
  const room = useMaybeRoomContext();
  const voice = useVoice();

  const condition = () => {
    const r = room?.();
    const s = voice.state();
    const ok = !!r && s === "CONNECTED" && (!props.channelId || props.channelId === voice.channel()?.id);
    console.log('[badge] InRoom check — room:', !!r, 'state:', s, 'ok:', ok);
    return ok;
  };

  return (
    <Show
      when={condition()}
      fallback={props.fallback}
    >
      {props.children}
    </Show>
  );
}
