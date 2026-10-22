/*
 * Exports:
 * - WorkbenchReloadMigrationSchema/WorkbenchReloadMigration: a schema release step a reload would apply.
 * - ReloadDirtScopeSchema/ReloadDirtScope/ReloadDirtSnapshot: dirty scopes that may name the migration their reload applies.
 * - DaemonReloadDirtEnvelopeSchema/DaemonReloadDirtEnvelope: the daemon's ordered dirt snapshot, migrations included.
 *
 * These extend the process-owned contracts in workbench-reload and daemon-reload instead of editing them, so evolving
 * them never restarts a process.
 */
import { z } from "zod";
import type { WorkbenchReloadDirtScope, WorkbenchReloadDirtSnapshot } from "./workbench-reload.ts";
import { WorkbenchDaemonReloadDirtEnvelopeSchema } from "../workbench/daemon-reload.ts";

/** `label` names the store, such as `database` or `app state`. */
export const WorkbenchReloadMigrationSchema = z.object({
  label: z.string().max(64),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
}).strict();
export type WorkbenchReloadMigration = z.infer<typeof WorkbenchReloadMigrationSchema>;

export const ReloadDirtScopeSchema = z.object({
  dependantScopes: z.array(z.string()).optional(),
  description: z.string(),
  destructive: z.boolean(),
  migration: WorkbenchReloadMigrationSchema.optional(),
  scope: z.string(),
}).strict();
export type ReloadDirtScope = WorkbenchReloadDirtScope & { migration?: WorkbenchReloadMigration };
export type ReloadDirtSnapshot = Omit<WorkbenchReloadDirtSnapshot, "dirtyScopes"> & { dirtyScopes: ReloadDirtScope[] };

/** Mirrors daemon-reload's bound on dirty scopes per snapshot. */
const MAX_DAEMON_DIRTY_SCOPES = 64;
const daemonSnapshot = WorkbenchDaemonReloadDirtEnvelopeSchema.shape.snapshot;
export const DaemonReloadDirtEnvelopeSchema = WorkbenchDaemonReloadDirtEnvelopeSchema.extend({
  snapshot: daemonSnapshot.extend({
    dirtyScopes: z.array(daemonSnapshot.shape.dirtyScopes.element.extend({
      migration: WorkbenchReloadMigrationSchema.optional(),
    })).max(MAX_DAEMON_DIRTY_SCOPES),
  }),
});
export type DaemonReloadDirtEnvelope = z.infer<typeof DaemonReloadDirtEnvelopeSchema>;
