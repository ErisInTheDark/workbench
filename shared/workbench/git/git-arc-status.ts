/*
 * Exports:
 * - GitArcStatusFullSchema/GitArcStatusFull: selectable expanded status groups.
 * - GitArcClaimLossSchema/GitArcClaimLoss: exact persisted ownership-loss boundary metadata.
 * - GitArcStatusSchema/GitArcStatus: complete status facts shared by inspection and transport.
 * - GitArcStatusPresentation: parsed compact facts, preserving count-only groups.
 * - formatGitArcStatus/parseGitArcStatus: round-trip the compact status text used by agents and cards.
 */
import { z } from "zod";
import { formatGitArcDriftComparison } from "./git-arc-failures";

const text = z.string().min(1);
const sha = text.regex(/^[a-f0-9]{7,64}$/iu);
const filePaths = z.array(text);
const summary = z.union([filePaths, z.number().int().nonnegative()]);
export const GitArcStatusFullSchema = z.enum(["dirty", "clean", "unclaimed-dirt"]);
export type GitArcStatusFull = z.infer<typeof GitArcStatusFullSchema>;
export const GitArcClaimLossSchema = z.object({
  version: z.literal(1),
  paths: filePaths.min(1),
  head: sha.nullable(),
}).strict();
export type GitArcClaimLoss = z.infer<typeof GitArcClaimLossSchema>;
const comparison = z.array(z.object({
  path: text, additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  binary: z.boolean(), kind: z.enum(["add", "delete", "update"]),
}).strict());
const recovery = z.object({
  paths: filePaths,
  headMovement: z.enum(["same", "fast-forward", "incompatible"]),
  commits: z.array(z.object({ commit: sha, subject: z.string(), changedPaths: filePaths }).strict()),
  comparison,
  omittedCommits: z.number().int().nonnegative().default(0),
}).strict();
export const GitArcStatusSchema = z.object({
  pending: z.array(z.object({ proposalId: text, title: z.string() }).strict()),
  accepted: z.array(z.object({ proposalId: text, title: z.string(), commitSha: sha }).strict()),
  dirtyClaims: filePaths,
  cleanClaims: filePaths,
  unclaimedDirt: filePaths,
  recovery: z.array(recovery),
  unavailableRecovery: filePaths,
}).strict();
export type GitArcStatus = z.infer<typeof GitArcStatusSchema>;
const presentationSchema = GitArcStatusSchema.extend({
  dirtyClaims: summary, cleanClaims: summary, unclaimedDirt: summary,
  recovery: z.array(recovery.extend({ paths: summary })),
});
export type GitArcStatusPresentation = z.infer<typeof presentationSchema>;

function quote(value: string) {
  return !value || /[,"\u0000-\u001f\u007f-\u009f]/u.test(value) || /^\d+$/u.test(value) || value.trim() !== value
    ? JSON.stringify(value) : value;
}
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  return text.or(z.literal("")).parse(JSON.parse(value));
}
function splitList(value: string) {
  const result: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === ",") {
      if (value[index + 1] !== " ") throw new Error("Invalid status separator.");
      result.push(value.slice(start, index));
      start = index + 2;
      index++;
    }
  }
  if (quoted || escaped) throw new Error("Incomplete status value.");
  result.push(value.slice(start));
  return result;
}
function summarize(paths: string[], full = false) {
  return !full && paths.length > 5 ? String(paths.length) : paths.map(quote).join(", ");
}
function parseSummary(value: string) {
  return /^\d+$/u.test(value) ? Number(value) : splitList(value).map(unquote);
}
function readProposal(value: string) {
  const separator = value.indexOf(" ");
  if (separator < 1) throw new Error("Invalid proposal summary.");
  return { proposalId: unquote(value.slice(0, separator)), title: unquote(value.slice(separator + 1)) };
}

export function formatGitArcStatus(input: GitArcStatus, full: readonly GitArcStatusFull[] = []) {
  const status = GitArcStatusSchema.parse(input);
  const lines: string[] = [];
  if (status.pending.length) lines.push(`Proposals pending: ${status.pending.map(p => `${quote(p.proposalId)} ${quote(p.title)}`).join(", ")}`);
  if (status.accepted.length) lines.push(`Proposals accepted: ${status.accepted.map(p => `${quote(p.proposalId)} ${quote(p.title)} as ${p.commitSha}`).join(", ")}`);
  for (const [label, paths, selector] of [
    ["Dirty claims", status.dirtyClaims, "dirty"],
    ["Clean claims", status.cleanClaims, "clean"],
    ["Unclaimed dirt", status.unclaimedDirt, "unclaimed-dirt"],
  ] as const) if (paths.length) lines.push(`${label}: ${summarize(paths, full.includes(selector))}`);
  for (const lost of status.recovery) {
    lines.push(`Lost claims: ${summarize(lost.paths)}`);
    if (lost.headMovement === "incompatible") lines.push("HEAD since claim loss: incompatible");
    if (lost.commits.length) {
      lines.push(`Intersecting commits: ${lost.commits.map(c => `${c.commit} ${quote(c.subject)}`).join(", ")}`);
    }
    if (lost.omittedCommits) lines.push(`More intersecting commits: ${lost.omittedCommits}`);
    if (lost.comparison.length) {
      lines.push("Changes since claim loss:");
      lines.push(...formatGitArcDriftComparison(lost.comparison));
    }
  }
  if (status.unavailableRecovery.length) lines.push(`Claim-loss baseline unavailable: ${status.unavailableRecovery.map(quote).join(", ")}`);
  return lines.join("\n");
}

export function parseGitArcStatus(output: string) {
  try {
    const result: GitArcStatusPresentation = {
      pending: [], accepted: [], dirtyClaims: [], cleanClaims: [], unclaimedDirt: [], recovery: [], unavailableRecovery: [],
    };
    let lost: GitArcStatusPresentation["recovery"][number] | undefined;
    const lines = output.trim() ? output.trim().split(/\r?\n/u) : [];
    const seen = new Set<string>();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const separator = line.indexOf(":");
      const label = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).trimStart();
      if (lost && !["HEAD since claim loss", "Intersecting commits", "More intersecting commits", "Changes since claim loss"].includes(label)) {
        result.recovery.push(lost);
        lost = undefined;
      }
      if (["Proposals pending", "Proposals accepted", "Dirty claims", "Clean claims", "Unclaimed dirt", "Claim-loss baseline unavailable"].includes(label)) {
        if (seen.has(label)) throw new Error("Duplicate status group.");
        seen.add(label);
      }
      switch (label) {
        case "Proposals pending": result.pending = splitList(value).map(readProposal); break;
        case "Proposals accepted":
          result.accepted = splitList(value).map(entry => {
            const at = entry.lastIndexOf(" as ");
            if (at < 0) throw new Error("Invalid acceptance summary.");
            return { ...readProposal(entry.slice(0, at)), commitSha: entry.slice(at + 4) };
          });
          break;
        case "Dirty claims": result.dirtyClaims = parseSummary(value); break;
        case "Clean claims": result.cleanClaims = parseSummary(value); break;
        case "Unclaimed dirt": result.unclaimedDirt = parseSummary(value); break;
        case "Lost claims":
          if (lost) throw new Error("Incomplete recovery group.");
          lost = { paths: parseSummary(value), headMovement: "same", commits: [], comparison: [], omittedCommits: 0 };
          break;
        case "HEAD since claim loss":
          if (!lost || value !== "incompatible") throw new Error("Invalid head movement.");
          lost.headMovement = "incompatible";
          break;
        case "Intersecting commits":
          if (!lost) throw new Error("Missing recovery group.");
          lost.commits = splitList(value).map(entry => {
            const at = entry.indexOf(" ");
            return { commit: entry.slice(0, at), subject: unquote(entry.slice(at + 1)), changedPaths: [] };
          });
          if (lost.headMovement !== "incompatible") lost.headMovement = "fast-forward";
          break;
        case "More intersecting commits":
          if (!lost || !/^\d+$/u.test(value)) throw new Error("Invalid omitted count.");
          lost.omittedCommits = Number(value);
          break;
        case "Changes since claim loss": {
          if (!lost) throw new Error("Missing recovery group.");
          if (value === "none") {
            result.recovery.push(lost);
            lost = undefined;
            break;
          }
          if (value) throw new Error("Invalid recovery comparison.");
          const count = /^comparison (\d+)$/u.exec(lines[++index] ?? "");
          if (!count) throw new Error("Missing comparison.");
          for (let row = 0; row < Number(count[1]); row++) {
            const match = /^([ADU])\t\+(\d+)\t-(\d+)\t(.+?)(\tbinary)?$/u.exec(lines[++index] ?? "");
            if (!match) throw new Error("Invalid comparison row.");
            lost.comparison.push({
              kind: match[1] === "A" ? "add" : match[1] === "D" ? "delete" : "update",
              additions: Number(match[2]), deletions: Number(match[3]), path: unquote(match[4]!), binary: Boolean(match[5]),
            });
          }
          if (lines[++index] !== formatGitArcDriftComparison(lost.comparison).at(-1)) throw new Error("Invalid comparison totals.");
          result.recovery.push(lost);
          lost = undefined;
          break;
        }
        case "Claim-loss baseline unavailable": result.unavailableRecovery = splitList(value).map(unquote); break;
        default: throw new Error("Unrecognised status line.");
      }
    }
    if (lost) result.recovery.push(lost);
    return presentationSchema.safeParse(result);
  } catch {
    return presentationSchema.safeParse(null);
  }
}
