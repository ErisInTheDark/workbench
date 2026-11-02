/*
 * Exports:
 * - GitArcRestackOutcomeSchema/GitArcRestackOutcome: what one restack did to one proposal, named by its title.
 * - GitArcRestackResultSchema/GitArcRestackResult: per-proposal restack outcomes, rewritten layers and released claims.
 * - formatGitArcRestackText/parseGitArcRestackText: the agent-read text of a restack, and its facts read back from it.
 */
import { z } from "zod";
import { escapeGitArcValue, readGitArcValue } from "./git-arc-receipts";

const nonEmptyString = z.string().trim().min(1);
const titled = { proposalId: nonEmptyString, title: z.string() };

export const GitArcRestackOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ ...titled, status: z.literal("rebased") }).strict(),
  z.object({ ...titled, status: z.literal("rescinded") }).strict(),
  /** `stripped` lists the files that left the proposal; a replaced proposal may also be a fold target. */
  z.object({ ...titled, replacementId: nonEmptyString, status: z.literal("replaced"), stripped: z.array(nonEmptyString) }).strict(),
  /** Folded into the proposal that `replacementId` now names. */
  z.object({ ...titled, replacementId: nonEmptyString, status: z.literal("superseded"), stripped: z.array(nonEmptyString) }).strict(),
]);
export type GitArcRestackOutcome = z.infer<typeof GitArcRestackOutcomeSchema>;

const LayerSchema = z.object({ proposalIds: z.array(nonEmptyString), title: nonEmptyString }).strict();

export const GitArcRestackResultSchema = z.object({
  /** Layers the restack rewrote, bottom first; lower layers and removed ones are omitted. */
  layers: z.array(LayerSchema),
  proposals: z.array(GitArcRestackOutcomeSchema),
  releasedClaims: z.array(nonEmptyString),
  rootId: nonEmptyString.optional(),
  stackTip: nonEmptyString.regex(/^[a-f0-9]{7,64}$/iu).nullable(),
}).strict();
export type GitArcRestackResult = z.infer<typeof GitArcRestackResultSchema>;

/** Layers and proposals print one JSON object per line: JSON escapes newlines, so titles cannot forge sections. */
export function formatGitArcRestackText(input: GitArcRestackResult) {
  const result = GitArcRestackResultSchema.parse(input);
  return [
    `arc restack ${result.stackTip ?? "none"}`,
    ...result.rootId ? [`root ${escapeGitArcValue(result.rootId)}`] : [],
    `layers ${result.layers.length}`, ...result.layers.map(layer => JSON.stringify(layer)),
    `proposals ${result.proposals.length}`, ...result.proposals.map(outcome => JSON.stringify(outcome)),
    `released ${result.releasedClaims.length}`, ...result.releasedClaims.map(escapeGitArcValue),
    "end restack",
  ].join("\n");
}

export function parseGitArcRestackText(output: string): GitArcRestackResult | null {
  const lines = String(output ?? "").split(/\r?\n/u);
  const start = lines.findIndex(line => /^arc restack \S+$/u.test(line));
  if (start < 0) return null;
  const tip = lines[start]!.slice("arc restack ".length);
  const result: Record<string, unknown> = { stackTip: tip === "none" ? null : tip };
  let index = start + 1;
  const take = (value: string) => {
    if (!/^\d+$/u.test(value) || index + Number(value) > lines.length) throw new Error("Invalid restack section count.");
    const values = lines.slice(index, index + Number(value));
    index += values.length;
    return values;
  };
  try {
    while (index < lines.length) {
      const line = lines[index++]!;
      if (line === "end restack") return GitArcRestackResultSchema.parse(result);
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "root") result.rootId = readGitArcValue(value);
      else if (key === "layers") result.layers = take(value).map(row => LayerSchema.parse(JSON.parse(row)));
      else if (key === "proposals") result.proposals = take(value).map(row => GitArcRestackOutcomeSchema.parse(JSON.parse(row)));
      else if (key === "released") result.releasedClaims = take(value).map(readGitArcValue);
      else return null;
    }
  } catch {
    return null;
  }
  return null;
}
