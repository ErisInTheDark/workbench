/*
 * Exports:
 * - INSTALLATION_UPDATE_MAX_INCOMING_PATHS: bound on reported incoming paths.
 * - PredictedInstallationUpdateSchema/PredictedInstallationUpdate: an installation update with what its pull would dirty.
 * - toBaseInstallationUpdate: the same update in the process-owned shape, for consumers that predate prediction.
 * - InstallationPullOptionsSchema/InstallationPullOptions: daemon pull admission options.
 *
 * These extend the process-owned contracts in installation-update instead of editing them, so evolving them never
 * restarts a process.
 */
import { z } from "zod";
import { ReloadDirtScopeSchema } from "../reload/reload-dirt-scope.ts";
import { InstallationUpdateSchema, type InstallationUpdate } from "./installation-update.ts";

export const INSTALLATION_UPDATE_MAX_INCOMING_PATHS = 5_000;

export const PredictedInstallationUpdateSchema = InstallationUpdateSchema.extend({
  /** Paths the pull would change, for each process to predict its own dirt; null when unknown or past the bound. */
  incomingPaths: z.array(z.string().max(4096)).max(INSTALLATION_UPDATE_MAX_INCOMING_PATHS).nullable().optional(),
  /** Daemon scopes the pull would dirty; null or absent when unknown, such as from a daemon that predates prediction. */
  predictedScopes: z.array(ReloadDirtScopeSchema).nullable().optional(),
});
export type PredictedInstallationUpdate = z.infer<typeof PredictedInstallationUpdateSchema>;

export function toBaseInstallationUpdate({
  incomingPaths: _incomingPaths, predictedScopes: _predictedScopes, ...update
}: PredictedInstallationUpdate): InstallationUpdate {
  return update;
}

/** `withoutInstall`: refuse a pull whose lockfile changes, for callers that cannot run that device's install. */
export const InstallationPullOptionsSchema = z.object({ withoutInstall: z.boolean().optional() }).strict();
export type InstallationPullOptions = z.infer<typeof InstallationPullOptionsSchema>;
