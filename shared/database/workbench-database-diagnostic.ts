/*
 * Exports:
 * - WorkbenchDatabaseDiagnosticEventSchema/WorkbenchDatabaseDiagnosticEvent: bounded database lifecycle evidence.
 * - formatWorkbenchDatabaseDiagnostic: render one diagnostic only at a human log edge.
 */
import { z } from "zod";

import { formatDatabaseLog } from "./database-log-format.ts";

export const WorkbenchDatabaseDiagnosticEventSchema = z.object({
  source: z.literal("database"),
  operation: z.string().min(1).transform(value =>
    value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 64)),
  phase: z.enum(["pending", "progress", "completed", "warning"]),
  level: z.enum(["info", "warn"]),
  detail: z.string().transform(value =>
    value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500)),
  elapsedMs: z.number().finite().nonnegative().nullable(),
  progress: z.object({
    completed: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
    unit: z.string().min(1).max(32),
  }).strict().nullable(),
}).strict();

export type WorkbenchDatabaseDiagnosticEvent = z.infer<typeof WorkbenchDatabaseDiagnosticEventSchema>;

export function formatWorkbenchDatabaseDiagnostic(event: WorkbenchDatabaseDiagnosticEvent) {
  if (event.phase === "warning") {
    return ` DB ${event.operation} warning (${event.detail})`;
  }
  return formatDatabaseLog(
    event.operation,
    event.phase === "completed" ? "ok" : event.phase === "progress" ? "copying" : "pending",
    event.detail,
    event.elapsedMs ?? undefined,
  );
}
