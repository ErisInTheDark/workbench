/*
 * Exports:
 * - GitArcEditReferenceSpecSchema/GitArcEditReferenceSpec: agent-defined path reference syntax that moves rewrite.
 * - GitArcEditOperationSchema/GitArcEditOperation/GitArcEditOperationsSchema: ordered move and regex replace operations.
 * - GitArcEditFileSchema/GitArcEditFile: one touched file with its totals and changed new-side lines.
 * - GitArcEditCollisionSchema/GitArcEditCollision: touched paths another thread claims.
 * - GitArcEditResultSchema/GitArcEditResult/GitArcEditPhase: one edit session response.
 * - GIT_ARC_EDIT_PAGE_SIZE: files per view page.
 * - formatGitArcEditText/parseGitArcEditText: plain-text session result shared by the CLI and transcript cards.
 */
import { z } from "zod";
import { escapeGitArcValue, readGitArcValue } from "./git-arc-receipts";

const text = z.string().trim().min(1);
const scopeRoots = z.array(text).min(1).default(["."]);

export const GIT_ARC_EDIT_PAGE_SIZE = 100;

export const GitArcEditReferenceSpecSchema = z.object({
  /** Specifier prefix -> root-relative folder it stands for. */
  aliases: z.record(text, text).default({}),
  /** Tried in order for extensionless or extension-swapped specifiers. */
  extensions: z.array(text).default([]),
  globs: z.array(text).default([]),
  includeIgnored: z.boolean().default(false),
  /** Folder specifiers try `<folder>/<name><extension>`. */
  indexNames: z.array(text).default([]),
  /** JavaScript regex; its `path` named group is the only text ever rewritten. */
  pattern: text,
  roots: scopeRoots,
}).strict();
export type GitArcEditReferenceSpec = z.infer<typeof GitArcEditReferenceSpecSchema>;

const MoveOperationSchema = z.object({
  from: text.optional(),
  includeIgnored: z.boolean().default(false),
  kind: z.literal("move"),
  pathPattern: text.optional(),
  pathReplacement: z.string().optional(),
  references: z.array(GitArcEditReferenceSpecSchema).default([]),
  roots: z.array(text).min(1).optional(),
  to: text.optional(),
}).strict().superRefine((input, context) => {
  const direct = input.from !== undefined || input.to !== undefined;
  const matching = input.pathPattern !== undefined || input.pathReplacement !== undefined || input.roots !== undefined;
  if (direct === matching
    || (direct && (input.from === undefined || input.to === undefined))
    || (matching && (input.pathPattern === undefined || input.pathReplacement === undefined || input.roots === undefined))) {
    context.addIssue({ code: "custom", message: "A move needs either from and to, or pathPattern, pathReplacement and roots." });
  }
});

const ReplaceOperationSchema = z.object({
  flags: z.string().regex(/^[ims]*$/u, "Replace flags may only add i, m and s.").default(""),
  globs: z.array(text).default([]),
  includeIgnored: z.boolean().default(false),
  kind: z.literal("replace"),
  pattern: text,
  replacement: z.string(),
  roots: scopeRoots,
}).strict();

export const GitArcEditOperationSchema = z.discriminatedUnion("kind", [MoveOperationSchema, ReplaceOperationSchema]);
export type GitArcEditOperation = z.infer<typeof GitArcEditOperationSchema>;
export const GitArcEditOperationsSchema = z.array(GitArcEditOperationSchema).min(1);

export const GitArcEditFileSchema = z.object({
  additions: z.number().int().nonnegative(),
  binary: z.boolean().default(false),
  deletions: z.number().int().nonnegative(),
  ignored: z.boolean().default(false),
  lines: z.array(z.number().int().positive()).default([]),
  movedFrom: text.optional(),
  path: text,
}).strict();
export type GitArcEditFile = z.infer<typeof GitArcEditFileSchema>;

export const GitArcEditCollisionSchema = z.object({
  owner: text,
  paths: z.array(text).min(1),
  threadId: text,
}).strict();
export type GitArcEditCollision = z.infer<typeof GitArcEditCollisionSchema>;

export const GitArcEditPhaseSchema = z.enum(["preview", "applied", "reverted", "ended"]);
export type GitArcEditPhase = z.infer<typeof GitArcEditPhaseSchema>;

const count = z.number().int().nonnegative();

export const GitArcEditResultSchema = z.object({
  additionalClaims: z.array(text).default([]),
  additions: count,
  blockedDirtyPaths: z.array(text).default([]),
  blockedPendingPaths: z.array(text).default([]),
  collisions: z.array(GitArcEditCollisionSchema).default([]),
  conflictedPaths: z.array(text).default([]),
  deletions: count,
  diffs: z.array(z.object({ patch: z.string(), path: text }).strict()).default([]),
  fileCount: count,
  files: z.array(GitArcEditFileSchema),
  ignoredFileCount: count.default(0),
  matchedPreview: z.boolean().optional(),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  phase: GitArcEditPhaseSchema,
  releasedClaims: z.array(text).default([]),
  rootId: text.optional(),
  session: text,
  skippedFileCount: count.default(0),
  warnings: z.array(text).default([]),
}).strict();
export type GitArcEditResult = z.infer<typeof GitArcEditResultSchema>;

const HINTS: Record<GitArcEditPhase, string> = {
  applied: "Review with wb git arc edit view, then wb git arc edit end to keep it or wb git arc edit revert to undo it.",
  ended: "Session ended; its changes stay as ordinary arc work.",
  preview: "Review with wb git arc edit view [--page <n>] [--diff <path>[:<line>]]..., then apply with wb git arc edit apply.",
  reverted: "Session reverted; later edits to its files were kept.",
};

function row(...values: string[]) {
  return values.map(escapeGitArcValue).join("\t");
}

export function formatGitArcEditText(input: GitArcEditResult) {
  const result = GitArcEditResultSchema.parse(input);
  const lines = [`arc edit ${result.phase} ${result.session}`];
  const list = (name: string, values: readonly string[]) => {
    if (values.length) lines.push(`${name} ${values.length}`, ...values.map(value => escapeGitArcValue(value)));
  };
  if (result.rootId) lines.push(`root ${escapeGitArcValue(result.rootId)}`);
  lines.push(`totals ${result.fileCount} +${result.additions} -${result.deletions}`);
  if (result.ignoredFileCount) lines.push(`ignored ${result.ignoredFileCount}`);
  if (result.skippedFileCount) lines.push(`skipped ${result.skippedFileCount}`);
  lines.push(`page ${result.page}/${result.pageCount}`, `files ${result.files.length}`);
  for (const file of result.files) {
    const flags = [...file.ignored ? ["ignored"] : [], ...file.binary ? ["binary"] : []];
    lines.push(row(file.movedFrom ? "R" : "M", `+${file.additions}`, `-${file.deletions}`, file.path, file.lines.join(","), file.movedFrom ?? "", flags.join(",")));
  }
  list("claimed", result.additionalClaims);
  list("released", result.releasedClaims);
  const collisionRows = result.collisions.flatMap(({ owner, paths, threadId }) => paths.map(filePath => row(threadId, owner, filePath)));
  if (collisionRows.length) lines.push(`collisions ${collisionRows.length}`, ...collisionRows);
  list("blocked-dirty", result.blockedDirtyPaths);
  list("blocked-pending", result.blockedPendingPaths);
  list("conflicts", result.conflictedPaths);
  list("warnings", result.warnings);
  if (result.matchedPreview !== undefined) lines.push(`matched-preview ${result.matchedPreview ? "yes" : "no"}`);
  lines.push("end edit");
  for (const diff of result.diffs) lines.push(`diff ${escapeGitArcValue(diff.path)}`, diff.patch.trimEnd());
  if (result.collisions.length && result.phase === "preview") lines.push("Apply waits until the other threads release the colliding paths.");
  if (result.blockedDirtyPaths.length) lines.push("Apply rejects unclaimed dirty paths: adopt them with git_arc_claims or exclude them from the operations.");
  if (result.blockedPendingPaths.length) lines.push("Apply rejects paths in pending proposals: stack or rescind those proposals first.");
  if (result.conflictedPaths.length) lines.push("Resolve the conflict markers directly. No Git continuation or abort command is required.");
  lines.push(HINTS[result.phase]);
  return lines.join("\n");
}

/** Reads the summary block of `formatGitArcEditText`; diffs and hints after `end edit` are not presentation facts. */
export function parseGitArcEditText(output: string): GitArcEditResult | null {
  const lines = String(output ?? "").split(/\r?\n/u);
  const start = lines.findIndex(line => /^arc edit (preview|applied|reverted|ended) \S+$/u.test(line));
  if (start < 0) return null;
  const [, , phase, session] = lines[start]!.split(" ");
  const result: Record<string, unknown> = { phase, session };
  let index = start + 1;
  const take = (value: string) => {
    if (!/^\d+$/u.test(value) || index + Number(value) > lines.length) throw new Error("Invalid edit section count.");
    const values = lines.slice(index, index + Number(value));
    index += values.length;
    return values;
  };
  const lists: Record<string, string> = {
    "blocked-dirty": "blockedDirtyPaths", "blocked-pending": "blockedPendingPaths", claimed: "additionalClaims",
    conflicts: "conflictedPaths", released: "releasedClaims", warnings: "warnings",
  };
  try {
    while (index < lines.length) {
      const line = lines[index++]!;
      if (line === "end edit") return GitArcEditResultSchema.parse(result);
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "root") result.rootId = readGitArcValue(value);
      else if (key === "totals") {
        const match = /^(\d+) \+(\d+) -(\d+)$/u.exec(value);
        if (!match) throw new Error("Invalid edit totals.");
        Object.assign(result, { additions: Number(match[2]), deletions: Number(match[3]), fileCount: Number(match[1]) });
      } else if (key === "ignored" || key === "skipped") {
        result[key === "ignored" ? "ignoredFileCount" : "skippedFileCount"] = Number(value);
      } else if (key === "page") {
        const match = /^(\d+)\/(\d+)$/u.exec(value);
        if (!match) throw new Error("Invalid edit page.");
        Object.assign(result, { page: Number(match[1]), pageCount: Number(match[2]) });
      } else if (key === "files") {
        result.files = take(value).map((entry) => {
          const [kind, additions, deletions, filePath, changed, movedFrom, flags] = entry.split("\t").map(readGitArcValue);
          if (!kind || !filePath || !/^\+\d+$/u.test(additions ?? "") || !/^-\d+$/u.test(deletions ?? "")) throw new Error("Invalid edit file row.");
          const flagSet = new Set((flags ?? "").split(",").filter(Boolean));
          return {
            additions: Number(additions!.slice(1)),
            binary: flagSet.has("binary"),
            deletions: Number(deletions!.slice(1)),
            ignored: flagSet.has("ignored"),
            lines: (changed ?? "").split(",").filter(Boolean).map(Number),
            ...(kind === "R" && movedFrom ? { movedFrom } : {}),
            path: filePath,
          };
        });
      } else if (key === "collisions") {
        const owners = new Map<string, { owner: string; paths: string[]; threadId: string }>();
        for (const entry of take(value)) {
          const [threadId, owner, filePath] = entry.split("\t").map(readGitArcValue);
          if (!threadId || !owner || !filePath) throw new Error("Invalid edit collision row.");
          const existing = owners.get(threadId) ?? { owner, paths: [], threadId };
          existing.paths.push(filePath);
          owners.set(threadId, existing);
        }
        result.collisions = [...owners.values()];
      } else if (lists[key]) {
        result[lists[key]!] = take(value).map(readGitArcValue);
      } else if (key === "matched-preview") {
        result.matchedPreview = value === "yes";
      } else throw new Error("Unknown edit section.");
    }
  } catch {
    return null;
  }
  return null;
}
