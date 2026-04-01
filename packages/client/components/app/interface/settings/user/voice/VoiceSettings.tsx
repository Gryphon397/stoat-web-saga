import { Column } from "@revolt/ui";

import { PushToTalkSettings } from "./PushToTalkSettings";
import { VoiceInputOptions } from "./VoiceInputOptions";
import { VoiceProcessingOptions } from "./VoiceProcessingOptions";

/**
 * Configure voice options
 */
export function VoiceSettings() {
  return (
    <Column gap="lg">
      <VoiceInputOptions />
      <VoiceProcessingOptions />
      <PushToTalkSettings />
    </Column>
  );
}
