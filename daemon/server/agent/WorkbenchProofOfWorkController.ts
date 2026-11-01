/*
 * Exports:
 * - WorkbenchProofOfWorkControllerOptions: caller, checklist catalogue, mode gate, workflow ledger and current-turn transcript ports.
 * - default WorkbenchProofOfWorkController: record one checklist submission and report what is still owed: gated checklists over
 *   their gate's window, others over the current turn.
 */
import {
  formatProofOfWorkReport,
  mergeProofs,
  proofFamily,
  readProofOfWorkSubmission,
  reconcileProofOfWork,
  type ProofOfWorkChecklist,
  type ProofState,
} from "workbench-shared/workbench/thread/proof-of-work";
import { gatedProofWindows, type ModeGate, type WorkflowLedgerEntry } from "workbench-shared/workbench/thread/workflow-modes";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { WorkbenchProofOfWorkRequestSchema } from "../lib/workbench/commands/proof-of-work-command-definition";

export interface WorkbenchProofOfWorkControllerOptions {
  resolveCaller(caller: { cwd: string; harness: string; threadId: string }, signal: AbortSignal): Promise<{ threadId: string; projectRoot: string | null }>;
  readCatalogue(projectRoot: string | null): Promise<readonly ProofOfWorkChecklist[]>;
  readGates(threadId: string): Promise<readonly ModeGate[]>;
  /** The thread's earlier successful filings and mode switches, oldest first; never the call being answered. */
  readLedger(threadId: string): Promise<readonly WorkflowLedgerEntry[]>;
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
    const [catalogue, items, gates, ledger] = await Promise.all([
      this.options.readCatalogue(projectRoot),
      this.options.readTurnItems(threadId, signal),
      this.options.readGates(threadId),
      this.options.readLedger(threadId),
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
    const turn = mergeProofs([...filed, proof]);
    const touched = new Set([...turn.keys()].map(proofFamily));
    const windows = gatedProofWindows(ledger, gates);
    const proofs = new Map<string, ProofState>([...turn].filter(([id]) => !windows.has(proofFamily(id))));
    for (const [family, window] of windows) {
      if (!touched.has(family)) continue;
      for (const [id, state] of mergeProofs([...window, proof])) if (proofFamily(id) === family) proofs.set(id, state);
    }
    return new Response(formatProofOfWorkReport(reconcileProofOfWork(proofs, catalogue), catalogue), { headers: TEXT_HEADERS });
  }
}
