import { For, Show, createMemo, createSignal } from "solid-js";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import { Column, Row, Text } from "@revolt/ui";

/**
 * Nameplate picker — shows the catalogue grouped by Discord theme, with a
 * horizontal chip strip to filter by category. Selection is saved immediately.
 */
export function NameplatePicker() {
  const client = useClient();
  const state = useState();

  const currentUserId = () => client().user?.id ?? "";
  const currentNameplateId = () =>
    state.nameplates.userNameplates[currentUserId()] ?? null;

  const [selectedCategory, setSelectedCategory] = createSignal<string | null>(null);

  async function select(id: string | null) {
    const uid = currentUserId();
    if (!uid) return;
    await state.nameplates.setNameplate(uid, id);
  }

  const categories = createMemo(() => {
    const set = new Set<string>();
    for (const e of state.nameplates.catalogue) {
      if (e.category) set.add(e.category);
    }
    return [...set].sort((a, b) => {
      if (a === "Retired") return 1;
      if (b === "Retired") return -1;
      return a.localeCompare(b);
    });
  });

  const visibleEntries = createMemo(() => {
    const cat = selectedCategory();
    if (cat === null) return state.nameplates.catalogue;
    return state.nameplates.catalogue.filter((e) => e.category === cat);
  });

  return (
    <Column gap="md">
      <Text class="title" size="large">
        Username Nameplate
      </Text>
      <Text size="small">
        A decorative background displayed behind your username in the chat.
      </Text>

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

      <Grid>
        <For each={visibleEntries()}>
          {(entry) => (
            <NameplateTile
              selected={currentNameplateId() === entry.id}
              onClick={() => select(entry.id)}
              title={entry.name}
            >
              <img
                src={entry.url}
                alt={entry.name}
                loading="lazy"
                style={{ width: "100%", height: "100%", "object-fit": "fill" }}
                draggable="false"
              />
            </NameplateTile>
          )}
        </For>
      </Grid>

      {/* "None" always visible below the grid */}
      <NameplateTile
        selected={currentNameplateId() === null}
        onClick={() => select(null)}
        title="None"
      >
        <NoneLabel>No nameplate</NoneLabel>
      </NameplateTile>

      <Show when={currentNameplateId()}>
        <Row gap="sm" align>
          <Text size="small">
            Current nameplate:{" "}
            <strong>
              {state.nameplates.catalogue.find((e) => e.id === currentNameplateId())
                ?.name ?? currentNameplateId()}
            </strong>
          </Text>
        </Row>
      </Show>
    </Column>
  );
}

// ── Styled pieces ─────────────────────────────────────────────────────────

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "8px",
    maxHeight: "360px",
    overflowY: "auto",
    padding: "4px",
  },
});

function NameplateTile(props: {
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
        height: "40px",
        borderRadius: "var(--borderRadius-sm)",
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

const CategoryChipStrip = styled("div", {
  base: {
    display: "flex",
    gap: "6px",
    overflowX: "auto",
    paddingBottom: "4px",
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

const NoneLabel = styled("span", {
  base: {
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",
    fontWeight: 500,
  },
});
