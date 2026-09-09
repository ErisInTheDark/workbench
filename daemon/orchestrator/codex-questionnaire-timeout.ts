/*
 * Keywords: Codex, MCP, questionnaire, timeout, provider boundary.
 * Exports:
 * - getCodexQuestionnaireTimeout: identify the owning turn of a failed Workbench questionnaire call, not unrelated tool failures or transcript prose.
 */
import { z } from "zod";

import type { JsonRpcNotification } from "./bridge-types";

const TimeoutNotificationSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    item: z.object({
      type: z.literal("mcpToolCall"),
      server: z.literal("wb"),
      tool: z.literal("request_user_input"),
      status: z.literal("failed"),
      error: z.object({ message: z.string() }),
    }),
  }),
});

export function getCodexQuestionnaireTimeout(notification: JsonRpcNotification) {
  const parsed = TimeoutNotificationSchema.safeParse(notification);
  if (!parsed.success) return null;
  // Codex's operation deadline reports failure on the tool item. It does not
  // require an MCP cancellation notification to reach the server.
  // Its tool handler can wrap that deadline in an anyhow error chain.
  const cause = parsed.data.params.item.error.message.replace(
    /^(?:tool call error: )?tool call failed for `wb\/request_user_input`\r?\n\r?\nCaused by:\r?\n[ \t]+/u,
    "",
  );
  if (!/^(?:tool call error: )?timed out awaiting tools\/call after \d+(?:\.\d+)?(?:ms|s|m|h)\s*$/u.test(cause)) return null;
  return { threadId: parsed.data.params.threadId, turnId: parsed.data.params.turnId };
}
