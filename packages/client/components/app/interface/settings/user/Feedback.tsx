import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Column, Row, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

const PLEX_PROXY_URL = (import.meta.env.VITE_PLEX_PROXY_URL as string) ?? "";
const FEEDBACK_API = `${PLEX_PROXY_URL}/feedback`;
const BEADS_API = `${PLEX_PROXY_URL}/beads`;

type FeedbackItem = {
  id: string;
  type: "bug" | "feature";
  title: string;
  description: string;
  submittedBy: string;
  displayName: string;
  done: boolean;
  beadsId: string | null;
  beadsSynced: boolean;
  createdAt: number;
};

type BeadIssue = {
  id: string;
  title: string;
  description: string;
  issue_type: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed";
  priority: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  closed_at?: string;
};

type BeadsCache = { updatedAt: number; issues: BeadIssue[] };

// Unified row rendered by the list. Originates from a feedback submission, a
// bead from the watcher cache, or both (we de-dupe by beadsId).
type ReportRow = {
  rowKey: string;
  beadsId: string | null;
  feedbackId: string | null;
  type: string; // bug | feature | task | epic | chore | ...
  title: string;
  description: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed" | "pending";
  submitter: string; // display name, "Internal", or "Pending"
  isInternal: boolean;
  createdAt: number;
};

function statusLabel(s: ReportRow["status"]): string {
  switch (s) {
    case "open": return "Open";
    case "in_progress": return "In progress";
    case "blocked": return "Blocked";
    case "deferred": return "Deferred";
    case "closed": return "Done";
    case "pending": return "Pending sync";
  }
}

export function Feedback() {
  const client = useClient();
  const [type, setType] = createSignal<"bug" | "feature">("bug");
  const [title, setTitle] = createSignal("");
  const [desc, setDesc] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal("");
  const [showClosed, setShowClosed] = createSignal(false);

  const [feedback, { refetch: refetchFeedback }] = createResource<FeedbackItem[]>(
    async () => {
      if (!PLEX_PROXY_URL) return [];
      const r = await fetch(FEEDBACK_API);
      return r.ok ? r.json() : [];
    },
  );

  const [beads, { refetch: refetchBeads }] = createResource<BeadsCache>(
    async () => {
      if (!PLEX_PROXY_URL) return { updatedAt: 0, issues: [] };
      const r = await fetch(BEADS_API);
      return r.ok ? r.json() : { updatedAt: 0, issues: [] };
    },
  );

  function refetch() {
    refetchFeedback();
    refetchBeads();
  }

  // Merge feedback submissions and beads cache into a single rendered list.
  // De-dupe rule: a feedback item with a beadsId is the same row as the
  // matching bead — prefer the bead's current status, but keep the human
  // submitter name from the feedback record.
  const rows = createMemo<ReportRow[]>(() => {
    const fbItems = feedback() ?? [];
    const beadIssues = beads()?.issues ?? [];

    const fbByBeadsId = new Map<string, FeedbackItem>();
    for (const f of fbItems) if (f.beadsId) fbByBeadsId.set(f.beadsId, f);

    const out: ReportRow[] = [];

    for (const b of beadIssues) {
      // Hide infra/template/gate beads — keep the user-facing types.
      if (!["bug", "feature", "task", "epic", "chore"].includes(b.issue_type)) {
        continue;
      }
      const fb = fbByBeadsId.get(b.id);
      out.push({
        rowKey: `bd:${b.id}`,
        beadsId: b.id,
        feedbackId: fb?.id ?? null,
        type: b.issue_type,
        title: b.title,
        description: b.description,
        status: b.status,
        submitter: fb
          ? fb.displayName || fb.submittedBy || "Unknown"
          : "Internal",
        isInternal: !fb,
        createdAt: new Date(b.created_at).getTime(),
      });
    }

    // Append feedback submissions that haven't been picked up by the watcher
    // yet so submitters immediately see their report in the list.
    for (const f of fbItems) {
      if (f.beadsId) continue;
      out.push({
        rowKey: `fb:${f.id}`,
        beadsId: null,
        feedbackId: f.id,
        type: f.type,
        title: f.title,
        description: f.description,
        status: "pending",
        submitter: f.displayName || f.submittedBy || "Unknown",
        isInternal: false,
        createdAt: f.createdAt,
      });
    }

    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  });

  const visibleRows = createMemo(() => {
    const r = rows();
    return showClosed() ? r : r.filter((x) => x.status !== "closed");
  });

  const closedCount = createMemo(
    () => rows().filter((r) => r.status === "closed").length,
  );

  async function submit() {
    const t = title().trim();
    if (!t || submitting()) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const user = client()?.user;
      const r = await fetch(FEEDBACK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: type(),
          title: t,
          description: desc().trim(),
          submittedBy: user?.id ?? "",
          displayName: user?.displayName ?? "",
        }),
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      setTitle("");
      setDesc("");
      refetch();
    } catch (e: any) {
      setSubmitError(e.message ?? "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleDone(row: ReportRow) {
    if (!row.feedbackId) return; // beads-only items aren't editable from here
    await fetch(`${FEEDBACK_API}/${row.feedbackId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toggle: true }),
    });
    refetch();
  }

  async function deleteItem(row: ReportRow) {
    if (!row.feedbackId) return;
    await fetch(`${FEEDBACK_API}/${row.feedbackId}`, { method: "DELETE" });
    refetch();
  }

  const isLoading = () => feedback.loading || beads.loading;

  return (
    <Column gap="xl">
      {/* ── Submit form ── */}
      <Column gap="md">
        <Text class="title" size="small">Submit a Report</Text>

        <TypeRow>
          <TypeBtn active={type() === "bug"} onClick={() => setType("bug")}>
            <Symbol size={14}>bug_report</Symbol>
            Bug Report
          </TypeBtn>
          <TypeBtn active={type() === "feature"} onClick={() => setType("feature")}>
            <Symbol size={14}>lightbulb</Symbol>
            Feature Request
          </TypeBtn>
        </TypeRow>

        <FormInput
          type="text"
          placeholder="Short title…"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <FormTextarea
          placeholder="More details (optional)…"
          value={desc()}
          onInput={(e) => setDesc(e.currentTarget.value)}
          rows={3}
        />

        <Show when={submitError()}>
          <Text class="label" style={{ color: "var(--md-sys-color-error)" }}>
            {submitError()}
          </Text>
        </Show>

        <SubmitBtn onClick={submit} disabled={submitting() || !title().trim()}>
          {submitting() ? "Submitting…" : "Submit"}
        </SubmitBtn>
      </Column>

      {/* ── Reports list ── */}
      <Column gap="sm">
        <Row align="center" justify="between">
          <Text class="title" size="small">All Reports</Text>
          <Row align="center" gap="sm">
            <ToggleLabel>
              <input
                type="checkbox"
                checked={showClosed()}
                onChange={(e) => setShowClosed(e.currentTarget.checked)}
              />
              Show completed ({closedCount()})
            </ToggleLabel>
            <RefreshBtn onClick={refetch} title="Refresh" disabled={isLoading()}>
              <Symbol size={16}>refresh</Symbol>
            </RefreshBtn>
          </Row>
        </Row>

        <Show when={!PLEX_PROXY_URL}>
          <Text class="label">Feedback system not available in this environment.</Text>
        </Show>

        <Show when={!!PLEX_PROXY_URL}>
          <Show when={!isLoading()} fallback={<Text class="label">Loading…</Text>}>
            <Show
              when={visibleRows().length > 0}
              fallback={<Text class="label">No reports yet — be the first!</Text>}
            >
              <ItemList>
                <For each={visibleRows()}>
                  {(row) => (
                    <ItemCard done={row.status === "closed"}>
                      <DoneCheck
                        type="checkbox"
                        checked={row.status === "closed"}
                        disabled={!row.feedbackId}
                        onChange={() => toggleDone(row)}
                        title={
                          row.feedbackId
                            ? row.status === "closed" ? "Mark open" : "Mark done"
                            : "Status is managed via the beads tracker"
                        }
                      />
                      <ItemBody>
                        <ItemHeader>
                          <TypeTag type={tagType(row.type)}>
                            {prettyType(row.type)}
                          </TypeTag>
                          <StatusTag status={row.status}>
                            {statusLabel(row.status)}
                          </StatusTag>
                          <ItemTitle done={row.status === "closed"}>{row.title}</ItemTitle>
                          <Show when={row.beadsId}>
                            <BeadsTag>{row.beadsId}</BeadsTag>
                          </Show>
                          <Show when={row.isInternal}>
                            <InternalTag>Internal</InternalTag>
                          </Show>
                        </ItemHeader>
                        <Show when={row.description}>
                          <ItemDesc>{row.description}</ItemDesc>
                        </Show>
                        <ItemMeta>
                          {row.submitter} ·{" "}
                          {new Date(row.createdAt).toLocaleDateString()}
                        </ItemMeta>
                      </ItemBody>
                      <Show when={row.feedbackId}>
                        <DeleteBtn onClick={() => deleteItem(row)} title="Delete">
                          <Symbol size={14}>delete</Symbol>
                        </DeleteBtn>
                      </Show>
                    </ItemCard>
                  )}
                </For>
              </ItemList>
            </Show>
          </Show>
        </Show>
      </Column>
    </Column>
  );
}

function prettyType(t: string): string {
  switch (t) {
    case "bug": return "Bug";
    case "feature": return "Feature";
    case "task": return "Task";
    case "epic": return "Epic";
    case "chore": return "Chore";
    default: return t.charAt(0).toUpperCase() + t.slice(1);
  }
}

function tagType(t: string): "bug" | "feature" | "other" {
  if (t === "bug") return "bug";
  if (t === "feature") return "feature";
  return "other";
}

/* ── Styled components ──────────────────────────────────────────────────── */

const TypeRow = styled("div", {
  base: { display: "flex", gap: "var(--gap-sm)" },
});

const TypeBtn = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    padding: "6px 14px",
    borderRadius: "var(--borderRadius-full)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    transition: "all 0.15s",
    "&:hover": { background: "var(--md-sys-color-surface-container)" },
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-secondary-container)",
        color: "var(--md-sys-color-on-secondary-container)",
        borderColor: "transparent",
      },
    },
  },
});

const FormInput = styled("input", {
  base: {
    width: "100%",
    padding: "8px 12px",
    background: "var(--md-sys-color-surface-container)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderRadius: "var(--borderRadius-md)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
    "&:focus": { borderColor: "var(--md-sys-color-primary)" },
    "&::placeholder": { color: "var(--md-sys-color-on-surface-variant)" },
  },
});

const FormTextarea = styled("textarea", {
  base: {
    width: "100%",
    padding: "8px 12px",
    background: "var(--md-sys-color-surface-container)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderRadius: "var(--borderRadius-md)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "14px",
    fontFamily: "inherit",
    outline: "none",
    resize: "vertical",
    minHeight: "72px",
    boxSizing: "border-box",
    "&:focus": { borderColor: "var(--md-sys-color-primary)" },
    "&::placeholder": { color: "var(--md-sys-color-on-surface-variant)" },
  },
});

const SubmitBtn = styled("button", {
  base: {
    alignSelf: "flex-start",
    padding: "8px 20px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    background: "var(--md-sys-color-primary)",
    color: "var(--md-sys-color-on-primary)",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
    transition: "opacity 0.15s",
    "&:disabled": { opacity: 0.5, cursor: "default" },
    "&:not(:disabled):hover": { opacity: 0.88 },
  },
});

const ToggleLabel = styled("label", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    userSelect: "none",
  },
});

const ItemList = styled("div", {
  base: { display: "flex", flexDirection: "column", gap: "var(--gap-xs)" },
});

const ItemCard = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--gap-sm)",
    padding: "10px 12px",
    background: "var(--md-sys-color-surface-container)",
    borderRadius: "var(--borderRadius-md)",
    transition: "opacity 0.2s",
  },
  variants: {
    done: { true: { opacity: 0.5 } },
  },
});

const DoneCheck = styled("input", {
  base: {
    marginTop: "3px",
    flexShrink: 0,
    cursor: "pointer",
    accentColor: "var(--md-sys-color-primary)",
    "&:disabled": { cursor: "default", opacity: 0.6 },
  },
});

const ItemBody = styled("div", {
  base: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
});

const ItemHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexWrap: "wrap",
  },
});

const TypeTag = styled("span", {
  base: {
    padding: "1px 7px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "11px",
    fontWeight: 600,
    flexShrink: 0,
  },
  variants: {
    type: {
      bug: {
        background: "color-mix(in srgb, var(--md-sys-color-error) 20%, transparent)",
        color: "var(--md-sys-color-error)",
      },
      feature: {
        background: "color-mix(in srgb, var(--md-sys-color-primary) 20%, transparent)",
        color: "var(--md-sys-color-primary)",
      },
      other: {
        background: "color-mix(in srgb, var(--md-sys-color-on-surface-variant) 18%, transparent)",
        color: "var(--md-sys-color-on-surface-variant)",
      },
    },
  },
});

const StatusTag = styled("span", {
  base: {
    padding: "1px 7px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "11px",
    fontWeight: 500,
    flexShrink: 0,
  },
  variants: {
    status: {
      open: {
        background: "color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent)",
        color: "var(--md-sys-color-tertiary)",
      },
      in_progress: {
        background: "color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent)",
        color: "var(--md-sys-color-primary)",
      },
      blocked: {
        background: "color-mix(in srgb, var(--md-sys-color-error) 18%, transparent)",
        color: "var(--md-sys-color-error)",
      },
      deferred: {
        background: "color-mix(in srgb, var(--md-sys-color-on-surface-variant) 18%, transparent)",
        color: "var(--md-sys-color-on-surface-variant)",
      },
      closed: {
        background: "color-mix(in srgb, var(--md-sys-color-on-surface-variant) 18%, transparent)",
        color: "var(--md-sys-color-on-surface-variant)",
      },
      pending: {
        background: "color-mix(in srgb, var(--md-sys-color-secondary) 22%, transparent)",
        color: "var(--md-sys-color-secondary)",
        fontStyle: "italic",
      },
    },
  },
});

const BeadsTag = styled("span", {
  base: {
    padding: "1px 7px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "11px",
    background: "color-mix(in srgb, var(--md-sys-color-tertiary) 20%, transparent)",
    color: "var(--md-sys-color-tertiary)",
    fontFamily: "monospace",
  },
});

const InternalTag = styled("span", {
  base: {
    padding: "1px 7px",
    borderRadius: "var(--borderRadius-full)",
    fontSize: "11px",
    background: "color-mix(in srgb, var(--md-sys-color-on-surface-variant) 14%, transparent)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontWeight: 500,
  },
});

const ItemTitle = styled("span", {
  base: {
    fontSize: "13px",
    fontWeight: 500,
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  variants: {
    done: { true: { textDecoration: "line-through" } },
  },
});

const ItemDesc = styled("div", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
    marginTop: "2px",
    wordBreak: "break-word",
  },
});

const ItemMeta = styled("div", {
  base: {
    fontSize: "11px",
    color: "var(--md-sys-color-on-surface-variant)",
    opacity: 0.7,
    marginTop: "2px",
  },
});

const RefreshBtn = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px",
    background: "transparent",
    border: "none",
    borderRadius: "var(--borderRadius-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    opacity: 0.6,
    transition: "all 0.15s",
    "&:hover:not(:disabled)": { opacity: 1 },
    "&:disabled": { opacity: 0.3, cursor: "default" },
  },
});

const DeleteBtn = styled("button", {
  base: {
    flexShrink: 0,
    padding: "4px",
    background: "transparent",
    border: "none",
    borderRadius: "var(--borderRadius-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    opacity: 0.4,
    transition: "all 0.15s",
    "&:hover": { opacity: 1, color: "var(--md-sys-color-error)" },
  },
});
