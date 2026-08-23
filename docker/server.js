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

// Match a hostname against a registrable domain, exactly or as a subdomain.
// Must not be a bare endsWith(): that also accepts "evil<domain>" lookalikes.
const isHost = (hostname, domain) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

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

// Proxy Discord CDN decoration APNGs (avoids CORS, serves passthrough APNG animations)
app.get("/decoration-proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end("missing url");
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).end("invalid url"); }
  if (parsed.protocol !== "https:" || !isHost(parsed.hostname, "discordapp.com") || !parsed.pathname.startsWith("/avatar-decoration-presets/")) {
    return res.status(400).end("disallowed url");
  }
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Length", buf.byteLength);
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// Proxy Discord CDN nameplate images (avoids CORS)
app.get("/nameplate-proxy", async (req, res) => {
  const slug = req.query.slug;
  if (!slug || !/^[a-z0-9_/]+$/.test(slug)) return res.status(400).end("invalid slug");
  const cdnPath = slug.includes("/") ? slug : `nameplates/${slug}`;
  const url = `https://cdn.discordapp.com/assets/collectibles/nameplates/${cdnPath}/static.png`;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Length", buf.byteLength);
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// Download proxy for Klipy static CDN (avoids CORS when fetching for attachment upload)
app.get("/gif-proxy", async (req, res) => {
  const url = req.query.url;
  console.log("gif-proxy request:", url);
  if (!url) {
    return res.status(400).end("missing url");
  }
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).end("invalid url"); }
  if (parsed.protocol !== "https:" || !isHost(parsed.hostname, "klipy.com")) {
    console.log("gif-proxy blocked:", parsed.hostname);
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

// [Voice/H6] Dev-only loopback-harness bot token, served live from the
// container env. Read per-request (no-store) instead of baking it into the
// static bundle — the service worker precaches the pre-injection index.html
// (placeholder), so an injected static global is unreliable, and this also
// keeps the secret out of cached assets. Empty string on prod (env unset),
// so the client treats it as disabled.
app.get("/voice-test-bot-token", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ token: process.env.VITE_VOICE_TEST_BOT_TOKEN || "" });
});

// Serve DeepFilterNet3 WASM/model assets (self-hosted to avoid CDN dependency)
app.use("/df3-assets", express.static(path.join(__dirname, "df3-assets")));

// Serve the SPA static files with single-page fallback
app.use(express.static(DIST));
app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Web server :${PORT}  jukebox → ${PLEX_TARGET}`)
);
