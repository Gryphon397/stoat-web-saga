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
 * Avatar decoration picker — shows the catalogue grouped by Discord theme,
 * a Flags tab for our self-added country flags, and a custom-upload tab.
 * Selection is saved immediately to the server.
 */
export function DecorationPicker() {
  const client = useClient();
  const state = useState();

  const currentUserId = () => client().user?.id ?? "";
  const currentDecoId = () => state.decorations.userDecorations[currentUserId()] ?? null;

  const [tab, setTab] = createSignal<"browse" | "flags" | "custom">("browse");
  const [selectedCategory, setSelectedCategory] = createSignal<string | null>(null);
  const [uploading, setUploading] = createSignal(false);

  // Build list of themed categories (everything except "flags") for the chip strip.
  // Retired sorts last so the live shop content is the default focus.
  const categories = createMemo(() => {
    const set = new Set<string>();
    for (const e of state.decorations.catalogue) {
      if (e.category && e.category !== "flags") set.add(e.category);
    }
    return [...set].sort((a, b) => {
      if (a === "Retired") return 1;
      if (b === "Retired") return -1;
      return a.localeCompare(b);
    });
  });

  const visibleEntries = createMemo(() => {
    if (tab() === "flags") {
      return state.decorations.catalogue.filter((e) => e.category === "flags");
    }
    if (tab() === "custom") return [];
    const cat = selectedCategory();
    return state.decorations.catalogue.filter((e) => {
      if (e.category === "flags") return false;
      if (cat === null) return true;
      return e.category === cat;
    });
  });

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
        <TabButton active={tab() === "browse"} onClick={() => setTab("browse")}>
          Browse
        </TabButton>
        <TabButton active={tab() === "flags"} onClick={() => setTab("flags")}>
          Flags
        </TabButton>
        <TabButton active={tab() === "custom"} onClick={() => setTab("custom")}>
          Custom
        </TabButton>
      </Row>

      <Show when={tab() === "browse"}>
        <CategoryChipStrip>
          <CategoryChip
            active={selectedCategory() === null}
            onClick={() => setSelectedCategory(null)}
          >
            All
          </CategoryChip>
          <For each={categories()}>
            {(cat) => (
              <CategoryChip
                active={selectedCategory() === cat}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </CategoryChip>
            )}
          </For>
        </CategoryChipStrip>
      </Show>

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

const CategoryChipStrip = styled("div", {
  base: {
    display: "flex",
    gap: "6px",
    overflowX: "auto",
    paddingBottom: "4px",
    // Keep the strip from stretching parent column when many categories present
    flexShrink: 0,
  },
});

const CategoryChip = styled("button", {
  base: {
    flexShrink: 0,
    padding: "4px 12px",
    borderRadius: "var(--borderRadius-full)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 500,
    whiteSpace: "nowrap",
    transition: "background 0.15s, color 0.15s, border-color 0.15s",
    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary)",
        borderColor: "var(--md-sys-color-primary)",
      },
    },
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
