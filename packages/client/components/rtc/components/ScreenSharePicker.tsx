import { For } from "solid-js";
import { Portal } from "solid-js/web";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";

export interface ScreenShareSource {
  id: string;
  name: string;
  thumbnail: string;
}

interface Props {
  sources: ScreenShareSource[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

const qualityLabel: Record<string, string> = {
  low: "720p",
  high: "1080p",
  "4k": "4K",
};

function SidebarSection(props: { label: string; children: any }) {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
      <div
        style={{
          "font-size": "0.75em",
          "font-weight": "600",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
          color: "var(--md-sys-color-on-surface-variant, #aaa)",
          "margin-bottom": "4px",
        }}
      >
        {props.label}
      </div>
      {props.children}
    </div>
  );
}

function RadioRow(props: { selected: boolean; label: string; onClick: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        padding: "6px 8px",
        "border-radius": "6px",
        cursor: "pointer",
        background: props.selected
          ? "var(--md-sys-color-secondary-container, #3a3a5c)"
          : "transparent",
        color: props.selected
          ? "var(--md-sys-color-on-secondary-container, #fff)"
          : "var(--md-sys-color-on-surface, #fff)",
        transition: "background 0.1s",
      }}
      onClick={props.onClick}
    >
      <div
        style={{
          width: "14px",
          height: "14px",
          "border-radius": "50%",
          border: props.selected
            ? "2px solid var(--md-sys-color-primary, #7c7cff)"
            : "2px solid var(--md-sys-color-on-surface-variant, #888)",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "flex-shrink": "0",
        }}
      >
        {props.selected && (
          <div
            style={{
              width: "6px",
              height: "6px",
              "border-radius": "50%",
              background: "var(--md-sys-color-primary, #7c7cff)",
            }}
          />
        )}
      </div>
      <span style={{ "font-size": "0.9em" }}>{props.label}</span>
    </div>
  );
}

export function ScreenSharePicker(props: Props) {
  const state = useState();
  const voice = useVoice();
  const rates = [15, 30, 60] as const;

  const qualities = () => {
    const q = voice.getEnabledScreenShareQualities();
    return (Object.keys(q) as ScreenShareQualityName[]).filter((k) => k in qualityLabel);
  };

  return (
    <Portal mount={document.getElementById("floating")!}>
      <div
        style={{
          position: "fixed",
          inset: "0",
          "z-index": "100",
          background: "rgba(0, 0, 0, 0.8)",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          padding: "24px",
        }}
        onClick={props.onCancel}
      >
        <div
          style={{
            background: "var(--md-sys-color-surface-container-high, #2b2b2b)",
            "border-radius": "16px",
            padding: "24px",
            "max-width": "900px",
            width: "100%",
            "max-height": "80vh",
            display: "flex",
            "flex-direction": "column",
            gap: "16px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              "font-size": "1.2em",
              "font-weight": "600",
              color: "var(--md-sys-color-on-surface, #fff)",
              "flex-shrink": "0",
            }}
          >
            Choose what to share
          </div>
          <div
            style={{
              display: "flex",
              gap: "16px",
              flex: "1",
              "min-height": "0",
            }}
          >
            {/* Settings sidebar */}
            <div
              style={{
                "flex-shrink": "0",
                width: "120px",
                background: "var(--md-sys-color-surface-container, #1e1e1e)",
                "border-radius": "8px",
                padding: "12px",
                display: "flex",
                "flex-direction": "column",
                gap: "16px",
              }}
            >
              <SidebarSection label="Resolution">
                <For each={qualities()}>
                  {(name) => (
                    <RadioRow
                      selected={state.voice.screenShareQuality === name}
                      label={qualityLabel[name]}
                      onClick={() => (state.voice.screenShareQuality = name)}
                    />
                  )}
                </For>
              </SidebarSection>
              <SidebarSection label="Frame Rate">
                <For each={rates}>
                  {(rate) => (
                    <RadioRow
                      selected={state.voice.screenshareFrameRate === rate}
                      label={`${rate} fps`}
                      onClick={() => (state.voice.screenshareFrameRate = rate)}
                    />
                  )}
                </For>
              </SidebarSection>
            </div>
            {/* Scrollable source grid */}
            <div style={{ flex: "1", overflow: "auto" }}>
              <div
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: "12px",
                }}
              >
                <For each={props.sources}>
                  {(source) => (
                    <div
                      style={{
                        background: "var(--md-sys-color-surface-container, #1e1e1e)",
                        "border-radius": "8px",
                        padding: "8px",
                        cursor: "pointer",
                        display: "flex",
                        "flex-direction": "column",
                        gap: "8px",
                      }}
                      onClick={() => props.onSelect(source.id)}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          "var(--md-sys-color-surface-container-highest, #333)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          "var(--md-sys-color-surface-container, #1e1e1e)";
                      }}
                    >
                      <img
                        src={source.thumbnail}
                        alt={source.name}
                        style={{
                          width: "100%",
                          "aspect-ratio": "16/9",
                          "object-fit": "contain",
                          "border-radius": "4px",
                          background: "#000",
                        }}
                      />
                      <div
                        style={{
                          "font-size": "0.85em",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                          color: "var(--md-sys-color-on-surface, #fff)",
                        }}
                      >
                        {source.name}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
          <button
            style={{
              "align-self": "flex-end",
              "flex-shrink": "0",
              padding: "8px 16px",
              "border-radius": "8px",
              border: "none",
              background: "var(--md-sys-color-surface-container-highest, #333)",
              color: "var(--md-sys-color-on-surface, #fff)",
              cursor: "pointer",
              "font-size": "0.9em",
            }}
            onClick={props.onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </Portal>
  );
}
