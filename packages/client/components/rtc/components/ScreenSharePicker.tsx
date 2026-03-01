import { For } from "solid-js";
import { Portal } from "solid-js/web";

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

export function ScreenSharePicker(props: Props) {
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
            background:
              "var(--md-sys-color-surface-container-high, #2b2b2b)",
            "border-radius": "16px",
            padding: "24px",
            "max-width": "800px",
            width: "100%",
            "max-height": "80vh",
            overflow: "auto",
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
            }}
          >
            Choose what to share
          </div>
          <div
            style={{
              display: "grid",
              "grid-template-columns":
                "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "12px",
            }}
          >
            <For each={props.sources}>
              {(source) => (
                <div
                  style={{
                    background:
                      "var(--md-sys-color-surface-container, #1e1e1e)",
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
          <button
            style={{
              "align-self": "flex-end",
              padding: "8px 16px",
              "border-radius": "8px",
              border: "none",
              background:
                "var(--md-sys-color-surface-container-highest, #333)",
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
