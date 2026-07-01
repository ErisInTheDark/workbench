/*
 * Exports:
 * - notifyCollaborationStateUpdated: best-effort bridge broadcast for persisted Collaboration state changes. Keywords: collaboration, state, notification, websocket.
 */

import type { NextRequest } from "next/server";

import { sendServerWorkbenchBridgeRequest } from "../../../lib/codex/server-bridge";
import type { WorkbenchCollaborationState } from "../../../lib/types";

export async function notifyCollaborationStateUpdated(
  request: NextRequest,
  projectId: string,
  state: WorkbenchCollaborationState,
) {
  try {
    await sendServerWorkbenchBridgeRequest<{ ok?: boolean }>(request, "codex", {
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
