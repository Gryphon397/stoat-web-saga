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
 * When a decoration is present the status overlay is re-rendered in a separate SVG
 * layer AFTER the decoration image so it appears on top of the decoration.
 */
export function DecoratedAvatar(props: Props) {
  const [local, avatarProps] = splitProps(props, ["decorationUrl"]);
  const [overlayProp, innerAvatarProps] = splitProps(avatarProps, ["overlay"]);

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
        {/* Render avatar without overlay so the decoration can go on top first */}
        <Avatar {...innerAvatarProps} />
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
        {/* Re-render the overlay (status dot) in its own SVG on top of the decoration */}
        <Show when={overlayProp.overlay}>
          <svg
            style={{
              position: "absolute",
              top: "0",
              left: "0",
              width: "var(--av)",
              height: "var(--av)",
              "pointer-events": "none",
              overflow: "visible",
            }}
            viewBox="0 0 32 32"
          >
            {overlayProp.overlay}
          </svg>
        </Show>
      </div>
    </Show>
  );
}
