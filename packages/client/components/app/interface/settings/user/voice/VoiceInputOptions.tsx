import { For } from "solid-js";
import { useMediaDeviceSelect } from "solid-livekit-components";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import { Checkbox, Column, Slider, Text } from "@revolt/ui";
import {
  CategoryButton,
  CategoryCollapse,
} from "@revolt/ui/components/design/CategoryButton";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Input options
 */
export function VoiceInputOptions() {
  return (
    <Column>
      <CategoryButton.Group>
        <SelectMicrophone />
        <SelectSpeaker />
      </CategoryButton.Group>
      <VolumeSliders />
      <CategoryButton.Group>
        <ScreenshareFrameRate />
      </CategoryButton.Group>
    </Column>
  );
}

/**
 * Select audio input
 */
function SelectMicrophone() {
  const { t } = useLingui();
  const state = useState();
  const { activeDeviceId, devices, setActiveMediaDevice } =
    useMediaDeviceSelect({
      kind: "audioinput",
    });

  const activeId = () =>
    (activeDeviceId() === "default"
      ? state.voice.preferredAudioInputDevice
      : undefined) ?? activeDeviceId();

  const description = () =>
    devices().find((device) => device.deviceId === activeId())?.label ??
    t`Using default microphone`;

  return (
    <CategoryCollapse
      icon={<Symbol>mic</Symbol>}
      title={<Trans>Select audio input</Trans>}
      description={description()}
      scrollable
    >
      <For each={devices()}>
        {(device) => (
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={device.deviceId === activeId()} />}
            onClick={() => {
              state.voice.preferredAudioInputDevice = device.deviceId;
              setActiveMediaDevice(device.deviceId);
            }}
          >
            {device.label}
          </CategoryButton>
        )}
      </For>
    </CategoryCollapse>
  );
}

/**
 * Select audio output
 */
function SelectSpeaker() {
  const { t } = useLingui();
  const state = useState();
  const { activeDeviceId, devices, setActiveMediaDevice } =
    useMediaDeviceSelect({
      kind: "audiooutput",
    });

  const activeId = () =>
    (activeDeviceId() === "default"
      ? state.voice.preferredAudioOutputDevice
      : undefined) ?? activeDeviceId();

  const description = () =>
    devices().find((device) => device.deviceId === activeId())?.label ??
    t`Using default speaker`;

  return (
    <CategoryCollapse
      icon={<Symbol>speaker</Symbol>}
      title={<Trans>Select audio output</Trans>}
      description={description()}
      scrollable
    >
      <For each={devices()}>
        {(device) => (
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={device.deviceId === activeId()} />}
            onClick={() => {
              state.voice.preferredAudioOutputDevice = device.deviceId;
              setActiveMediaDevice(device.deviceId);
            }}
          >
            {device.label}
          </CategoryButton>
        )}
      </For>
    </CategoryCollapse>
  );
}

/**
 * Select screenshare frame rate
 */
function ScreenshareFrameRate() {
  const state = useState();
  const rates = [15, 30, 60] as const;

  return (
    <CategoryCollapse
      icon={<Symbol>screen_share</Symbol>}
      title="Screen Share Frame Rate"
      description={`${state.voice.screenshareFrameRate} fps`}
    >
      <For each={rates}>
        {(rate) => (
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={state.voice.screenshareFrameRate === rate} />}
            onClick={() => (state.voice.screenshareFrameRate = rate)}
          >
            {rate} fps
          </CategoryButton>
        )}
      </For>
    </CategoryCollapse>
  );
}

/**
 * Select volume
 */
function VolumeSliders() {
  const state = useState();

  return (
    <Column>
      <Text class="label">
        <Trans>Output Volume</Trans>
      </Text>
      <Slider
        min={0}
        max={3}
        step={0.1}
        value={state.voice.outputVolume}
        onInput={(event) =>
          (state.voice.outputVolume = event.currentTarget.value)
        }
        labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
      />
    </Column>
  );
}
