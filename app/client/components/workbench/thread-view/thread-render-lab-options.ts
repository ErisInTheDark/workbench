/*
 * Exports:
 * - ThreadRenderContext: renderer-owned optional fixture context.
 * - threadRenderFlags/ThreadRenderFlags: named switches exposed by the lab.
 * - ThreadRenderTurnStatus/withThreadRenderStatus: non-mutating latest-turn override.
 * - parseThreadRenderContext: admit local JSON context, rejecting unsupported keys.
 * - parseThreadRenderProjection: admit a canonical projection fixture for the thread renderer.
 */
import type { ComponentProps } from "react";
import type { ThreadPayload } from "workbench-shared/types";
import type ThreadTranscriptProjection from "./ThreadTranscriptProjection";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";

type RendererProps = ComponentProps<typeof ThreadTranscriptProjection>;
export type ThreadRenderContext = Partial<Pick<RendererProps,
  "knownSkills" | "projectFilePaths" | "projectId" | "projectRootPath" | "workspaceRoots"
  | "relatedThreadsById" | "subagents" | "inlineMentionSources" | "hiddenReasoningStep">>;

export const threadRenderFlags = {
  showLiveActivity: "Show live activity",
} as const;
export type ThreadRenderFlags = Partial<Record<keyof typeof threadRenderFlags, boolean>>;
export type ThreadRenderTurnStatus = "preserve" | ThreadPayload["turns"][number]["status"];

export function withThreadRenderStatus(thread: ThreadPayload | null, status: ThreadRenderTurnStatus): ThreadPayload | null {
  if (!thread || status === "preserve" || !thread.turns.length) return thread;
  const last = thread.turns.at(-1)!;
  return {
    ...thread,
    status: status === "inProgress" ? "active" : "idle",
    turns: thread.turns.map(turn => turn === last ? { ...turn, status } : turn),
    turnHistory: thread.turnHistory.map(entry => entry.turnId === last.id ? { ...entry, status } : entry),
  };
}

const contextKinds = {
  knownSkills: "array", projectFilePaths: "array", projectId: "string", projectRootPath: "string",
  workspaceRoots: "array", relatedThreadsById: "object", subagents: "array",
  inlineMentionSources: "object", hiddenReasoningStep: "object",
} as const satisfies Record<keyof ThreadRenderContext, "array" | "object" | "string">;

export function parseThreadRenderContext(text: string): ThreadRenderContext {
  const value: unknown = JSON.parse(text.trim() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rendering context must be a JSON object.");
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(contextKinds, key)) throw new Error(`Unsupported context field: ${key}`);
    if (field === null && (key === "projectId" || key === "inlineMentionSources" || key === "hiddenReasoningStep")) continue;
    const kind = contextKinds[key as keyof typeof contextKinds];
    if (kind === "array" ? !Array.isArray(field) : kind === "string" ? typeof field !== "string" : !field || typeof field !== "object" || Array.isArray(field)) {
      throw new Error(`Context field ${key} must be ${kind}.`);
    }
  }
  // Fixture internals use the renderer's own contracts; render failures stay inside the lab boundary.
  return value as ThreadRenderContext;
}

export function parseThreadRenderProjection(text: string): WorkbenchTranscriptProjection {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("thread" in value) || !value.thread || typeof value.thread !== "object"
    || !("id" in value.thread) || typeof value.thread.id !== "string"
    || !("turns" in value) || !Array.isArray(value.turns)
    || !("display" in value) || !value.display || typeof value.display !== "object"
    || !("segments" in value.display) || !Array.isArray(value.display.segments)
    || !("browseResultEntries" in value) || !Array.isArray(value.browseResultEntries)) {
    throw new Error("Supply a canonical transcript projection with thread, turns, display.segments and browseResultEntries.");
  }
  return value as WorkbenchTranscriptProjection;
}
