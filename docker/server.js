// Run placeholder injection before serving
require("./inject.js");

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");

const PLEX_TARGET =
  process.env.PLEX_PROXY_TARGET || "http://stoat-plex-proxy:3500";
const PORT = parseInt(process.env.PORT || "5000");
const DIST = path.join(__dirname, "dist_injected");

const app = express();

// Log every request
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

// Proxy /jukebox-api/* → plex-proxy container over Docker's internal network
app.use(
  "/jukebox-api",
  createProxyMiddleware({
    target: PLEX_TARGET,
    changeOrigin: true,
    pathRewrite: { "^/jukebox-api": "" },
  })
);

// Download proxy for Klipy static CDN (avoids CORS when fetching for attachment upload)
app.get("/gif-proxy", async (req, res) => {
  const url = req.query.url;
  console.log("gif-proxy request:", url);
  if (!url) {
    return res.status(400).end("missing url");
  }
  let parsedHost;
  try { parsedHost = new URL(url).hostname; } catch { return res.status(400).end("invalid url"); }
  if (!url.startsWith("https://") || !parsedHost.endsWith("klipy.com")) {
    console.log("gif-proxy blocked:", parsedHost);
    return res.status(400).end("disallowed host");
  }
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.log("gif-proxy upstream error:", upstream.status);
      return res.status(502).end();
    }
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await upstream.arrayBuffer());
    console.log("gif-proxy ok:", ct, buf.byteLength, "bytes");
    res.set("Content-Type", ct);
    res.set("Content-Length", buf.byteLength);
    res.end(buf);
  } catch (e) {
    console.log("gif-proxy error:", e.message);
    res.status(500).end();
  }
});

// Proxy /gif-api/* → Klipy API (avoids CORS, keeps key server-side)
const KLIPY_KEY = process.env.VITE_KLIPY_KEY || "";
app.use(
  "/gif-api",
  createProxyMiddleware({
    target: "https://api.klipy.com",
    changeOrigin: true,
    pathRewrite: (path) => `/api/v1/${KLIPY_KEY}${path}`,
  })
);

// Proxy /autumn/* → file-server container over Docker's internal network
// Avoids CORS preflight failures when uploading from stoatdev.sagarmatha.app
const AUTUMN_TARGET =
  process.env.AUTUMN_PROXY_TARGET || "http://stoat-file-server:14704";
app.use(
  "/autumn",
  createProxyMiddleware({
    target: AUTUMN_TARGET,
    changeOrigin: true,
    on: {
      // Autumn's /original endpoint redirects to /<tag>/<id>/<filename>.
      // Prepend /autumn so the browser follows back through this proxy.
      proxyRes: (proxyRes) => {
        const loc = proxyRes.headers["location"];
        if (loc && loc.startsWith("/") && !loc.startsWith("/autumn")) {
          proxyRes.headers["location"] = "/autumn" + loc;
        }
      },
    },
  })
);

// Serve DeepFilterNet3 WASM/model assets (self-hosted to avoid CDN dependency)
app.use("/df3-assets", express.static(path.join(__dirname, "df3-assets")));

// Serve the SPA static files with single-page fallback
app.use(express.static(DIST));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Web server :${PORT}  jukebox → ${PLEX_TARGET}`)
);
