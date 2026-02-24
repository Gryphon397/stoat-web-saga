import { Show, type JSX, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import { IconButton } from "./IconButton";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const Container = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
  },
});

const KeybindButton = styled("button", {
  base: {
    flex: 1,
    padding: "12px 16px",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
    fontWeight: 500,
    textAlign: "center",
    cursor: "pointer",
    border: "2px solid transparent",
    transition: "all 0.2s ease",
    minHeight: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
      background: "var(--md-sys-color-primary-container)",
    },

    "&.capturing": {
      borderColor: "var(--md-sys-color-primary)",
      background: "var(--md-sys-color-primary-container)",
      color: "var(--md-sys-color-on-primary-container)",
    },

    "&.empty": {
      color: "var(--md-sys-color-on-surface-variant)",
      fontStyle: "italic",
    },
  },
});

/**
 * Keybind input component for capturing keyboard shortcuts
 * Similar to Discord's keybind input
 */
export function KeybindInput(props: Props) {
  const [capturing, setCapturing] = createSignal(false);
  const [displayValue, setDisplayValue] = createSignal(props.value);

  onMount(() => {
    setDisplayValue(props.value);
  });

  // update displayValue when props.value changes externally
  createEffect(() => {
    if (!capturing()) {
      setDisplayValue(props.value);
    }
  });

  const startCapturing = () => {
    setCapturing(true);
  };

  const stopCapturing = () => {
    setCapturing(false);
  };

  const clearKeybind = () => {
    setDisplayValue("");
    props.onChange("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      if (displayValue() === "") {
        stopCapturing();
      } else {
        clearKeybind();
      }
      return;
    }

    const keys: string[] = [];

    if (e.ctrlKey && e.key !== "Control") keys.push("Ctrl");
    if (e.altKey && e.key !== "Alt") keys.push("Alt");
    if (e.shiftKey && e.key !== "Shift") keys.push("Shift");
    if (e.metaKey && e.key !== "Meta") keys.push("Meta");

    const modifierKeys = ["Control", "Alt", "Shift", "Meta"];
    if (!modifierKeys.includes(e.key)) {
      let key = e.key;
      if (key.length === 1) {
        key = key.toUpperCase();
      }
      keys.push(key);
    }

    if (keys.length === 0) {
      if (modifierKeys.includes(e.key)) {
        keys.push(e.key);
      }
      return;
    }

    const keybind = keys.join("+");
    setDisplayValue(keybind);
    props.onChange(keybind);
    stopCapturing();
  };

  const handleBlur = () => {
    stopCapturing();
  };

  return (
    <Container>
      <KeybindButton
        class={
          capturing()
            ? "capturing"
            : displayValue() === ""
              ? "empty"
              : undefined
        }
        onClick={startCapturing}
        onKeyDown={capturing() ? handleKeyDown : undefined}
        onBlur={handleBlur}
        tabIndex={0}
      >
        {capturing()
          ? "Press any key combination..."
          : displayValue() || props.placeholder || "Click to set keybind"}
      </KeybindButton>
      <Show when={displayValue() !== ""}>
        <IconButton
          variant="standard"
          size="md"
          onPress={clearKeybind}
          title="Clear keybind"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="20"
            width="20"
            viewBox="0 96 960 960"
            fill="currentColor"
          >
            <path d="m249 849-42-42 231-231-231-231 42-42 231 231 231-231 42 42-231 231 231 231-42 42-231-231-231 231Z" />
          </svg>
        </IconButton>
      </Show>
    </Container>
  );
}

