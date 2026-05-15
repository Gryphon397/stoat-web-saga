import { Show, createSignal } from "solid-js";

import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/client";
import { useState } from "@revolt/state";
import { DecoratedAvatar, OverflowingText, UserStatus, typography } from "@revolt/ui";

import { UserMenu } from "../servers/UserMenu";

export function UserPanel() {
  const user = useUser();
  const state = useState();

  const [cardRef, setCardRef] = createSignal<HTMLDivElement>();

  const decorationUrl = () =>
    user() ? state.decorations.getDecorationUrl(user()!.id) : undefined;
  const nameplateUrl = () =>
    user() ? state.nameplates.getNameplateUrl(user()!.id) : undefined;

  return (
    <PanelBase>
      <CardArea
        ref={setCardRef}
        style={
          nameplateUrl()
            ? {
                "background-image": `url(${nameplateUrl()})`,
                "background-size": "100% 100%",
                "background-repeat": "no-repeat",
              }
            : {}
        }
      >
        <DecoratedAvatar
          size={32}
          src={user()?.animatedAvatarURL}
          holepunch="bottom-right"
          overlay={<UserStatus.Graphic status={user()?.presence} />}
          interactive
          decorationUrl={decorationUrl()}
        />
        <UserInfo>
          <OverflowingText class={typography({ class: "label" })}>
            {user()?.displayName}
          </OverflowingText>
          <Show
            when={user()?.statusMessage()}
            fallback={
              <OverflowingText class={typography({ class: "_status" })}>
                {user()?.presence}
              </OverflowingText>
            }
          >
            <OverflowingText class={typography({ class: "_status" })}>
              {user()!.statusMessage()}
            </OverflowingText>
          </Show>
        </UserInfo>
      </CardArea>
      <UserMenu anchor={cardRef} />
    </PanelBase>
  );
}

const PanelBase = styled("div", {
  base: {
    flexShrink: 0,
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const CardArea = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "10px var(--gap-md)",
    cursor: "pointer",
    borderRadius: "var(--borderRadius-md)",
    margin: "var(--gap-sm)",
    transition: "background var(--transitions-fast)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
  },
});

const UserInfo = styled("div", {
  base: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  },
});
