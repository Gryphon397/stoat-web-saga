/**
 * Downloads all decoration and nameplate images from Discord CDN into
 * assets_fallback so they can be served locally without any CDN dependency.
 *
 * Run before building the Docker container:
 *   node scripts/download-assets.mjs
 *
 * Skips files that already exist (safe to re-run; only downloads new entries).
 * Updates each manifest with a `url` field pointing to the local static path.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsFallback = join(__dirname, "assets_fallback");

async function download(url, dest) {
  if (existsSync(dest)) {
    process.stdout.write(".");
    return true;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`\n  HTTP ${res.status}: ${url}`);
      return false;
    }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    process.stdout.write("+");
    return true;
  } catch (e) {
    console.error(`\n  error fetching ${url}: ${e.message}`);
    return false;
  }
}

// ── Decorations ──────────────────────────────────────────────────────────────

const decorManifestPath = join(assetsFallback, "decorations", "manifest.json");
const decorImagesDir = join(assetsFallback, "decorations", "images");
mkdirSync(decorImagesDir, { recursive: true });

const decorManifest = JSON.parse(readFileSync(decorManifestPath, "utf8"));
console.log(`Downloading ${decorManifest.length} decorations...`);
let decorOk = 0, decorFail = 0;

for (const entry of decorManifest) {
  const cdnUrl = entry.cdnUrl;
  // Extract filename from pathname (e.g. "a_abc123.png"), strip query string
  const filename = new URL(cdnUrl).pathname.split("/").pop();
  const dest = join(decorImagesDir, filename);
  const localUrl = `/assets/decorations/images/${filename}`;

  if (await download(cdnUrl, dest)) {
    entry.url = localUrl;
    decorOk++;
  } else {
    decorFail++;
  }
}

writeFileSync(decorManifestPath, JSON.stringify(decorManifest, null, 2));
console.log(`\nDecorations: ${decorOk} downloaded/cached, ${decorFail} failed`);

// ── Nameplates ───────────────────────────────────────────────────────────────

const npManifestPath = join(assetsFallback, "nameplates", "manifest.json");
const npImagesDir = join(assetsFallback, "nameplates", "images");
mkdirSync(npImagesDir, { recursive: true });

const npManifest = JSON.parse(readFileSync(npManifestPath, "utf8"));
console.log(`\nDownloading ${npManifest.length} nameplates...`);
let npOk = 0, npFail = 0;

for (const entry of npManifest) {
  const slug = entry.cdnSlug;
  // Simple slugs (e.g. "vengeance") live under nameplates/nameplates/
  // Collection slugs (e.g. "spell/white_mana") are used as-is after nameplates/
  const cdnPath = slug.includes("/") ? slug : `nameplates/${slug}`;
  const cdnUrl = `https://cdn.discordapp.com/assets/collectibles/nameplates/${cdnPath}/static.png`;
  const filename = slug.replace(/\//g, "_") + ".png";
  const dest = join(npImagesDir, filename);
  const localUrl = `/assets/nameplates/images/${filename}`;

  if (await download(cdnUrl, dest)) {
    entry.url = localUrl;
    npOk++;
  } else {
    npFail++;
  }
}

writeFileSync(npManifestPath, JSON.stringify(npManifest, null, 2));
console.log(`\nNameplates: ${npOk} downloaded/cached, ${npFail} failed`);

console.log("\nDone. Run `docker compose build web-dev && docker compose up -d web-dev` to deploy.");
