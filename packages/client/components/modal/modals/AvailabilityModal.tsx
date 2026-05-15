import { createSignal } from "solid-js";
import { styled } from "styled-system/jsx";

import { Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

const PRESETS = [
  { label: "+30m", ms: 30 * 60 * 1000 },
  { label: "+1h", ms: 60 * 60 * 1000 },
  { label: "+2h", ms: 2 * 60 * 60 * 1000 },
  { label: "+3h", ms: 3 * 60 * 60 * 1000 },
  { label: "+4h", ms: 4 * 60 * 60 * 1000 },
];

function formatAvailability(ts: number): string {
  const diffMs = ts - Date.now();
  if (diffMs < 60 * 60 * 1000)
    return `Available in ${Math.round(diffMs / 60000)}m`;
  if (diffMs < 12 * 60 * 60 * 1000)
    return `Available in ${Math.round(diffMs / 3600000)}h`;
  return `Available at ${new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function AvailabilityModal(
  props: DialogProps & Modals & { type: "availability" },
) {
  const { showError } = useModals();
  const user = props.client.user!;

  const existingAvailTs = (() => {
    const text = user.status?.text;
    if (!text?.startsWith("__avail__")) return null;
    const ts = parseInt(text.slice(9), 10);
    return !isNaN(ts) && ts > Date.now() ? ts : null;
  })();

  const [presetMs, setPresetMs] = createSignal<number | null>(null);
  const [customTime, setCustomTime] = createSignal("");

  function targetMs(): number | null {
    const p = presetMs();
    if (p !== null) return Date.now() + p;
    const t = customTime();
    if (t) {
      const [hh, mm] = t.split(":").map(Number);
      const target = new Date();
      target.setHours(hh, mm, 0, 0);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
    return null;
  }

  async function onSubmit() {
    const ts = targetMs();
    if (!ts) return;
    try {
      await user.edit({
        status: { ...user.status, text: `__avail__${ts}` },
      });
      props.onClose();
    } catch (err) {
      showError(err);
    }
  }

  async function onClear() {
    try {
      await user.edit({ remove: ["StatusText"] });
      props.onClose();
    } catch (err) {
      showError(err);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title="Set availability"
      actions={[
        ...(existingAvailTs
          ? [
              {
                text: "Clear",
                onClick: () => {
                  onClear();
                  return false;
                },
              },
            ]
          : []),
        { text: "Close" },
        {
          text: "Set",
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !targetMs(),
        },
      ]}
    >
      <Column>
        <PresetRow>
          {PRESETS.map((p) => (
            <PresetButton
              type="button"
              data-selected={presetMs() === p.ms}
              onClick={() => {
                setCustomTime("");
                setPresetMs(presetMs() === p.ms ? null : p.ms);
              }}
            >
              {p.label}
            </PresetButton>
          ))}
        </PresetRow>
        <TimeInput
          type="time"
          value={customTime()}
          onInput={(e) => {
            setPresetMs(null);
            setCustomTime(e.currentTarget.value);
          }}
        />
        {targetMs() && (
          <PreviewText>
            Others will see: <strong>{formatAvailability(targetMs()!)}</strong>
          </PreviewText>
        )}
        {!targetMs() && existingAvailTs && (
          <PreviewText>
            Current: <strong>{formatAvailability(existingAvailTs)}</strong>
          </PreviewText>
        )}
      </Column>
    </Dialog>
  );
}

const PresetRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const PresetButton = styled("button", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    border: "2px solid var(--md-sys-color-outline-variant)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    _hover: {
      borderColor: "var(--md-sys-color-primary)",
      color: "var(--md-sys-color-primary)",
    },
    "&[data-selected=true]": {
      background: "var(--md-sys-color-primary-container)",
      borderColor: "var(--md-sys-color-primary)",
      color: "var(--md-sys-color-on-primary-container)",
    },
  },
});

const TimeInput = styled("input", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
    width: "100%",
    boxSizing: "border-box",
  },
});

const PreviewText = styled("div", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
