/*
 * Exports:
 * - statsThreadIdentity: the openable thread a stats row names, or null when it lacks a provider or valid ids.
 */
import { ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

export function statsThreadIdentity({ harness, projectId, threadId }: { harness: string | null; projectId: string; threadId: string | null }) {
  const project = ProjectIdSchema.safeParse(projectId).data;
  const thread = WorkbenchThreadIdSchema.safeParse(threadId).data;
  return harness && project && thread ? { harness, projectId: project, threadId: thread } : null;
}
