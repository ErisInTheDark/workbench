/*
 * Exports:
 * - ProjectLocationReferenceSchema/ProjectLocationReference: concrete daemon-owned execution address.
 * - WorkbenchProjectLocationsPayloadSchema/WorkbenchProjectLocationsPayload: identity metadata over concrete catalogue rows.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema } from "../identity.ts";
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

