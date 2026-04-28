import { Show } from "solid-js";

import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";
import { CategoryCollapse } from "@revolt/ui/components/design/CategoryButton";

export function VoiceProcessingOptions() {
  const state = useState();

  return (
    <Column>
      <Text class="title">Input Sensitivity</Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.inputSensitivityAuto} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.inputSensitivityAuto = !state.voice.inputSensitivityAuto;
          }}
        >
          Automatically determine input sensitivity
        </CategoryButton>
      </CategoryButton.Group>
      <Show when={!state.voice.inputSensitivityAuto}>
        <Column>
          <Text class="label">Sensitivity Threshold ({(state.voice.inputSensitivity ?? -60).toFixed(0)} dBFS)</Text>
          <Slider
            min={-100}
            max={-20}
            step={1}
            value={state.voice.inputSensitivity ?? -60}
            onInput={(event) => {
              state.voice.inputSensitivity = Number(event.currentTarget.value);
            }}
            labelFormatter={(label) => `${label.toFixed(0)} dB`}
          />
        </Column>
      </Show>
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
      </CategoryButton.Group>
      <Show when={state.voice.noiseSupression}>
        <Column>
          <Text class="label">Suppression Level</Text>
          <Slider
            min={0}
            max={100}
            step={5}
            value={state.voice.noiseSupressionLevel}
            onInput={(event) =>
              (state.voice.noiseSupressionLevel = Number(event.currentTarget.value))
            }
            labelFormatter={(label) => label.toFixed(0)}
          />
        </Column>
      </Show>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.echoCancellation} style={{ "pointer-events": "none" }} />}
          onClick={() => {
            state.voice.echoCancellation = !state.voice.echoCancellation;
          }}
        >
          Echo Cancellation
        </CategoryButton>
      </CategoryButton.Group>
      {/* [VAD-IMPROVEMENT-#8] Silero VAD toggle */}
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={state.voice.useSileroVad} style={{ "pointer-events": "none" }} />}
          description="Adds a neural-network voice classifier on top of the input sensitivity gate. Reduces false triggers from non-speech sounds (typing, sneezes, fans). Loads ~6 MB on first use."
          onClick={() => {
            state.voice.useSileroVad = !state.voice.useSileroVad;
          }}
        >
          Smart Voice Detection (Silero VAD)
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
