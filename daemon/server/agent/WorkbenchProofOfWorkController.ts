/*
 * Exports:
 * - WorkbenchProofOfWorkControllerOptions: caller, checklist catalogue and current-turn transcript ports.
 * - default WorkbenchProofOfWorkController: record one checklist submission and report what the turn still owes.
 */
import {
  mergeProofs,
  proofFamily,
  readProofOfWorkSubmission,
  reconcileProofOfWork,
  type ProofOfWorkChecklist,
} from "workbench-shared/workbench/thread/proof-of-work";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { WorkbenchProofOfWorkRequestSchema } from "../lib/workbench/commands/proof-of-work-command-definition";

export interface WorkbenchProofOfWorkControllerOptions {
  resolveCaller(caller: { cwd: string; harness: string; threadId: string }, signal: AbortSignal): Promise<{ threadId: string; projectRoot: string | null }>;
  readCatalogue(projectRoot: string | null): Promise<readonly ProofOfWorkChecklist[]>;
  /** The latest turn's items in transcript order; it may already hold the call being answered. */
  readTurnItems(threadId: string, signal: AbortSignal): Promise<readonly ThreadItem[]>;
}

const TEXT_HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

export default class WorkbenchProofOfWorkController {
  constructor(private readonly options: WorkbenchProofOfWorkControllerOptions) {}

  async execute(body: object, signal: AbortSignal) {
    const parsed = WorkbenchProofOfWorkRequestSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 5).map(({ message, path }) => `${path.map(String).join(".") || "input"}: ${message}`).join("\n");
      return new Response(`Invalid proof of work.\n${detail}\n`, { headers: TEXT_HEADERS, status: 400 });
    }
    const { proof, ...caller } = parsed.data;
    const { threadId, projectRoot } = await this.options.resolveCaller(caller, signal);
    const [catalogue, items] = await Promise.all([
      this.options.readCatalogue(projectRoot),
      this.options.readTurnItems(threadId, signal),
    ]);
    signal.throwIfAborted();

    const unknown = reconcileProofOfWork(mergeProofs([proof]), catalogue).unknownItems;
    if (unknown.length) {
      const families = [...new Set(unknown.map(proofFamily))];
      const listed = catalogue.filter(checklist => families.includes(checklist.id))
        .map(checklist => `${checklist.id}: ${checklist.items.map(item => item.id).join(", ")}`);
      return new Response(`Unknown checklist ids: ${unknown.join(", ")}. Nothing was recorded.\n${listed.join("\n")}\n`, { headers: TEXT_HEADERS, status: 400 });
    }

    const filed = items.flatMap(item => { const submission = readProofOfWorkSubmission(item); return submission ? [submission] : []; });
    const report = reconcileProofOfWork(mergeProofs([...filed, proof]), catalogue);
    const lines = ["Recorded."];
    for (const { checklist, resolved, deferred, missing } of report.checklists) {
      if (!deferred.length && !missing.length) { lines.push(`${checklist.id}: complete.`); continue; }
      lines.push([
        `${checklist.id}: ${resolved}/${checklist.items.length} resolved.`,
        deferred.length ? `Deferred: ${deferred.join(", ")}.` : "",
        missing.length ? `Missing: ${missing.join(", ")}. File or defer them.` : "",
      ].filter(Boolean).join(" "));
    }
    if (report.unknownFamilies.length) {
      lines.push(`Unregistered checklists: ${report.unknownFamilies.join(", ")}; filed without coverage checks. Registered: ${catalogue.map(checklist => checklist.id).join(", ") || "none"}.`);
    }
    return new Response(`${lines.join("\n")}\n`, { headers: TEXT_HEADERS });
  }
}
