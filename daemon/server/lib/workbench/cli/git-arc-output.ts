/*
 * Exports:
 * - renderGitArcOutput: render status, compact lifecycle receipts and inspection details.
 */
import type { WorkbenchAgentCliRequest } from "./workbench-agent-cli-commands";
import { escapeGitArcValue, formatGitArcTextReceipt, type GitArcAction, type GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import { GIT_ARC_DIFF_TRAILER_PREFIX } from "workbench-shared/workbench/git/git-arc-diff-pages";
import { normalizeDaemonReloadScopes } from "workbench-shared/workbench/daemon-reload";
import { formatGitArcStatus, GitArcStatusFullSchema, GitArcStatusSchema } from "workbench-shared/workbench/git/git-arc-status";

type Payload = Record<string, unknown>;
const record = (value: unknown): value is Payload => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: Payload | null | undefined, key: string) => typeof value?.[key] === "string" ? value[key] as string : "";
const paths = (value: Payload | null | undefined, key: string) => Array.isArray(value?.[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const rows = (value: Payload | null | undefined, key: string) => Array.isArray(value?.[key]) ? (value[key] as unknown[]).filter(record) : [];
const number = (value: Payload | null | undefined, key: string) => typeof value?.[key] === "number" ? value[key] as number : undefined;

export function renderGitArcOutput(request: WorkbenchAgentCliRequest, payload: Payload | null) {
  if (request.responseKind === "git-arc-status") {
    return formatGitArcStatus(GitArcStatusSchema.parse(payload), paths(request.body, "full").map(value => GitArcStatusFullSchema.parse(value)));
  }
  if (!payload) return "No registered Git arc.";
  const action = (request.responseKind === "git-arc-wait" ? "start" : request.responseKind.replace("git-arc-", "")) as GitArcAction;
  const members = rows(payload, "members");
  const sources = members.length ? members : [payload];
  const phase = payload.phase === "resolved" ? "resolved"
    : payload.phase === "plan" || payload.kind === "plan" || action === "plan" ? "plan" : "active";
  const fullScope = action === "scope";
  const claimedPaths = action === "release" ? paths(payload, "scopePaths")
    : action === "compare" || action === "diff"
    ? sources.flatMap(member => member.phase === "resolved" ? [] : paths(member, "scopePaths"))
    : phase === "plan" || action === "scope" ? paths(payload, "claimedPaths") : paths(payload, "scopePaths");
  const plannedPaths = phase === "plan" && action !== "release"
    ? paths(payload, "plannedPaths").length ? paths(payload, "plannedPaths") : paths(payload, "scopePaths")
    : undefined;
  const additions = action === "start" ? paths(payload, "acquiredClaims")
    : Array.isArray(payload.addedClaims) ? paths(payload, "addedClaims") : paths(payload, "additionalClaims");
  const removals = action === "start" ? paths(payload, "releasedClaims")
    : Array.isArray(payload.removedClaims) ? paths(payload, "removedClaims") : paths(payload, "releasedClaims");
  const added = new Set(additions);
  const removed = new Set(removals);
  const planningDrift = sources.flatMap((member) => {
    const drift = record(member.planningDrift) ? member.planningDrift : null;
    const previousRef = string(drift, "previousRef");
    const changed = paths(drift, "paths");
    return previousRef && changed.length ? [{ previousRef, paths: changed }] : [];
  });
  const ref = string(payload, action === "propose" ? "sourceCheckpoint" : "checkpointCommit");
  const lines: string[] = [];
  const inspectsProposal = (action === "compare" || action === "diff") && sources.some((member) => Boolean(string(member, "proposalId")));
  if (ref && !inspectsProposal) {
    const receipt: GitArcReceipt = {
      action, phase, fullScope, claimedPaths, claimedPathCount: claimedPaths.length, ref, version: 1,
      intentName: string(payload, "intentName") || null,
      ...(fullScope ? { plannedPaths, adoptedPaths: paths(payload, "adoptedPaths") } : {
        ...(plannedPaths ? { plannedPathCount: plannedPaths.length } : {}),
        ...(action === "plan" || action === "claims" ? { adoptedPathCount: paths(payload, "adoptedPaths").length } : {}),
      }),
      ...(payload.unchanged === true ? { unchanged: true } : {}),
      additionalClaims: additions.filter((path) => !removed.has(path)),
      removedClaims: removals.filter((path) => !added.has(path)),
      ...(action === "scope" ? {
        proposals: sources.flatMap((member) => rows(member, "proposals").flatMap((proposal) => {
          const status = string(proposal, "status");
          return status === "proposed" || status === "committed"
            ? [{ proposalId: string(proposal, "proposalId"), status }] : [];
        })),
      } : {}),
      acceptedProposals: sources.flatMap((member) => rows(member, "acceptedProposals").map((accepted) => ({ proposalId: string(accepted, "proposalId"), commitSha: string(accepted, "commitSha") }))),
      planningDrift,
      memberRefs: members.flatMap((member) => {
        const memberRef = string(member, action === "propose" ? "sourceCheckpoint" : "checkpointCommit");
        return memberRef ? [{ ref: memberRef, rootId: string(member, "rootId") }] : [];
      }),
      ...(string(payload, "proposalId") ? { proposalId: string(payload, "proposalId") } : {}),
      ...(string(payload, "rootId") ? { rootId: string(payload, "rootId") } : {}),
      reloadScopes: normalizeDaemonReloadScopes(paths(payload, "reloadScopes")),
      ...(action === "mv" ? {
        mode: payload.mode === "preview" ? "preview" : "applied",
        mappings: rows(payload, "mappings").map((mapping) => ({ source: string(mapping, "source"), destination: string(mapping, "destination") })),
        matchedPathCount: number(payload, "matchedPathCount"), remainingMatchCount: number(payload, "remainingMatchCount"),
      } : {}),
    };
    lines.push(formatGitArcTextReceipt(receipt));
  }
  const ignored = paths(payload, "skippedIgnoredPaths");
  if (ignored.length) lines.push(`skipped gitignored ${ignored.length}`, ...ignored.map(escapeGitArcValue));
  for (const drift of planningDrift) {
    lines.push("Baselines refreshed. Inspect before presenting the revised plan.",
      `git_arc_diff ${JSON.stringify({ ref: drift.previousRef, paths: drift.paths })}`);
  }
  if (action === "diff") {
    const diff = string(payload, "diff");
    // Diff bytes remain exact. Protocol facts precede them; pagination follows the existing trailer.
    lines.push(diff || "No differences from this baseline.", GIT_ARC_DIFF_TRAILER_PREFIX);
    const selected = paths(request.body, "paths").length || rows(request.body, "roots").some((root) => paths(root, "paths").length);
    if (!selected) {
      const nextPage = number(payload, "nextPage");
      const target = {
        ...(request.body?.ref ? { ref: request.body.ref } : {}),
        ...(request.body?.checkpointCommit ? { ref: request.body.checkpointCommit } : {}),
        ...(request.body?.refs ? { refs: request.body.refs } : {}),
      };
      lines.push(nextPage === undefined ? "end diff" : `next git_arc_diff ${JSON.stringify({ ...target, page: nextPage })}`);
      for (const filePath of paths(payload, "oversizedDiffPaths")) {
        lines.push(`Oversized diff omitted. git_arc_diff ${JSON.stringify({ ...target, paths: [filePath] })}`);
      }
    } else lines.push("end diff");
  }
  if (action === "compare") {
    const changes = rows(payload, "changes");
    if (!changes.length) lines.push("No differences from this baseline.");
    for (const change of changes) {
      const kind = record(change.kind) ? string(change.kind, "type").slice(0, 1).toUpperCase() : "M";
      lines.push(`${kind || "M"}\t+${number(change, "additions") ?? 0}\t-${number(change, "deletions") ?? 0}\t${escapeGitArcValue(string(change, "path"))}`);
    }
  }
  if (action === "diff" || action === "compare") {
    const dirt = paths(payload, "unclaimedDirtPaths");
    lines.push(`unclaimed dirt ${dirt.length}`, ...dirt.map(escapeGitArcValue));
  }
  if (action === "propose") {
    const proposalId = string(payload, "proposalId");
    lines.push(request.body?.action === "proposalRescind" ? `Rescinded proposal ${escapeGitArcValue(proposalId)}`
      : proposalId ? `Proposal ready ${escapeGitArcValue(proposalId)}` : "No uncommitted changes to propose.");
  }
  if (action === "mv" && payload.mode === "preview") lines.push("Preview only. Use --confirm to apply this batch, then preview remaining matches.");
  if (action === "restore") {
    const restored = paths(payload, "restoredPaths");
    lines.push(`restored ${restored.length}`, ...restored.map(escapeGitArcValue));
  }
  if (action === "release" && request.body?.disown !== true && claimedPaths.length) {
    lines.push(
      "These dirty paths remain claimed:",
      ...claimedPaths.map(escapeGitArcValue),
      "Set disown to also release dirty claims.",
    );
  }
  return lines.join("\n");
}
