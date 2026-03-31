import { reconcile } from "solid-js/store";

import { State } from "..";

import { AbstractStore } from ".";

/** A single decoration from the catalogue. */
export interface DecorationEntry {
  /** Discord snowflake for presets; "custom:<url>" for user uploads */
  id: string;
  name: string;
  /** "decorations" | "flags" | "custom" */
  category: string;
  /** URL rendered in <img> — proxied CDN or Autumn */
  url: string;
}

export interface TypeDecorations {
  /** Server-synced userId → decorationId. Persisted as render cache. */
  userDecorations: Record<string, string>;
  /** Decoration catalogue loaded from manifest. Stored for instant cold-load. */
  catalogue: DecorationEntry[];
}

const DECORATIONS_API = "/jukebox-api/decorations";
const MANIFEST_URL = "/assets/decorations/manifest.json";

/**
 * Avatar decoration store — syncs to Redis so every client sees everyone's
 * decoration. Catalogue is loaded from a local manifest at startup.
 */
export class Decorations extends AbstractStore<"decorations", TypeDecorations> {
  constructor(state: State) {
    super(state, "decorations");
  }

  hydrate(): void {
    this.fetchFromServer();
    this.loadCatalogue();
  }

  default(): TypeDecorations {
    return { userDecorations: {}, catalogue: [] };
  }

  clean(input: Partial<TypeDecorations>): TypeDecorations {
    const data = this.default();

    if (input.userDecorations && typeof input.userDecorations === "object") {
      for (const [uid, id] of Object.entries(input.userDecorations)) {
        if (typeof uid === "string" && typeof id === "string") {
          data.userDecorations[uid] = id;
        }
      }
    }

    if (Array.isArray(input.catalogue)) {
      data.catalogue = input.catalogue.filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          typeof e.name === "string" &&
          typeof e.url === "string",
      );
    }

    return data;
  }

  // ── Catalogue ────────────────────────────────────────────────────────────

  /** Full decoration catalogue (reactive — updates trigger re-renders). */
  get catalogue(): DecorationEntry[] {
    return this.get().catalogue;
  }

  private async loadCatalogue(): Promise<void> {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return;
      const raw: { id: string; name: string; category: string; cdnUrl: string; url?: string }[] =
        await res.json();
      const entries: DecorationEntry[] = raw.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        url: e.url ?? `/decoration-proxy?url=${encodeURIComponent(e.cdnUrl)}`,
      }));
      this.set("catalogue", entries);
    } catch {
      // manifest unavailable — stale cache remains
    }
  }

  /** Resolve a decoration ID to its rendered URL. */
  getDisplayUrl(decorationId: string): string | undefined {
    if (decorationId.startsWith("custom:")) {
      return decorationId.slice("custom:".length);
    }
    return this.get().catalogue.find((e) => e.id === decorationId)?.url;
  }

  // ── Server-synced user decorations ──────────────────────────────────────

  get userDecorations(): Record<string, string> {
    return this.get().userDecorations;
  }

  getDecorationUrl(userId: string): string | undefined {
    const id = this.get().userDecorations[userId];
    return id ? this.getDisplayUrl(id) : undefined;
  }

  async fetchFromServer(): Promise<void> {
    // Apply cached mapping immediately so decorations render without waiting for Redis
    try {
      const cached = localStorage.getItem("stoat:decorations");
      if (cached) this.set("userDecorations", reconcile(JSON.parse(cached)));
    } catch { /* corrupt cache — ignore */ }

    try {
      const res = await fetch(DECORATIONS_API);
      if (!res.ok) return;
      const data: Record<string, string> = await res.json();
      this.set("userDecorations", reconcile(data));
      try { localStorage.setItem("stoat:decorations", JSON.stringify(data)); } catch {}
    } catch {
      // server unavailable
    }
  }

  async setDecoration(userId: string, decorationId: string | null): Promise<void> {
    // SolidJS stores merge rather than replace, so deleted keys must use reconcile
    const next = { ...this.get().userDecorations };
    if (decorationId === null) {
      delete next[userId];
    } else {
      next[userId] = decorationId;
    }
    this.set("userDecorations", reconcile(next));
    try { localStorage.setItem("stoat:decorations", JSON.stringify(next)); } catch {}

    try {
      await fetch(DECORATIONS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, decoration: decorationId }),
      });
    } catch {
      // server unavailable
    }
  }
}
