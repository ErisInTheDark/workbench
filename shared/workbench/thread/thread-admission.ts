/*
 * Keywords: turn, admission, connecting, provider, temporary.
 * Exports:
 * - WorkbenchTurnAdmission: explicit temporary versus admitted turn state.
 * - WorkbenchAdmissionTurn: provider-compatible turn carrying admission metadata.
 * - getWorkbenchTurnAdmission: read admitted metadata without interpreting an ID.
 * - withWorkbenchTurnAdmission: attach the lifecycle owner's admission state.
 */
import type { Turn } from "../../codex/generated/app-server/v2/Turn.ts";

export type WorkbenchTurnAdmission = "connecting" | "providerPending" | "admitted";
export type WorkbenchAdmissionTurn = Turn & { workbenchAdmission?: WorkbenchTurnAdmission };

export function getWorkbenchTurnAdmission(turn: Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">): WorkbenchTurnAdmission {
  return turn.workbenchAdmission ?? "admitted";
}

export function withWorkbenchTurnAdmission<T extends Turn>(turn: T, admission: WorkbenchTurnAdmission): T {
  return { ...turn, workbenchAdmission: admission };
}
