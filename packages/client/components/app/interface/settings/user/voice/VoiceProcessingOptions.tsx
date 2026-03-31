import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";
import { CategoryCollapse } from "@revolt/ui/components/design/CategoryButton";

export function VoiceProcessingOptions() {
  const state = useState();

  return (
    <Column>
      <Text class="title">Voice Processing</Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.noiseSupression} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.noiseSupression = !state.voice.noiseSupression;
          }}
        >
          Noise Suppression
        </CategoryButton>


        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.noiseSupression ? false : state.voice.echoCancellation} style={{ "pointer-events": "none", opacity: state.voice.noiseSupression ? 0.5 : 1 }} />}
          onClick={() => {
            if (!state.voice.noiseSupression) {
              state.voice.echoCancellation = !state.voice.echoCancellation;
            }
          }}
        >
          {state.voice.noiseSupression ? "Echo Cancellation (disabled — conflicts with Noise Suppression)" : "Echo Cancellation"}
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.autoGainControl} />}
          onClick={() =>
            (state.voice.autoGainControl = !state.voice.autoGainControl)
          }
        >
          <Trans>Automatic Gain Control</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
