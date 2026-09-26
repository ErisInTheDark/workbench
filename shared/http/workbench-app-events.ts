/*
 * Exports:
 * - WORKBENCH_APP_LIFETIME_SOCKET_PATH/WORKBENCH_APP_NETWORK_SOCKET_PATH: app-owned upgrade routes.
 * - WorkbenchAppLifetimeEventSchema/WorkbenchAppNetworkEventSchema: validated channel-specific notifications.
 */
import { z } from "zod";
import { WorkbenchNetworkSnapshotSchema } from "./workbench-network.ts";
import {
  WorkbenchPresentationImportStatusSchema,
  WorkbenchPresentationRevisionEventSchema,
} from "../state/workbench-presentation-state.ts";

export const WORKBENCH_APP_LIFETIME_SOCKET_PATH = "/api/workbench-app-lifetime/socket";
export const WORKBENCH_APP_NETWORK_SOCKET_PATH = "/api/workbench-network/socket";

export const WorkbenchAppLifetimeEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("stopped") }).strict(),
]);

export const WorkbenchAppNetworkEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("network"), snapshot: WorkbenchNetworkSnapshotSchema }).strict(),
  z.object({ kind: z.literal("presentation"), event: WorkbenchPresentationRevisionEventSchema }).strict(),
  z.object({ kind: z.literal("presentation-import"), status: WorkbenchPresentationImportStatusSchema }).strict(),
]);
