/*
 * Exports:
 * - NativeLocationRelocation: one native location a project merge moved, and where it went.
 * - default NativeLocationRelocations: map native locations under relocated prefixes onto their destinations; read and record them.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import { nativeLocationKey } from "./native-location-key.ts";

export interface NativeLocationRelocation {
  from: string;
  to: string;
}

/** The same normalisation as `nativeLocationKey`, keeping the stored spelling's case. */
function nativeSpelling(location: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return path.posix.normalize(location);
  const native = location.replaceAll("/", "\\")
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\(?=[a-z]:\\)/iu, "");
  return path.win32.normalize(native).replace(/\\+$/u, "");
}

class NativeLocationRelocations {
  private readonly entries: Array<{ key: string; to: string }>;

  constructor(relocations: readonly NativeLocationRelocation[] = [], private readonly platform: NodeJS.Platform = process.platform) {
    this.entries = relocations
      .map(relocation => ({ key: nativeLocationKey(relocation.from, platform), to: relocation.to }))
      .sort((left, right) => right.key.length - left.key.length);
  }

  /** `location` with its longest relocated prefix replaced by that prefix's destination, following chains; others unchanged. */
  relocate(location: string): string {
    let current = location;
    for (let hop = 0; hop <= this.entries.length; hop++) {
      const next = this.relocateOnce(current);
      if (next === current) return current;
      current = next;
    }
    throw new Error("Native location relocations form a cycle.");
  }

  /** The comparison key of `location` after relocation, so a moved location and its destination compare equal. */
  key(location: string) {
    return nativeLocationKey(this.relocate(location), this.platform);
  }

  private relocateOnce(location: string) {
    const key = nativeLocationKey(location, this.platform);
    const separator = this.platform === "win32" ? "\\" : "/";
    const entry = this.entries.find(candidate => key === candidate.key || key.startsWith(`${candidate.key}${separator}`));
    if (!entry) return location;
    const spelling = nativeSpelling(location, this.platform);
    const suffix = (nativeLocationKey(spelling, this.platform) === key ? spelling : key).slice(entry.key.length);
    if (!suffix) return entry.to;
    const destinationSeparator = entry.to.includes("\\") ? "\\" : "/";
    return `${entry.to.replace(/[\\/]+$/u, "")}${suffix.replaceAll(separator, destinationSeparator)}`;
  }
}

namespace NativeLocationRelocations {
  export function read(database: Database.Database): NativeLocationRelocation[] {
    return (database.prepare("SELECT from_location, to_location FROM workbench_native_location_relocations ORDER BY from_location")
      .all() as Array<{ from_location: string; to_location: string }>)
      .map(row => ({ from: row.from_location, to: row.to_location }));
  }

  /** Records `from` moving to `to`; a destination that becomes live again stops being relocated itself. */
  export function record(database: Database.Database, relocation: NativeLocationRelocation, at: number, platform: NodeJS.Platform = process.platform) {
    const fromKey = nativeLocationKey(relocation.from, platform);
    const toKey = nativeLocationKey(relocation.to, platform);
    if (fromKey === toKey) return;
    const remove = database.prepare("DELETE FROM workbench_native_location_relocations WHERE from_location = ?");
    for (const existing of read(database)) {
      const key = nativeLocationKey(existing.from, platform);
      if (key === fromKey || key === toKey) remove.run(existing.from);
    }
    database.prepare("INSERT INTO workbench_native_location_relocations(from_location, to_location, relocated_at) VALUES (?, ?, ?)")
      .run(relocation.from, relocation.to, at);
  }
}

export default NativeLocationRelocations;
