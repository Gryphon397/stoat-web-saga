import { Show, splitProps } from "solid-js";

import { Avatar, Props as AvatarProps } from "./Avatar";

type Props = AvatarProps & {
  /**
   * URL of the decoration APNG to render on top of the avatar.
   * If undefined/null, renders a plain Avatar.
   */
  decorationUrl?: string | null;
};

/**
 * Avatar with an optional animated decoration overlay.
 * The decoration is rendered at 160% of the avatar size, centered (Discord standard).
 */
export function DecoratedAvatar(props: Props) {
  const [local, avatarProps] = splitProps(props, ["decorationUrl"]);

  return (
    <Show when={local.decorationUrl} fallback={<Avatar {...avatarProps} />}>
      <div
        style={{
          "--av": `${avatarProps.size ?? 32}px`,
          position: "relative",
          display: "inline-block",
          "flex-shrink": "0",
          "line-height": "0",
          "vertical-align": "middle",
          width: "var(--av)",
          height: "var(--av)",
        }}
      >
        <Avatar {...avatarProps} />
        <img
          src={local.decorationUrl!}
          style={{
            position: "absolute",
            top: "calc(var(--av) * -0.125)",
            left: "calc(var(--av) * -0.125)",
            width: "calc(var(--av) * 1.25)",
            height: "calc(var(--av) * 1.25)",
            "max-width": "none",
            "max-height": "none",
            "pointer-events": "none",
          }}
          draggable="false"
        />
      </div>
    </Show>
  );
}
