/*
 * Exports:
 * - GitArcAction/GitArcReceipt: describe persisted arc action presentation data.
 * - GitArcChangeTotalSchema/GitArcChangeTotal: one file's diff-free change totals.
 * - GitArcStackedProposalSchema/GitArcStackedProposal: sealed proposal message and per-file totals captured at stacking.
 * - GitArcStackedProposalReceiptSchema/GitArcStackedProposalReceipt/projectGitArcStackedProposalReceipt: bounded stack receipt summary.
 * - GitArcInvalidatedProposalSchema/GitArcInvalidatedProposal: proposal an operation made unavailable, with its reason.
 * - GitArcReceiptSchema/projectGitArcReceipt/parseGitArcReceipt: validate compact presentation facts and decode current or historical text.
 * - formatGitArcTextReceipt: emit one labelled plain-text result without duplicated JSON.
 * - escapeGitArcValue/readGitArcValue: preserve literal values without permitting output-section injection.
 */
import { z } from "zod";
import { DAEMON_RELOAD_SCOPE_PATTERN } from "../daemon-reload.ts";

const RECEIPT_PREFIX = "Workbench arc receipt: ";

/** One file's diff-free change totals, recorded when a proposal or stack layer is written. */
export const GitArcChangeTotalSchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  kind: z.enum(["add", "delete", "update"]),
  path: z.string().min(1),
}).strict();
export type GitArcChangeTotal = z.infer<typeof GitArcChangeTotalSchema>;

/** One sealed proposal as captured when its layer was stacked. */
export const GitArcStackedProposalSchema = z.object({
  changes: z.array(GitArcChangeTotalSchema),
  description: z.string(),
  proposalId: z.string().min(1),
  title: z.string(),
}).strict();
export type GitArcStackedProposal = z.infer<typeof GitArcStackedProposalSchema>;

export const GitArcStackedProposalReceiptSchema = z.object({
  changeCount: z.number().int().nonnegative().optional(),
  changes: z.array(GitArcChangeTotalSchema).nullable(),
  description: z.string(),
  proposalId: z.string().min(1),
  title: z.string(),
}).strict();
export type GitArcStackedProposalReceipt = z.infer<typeof GitArcStackedProposalReceiptSchema>;

const STACK_RECEIPT_CHANGE_LIMIT = 20;

export function projectGitArcStackedProposalReceipt(input: GitArcStackedProposal): GitArcStackedProposalReceipt {
  return {
    ...input,
    changeCount: input.changes.length,
    changes: input.changes.length > STACK_RECEIPT_CHANGE_LIMIT ? null : input.changes,
  };
}

/** One proposal an operation made unavailable, with the reason its owner can no longer commit it. */
export const GitArcInvalidatedProposalSchema = z.object({ proposalId: z.string().min(1), reason: z.string().min(1) }).strict();
export type GitArcInvalidatedProposal = z.infer<typeof GitArcInvalidatedProposalSchema>;

export const GitArcReceiptSchema = z.object({
  action: z.enum(["add", "adopt", "claims", "scope", "compare", "continue", "diff", "mv", "plan", "propose", "release", "remove", "restore", "stack", "stash", "start", "unstack", "unstash"]),
  /** Stack layer title sealed or reopened by stack/unstack. */
  layer: z.string().min(1).optional(),
  additionalClaims: z.array(z.string().min(1)).optional(),
  claimedPaths: z.array(z.string().min(1)),
  claimedPathCount: z.number().int().nonnegative().optional(),
  plannedPathCount: z.number().int().nonnegative().optional(),
  adoptedPathCount: z.number().int().nonnegative().optional(),
  fullScope: z.boolean().optional(),
  phase: z.enum(["plan", "active", "stashed", "resolved", "workspace"]).optional(),
  stashedPaths: z.array(z.string().min(1)).optional(),
  conflictedPaths: z.array(z.string().min(1)).optional(),
  plannedPaths: z.array(z.string().min(1)).optional(),
  adoptedPaths: z.array(z.string().min(1)).optional(),
  removedClaims: z.array(z.string().min(1)).optional(),
  acceptedProposals: z.array(z.object({ proposalId: z.string().min(1), commitSha: z.string().min(1) })).optional(),
  invalidatedProposals: z.array(GitArcInvalidatedProposalSchema).optional(),
  planningDrift: z.array(z.object({ previousRef: z.string().min(1), paths: z.array(z.string().min(1)) })).optional(),
  unchanged: z.boolean().optional(),
  intentName: z.string().min(1).nullable(),
  memberRefs: z.array(z.object({ ref: z.string().regex(/^[a-f0-9]{7,64}$/iu), rootId: z.string().min(1) }).strict()).optional(),
  proposalId: z.string().min(1).optional(),
  proposals: z.array(z.object({ proposalId: z.string().min(1), status: z.enum(["proposed", "committed"]) })).optional(),
  /** Sealed proposals of the stacked or unstacked layer, when the layer recorded them. */
  stackedProposals: z.array(GitArcStackedProposalReceiptSchema).optional(),
  rootId: z.string().min(1).optional(),
  reloadScopes: z.array(z.string().regex(DAEMON_RELOAD_SCOPE_PATTERN)).optional(),
  ref: z.string().regex(/^[a-f0-9]{7,64}$/iu),
  matchedPathCount: z.number().int().nonnegative().optional(),
  mappings: z.array(z.object({ destination: z.string().min(1), source: z.string().min(1) })).optional(),
  mode: z.enum(["applied", "preview"]).optional(),
  remainingMatchCount: z.number().int().nonnegative().optional(),
  selectedPaths: z.array(z.string().min(1)).optional(),
  version: z.literal(1),
});

export type GitArcAction = z.infer<typeof GitArcReceiptSchema>["action"];
export type GitArcReceipt = z.infer<typeof GitArcReceiptSchema>;

export function projectGitArcReceipt(input: GitArcReceipt): GitArcReceipt {
  const receipt = GitArcReceiptSchema.parse(input);
  const fullScope = receipt.fullScope ?? receipt.action === "scope";
  const visible = <T,>(values: T[] | undefined) => values?.length ? values : undefined;
  const plannedCount = receipt.plannedPathCount ?? receipt.plannedPaths?.length;
  const adoptedCount = receipt.adoptedPathCount ?? receipt.adoptedPaths?.length;
  return GitArcReceiptSchema.parse({
    action: receipt.action,
    phase: receipt.phase ?? (receipt.action === "plan" ? "plan" : "active"),
    fullScope,
    claimedPaths: fullScope ? receipt.claimedPaths : [],
    ...(!fullScope ? {
      claimedPathCount: receipt.claimedPathCount ?? receipt.claimedPaths.length,
      ...(plannedCount === undefined ? {} : { plannedPathCount: plannedCount }),
      ...(adoptedCount === undefined ? {} : { adoptedPathCount: adoptedCount }),
    } : {
      ...(receipt.plannedPaths === undefined ? {} : { plannedPaths: receipt.plannedPaths }),
      ...(receipt.adoptedPaths === undefined ? {} : { adoptedPaths: receipt.adoptedPaths }),
    }),
    intentName: receipt.intentName || null,
    ref: receipt.ref,
    version: 1,
    ...(visible(receipt.additionalClaims) ? { additionalClaims: receipt.additionalClaims } : {}),
    ...(visible(receipt.removedClaims) ? { removedClaims: receipt.removedClaims } : {}),
    ...(visible(receipt.stashedPaths) ? { stashedPaths: receipt.stashedPaths } : {}),
    ...(visible(receipt.conflictedPaths) ? { conflictedPaths: receipt.conflictedPaths } : {}),
    ...(visible(receipt.selectedPaths) ? { selectedPaths: receipt.selectedPaths } : {}),
    ...(visible(receipt.reloadScopes) ? { reloadScopes: receipt.reloadScopes } : {}),
    ...(receipt.rootId ? { rootId: receipt.rootId } : {}),
    ...(receipt.proposalId ? { proposalId: receipt.proposalId } : {}),
    ...(receipt.layer ? { layer: receipt.layer } : {}),
    ...(receipt.proposals === undefined ? {} : { proposals: receipt.proposals }),
    ...(receipt.stackedProposals === undefined ? {} : { stackedProposals: receipt.stackedProposals }),
    ...(receipt.unchanged ? { unchanged: true } : {}),
    ...(visible(receipt.memberRefs) ? { memberRefs: receipt.memberRefs } : {}),
    ...(visible(receipt.acceptedProposals) ? { acceptedProposals: receipt.acceptedProposals } : {}),
    ...(visible(receipt.invalidatedProposals) ? { invalidatedProposals: receipt.invalidatedProposals } : {}),
    ...(receipt.planningDrift?.some((drift) => drift.paths.length)
      ? { planningDrift: receipt.planningDrift.filter((drift) => drift.paths.length) } : {}),
    ...(receipt.mode ? { mode: receipt.mode } : {}),
    ...(receipt.matchedPathCount === undefined ? {} : { matchedPathCount: receipt.matchedPathCount }),
    ...(receipt.remainingMatchCount === undefined ? {} : { remainingMatchCount: receipt.remainingMatchCount }),
    ...(receipt.mappings === undefined ? {} : { mappings: receipt.mappings }),
  });
}

export function escapeGitArcValue(value: string) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.startsWith('"')
    ? JSON.stringify(value) : value;
}

export function readGitArcValue(value: string): string {
  if (!value.startsWith('"')) return value;
  const parsed: string | number | boolean | null = JSON.parse(value);
  if (typeof parsed !== "string") throw new Error("An arc output value must be text.");
  return parsed;
}

export function formatGitArcTextReceipt(input: GitArcReceipt) {
  const receipt = projectGitArcReceipt(input);
  const fullScope = receipt.fullScope ?? receipt.action === "scope";
  const lines = [`arc ${receipt.action} ${receipt.phase ?? (receipt.action === "plan" ? "plan" : "active")}`, `ref ${receipt.ref}`];
  const list = (name: string, values: string[] | undefined) => {
    if (values === undefined || (!values.length && !["claimed", "planned", "claimed+planned", "adopted"].includes(name))) return;
    lines.push(`${name} ${values.length}`, ...values.map(escapeGitArcValue));
  };
  if (receipt.intentName) lines.push(`intent ${escapeGitArcValue(receipt.intentName)}`);
  const claimed = new Set(receipt.claimedPaths);
  const sharedScope = fullScope && receipt.plannedPaths !== undefined
    && claimed.size === new Set(receipt.plannedPaths).size
    && receipt.plannedPaths.every((path) => claimed.has(path));
  if (sharedScope) list("claimed+planned", receipt.claimedPaths);
  else if (fullScope) list("claimed", receipt.claimedPaths);
  else lines.push(`claimed-count ${receipt.claimedPathCount ?? receipt.claimedPaths.length}`);
  if (fullScope) {
    if (!sharedScope) list("planned", receipt.plannedPaths);
    list("adopted", receipt.adoptedPaths);
  } else {
    const plannedCount = receipt.plannedPathCount ?? receipt.plannedPaths?.length;
    const adoptedCount = receipt.adoptedPathCount ?? receipt.adoptedPaths?.length;
    if (plannedCount !== undefined) lines.push(`planned-count ${plannedCount}`);
    if (adoptedCount !== undefined) lines.push(`adopted-count ${adoptedCount}`);
  }
  list("added", receipt.additionalClaims);
  list("removed", receipt.removedClaims);
  list("stashed", receipt.stashedPaths);
  list("conflicts", receipt.conflictedPaths);
  list("selected", receipt.selectedPaths);
  list("reload", receipt.reloadScopes);
  if (receipt.rootId) lines.push(`root ${escapeGitArcValue(receipt.rootId)}`);
  if (receipt.proposalId) lines.push(`proposal ${escapeGitArcValue(receipt.proposalId)}`);
  if (receipt.layer) lines.push(`layer ${escapeGitArcValue(receipt.layer)}`);
  if (receipt.proposals !== undefined) {
    lines.push(`proposals ${receipt.proposals.length}`);
    for (const proposal of receipt.proposals) lines.push(`${escapeGitArcValue(proposal.proposalId)}\t${proposal.status}`);
  }
  if (receipt.stackedProposals !== undefined) {
    // One JSON object per line: JSON escapes newlines, so values cannot forge sections.
    lines.push(`sealed ${receipt.stackedProposals.length}`, ...receipt.stackedProposals.map(proposal => JSON.stringify(proposal)));
  }
  if (receipt.unchanged) lines.push("unchanged");
  if (receipt.memberRefs?.length) {
    lines.push(`members ${receipt.memberRefs.length}`);
    for (const member of receipt.memberRefs) lines.push(`${escapeGitArcValue(member.rootId)}\t${member.ref}`);
  }
  if (receipt.acceptedProposals?.length) {
    lines.push(`accepted ${receipt.acceptedProposals.length}`);
    for (const accepted of receipt.acceptedProposals) lines.push(`${escapeGitArcValue(accepted.proposalId)}\t${accepted.commitSha}`);
  }
  if (receipt.invalidatedProposals?.length) {
    lines.push(`invalidated ${receipt.invalidatedProposals.length}`);
    for (const invalidated of receipt.invalidatedProposals) {
      lines.push(`${escapeGitArcValue(invalidated.proposalId)}\t${escapeGitArcValue(invalidated.reason)}`);
    }
  }
  for (const drift of receipt.planningDrift ?? []) {
    if (!drift.paths.length) continue;
    lines.push(`previous-plan ${drift.previousRef}`);
    list("changed", drift.paths);
  }
  if (receipt.mode) lines.push(`mode ${receipt.mode}`);
  if (receipt.matchedPathCount !== undefined) lines.push(`matched ${receipt.matchedPathCount}`);
  if (receipt.remainingMatchCount !== undefined) lines.push(`remaining ${receipt.remainingMatchCount}`);
  if (receipt.mappings) {
    lines.push(`mappings ${receipt.mappings.length}`);
    for (const mapping of receipt.mappings) lines.push(`${escapeGitArcValue(mapping.source)}\t${escapeGitArcValue(mapping.destination)}`);
  }
  lines.push("end arc");
  return lines.join("\n");
}

function parseTextReceipt(output: string) {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^arc \S+ (plan|active|stashed|resolved|workspace)$/u.test(line));
  if (start < 0) return null;
  const [, action, phase] = lines[start]!.split(" ");
  const result: Record<string, string | number | boolean | null | string[] | object[]> = {
    action: action!, phase: phase!, claimedPaths: [], intentName: null, version: 1, fullScope: false,
  };
  let index = start + 1;
  let previousRef: string | null = null;
  const drift: Array<{ previousRef: string; paths: string[] }> = [];
  const keys = new Set<string>();
  const count = (value: string) => {
    if (!/^\d+$/u.test(value) || Number(value) > lines.length) throw new Error("Invalid arc section count.");
    return Number(value);
  };
  const take = (length: number) => {
    if (index + length > lines.length) throw new Error("Truncated arc section.");
    const values = lines.slice(index, index + length);
    index += length;
    return values;
  };
  const lists: Record<string, string> = {
    claimed: "claimedPaths", planned: "plannedPaths", adopted: "adoptedPaths", added: "additionalClaims",
    removed: "removedClaims", stashed: "stashedPaths", conflicts: "conflictedPaths",
    selected: "selectedPaths", reload: "reloadScopes",
  };
  while (index < lines.length) {
    const line = lines[index++]!;
    if (line === "end arc") {
      if (previousRef) throw new Error("Missing planning drift paths.");
      if (drift.length) result.planningDrift = drift;
      return GitArcReceiptSchema.parse(result);
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (keys.has(key) && key !== "previous-plan" && key !== "changed") throw new Error("Duplicate arc section.");
    keys.add(key);
    if (key === "claimed+planned") {
      if (keys.has("claimed") || keys.has("planned")) throw new Error("Duplicate arc scope.");
      keys.add("claimed");
      keys.add("planned");
      const paths = take(count(value)).map(readGitArcValue);
      result.claimedPaths = paths;
      result.plannedPaths = [...paths];
      result.fullScope = true;
    } else if (lists[key]) {
      result[lists[key]!] = take(count(value)).map(readGitArcValue);
      if (key === "claimed") result.fullScope = true;
    } else if (key === "claimed-count" || key === "planned-count" || key === "adopted-count" || key === "matched" || key === "remaining") {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid arc count.");
      const counts = {
        "claimed-count": "claimedPathCount", "planned-count": "plannedPathCount", "adopted-count": "adoptedPathCount",
        matched: "matchedPathCount", remaining: "remainingMatchCount",
      };
      result[counts[key]] = Number(value);
    } else if (key === "ref" || key === "intent" || key === "root" || key === "proposal" || key === "mode" || key === "layer") {
      result[key === "intent" ? "intentName" : key === "root" ? "rootId" : key === "proposal" ? "proposalId" : key] = readGitArcValue(value);
    } else if (key === "sealed") {
      result.stackedProposals = take(count(value)).map(row => GitArcStackedProposalReceiptSchema.parse(JSON.parse(row)));
    } else if (key === "unchanged") result.unchanged = true;
    else if (key === "previous-plan") {
      if (previousRef) throw new Error("Missing planning drift paths.");
      previousRef = value;
    } else if (key === "changed") {
      if (!previousRef) throw new Error("Missing previous plan ref.");
      drift.push({ previousRef, paths: take(count(value)).map(readGitArcValue) });
      previousRef = null;
    } else if (key === "members" || key === "accepted" || key === "mappings" || key === "proposals" || key === "invalidated") {
      const field = key === "members" ? "memberRefs" : key === "accepted" ? "acceptedProposals" : key === "invalidated" ? "invalidatedProposals" : key;
      result[field] = take(count(value)).map((row) => {
        const parts = row.split("\t");
        if (parts.length !== 2) throw new Error("Invalid arc pair.");
        const first = readGitArcValue(parts[0]!);
        const second = readGitArcValue(parts[1]!);
        return key === "members" ? { rootId: first, ref: second }
          : key === "accepted" ? { proposalId: first, commitSha: second }
          : key === "proposals" ? { proposalId: first, status: second }
          : key === "invalidated" ? { proposalId: first, reason: second }
          : { source: first, destination: second };
      });
    } else throw new Error("Unknown arc section.");
  }
  return null;
}

export function parseGitArcReceipt(output: string) {
  const line = String(output ?? "").split(/\r?\n/u).find((candidate) => candidate.startsWith(RECEIPT_PREFIX));
  try {
    if (!line) return parseTextReceipt(String(output ?? ""));
    const parsed = GitArcReceiptSchema.safeParse(JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
