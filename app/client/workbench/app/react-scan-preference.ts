/*
 * Exports:
 * - ReactScanPreferenceStorage: synchronous storage boundary for the preference.
 * - readReactScanPreference/writeReactScanPreference: device-local React Scan opt-in, read at boot before React loads.
 */
import { z } from "zod";

import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";

export type ReactScanPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

// Device-local on purpose: profiling overhead belongs to the device being profiled, and boot must decide before React loads.
const STORAGE_KEY = "workbench.reactScan";
const ReactScanPreferenceSchema = z.object({ enabled: z.boolean() });

function browserStorage(): ReactScanPreferenceStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readReactScanPreference(storage: ReactScanPreferenceStorage | null = browserStorage()) {
  const raw = storage?.getItem(STORAGE_KEY);
  if (!raw) return false;
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // A hand-edited or truncated value conforms to the default below.
  }
  return conformToZodSchema(ReactScanPreferenceSchema, value, { enabled: false }).data.enabled;
}

export function writeReactScanPreference(enabled: boolean, storage: ReactScanPreferenceStorage | null = browserStorage()) {
  if (!storage) throw new Error("Browser storage is unavailable.");
  storage.setItem(STORAGE_KEY, JSON.stringify({ enabled }));
}
