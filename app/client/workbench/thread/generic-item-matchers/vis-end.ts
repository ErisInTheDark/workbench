/*
 * Keywords: generic item, vis end, matcher.
 * Exports:
 * - VisEndItemMatch: validated presentation input for a vis session the user ended from its card.
 * - matchVisEndItem: recognise Workbench's stored `visEnd` item without changing its source.
 */
import { z } from "zod";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";

export interface VisEndItemMatch {
  kind: "visEnd";
  sessionId: string;
  path: string;
}

const VisEndValueSchema = z.object({ sessionId: z.uuid(), path: z.string().min(1) });

export function matchVisEndItem({ nativeType, safeValue }: { nativeType: string; safeValue: JsonValue }): VisEndItemMatch | null {
  if (nativeType !== "visEnd") return null;
  const parsed = VisEndValueSchema.safeParse(safeValue);
  return parsed.success ? { kind: "visEnd", sessionId: parsed.data.sessionId, path: parsed.data.path } : null;
}
