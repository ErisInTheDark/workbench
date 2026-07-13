/*
 * Exports:
 * - notifyCollaborationStateUpdated: best-effort orchestrator broadcast for persisted Collaboration state changes. Keywords: collaboration, state, notification, orchestrator.
 */

import type { NextRequest } from "next/server";

import { sendServerWorkbenchOrchestratorRequest } from "../../../lib/codex/server-orchestrator";
import type { WorkbenchCollaborationState } from "../../../lib/types";

export async function notifyCollaborationStateUpdated(
  request: NextRequest,
  projectId: string,
  state: WorkbenchCollaborationState,
) {
  try {
    await sendServerWorkbenchOrchestratorRequest<{ ok?: boolean }>(request, "codex", {
      method: "workbench/notification/broadcast",
      params: {
        notification: {
          method: "collaboration/state/updated",
          params: {
            projectId,
            state,
          },
        },
      },
    });
  } catch {
    // Persistence is authoritative; live notification is best-effort.
  }
}
