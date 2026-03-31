import { reconcile } from "solid-js/store";

import { State } from "..";

import { AbstractStore } from ".";

/** A single nameplate from the catalogue. */
export interface NameplateEntry {
  /** Slug used as ID (e.g. "cityscape") */
  id: string;
  name: string;
  category: string;
  /** URL rendered in <img> — proxied CDN */
  url: string;
}

export interface TypeNameplates {
  /** Server-synced userId → nameplateId. */
  userNameplates: Record<string, string>;
  /** Nameplate catalogue loaded from manifest. */
  catalogue: NameplateEntry[];
}

const NAMEPLATES_API = "/jukebox-api/nameplates";
const MANIFEST_URL = "/assets/nameplates/manifest.json";

/**
 * Nameplate store — syncs to Redis so every client sees everyone's nameplate.
 * Catalogue is loaded from a local manifest at startup.
 */
export class Nameplates extends AbstractStore<"nameplates", TypeNameplates> {
  constructor(state: State) {
    super(state, "nameplates");
  }

  hydrate(): void {
    this.fetchFromServer();
    this.loadCatalogue();
  }

  default(): TypeNameplates {
    return { userNameplates: {}, catalogue: [] };
  }

  clean(input: Partial<TypeNameplates>): TypeNameplates {
    const data = this.default();

    if (input.userNameplates && typeof input.userNameplates === "object") {
      for (const [uid, id] of Object.entries(input.userNameplates)) {
        if (typeof uid === "string" && typeof id === "string") {
          data.userNameplates[uid] = id;
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

  /** Full nameplate catalogue (reactive — updates trigger re-renders). */
  get catalogue(): NameplateEntry[] {
    return this.get().catalogue;
  }

  private async loadCatalogue(): Promise<void> {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return;
      const raw: { id: string; name: string; category: string; cdnSlug: string; url?: string }[] =
        await res.json();
      const entries: NameplateEntry[] = raw.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        url: e.url ?? `/nameplate-proxy?slug=${encodeURIComponent(e.cdnSlug)}`,
      }));
      this.set("catalogue", entries);
    } catch {
      // manifest unavailable — stale cache remains
    }
  }

  /** Resolve a nameplate ID to its rendered URL. */
  getDisplayUrl(nameplateId: string): string | undefined {
    return this.get().catalogue.find((e) => e.id === nameplateId)?.url;
  }

  // ── Server-synced user nameplates ────────────────────────────────────────

  get userNameplates(): Record<string, string> {
    return this.get().userNameplates;
  }

  getNameplateUrl(userId: string): string | undefined {
    const id = this.get().userNameplates[userId];
    return id ? this.getDisplayUrl(id) : undefined;
  }

  async fetchFromServer(): Promise<void> {
    try {
      const res = await fetch(NAMEPLATES_API);
      if (!res.ok) return;
      const data: Record<string, string> = await res.json();
      this.set("userNameplates", reconcile(data));
    } catch {
      // server unavailable
    }
  }

  async setNameplate(userId: string, nameplateId: string | null): Promise<void> {
    if (nameplateId === null) {
      // SolidJS stores merge rather than replace, so deleted keys must use reconcile
      const next = { ...this.get().userNameplates };
      delete next[userId];
      this.set("userNameplates", reconcile(next));
    } else {
      this.set("userNameplates", userId as never, nameplateId);
    }

    try {
      await fetch(NAMEPLATES_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, nameplate: nameplateId }),
      });
    } catch {
      // server unavailable
    }
  }
}
