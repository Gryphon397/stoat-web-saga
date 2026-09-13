import {
  Accessor,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Channel, User } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useDurationFormat } from "@revolt/i18n/durations";
import { useUsers } from "@revolt/markdown/users";
import { Avatar, OverflowingText, Symbol, typography } from "@revolt/ui";

interface Props {
  channel: Channel;
}

/**
 * Seconds remaining until `target`, re-evaluated once a second while a target
 * is set.
 *
 * Upstream uses createCountdownFromNow from @solid-primitives/date. We skip
 * that dependency for the same reason the shared clock does (Upstream/U15):
 * pulling it in re-resolves the entire lockfile for a handful of lines.
 */
function createSecondsRemaining(target: Accessor<number | undefined>) {
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    if (!target()) return;

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  return () => {
    const ts = target();
    if (!ts) return 0;
    return Math.max(0, Math.ceil((ts - now()) / 1000));
  };
}

/**
 * Split a number of seconds into an Intl duration
 */
function asDuration(totalSeconds: number) {
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/**
 * Bar between the message list and the composition box, carrying the typing
 * indicator and the slowmode state.
 */
export function CompositionInfo(props: Props) {
  const { t } = useLingui();
  const durationFormat = useDurationFormat();
  const client = useClient();

  const isSlowmodeExempt = (): boolean =>
    props.channel.havePermission("BypassSlowmode");

  const cooldownTarget = createMemo(() => {
    if (!props.channel.slowmode || isSlowmodeExempt()) return;

    const entry = props.channel.userSlowmode();
    if (!entry) return;

    const receivedAt = entry.receivedAt ?? Date.now();
    // Add 100 ms here so the countdown has a bit to render
    return receivedAt + 100 + entry.retry_after * 1000;
  });

  const cooldownRemaining = createSecondsRemaining(cooldownTarget);

  const slowmodeText = () =>
    durationFormat(asDuration(cooldownRemaining()), { style: "digital" });

  const slowmodeWaitTime = () =>
    props.channel.slowmode
      ? durationFormat(asDuration(props.channel.slowmode))
      : "";

  /**
   * Generate list of user IDs
   * @returns User IDs
   */
  const userIds = () =>
    (
      props.channel.typing.filter(
        (user) =>
          typeof user !== "undefined" &&
          user.id !== client().user!.id &&
          user.relationship !== "Blocked",
      ) as User[]
    )
      .sort((a, b) => a!.id.toUpperCase().localeCompare(b!.id.toUpperCase()))
      .map((user) => user.id);

  const users = useUsers(userIds, true);

  return (
    <Bar>
      <Show when={users().length} fallback={<Dummy />}>
        <Avatars>
          <For each={users()}>
            {(user, index) => (
              <Avatar
                src={user!.avatar}
                size={15}
                holepunch={
                  index() + 1 < users().length ? "overlap-subtle" : "none"
                }
              />
            )}
          </For>
        </Avatars>
        <OverflowingText class={typography({ class: "body", size: "small" })}>
          <Switch fallback={<Trans>Several people are typing…</Trans>}>
            <Match when={users().length === 1}>
              <Trans>{users()[0]!.username} is typing…</Trans>
            </Match>
            <Match when={users().length < 5}>
              <Trans>
                {users()
                  .slice(0, -1)
                  .map((user) => user!.username)
                  .join(", ")}{" "}
                and {users().slice(-1)[0]!.username} are typing…
              </Trans>
            </Match>
          </Switch>
        </OverflowingText>
      </Show>
      <Show when={props.channel.slowmode}>
        <div
          class={slowmodeHolder()}
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Members can send one message every ${slowmodeWaitTime()}.`,
            },
          }}
        >
          <Symbol style={{ "font-size": "1rem" }}>schedule</Symbol>
          <SlowmodeText>
            <Switch fallback={t`Slowmode is enabled.`}>
              <Match when={isSlowmodeExempt()}>{t`Slowmode Immune`}</Match>
              <Match when={cooldownRemaining() > 0}>{slowmodeText()}</Match>
            </Switch>
          </SlowmodeText>
        </div>
      </Show>
    </Bar>
  );
}

/**
 * Avatar alignment
 */
const Avatars = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    height: "fit-content",

    "& :not(:first-child)": {
      marginInlineStart: "-6px",
    },
  },
});

/**
 * Styles for the typing indicator
 */
const Bar = styled("div", {
  base: {
    width: "100%",
    minHeight: "26px",

    padding: "0 var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",

    display: "flex",
    gap: "var(--gap-md)",

    userSelect: "none",
    alignItems: "center",
    flexDirection: "row",

    color: "var(--md-sys-color-on-surface)",
  },
});

const Dummy = styled("div", {
  base: {
    display: "flex",
    width: 0,
  },
});

/**
 * cva, not styled(): use:floating only applies to native elements, so the
 * slowmode holder has to stay a plain div (upstream 61d09723).
 */
const slowmodeHolder = cva({
  base: {
    display: "flex",
    alignItems: "center",
    marginLeft: "auto",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-outline)",
    flexShrink: 0,
  },
});

const SlowmodeText = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontWeight: "600",
  },
});
