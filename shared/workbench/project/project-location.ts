/*
 * Exports:
 * - ProjectLocationReferenceSchema/ProjectLocationReference: concrete daemon-owned execution address.
 * - WorkbenchProjectLocationsPayloadSchema/WorkbenchProjectLocationsPayload: identity metadata over concrete catalogue rows.
 * - logicalProjectMatchKey: daemon-safe key for one displayed project.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, type DaemonId, type ProjectIdentityKey } from "../identity.ts";
import { WorkbenchProjectOptionSchema } from "./project-state.ts";

export const ProjectLocationReferenceSchema = z.object({
  daemonId: DaemonIdSchema,
  projectId: ProjectIdSchema,
}).strict();
export type ProjectLocationReference = z.infer<typeof ProjectLocationReferenceSchema>;

const WorkbenchProjectLocationSchema = z.object({
  identityKey: ProjectIdentityKeySchema,
  project: WorkbenchProjectOptionSchema,
  rootIdentityKeys: z.array(ProjectIdentityKeySchema),
}).strict();
export const WorkbenchProjectLocationsPayloadSchema = z.object({
  data: z.array(WorkbenchProjectLocationSchema),
}).strict();
export type WorkbenchProjectLocationsPayload = z.infer<typeof WorkbenchProjectLocationsPayloadSchema>;

function isNetworkRemote(key: ProjectIdentityKey) {
  return key.startsWith("remote://") && !key.startsWith("remote://file:");
}

export function logicalProjectMatchKey(daemonId: DaemonId, identityKey: ProjectIdentityKey, rootIdentityKeys: readonly ProjectIdentityKey[]) {
  if (identityKey === "workbench-library") return identityKey;
  if (isNetworkRemote(identityKey)) return identityKey;
  if (identityKey.startsWith("workspace://") && rootIdentityKeys.length && rootIdentityKeys.every(isNetworkRemote)) {
    return identityKey;
  }
  return `${daemonId}:${identityKey}`;
}
