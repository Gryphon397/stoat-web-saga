import { Show } from "solid-js";

import { CONFIGURATION } from "@revolt/common";
import { Column } from "@revolt/ui";

import { PushToTalkSettings } from "./PushToTalkSettings";
import { ScreenShareOptions } from "./ScreenShareOptions";
import { VoiceInputOptions } from "./VoiceInputOptions";
import { VoiceProcessingOptions } from "./VoiceProcessingOptions";

export function VoiceSettings() {
  return (
    <Column gap="lg">
      <VoiceInputOptions />
      <VoiceProcessingOptions />
      <PushToTalkSettings />
      <Show when={CONFIGURATION.ENABLE_VIDEO}>
        <ScreenShareOptions />
      </Show>
    </Column>
  );
}
