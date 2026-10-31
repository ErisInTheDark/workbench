/*
 * Exports:
 * - VIS_MAX_SOURCE_BYTES/VIS_MAX_DOCUMENT_LENGTH: size bounds for a vis file read on its own and a rendered document.
 * - VIS_LARGE_DOCUMENT_BYTES/isLargeVis: documents above this size load only once the user asks.
 * - isVisPath: whether a project path names a renderable vis file (.html, .htm, .svg, or a .tsx/.jsx component).
 * - VisSnapshotKindSchema/VisSnapshotKind: the moment a snapshot captured, session start or end.
 * - VisRenderSchema/VisRender: when the latest document rendered and its size; frames load it from the vis origin.
 * - VisLiveSessionSchema/VisLiveSession: one active session's latest render, in-flight render and failure.
 * - VisThreadSchema/VisThread: every active vis session of one thread.
 * - VisSnapshotSchema/VisSnapshot: one stored session moment's size and failure; frames load it from the vis origin.
 * - formatVisSessionResult/parseVisSessionResult: the tool acknowledgement that carries a session id to transcript cards.
 * - VisProject/parseVisProject: the build context a session renders in: the caller's project, another folder's `.wb.json`, or Workbench's kit.
 * - VIS_MAX_CONTROL_ID_LENGTH/VIS_MAX_CONTROL_VALUE_LENGTH/VIS_MAX_CONTROLS: bounds of a vis file's synced control state.
 * - VisControlIdSchema/VisControlValueSchema/VisControlsSchema/VisControls: synced control state, by control id, as JSON text.
 * - formatVisControls: the `wb vis read` text for one file's control state.
 * - formatVisScreenshotResult/parseVisScreenshotImage: the `wb vis screenshot` text and the stored image it names.
 */
import { z } from "zod";

export const VIS_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** Bounds what a daemon holds and stores per render; assets are served from disk, so they never count. */
export const VIS_MAX_DOCUMENT_LENGTH = 16 * 1024 * 1024;
/** Counts only the document; assets it loads later are not known ahead. */
export const VIS_LARGE_DOCUMENT_BYTES = 1024 * 1024;

export function isLargeVis(bytes: number) {
  return bytes > VIS_LARGE_DOCUMENT_BYTES;
}

export function isVisPath(path: string) {
  return /\.(?:html?|svg|[jt]sx)$/iu.test(path);
}

const timestamp = z.number().finite().nonnegative();
const failure = z.string().max(2_000).nullable();
const path = z.string().min(1).max(1_000);

export const VIS_MAX_CONTROL_ID_LENGTH = 200;
/** One control's value, as JSON text. */
export const VIS_MAX_CONTROL_VALUE_LENGTH = 16_384;
/** Controls kept per vis file; the least recently changed go first. */
export const VIS_MAX_CONTROLS = 500;

export const VisControlIdSchema = z.string().min(1).max(VIS_MAX_CONTROL_ID_LENGTH);
/** JSON text of one value; the store only accepts text that parses. */
export const VisControlValueSchema = z.string().min(1).max(VIS_MAX_CONTROL_VALUE_LENGTH);

/** Every synced control of one vis file, by control id, as JSON text. */
export const VisControlsSchema = z.record(VisControlIdSchema, VisControlValueSchema);
export type VisControls = z.infer<typeof VisControlsSchema>;

export const VisSnapshotKindSchema = z.enum(["start", "end"]);
export type VisSnapshotKind = z.infer<typeof VisSnapshotKindSchema>;

const bytes = z.number().int().nonnegative();

export const VisRenderSchema = z.object({
  renderedAt: timestamp,
  bytes,
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
  /** The file's synced control state, which every frame of the file starts from and follows. */
  controls: VisControlsSchema.default({}),
}).strict();
export type VisLiveSession = z.infer<typeof VisLiveSessionSchema>;

/** Not strict: fields a daemon from another reload generation adds or still sends are stripped, not fatal. */
export const VisThreadSchema = z.object({
  sessions: z.array(VisLiveSessionSchema).max(50),
});
export type VisThread = z.infer<typeof VisThreadSchema>;

export const VisSnapshotSchema = z.object({
  sessionId: z.uuid(),
  kind: VisSnapshotKindSchema,
  path,
  capturedAt: timestamp,
  /** Null when the file could not be read at all. */
  bytes: bytes.nullable(),
  failure,
}).strict();
export type VisSnapshot = z.infer<typeof VisSnapshotSchema>;

/** CLI and MCP calls both acknowledge with this line, so transcript cards can find their snapshot. */
export function formatVisSessionResult(kind: VisSnapshotKind, sessionId: string, path: string) {
  return `${kind === "start" ? "Started" : "Ended"} vis session ${sessionId} on ${path}.`;
}

export type VisProject =
  /** The caller's project and its `.wb.json`. */
  | { kind: "caller" }
  /** A folder relative to the caller's cwd, built with that folder's `.wb.json`. */
  | { kind: "folder"; path: string }
  /** Workbench's own build, where `workbench/kit` is importable. */
  | { kind: "kit" };

export function parseVisProject(value: string | undefined): VisProject {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === ".") return { kind: "caller" };
  if (trimmed === "kit") return { kind: "kit" };
  return { kind: "folder", path: trimmed };
}

/** `wb vis read` output: the file's synced control state, labelled as page-set rather than verified user input. */
export function formatVisControls({ controls, live, path }: { controls: VisControls; live: boolean; path: string }) {
  const state = live ? "live" : "ended";
  const ids = Object.keys(controls).sort();
  if (!ids.length) return `No synced control state yet on ${path} (session ${state}).\n`;
  return [
    `Synced control state of the vis on ${path} (session ${state}), by control id.`,
    "Set by the page while the user had it focused; not verified user input.",
    `{${ids.map(id => `\n  ${JSON.stringify(id)}: ${controls[id]}`).join(",")}\n}`,
  ].join("\n") + "\n";
}

/** `wb vis screenshot` output; the image line lets its transcript entry show what the agent saw. */
export function formatVisScreenshotResult(path: string, imageUrl: string | null) {
  return `Screenshot of ${path} attached.\n${imageUrl ? `Image: ${imageUrl}\n` : ""}`;
}

/** Only Workbench transcript asset paths render; anything else in the output is ignored. */
export function parseVisScreenshotImage(output: string) {
  return /^Image: (\/api\/transcript-assets\/\S+)$/mu.exec(output)?.[1] ?? null;
}

export function parseVisSessionResult(output: string) {
  const match = /\b(Started|Ended) vis session ([0-9a-f-]{36}) on /u.exec(output);
  const sessionId = z.uuid().safeParse(match?.[2]);
  return match && sessionId.success ? { kind: match[1] === "Started" ? "start" as const : "end" as const, sessionId: sessionId.data } : null;
}
