import { For, Show, createMemo, createSignal } from "solid-js";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  CircularProgress,
  Column,
  Row,
  Text,
} from "@revolt/ui";

/**
 * Avatar decoration picker — shows all catalogue presets in a scrollable grid,
 * plus a custom-upload option. Selection is saved immediately to the server.
 */
export function DecorationPicker() {
  const client = useClient();
  const state = useState();

  const currentUserId = () => client().user?.id ?? "";
  const currentDecoId = () => state.decorations.userDecorations[currentUserId()] ?? null;

  const [tab, setTab] = createSignal<"decorations" | "flags" | "custom">(
    "decorations"
  );
  const [uploading, setUploading] = createSignal(false);

  const visibleEntries = createMemo(() =>
    state.decorations.catalogue.filter((e) => e.category === tab())
  );

  async function select(id: string | null) {
    const uid = currentUserId();
    if (!uid) return;
    await state.decorations.setDecoration(uid, id);
  }

  async function handleCustomUpload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const fileId = await client().uploadFile(
        "avatars",
        file,
        CONFIGURATION.DEFAULT_MEDIA_URL
      );
      const url = `${CONFIGURATION.DEFAULT_MEDIA_URL}/avatars/${fileId}`;
      await select(`custom:${url}`);
      setTab("custom");
    } catch (err) {
      console.error("[DecorationPicker] upload failed", err);
    } finally {
      setUploading(false);
      // reset input so same file can be re-uploaded
      input.value = "";
    }
  }

  const customUrl = createMemo(() => {
    const id = currentDecoId();
    return id?.startsWith("custom:") ? id.slice("custom:".length) : null;
  });

  return (
    <Column gap="md">
      <Text class="title" size="large">
        Avatar Decoration
      </Text>

      {/* Tab bar */}
      <Row gap="sm">
        <TabButton active={tab() === "decorations"} onClick={() => setTab("decorations")}>
          Decorations
        </TabButton>
        <TabButton active={tab() === "flags"} onClick={() => setTab("flags")}>
          Flags
        </TabButton>
        <TabButton active={tab() === "custom"} onClick={() => setTab("custom")}>
          Custom
        </TabButton>
      </Row>

      <Show when={tab() !== "custom"}>
        {/* "None" tile + preset grid */}
        <Grid>
          <DecoTile
            selected={currentDecoId() === null}
            onClick={() => select(null)}
            title="None"
          >
            <NoneIcon>✕</NoneIcon>
          </DecoTile>
          <For each={visibleEntries()}>
            {(entry) => (
              <DecoTile
                selected={currentDecoId() === entry.id}
                onClick={() => select(entry.id)}
                title={entry.name}
              >
                <img
                  src={entry.url}
                  alt={entry.name}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", "object-fit": "contain" }}
                  draggable="false"
                />
              </DecoTile>
            )}
          </For>
        </Grid>
      </Show>

      <Show when={tab() === "custom"}>
        <Column gap="md">
          <Text size="small">
            Upload your own APNG, GIF, or PNG. It will be used as your avatar frame.
            For best results use a transparent image at 640×640px.
          </Text>
          <Row gap="md" align>
            <label
              class={css({
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--gap-sm)",
                padding: "8px 16px",
                borderRadius: "var(--borderRadius-md)",
                background: "var(--md-sys-color-primary)",
                color: "var(--md-sys-color-on-primary)",
                cursor: uploading() ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontSize: "0.875rem",
                opacity: uploading() ? 0.6 : 1,
              })}
            >
              <Show when={uploading()} fallback="Upload Image">
                <CircularProgress />
                Uploading…
              </Show>
              <input
                type="file"
                accept="image/png,image/apng,image/gif,image/webp"
                style={{ display: "none" }}
                disabled={uploading()}
                onChange={handleCustomUpload}
              />
            </label>
            <Show when={customUrl()}>
              <CategoryButton
                icon="blank"
                action={
                  <span
                    class={css({ fontSize: "0.75rem", color: "var(--md-sys-color-error)" })}
                  >
                    Remove
                  </span>
                }
                onClick={() => select(null)}
              >
                Current custom decoration
              </CategoryButton>
            </Show>
          </Row>
          <Show when={customUrl()}>
            <div style={{ display: "flex", "justify-content": "center" }}>
              <img
                src={customUrl()!}
                alt="Custom decoration preview"
                style={{
                  width: "96px",
                  height: "96px",
                  "object-fit": "contain",
                  "border-radius": "var(--borderRadius-md)",
                }}
              />
            </div>
          </Show>
        </Column>
      </Show>
    </Column>
  );
}

// ── Styled pieces ────────────────────────────────────────────────────────────

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
    gap: "8px",
    maxHeight: "420px",
    overflowY: "auto",
    padding: "4px",
  },
});

function DecoTile(props: {
  selected: boolean;
  onClick: () => void;
  title: string;
  children: import("solid-js").JSXElement;
}) {
  return (
    <div
      title={props.title}
      onClick={props.onClick}
      class={css({
        width: "72px",
        height: "72px",
        borderRadius: "var(--borderRadius-md)",
        border: "2px solid transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: "var(--md-sys-color-surface-container-low)",
        transition: "border-color 0.15s, background 0.15s",
        "&:hover": {
          background: "var(--md-sys-color-surface-container)",
        },
      })}
      style={{
        "border-color": props.selected
          ? "var(--md-sys-color-primary)"
          : "transparent",
      }}
    >
      {props.children}
    </div>
  );
}

const NoneIcon = styled("span", {
  base: {
    fontSize: "1.5rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const TabButton = styled("button", {
  base: {
    padding: "6px 14px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
    transition: "background 0.15s, color 0.15s",
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary)",
      },
      false: {
        background: "var(--md-sys-color-surface-container)",
        color: "var(--md-sys-color-on-surface)",
      },
    },
  },
  defaultVariants: {
    active: false,
  },
});
