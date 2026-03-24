import {
  Match,
  Suspense,
  Switch,
  createContext,
  createMemo,
  createSignal,
  useContext,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { VirtualContainer } from "@minht11/solid-virtual-container";
import { useQuery } from "@tanstack/solid-query";
import { styled } from "styled-system/jsx";

import {
  CircularProgress,
  TextField,
  typography,
} from "@revolt/ui/components/design";

import { useClient } from "@revolt/client";

import { CompositionMediaPickerContext } from "./CompositionMediaPicker";

const KLIPY_BASE = "/gif-api";
const CONTENT_FILTER = "high";

type GifCategory = { title: string; image: string };

type GifResult = {
  url: string;
  media_formats: Record<"webm" | "tinywebm", { url: string }>;
};

function klipyGifToResult(gif: any): GifResult {
  return {
    url: gif.file?.hd?.gif?.url ?? gif.file?.md?.gif?.url ?? "",
    media_formats: {
      webm: { url: gif.file?.md?.mp4?.url ?? "" },
      tinywebm: { url: gif.file?.sm?.mp4?.url ?? gif.file?.xs?.mp4?.url ?? "" },
    },
  };
}

const FilterContext = createContext<(value: string) => void>();

export function GifPicker() {
  const [filter, setFilter] = createSignal("");
  const [debouncedFilter, setDebouncedFilter] = createSignal("");
  let debounceTimer: ReturnType<typeof setTimeout>;

  function onInput(value: string) {
    setFilter(value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setDebouncedFilter(value.toLowerCase()), 300);
  }

  // Used by category clicks — bypasses debounce for instant navigation
  function setFilterImmediate(value: string) {
    clearTimeout(debounceTimer);
    setFilter(value);
    setDebouncedFilter(value.toLowerCase());
  }

  return (
    <Stack>
      <TextField
        autoFocus
        variant="filled"
        placeholder="Search KLIPY..."
        value={filter()}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <Suspense fallback={<CircularProgress />}>
        <Switch
          fallback={
            <FilterContext.Provider value={setFilterImmediate}>
              <Categories />
            </FilterContext.Provider>
          }
        >
          <Match when={debouncedFilter()}>
            <GifSearch query={debouncedFilter()} />
          </Match>
        </Switch>
      </Suspense>
    </Stack>
  );
}

const Stack = styled("div", {
  base: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
});

type CategoryItem =
  | {
      /**
       * Category entry
       */
      t: 0;
      category: GifCategory;
    }
  | {
      /**
       * Trending entry
       */
      t: 1;
      gif: GifResult | null;
    };

function Categories() {
  let targetElement!: HTMLDivElement;

  const trendingCategories = useQuery<GifCategory[]>(() => ({
    queryKey: ["trendingGifCategories"],
    queryFn: () =>
      fetch(
        `${KLIPY_BASE}/gifs/categories?content_filter=${CONTENT_FILTER}`,
      )
        .then((r) => r.json())
        .then((resp) =>
          (resp.data?.categories ?? []).map((cat: any) => ({
            title: cat.query ?? cat.category ?? "",
            image: cat.preview_url ?? "",
          })),
        ),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  }));

  const trendingGif = useQuery<GifResult | null>(() => ({
    queryKey: ["trendingGif1"],
    queryFn: () =>
      fetch(
        `${KLIPY_BASE}/gifs/trending?per_page=1&content_filter=${CONTENT_FILTER}`,
      )
        .then((r) => r.json())
        .then((resp) =>
          resp.data?.data?.[0] ? klipyGifToResult(resp.data.data[0]) : null,
        ),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    initialData: null,
  }));

  const items = createMemo(() => {
    return [
      {
        t: 1,
        gif: trendingGif.data,
      },
      ...(trendingCategories.data?.map((category) => ({ t: 0, category })) ??
        []),
    ] as CategoryItem[];
  });

  return (
    <div ref={targetElement} use:invisibleScrollable>
      <VirtualContainer
        items={items()}
        scrollTarget={targetElement}
        itemSize={{ height: 120, width: 200 }}
        crossAxisCount={(measurements) =>
          Math.floor(measurements.container.cross / measurements.itemSize.cross)
        }
      >
        {CategoryItem}
      </VirtualContainer>
    </div>
  );
}

const CategoryItem = (props: {
  style: unknown;
  tabIndex: number;
  item: CategoryItem;
}) => {
  const setFilter = useContext(FilterContext);

  return (
    <Category
      style={{
        ...(props.style as object),
        "background-image": `linear-gradient(to right, #0006, #0006), url("${props.item.t === 0 ? props.item.category.image : props.item.gif?.url}")`,
      }}
      tabIndex={props.tabIndex}
      role="listitem"
      onClick={() =>
        setFilter!(props.item.t === 0 ? props.item.category.title : "trending")
      }
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }}
    >
      <Switch fallback={<Trans>Trending GIFs</Trans>}>
        <Match when={props.item.t === 0}>
          {(props.item as CategoryItem & { t: 0 }).category.title}
        </Match>
      </Switch>
    </Category>
  );
};

const Category = styled("div", {
  base: {
    ...typography.raw({ class: "title", size: "small" }),

    width: "200px",
    height: "120px",
    backgroundSize: "cover",
    backgroundPosition: "center",

    color: "white",
    display: "flex",
    padding: "var(--gap-md)",

    alignItems: "end",
    justifyContent: "end",

    cursor: "pointer",
  },
});

function GifSearch(props: { query: string }) {
  let targetElement!: HTMLDivElement;

  const search = useQuery<GifResult[]>(() => ({
    queryKey: ["gifs", props.query],
    queryFn: () => {
      const endpoint =
        props.query === "trending"
          ? `trending?per_page=25&content_filter=${CONTENT_FILTER}`
          : `search?q=${encodeURIComponent(props.query)}&per_page=25&content_filter=${CONTENT_FILTER}`;

      return fetch(`${KLIPY_BASE}/gifs/${endpoint}`)
        .then((r) => r.json())
        .then((resp) => (resp.data?.data ?? []).map(klipyGifToResult));
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  }));

  return (
    <div ref={targetElement} use:invisibleScrollable>
      <VirtualContainer
        items={search.data as never /* resource */}
        scrollTarget={targetElement}
        itemSize={{ height: 120, width: 200 }}
        crossAxisCount={(measurements) =>
          Math.floor(measurements.container.cross / measurements.itemSize.cross)
        }
      >
        {GifItem}
      </VirtualContainer>
    </div>
  );
}

const GifItem = (props: {
  style: unknown;
  tabIndex: number;
  item: GifResult;
}) => {
  const { onMessage } = useContext(CompositionMediaPickerContext);
  const client = useClient();

  async function handleClick() {
    // Prefer the smaller MP4 video format; fall back to GIF URL
    const gifUrl = props.item.media_formats.webm.url || props.item.url;
    const isVideo = gifUrl.includes(".mp4") || gifUrl.includes(".webm");
    const ext = isVideo ? (gifUrl.includes(".webm") ? "webm" : "mp4") : "gif";
    const mime = isVideo ? (ext === "webm" ? "video/webm" : "video/mp4") : "image/gif";

    try {
      // Download via server-side proxy to avoid CORS issues with Klipy CDN
      const proxyUrl = `/gif-proxy?url=${encodeURIComponent(gifUrl)}`;
      const resp = await fetch(proxyUrl);
      if (!resp.ok) {
        onMessage(gifUrl);
        return;
      }

      const blob = await resp.blob();
      const file = new File([blob], `gif.${ext}`, { type: mime });

      // Upload to Autumn (file server) directly — Autumn already allows CORS from the app origin
      const autumnUrl = client().configuration!.features.autumn.url;
      const body = new FormData();
      body.set("file", file);

      const [authHeader, authHeaderValue] = client().authenticationHeader;
      const uploadResp = await fetch(`${autumnUrl}/attachments`, {
        method: "POST",
        headers: { [authHeader]: authHeaderValue },
        body,
      });

      if (!uploadResp.ok) {
        onMessage(gifUrl);
        return;
      }

      const { id: attachmentId } = await uploadResp.json();

      // Send as message with attachment — use special prefix so
      // sendMessage knows to send as attachment, not text
      onMessage(`\x00attachment:${attachmentId}`);
    } catch {
      onMessage(gifUrl);
    }
  }

  return (
    <Gif
      loop
      autoplay
      muted
      preload="auto"
      role="listitem"
      style={props.style as string}
      tabIndex={props.tabIndex}
      src={props.item.media_formats.tinywebm.url}
      onClick={handleClick}
    />
  );
};

const Gif = styled("video", {
  base: {
    width: "200px",
    height: "120px",
    cursor: "pointer",
    objectFit: "cover",
  },
});
