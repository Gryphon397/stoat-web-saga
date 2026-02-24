import { Trans } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import {
  CategoryButton,
  Checkbox,
  Column,
  Row,
  Slider,
  Text,
  TextField,
} from "@revolt/ui";

/**
 * Notification sounds settings configuration
 */
export function NotificationSoundsSettings() {
  const state = useState();
  
  const individualSoundsDisabled = () => !state.voice.notificationSoundsEnabled;

  return (
    <Column gap="lg">
      <Column>
        <Text class="title" size="small">
          <Trans id="notifications.sounds.title">Notification Sounds</Trans>
        </Text>

        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.notificationSoundsEnabled}
                />
              </div>
            }
            onClick={() => {
              state.voice.notificationSoundsEnabled = !state.voice.notificationSoundsEnabled;
            }}
          >
            <Trans id="notifications.sounds.enable">Enable Notification Sounds</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Column>

      <Column gap="md">
        <Text class="label">
          <Trans id="notifications.sounds.volume">Master Volume</Trans>
        </Text>
        <Row gap="md" align="center">
          <SliderContainer>
            <Slider
              min={0}
              max={100}
              step={1}
              disabled={individualSoundsDisabled()}
              value={state.voice.notificationVolume * 100}
              onInput={(event) => {
                if (!individualSoundsDisabled()) {
                  const value = event.currentTarget.value;
                  state.voice.notificationVolume = value / 100;
                }
              }}
              labelFormatter={(value) => `${value}%`}
            />
          </SliderContainer>
          <TextFieldContainer>
            <TextField
              type="text"
              disabled={individualSoundsDisabled()}
              value={Math.round(state.voice.notificationVolume * 100).toString()}
              onChange={(event) => {
                if (!individualSoundsDisabled()) {
                  const value = parseInt(event.currentTarget.value, 10);
                  if (!isNaN(value) && value >= 0 && value <= 100) {
                    state.voice.notificationVolume = value / 100;
                  }
                }
              }}
              class={css({
                width: "60px",
                textAlign: "center",
              })}
            />
            <Text size="small" class="label">
              %
            </Text>
          </TextFieldContainer>
        </Row>
      </Column>

      <Column>
        <Text class="label">
          <Trans id="notifications.sounds.individual">Individual Sounds</Trans>
        </Text>
        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundJoinCall}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundJoinCall = !state.voice.soundJoinCall;
              }
            }}
          >
            <Trans id="notifications.sounds.joinCall">Join Call</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundLeaveCall}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundLeaveCall = !state.voice.soundLeaveCall;
              }
            }}
          >
            <Trans id="notifications.sounds.leaveCall">Leave Call</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundSomeoneJoined}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundSomeoneJoined = !state.voice.soundSomeoneJoined;
              }
            }}
          >
            <Trans id="notifications.sounds.someoneJoined">Someone Joined</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundSomeoneLeft}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundSomeoneLeft = !state.voice.soundSomeoneLeft;
              }
            }}
          >
            <Trans id="notifications.sounds.someoneLeft">Someone Left</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundMute}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundMute = !state.voice.soundMute;
              }
            }}
          >
            <Trans id="notifications.sounds.mute">Mute</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundUnmute}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundUnmute = !state.voice.soundUnmute;
              }
            }}
          >
            <Trans id="notifications.sounds.unmute">Unmute</Trans>
          </CategoryButton>

          <CategoryButton
            icon="blank"
            disabled={individualSoundsDisabled()}
            action={
              <div style={{ "pointer-events": "none" }}>
                <Checkbox
                  checked={state.voice.soundReceiveMessage}
                  disabled={individualSoundsDisabled()}
                />
              </div>
            }
            onClick={() => {
              if (!individualSoundsDisabled()) {
                state.voice.soundReceiveMessage = !state.voice.soundReceiveMessage;
              }
            }}
          >
            <Trans id="notifications.sounds.receiveMessage">Receive Message</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Column>
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
