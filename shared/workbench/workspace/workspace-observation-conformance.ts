/*
 * Exports:
 * - conformWorkspaceObservation: repair app observations, returning conformed app-state payloads.
 * - conformDaemonWorkspaceObservation: repair daemon observations without inventing envelope identity.
 * - conformWorkspaceObservationDelta: reject patches whose conformance discarded operations.
 * - describeObservationRepairs: bounded repair paths without payload values.
 */
import { z } from "zod";
import { conformWorkbenchClientStateResponse } from "../../state/workbench-client-state-conformance";
import { conformToZodSchema, type ZodSchemaRepair } from "../zod-schema-conformer";
import {
  DaemonWorkspaceObservationSchema, WorkspaceObservationSchema, WorkspaceObservationDeltaSchema,
  type WorkspaceObservation, type WorkspaceObservationDelta,
} from "./workspace-observation";

const payload = z.looseObject({ kind: z.string(), data: z.unknown().optional() });

export function conformWorkspaceObservation(value: unknown): ZodSchemaRepair<WorkspaceObservation> {
  const addressed = conformToZodSchema(payload, value);
  if (!addressed.success || addressed.data.kind !== "appState" || addressed.data.data == null) {
    return conformToZodSchema(WorkspaceObservationSchema, value);
  }
  const state = conformWorkbenchClientStateResponse(addressed.data.data);
  const repairedPaths = state.repairedPaths.map(path => ["data", ...path]);
  if (!("data" in state)) return { success: false, repairedPaths, discardedPaths: state.issues.map(issue => ["data", ...issue.path]) };
  const result = conformToZodSchema(WorkspaceObservationSchema, { ...addressed.data, data: state.data });
  return {
    ...result, repairedPaths: [...repairedPaths, ...result.repairedPaths],
    // Relational repairs ending at a row index drop that row; field repairs strip extras or fill declared defaults.
    discardedPaths: [...repairedPaths.filter(path => typeof path.at(-1) === "number"), ...result.discardedPaths],
  };
}

export function conformDaemonWorkspaceObservation(value: unknown) {
  return conformToZodSchema(DaemonWorkspaceObservationSchema, value);
}

export function conformWorkspaceObservationDelta(value: unknown): ZodSchemaRepair<WorkspaceObservationDelta> {
  const result = conformToZodSchema(WorkspaceObservationDeltaSchema, value);
  if (result.discardedPaths.length) return {
    success: false, repairedPaths: result.repairedPaths, discardedPaths: result.discardedPaths,
  };
  return result;
}

export function describeObservationRepairs(paths: readonly PropertyKey[][]) {
  return paths.slice(0, 5).map(path => path.map(String).join(".") || "<root>").join(", ")
    .concat(paths.length > 5 ? ` (+${paths.length - 5} more)` : "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 1_000);
}
