/*
 * Exports:
 * - INSTALLATION_UPDATE_MAX_CONFLICTS: bound on reported conflicting paths.
 * - InstallationUpdateFailureSchema/InstallationUpdateFailure: the last update repair that needed more than a plain install.
 * - InstallationUpdateSchema/InstallationUpdate: the running checkout's upstream position and pull prediction.
 * - InstallationRepairJournalSchema/InstallationRepairJournal/INSTALLATION_REPAIR_JOURNAL_SEGMENTS: the lockfile-install repair journal and its data-root location.
 * - InstallationPullRequestSchema/InstallationPullResultSchema/InstallationPullResult: daemon pull admission and outcome.
 */
import { z } from "zod";
import { ProjectIdSchema } from "./identity";

export const INSTALLATION_UPDATE_MAX_CONFLICTS = 50;

const sha = z.string().regex(/^[0-9a-f]{40,64}$/u);
const message = z.string().max(512);

export const InstallationUpdateFailureSchema = z.object({
  at: z.number().int().nonnegative(),
  logPath: z.string().max(4096),
  message,
}).strict();
export type InstallationUpdateFailure = z.infer<typeof InstallationUpdateFailureSchema>;

/**
 * `current`: nothing to pull. `available`: a pull is predicted clean (fast-forward, or rebasing local commits).
 * `conflict`: incoming changes overlap local changes or the rebase would conflict. `unavailable`: no upstream or
 * the last check failed (`reason` says which).
 */
export const InstallationUpdateSchema = z.object({
  state: z.enum(["current", "available", "conflict", "unavailable"]),
  reason: message.nullable(),
  upstream: z.string().max(256).nullable(),
  behind: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
  conflicts: z.array(z.string().max(4096)).max(INSTALLATION_UPDATE_MAX_CONFLICTS),
  lockfileChanged: z.boolean(),
  checkedAt: z.number().int().nonnegative().nullable(),
  projectId: ProjectIdSchema.nullable(),
  failure: InstallationUpdateFailureSchema.nullable(),
}).strict();
export type InstallationUpdate = z.infer<typeof InstallationUpdateSchema>;

/**
 * The repair journal written by the built-ins-only engine in `package/update.mjs` (which mirrors this shape without
 * zod). Phases advance in order; `done` and `stranded` are terminal, and only `done` lets processes load
 * `node_modules`. `failure` survives `done` when a rung beyond a plain install was needed, until dismissed.
 */
export const InstallationRepairJournalSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  phase: z.enum(["pending", "stopping", "installing", "rolling-back", "clean-installing", "done", "stranded"]),
  fromSha: sha.nullable(),
  toSha: sha.nullable(),
  logPath: z.string().max(4096),
  lastError: message.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  failure: InstallationUpdateFailureSchema.nullable(),
}).strict();
export type InstallationRepairJournal = z.infer<typeof InstallationRepairJournalSchema>;
/** Journal location relative to the Workbench data root (browser-safe; join with the platform path module). */
export const INSTALLATION_REPAIR_JOURNAL_SEGMENTS = ["update", "journal.json"] as const;

export const InstallationPullRequestSchema = z.object({}).strict();

export const InstallationPullResultSchema = z.object({
  fromSha: sha,
  toSha: sha,
  lockfileChanged: z.boolean(),
}).strict();
export type InstallationPullResult = z.infer<typeof InstallationPullResultSchema>;
