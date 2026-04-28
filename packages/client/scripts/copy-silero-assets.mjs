#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * [VAD-IMPROVEMENT-#8] Self-host Silero VAD assets.
 *
 * Copies the Silero ONNX models, AudioWorklet bundle, and onnxruntime-web wasm
 * files from node_modules into packages/client/public/silero/. Vite serves
 * everything in public/ at the site root in dev, and the prod build emits them
 * into dist/ which docker/server.js then serves.
 *
 * Runs as a `postinstall` script — bumping the @ricky0123/vad-web version in
 * package.json deterministically refreshes the assets on the next pnpm install.
 *
 * Reasoning: avoids client-side hits to JSDelivr at runtime (privacy / no
 * external dependency for self-hosters). Mirrors the docker/df3-assets pattern
 * used by DeepFilterNet3.
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..");
const target = resolve(clientRoot, "public", "silero");

// Sources are relative to the workspace root's hoisted node_modules. With
// pnpm shamefully-hoist=true everything resolves at the workspace root.
const repoRoot = resolve(clientRoot, "..", "..");
const vadDist = resolve(repoRoot, "node_modules", "@ricky0123", "vad-web", "dist");
const ortDist = resolve(repoRoot, "node_modules", "onnxruntime-web", "dist");

// File list. Keep in sync with @ricky0123/vad-web's expected asset names.
// MicVAD looks for these under baseAssetPath / onnxWASMBasePath.
const vadFiles = [
  "silero_vad_legacy.onnx",
  "silero_vad_v5.onnx",
  "vad.worklet.bundle.min.js",
];
// onnxruntime-web requests these by name from `wasmPaths`. We ship the
// SIMD-threaded variant (the modern default); ORT picks the right one at
// runtime based on browser capability.
const ortFiles = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

async function fileExists(path) {
  try { await readdir(dirname(path)); } catch { return false; }
  try {
    const dirEntries = await readdir(dirname(path));
    return dirEntries.includes(path.split(/[\\/]/).pop());
  } catch { return false; }
}

async function main() {
  // Skip silently if either source is missing — this script runs as
  // postinstall, and `pnpm install --frozen-lockfile` may run before all
  // workspace symlinks settle. Exiting 0 keeps the install from failing.
  try { await readdir(vadDist); } catch {
    console.warn(`[silero] vad-web dist not found at ${vadDist} — skipping`);
    return;
  }
  try { await readdir(ortDist); } catch {
    console.warn(`[silero] onnxruntime-web dist not found at ${ortDist} — skipping`);
    return;
  }

  // Wipe the target so renamed/removed upstream files don't linger.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const allFiles = [
    ...vadFiles.map((f) => ({ src: resolve(vadDist, f), name: f })),
    ...ortFiles.map((f) => ({ src: resolve(ortDist, f), name: f })),
  ];

  let copied = 0;
  for (const { src, name } of allFiles) {
    try {
      await copyFile(src, resolve(target, name));
      copied++;
    } catch (e) {
      // Some optional files may not exist in every package version; warn
      // but don't fail the install. MicVAD will surface the real error if
      // a required file is missing at runtime.
      console.warn(`[silero] could not copy ${name}: ${e.message}`);
    }
  }
  console.log(`[silero] self-hosted assets ready at public/silero/ (${copied} files)`);
}

main().catch((e) => {
  console.error("[silero] copy failed:", e);
  process.exit(1);
});
