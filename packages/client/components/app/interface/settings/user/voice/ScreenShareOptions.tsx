import { Trans } from "@lingui-solid/solid/macro";
import { For } from "solid-js";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

export function ScreenShareOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();

  const qualities = voiceContext.getEnabledScreenShareQualities();

  return (
    <Column>
      <Text class="title">
        <Trans>Screen Share Settings</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>screen_share</Symbol>}
          action={
            <select
              value={voice.screenShareQuality}
              onChange={(e) =>
                (voice.screenShareQuality = e.currentTarget.value as ScreenShareQualityName)
              }
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit" }}
              onClick={(e) => e.stopPropagation()}
            >
              <For each={Object.keys(qualities) as ScreenShareQualityName[]}>
                {(name) => (
                  <option value={name} style={{ background: "var(--md-sys-color-surface)" }}>
                    {qualities[name]!.fullName}
                  </option>
                )}
              </For>
            </select>
          }
        >
          <Trans>Screen share quality</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.screenShareQualityAsk} />}
          onClick={() =>
            (voice.screenShareQualityAsk = !voice.screenShareQualityAsk)
          }
        >
          <Trans>Always ask for quality before sharing</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
