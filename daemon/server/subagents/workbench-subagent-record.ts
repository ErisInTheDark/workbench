/*
 * Exports:
 * - WorkbenchSubagentReservation: reserved child metadata without a thread id.
 * - WorkbenchStoredSubagent: reserved or active stored relationship.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

export type WorkbenchSubagentReservation = Omit<WorkbenchSubagentRelationship, "threadId"> & { reservationId: string };
export type WorkbenchStoredSubagent =
  | (WorkbenchSubagentReservation & { kind: "reserved" })
  | (WorkbenchSubagentRelationship & { kind: "active" });

