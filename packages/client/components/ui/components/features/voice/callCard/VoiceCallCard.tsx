import {
  JSX,
  Show,
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";

import { useVoice } from "@revolt/rtc";

import { VoiceCallCardPiP } from "./VoiceCallCardPiP";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Voice call card context — shows a draggable screenshare preview PiP
 * only when the local user is actively sharing their screen.
 */
export function VoiceCallCardContext(props: { children: JSX.Element }) {
  const voice = useVoice();

  const [corner, setCorner] = createSignal<Corner>("bottom-right");
  const [moving, setMoving] = createSignal<boolean>();
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });

  function position() {
    const c = corner();
    return {
      "--width": "280px",
      "--height": "158px",
      "--padding-x": "32px",
      "--padding-y": "96px",
      transform: `translate(${
        c === "top-left" || c === "bottom-left"
          ? "calc(var(--padding-x) + var(--offset-x))"
          : "calc(100vw - var(--padding-x) - var(--width) + var(--offset-x))"
      }, ${
        c === "top-left" || c === "top-right"
          ? "calc(var(--padding-y) + var(--offset-y))"
          : "calc(100vh - var(--padding-y) - var(--height) + var(--offset-y))"
      })`,
      width: "var(--width)",
      height: "var(--height)",
    };
  }

  createEffect(
    on(moving, (moving) => {
      if (moving) {
        const controller = new AbortController();

        document.addEventListener(
          "mousemove",
          (event) => {
            setOffset((pos) => ({
              x: pos.x + event.movementX,
              y: pos.y + event.movementY,
            }));
          },
          { signal: controller.signal },
        );

        document.addEventListener(
          "mouseup",
          (event) => {
            batch(() => {
              setMoving(false);
              const left = event.clientX < window.outerWidth / 2;
              const top = event.clientY < window.outerHeight / 2;
              setCorner(
                left ? (top ? "top-left" : "bottom-left") : top ? "top-right" : "bottom-right",
              );
            });
          },
          { signal: controller.signal },
        );

        onCleanup(() => controller.abort());
      }
    }),
  );

  return (
    <>
      {props.children}

      <Portal ref={document.getElementById("floating")! as HTMLDivElement}>
        <Show when={voice.screenshare()}>
          <div
            style={{
              position: "fixed",
              "z-index": 10,
              ...position(),
              "pointer-events": "none",
              cursor: moving() ? "grabbing" : "grab",
              "--offset-x": `${moving() ? offset().x : 0}px`,
              "--offset-y": `${moving() ? offset().y : 0}px`,
            }}
            onMouseDown={() => {
              batch(() => {
                setMoving(true);
                setOffset({ x: 0, y: 0 });
              });
            }}
          >
            <VoiceCallCardPiP />
          </div>
        </Show>
      </Portal>
    </>
  );
}
