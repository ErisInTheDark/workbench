// @ts-check
/*
 * Exports:
 * - ARC_TREE_MANIFEST_ENV: environment variable naming the manifest Node processes preload.
 * - arcTreePathKey: comparable key for an absolute path on this platform's file system.
 * - writeArcTreeManifest: write held paths and their arc tree bytes for ./arc-tree-preload.mjs.
 * - readArcTreeManifest: read a manifest into path keys mapped to bytes, or null where the arc tree lacks the path.
 */
import fs from "node:fs";
import path from "node:path";

export const ARC_TREE_MANIFEST_ENV = "WORKBENCH_ARC_OVERLAY_MANIFEST";
const MANIFEST_VERSION = 1;

/** @param {string} target */
export function arcTreePathKey(target) {
  const resolved = path.resolve(target);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** @param {string} file @param {ReadonlyMap<string, Buffer | null>} files absolute paths */
export async function writeArcTreeManifest(file, files) {
  const encoded = Object.fromEntries([...files].map(([target, content]) => [target, content?.toString("base64") ?? null]));
  await fs.promises.writeFile(file, JSON.stringify({ version: MANIFEST_VERSION, files: encoded }), { flag: "wx" });
}

/**
 * @param {string} file
 * @returns {Map<string, Buffer | null>}
 */
export function readArcTreeManifest(file) {
  /** @type {{ files?: unknown; version?: unknown }} */
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.version !== MANIFEST_VERSION || !parsed.files || typeof parsed.files !== "object") {
    throw new Error(`Arc tree manifest ${file} is invalid.`);
  }
  return new Map(Object.entries(parsed.files).map(([target, content]) => {
    if (content !== null && typeof content !== "string") throw new Error(`Arc tree manifest ${file} is invalid.`);
    return [arcTreePathKey(target), content === null ? null : Buffer.from(content, "base64")];
  }));
}
