/*
 * Exports:
 * - ReloadSchemaManifest: an append-only schema release manifest whose newest version a reload would install.
 * - readSchemaManifestVersion: the newest `release(<version>, ...)` in a manifest's source text.
 * - schemaMigrationBetween: the migration from one manifest text to another, or null when nothing newer arrives.
 */
import type { WorkbenchReloadMigration } from "./reload-dirt-scope.ts";

export interface ReloadSchemaManifest {
  /** Repository-relative manifest path. */
  path: string;
  /** Store name shown to the user, such as `database`. */
  label: string;
}

const RELEASE_PATTERN = /\brelease\(\s*(\d+)\s*,/gu;

export function readSchemaManifestVersion(source: string) {
  let newest: number | null = null;
  for (const match of source.matchAll(RELEASE_PATTERN)) {
    const version = Number(match[1]);
    if (Number.isSafeInteger(version) && (newest === null || version > newest)) newest = version;
  }
  return newest;
}

export function schemaMigrationBetween(
  manifest: ReloadSchemaManifest,
  loaded: string | null,
  next: string | null,
): WorkbenchReloadMigration | null {
  const from = loaded === null ? null : readSchemaManifestVersion(loaded);
  const to = next === null ? null : readSchemaManifestVersion(next);
  return from !== null && to !== null && to > from ? { label: manifest.label, from, to } : null;
}
