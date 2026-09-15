/*
 * Exports:
 * - WorkbenchTurnAdmission: explicit temporary versus admitted turn state.
 * - WorkbenchAdmissionTurn: provider-compatible turn carrying admission metadata.
 * - getWorkbenchTurnAdmission: read admitted metadata without interpreting an ID.
 * - withWorkbenchTurnAdmission: attach the lifecycle owner's admission state.
 * - isPendingWorkbenchTurn: narrow temporary identity from explicit admission metadata.
 */
import type { Turn } from "./workbench-thread-turn.ts";
import type { PendingTurnId } from "../identity.ts";

export type WorkbenchTurnAdmission = "connecting" | "providerPending" | "admitted";
export type WorkbenchAdmissionTurn = Turn & { workbenchAdmission?: WorkbenchTurnAdmission };

export function getWorkbenchTurnAdmission(turn: Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">): WorkbenchTurnAdmission {
  return turn.workbenchAdmission ?? "admitted";
}

export function isPendingWorkbenchTurn(turn: WorkbenchAdmissionTurn): turn is Turn & {
  id: PendingTurnId;
  workbenchAdmission: "connecting" | "providerPending";
} {
  return turn.workbenchAdmission === "connecting" || turn.workbenchAdmission === "providerPending";
}

export function withWorkbenchTurnAdmission<T extends Turn>(turn: T, admission: WorkbenchTurnAdmission): T {
  return { ...turn, workbenchAdmission: admission };
}
