import { For, Show, createMemo } from "solid-js";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import { Column, Row, Text } from "@revolt/ui";

/**
 * Nameplate picker — shows all available nameplates in a scrollable grid.
 * Selection is saved immediately to the server.
 */
export function NameplatePicker() {
  const client = useClient();
  const state = useState();

  const currentUserId = () => client().user?.id ?? "";
  const currentNameplateId = () =>
    state.nameplates.userNameplates[currentUserId()] ?? null;

  async function select(id: string | null) {
    const uid = currentUserId();
    if (!uid) return;
    await state.nameplates.setNameplate(uid, id);
  }

  const entries = createMemo(() => state.nameplates.catalogue);

  return (
    <Column gap="md">
      <Text class="title" size="large">
        Username Nameplate
      </Text>
      <Text size="small">
        A decorative background displayed behind your username in the chat.
      </Text>

      <Grid>
        {/* "None" tile */}
        <NameplateTile
          selected={currentNameplateId() === null}
          onClick={() => select(null)}
          title="None"
          wide
        >
          <NoneLabel>None</NoneLabel>
        </NameplateTile>
        <For each={entries()}>
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

      <Show when={currentNameplateId()}>
        <Row gap="sm" align>
          <Text size="small">
            Current nameplate:{" "}
            <strong>
              {entries().find((e) => e.id === currentNameplateId())?.name ??
                currentNameplateId()}
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
  wide?: boolean;
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

const NoneLabel = styled("span", {
  base: {
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",
    fontWeight: 500,
  },
});
