import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import {
  CategoryButton,
  Checkbox,
  Column,
  KeybindInput,
  Row,
  Slider,
  Text,
  TextField,
} from "@revolt/ui";

/**
 * Sync PTT settings to desktop main process
 */
function syncToDesktop(settings: {
  enabled?: boolean;
  keybind?: string;
  mode?: "hold" | "toggle";
  releaseDelay?: number;
  notificationSounds?: boolean;
}) {
  if (typeof window !== "undefined" && window.pushToTalk?.updateSettings) {
    window.pushToTalk.updateSettings(settings);
  }
}

/**
 * Push to Talk settings configuration
 */
export function PushToTalkSettings() {
  const state = useState();

  return (
    <Column gap="lg">
      <Column>
        <Text class="title" size="small">
          <Trans id="ptt.settings.title">Push to Talk</Trans>
        </Text>

        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.pushToTalkEnabled}
                />
              </div>
            }
            onClick={() => {
              const newValue = !state.voice.pushToTalkEnabled;
              state.voice.pushToTalkEnabled = newValue;
              syncToDesktop({ enabled: newValue });
            }}
          >
            <Trans id="ptt.settings.enable">Enable Push to Talk</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Column>

      <Show when={state.voice.pushToTalkEnabled}>
        <Column gap="md">
          <Text class="label">
            <Trans id="ptt.settings.keybind">Push to Talk Keybind</Trans>
          </Text>
          <KeybindInput
            value={state.voice.pushToTalkKeybind}
            onChange={(value) => {
              state.voice.pushToTalkKeybind = value;
              syncToDesktop({ keybind: value });
            }}
            placeholder="Click to set keybind"
          />
        </Column>

        <Column>
          <Text class="label">
            <Trans id="ptt.settings.notifications">Notification Sounds</Trans>
          </Text>
          <CategoryButton.Group>
            <CategoryButton
              icon="blank"
              action={
                <div style={{ "pointer-events": "none" }}>
                  <Checkbox
                    checked={state.voice.pushToTalkNotificationSounds}
                  />
                </div>
              }
              onClick={() => {
                const newValue = !state.voice.pushToTalkNotificationSounds;
                state.voice.pushToTalkNotificationSounds = newValue;
                syncToDesktop({ notificationSounds: newValue });
              }}
            >
              <Trans id="ptt.settings.playMuteSounds">Play Mute/Unmute Sounds</Trans>
            </CategoryButton>
          </CategoryButton.Group>
          <Text class="label" size="small">
            <Trans id="ptt.settings.muteSoundsDescription">Play sounds when muting/unmuting with Push to Talk</Trans>
          </Text>
        </Column>

        <Column>
          <Text class="label">
            <Trans id="ptt.settings.mode">Mode</Trans>
          </Text>
          <CategoryButton.Group>
            <CategoryButton
              icon="blank"
              action={
                <div style={{ "pointer-events": "none" }}>
                  <Checkbox
                    checked={state.voice.pushToTalkMode === "toggle"}
                  />
                </div>
              }
              onClick={() => {
                const newMode = state.voice.pushToTalkMode === "hold" ? "toggle" : "hold";
                state.voice.pushToTalkMode = newMode;
                syncToDesktop({ mode: newMode });
              }}
            >
              <Trans id="ptt.settings.toggleMode">Enable Toggle Mode</Trans>
            </CategoryButton>
          </CategoryButton.Group>
          <Text class="label" size="small">
            <Trans id="ptt.settings.defaultHold">Default is Hold mode</Trans>
          </Text>
        </Column>

        <Column gap="md">
          <Text class="label">
            <Trans id="ptt.settings.releaseDelay">Release Delay</Trans>
          </Text>
          <Row gap="md">
            <SliderContainer>
              <Slider
                min={0}
                max={5000}
                step={50}
                value={state.voice.pushToTalkReleaseDelay}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  state.voice.pushToTalkReleaseDelay = value;
                  syncToDesktop({ releaseDelay: value });
                }}
                labelFormatter={(value) => `${value}ms`}
              />
            </SliderContainer>
            <TextFieldContainer>
              <TextField
                type="text"
                value={state.voice.pushToTalkReleaseDelay.toString()}
                onChange={(event) => {
                  const value = parseInt(event.currentTarget.value, 10);
                  if (!isNaN(value) && value >= 0 && value <= 5000) {
                    state.voice.pushToTalkReleaseDelay = value;
                    syncToDesktop({ releaseDelay: value });
                  }
                }}
                class={css({
                  width: "80px",
                  textAlign: "center",
                })}
              />
              <Text size="small" class="label">
                ms
              </Text>
            </TextFieldContainer>
          </Row>
        </Column>
      </Show>
    </Column>
  );
}

const SliderContainer = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
  },
});

const TextFieldContainer = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
  },
});
