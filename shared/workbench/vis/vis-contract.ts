/*
 * Exports:
 * - VIS_MAX_SOURCE_BYTES/VIS_MAX_DOCUMENT_LENGTH: size bounds for a vis file and its rendered document.
 * - isVisPath: whether a project path names a renderable vis file (.html, .htm, .svg, or a .tsx/.jsx component).
 * - VisSnapshotKindSchema/VisSnapshotKind: the moment a snapshot captured, session start or end.
 * - VisRenderSchema/VisRender: one rendered document, ready for a sandboxed frame.
 * - VisLiveSessionSchema/VisLiveSession: one active session's latest render, in-flight render and failure.
 * - VisUserEndedSchema/VisUserEnded: a session the user ended, for their own transcript note.
 * - VisThreadSchema/VisThread: every active vis session of one thread, plus the ones the user ended.
 * - VisSnapshotSchema/VisSnapshot: the stored document of one session moment.
 * - formatVisSessionResult/parseVisSessionResult: the tool acknowledgement that carries a session id to transcript cards.
 */
import { z } from "zod";

export const VIS_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** Rendered documents include compiled CSS, so they may outgrow their source. */
export const VIS_MAX_DOCUMENT_LENGTH = 6 * 1024 * 1024;

export function isVisPath(path: string) {
  return /\.(?:html?|svg|[jt]sx)$/iu.test(path);
}

const timestamp = z.number().finite().nonnegative();
const failure = z.string().max(2_000).nullable();
const path = z.string().min(1).max(1_000);

export const VisSnapshotKindSchema = z.enum(["start", "end"]);
export type VisSnapshotKind = z.infer<typeof VisSnapshotKindSchema>;

export const VisRenderSchema = z.object({
  document: z.string().max(VIS_MAX_DOCUMENT_LENGTH),
  renderedAt: timestamp,
}).strict();
export type VisRender = z.infer<typeof VisRenderSchema>;

export const VisLiveSessionSchema = z.object({
  sessionId: z.uuid(),
  path,
  startedAt: timestamp,
  /** The last finished render; a file change keeps showing it until the next render finishes. */
  render: VisRenderSchema.nullable(),
  /** A file change was seen and its render has not finished yet. */
  rendering: z.boolean(),
  /** Why the latest render failed; the previous render stays. */
  failure,
}).strict();
export type VisLiveSession = z.infer<typeof VisLiveSessionSchema>;

/** A session the user ended from the card; shown to them in the transcript, never to the agent. */
export const VisUserEndedSchema = z.object({ sessionId: z.uuid(), path, endedAt: timestamp }).strict();
export type VisUserEnded = z.infer<typeof VisUserEndedSchema>;

export const VisThreadSchema = z.object({
  sessions: z.array(VisLiveSessionSchema).max(50),
  /** Older daemons send none. */
  userEnded: z.array(VisUserEndedSchema).max(500).default([]),
}).strict();
export type VisThread = z.infer<typeof VisThreadSchema>;

export const VisSnapshotSchema = z.object({
  sessionId: z.uuid(),
  kind: VisSnapshotKindSchema,
  path,
  capturedAt: timestamp,
  /** Null when the file could not be read at all. */
  document: z.string().max(VIS_MAX_DOCUMENT_LENGTH).nullable(),
  failure,
}).strict();
export type VisSnapshot = z.infer<typeof VisSnapshotSchema>;

/** CLI and MCP calls both acknowledge with this line, so transcript cards can find their snapshot. */
export function formatVisSessionResult(kind: VisSnapshotKind, sessionId: string, path: string) {
  return `${kind === "start" ? "Started" : "Ended"} vis session ${sessionId} on ${path}.`;
}

export function parseVisSessionResult(output: string) {
  const match = /\b(Started|Ended) vis session ([0-9a-f-]{36}) on /u.exec(output);
  const sessionId = z.uuid().safeParse(match?.[2]);
  return match && sessionId.success ? { kind: match[1] === "Started" ? "start" as const : "end" as const, sessionId: sessionId.data } : null;
}
