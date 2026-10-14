/*
 * Exports:
 * - ProviderRuntimeKeySchema/ProviderRuntimeKey: optional providers whose executable Workbench installs on demand.
 * - ProviderRuntimeStateSchema/ProviderRuntimeState: install lifecycle state of one provider runtime.
 * - ProviderRuntimeStatusSchema/ProviderRuntimeStatus: pinned version, installed version and state of one runtime.
 * - ProviderRuntimesSnapshotSchema/ProviderRuntimesSnapshot: every provider runtime status for one daemon.
 * - ProviderRuntimeInstallRequestSchema/ProviderRuntimeInstallRequest: browser request to install one runtime.
 */
import { z } from "zod";

export const ProviderRuntimeKeySchema = z.enum(["claude", "opencode"]);
export type ProviderRuntimeKey = z.infer<typeof ProviderRuntimeKeySchema>;

export const ProviderRuntimeStateSchema = z.enum(["missing", "installing", "ready", "failed", "unsupported"]);
export type ProviderRuntimeState = z.infer<typeof ProviderRuntimeStateSchema>;

export const ProviderRuntimeStatusSchema = z.object({
  provider: ProviderRuntimeKeySchema,
  /** Version pinned by this Workbench checkout. */
  version: z.string(),
  /** Version currently committed under the data root; null when none. */
  installedVersion: z.string().nullable(),
  state: ProviderRuntimeStateSchema,
  /** Bounded failure or unsupported-platform detail; null otherwise. */
  error: z.string().max(2000).nullable(),
}).strict();
export type ProviderRuntimeStatus = z.infer<typeof ProviderRuntimeStatusSchema>;

export const ProviderRuntimesSnapshotSchema = z.object({
  data: z.array(ProviderRuntimeStatusSchema),
}).strict();
export type ProviderRuntimesSnapshot = z.infer<typeof ProviderRuntimesSnapshotSchema>;

export const ProviderRuntimeInstallRequestSchema = z.object({
  provider: ProviderRuntimeKeySchema,
}).strict();
export type ProviderRuntimeInstallRequest = z.infer<typeof ProviderRuntimeInstallRequestSchema>;
