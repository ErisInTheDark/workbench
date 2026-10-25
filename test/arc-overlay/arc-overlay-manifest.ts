/*
 * Exports:
 * - ArcOverlayFiles: absolute held paths mapped to their arc tree bytes, or null where that tree lacks them.
 * - writeArcOverlayManifest: write the file handing an overlay to test processes; ./arc-overlay-preload.mjs reads it.
 * - arcOverlayProcessEnvironment: environment that makes Node descendants preload the overlay from a manifest.
 */
import fs from "node:fs";
import path from "node:path";

export type ArcOverlayFiles = ReadonlyMap<string, Buffer | null>;

/** Shared with ./arc-overlay-preload.mjs, which must load before any TypeScript loader. */
const MANIFEST_ENV = "WORKBENCH_ARC_OVERLAY_MANIFEST";
const MANIFEST_VERSION = 1;

export async function writeArcOverlayManifest(file: string, files: ArcOverlayFiles) {
  const encoded = Object.fromEntries([...files].map(([target, content]) => [target, content?.toString("base64") ?? null]));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ version: MANIFEST_VERSION, files: encoded }), { flag: "wx" });
}

export function arcOverlayProcessEnvironment(manifest: string, environment: NodeJS.ProcessEnv): Record<string, string> {
  const preload = `--import ${new URL("./arc-overlay-preload.mjs", import.meta.url).href}`;
  return {
    [MANIFEST_ENV]: manifest,
    NODE_OPTIONS: environment.NODE_OPTIONS ? `${environment.NODE_OPTIONS} ${preload}` : preload,
  };
}
