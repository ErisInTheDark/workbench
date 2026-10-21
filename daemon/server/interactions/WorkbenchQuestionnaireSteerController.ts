/*
 * Exports:
 * - joinUserInputs: join messages into one input, adjacent text separated by a blank line.
 * - default WorkbenchQuestionnaireSteerController: own virtual steers: hold messages sent while a held questionnaire's turn is not live, hand them to the answer's continuation, and release them undelivered once no questionnaire waits.
 */
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import {
  WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import { WorkbenchUserInputSchema, type WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import type { DaemonTranscriptRegistration } from "../daemon-runtime-objects";
import { heldSteerInput, type QueuedThreadMessage } from "../turn/WorkbenchThreadCompactionController";

const STEER_SEPARATOR = "\n\n";
/** The compaction queue's held steers deliver when its compaction ends, never with an answer. */
const COMPACTION_ENTRY_PREFIX = "compaction:";

/** Each message's leading text joins the previous message's trailing text, so the agent reads `<first>\n\n<second>`. */
export function joinUserInputs(messages: readonly (readonly WorkbenchUserInput[])[]): WorkbenchUserInput[] {
  const merged: WorkbenchUserInput[] = [];
  for (const message of messages) {
    message.forEach((part, index) => {
      const last = merged.at(-1);
      if (index !== 0 || part.type !== "text" || last?.type !== "text") {
        merged.push(part);
        return;
      }
      const offset = Buffer.byteLength(`${last.text}${STEER_SEPARATOR}`);
      merged[merged.length - 1] = {
        ...last,
        text: `${last.text}${STEER_SEPARATOR}${part.text}`,
        text_elements: [...last.text_elements, ...part.text_elements.map(element => ({
          ...element, byteRange: { start: element.byteRange.start + offset, end: element.byteRange.end + offset },
        }))],
      };
    });
  }
  return merged;
}

function sendOrder(left: WorkbenchSteerHistoryEntry, right: WorkbenchSteerHistoryEntry) {
  return left.attemptedAt - right.attemptedAt || (left.dispatchSequence ?? 0) - (right.dispatchSequence ?? 0);
}

export default class WorkbenchQuestionnaireSteerController {
  /** Per-thread chain: a message is either held before the answer collects steers, or sees the continuation's live turn. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: {
    hasPendingQuestionnaire(threadId: string): Promise<boolean>;
    /** The thread's latest turn and whether its provider still runs it. */
    latestTurn(threadId: string): Promise<{ id: string; live: boolean } | null>;
    readSteers(threadId: string): Promise<readonly WorkbenchSteerHistoryEntry[]>;
    record: DaemonTranscriptRegistration["record"];
    now(): number;
    warn(message: string): void;
  }) {}

  /** True when the message became a virtual steer instead of provider input. */
  hold(threadId: string, message: QueuedThreadMessage) {
    return this.serial(threadId, async () => {
      if (!await this.ports.hasPendingQuestionnaire(threadId)) return false;
      const turn = await this.ports.latestTurn(threadId);
      if (!turn || turn.live) return false;
      const turnId = turn.id;
      const pending = (await this.ports.readSteers(threadId)).filter(entry => entry.status === "pending");
      const now = this.ports.now();
      await this.ports.record([{
        kind: "steer",
        entry: {
          threadId: WorkbenchThreadIdSchema.parse(threadId), turnId: WorkbenchTurnIdSchema.parse(turnId),
          entryKey: `questionnaire:${message.clientMessageId}`, input: heldSteerInput(message.input),
          status: "pending", attemptedAt: now, resolvedAt: null, requestId: null, canonicalItemId: null,
          clientUserMessageId: message.clientMessageId, dispatchSequence: pending.length, error: null,
        },
        observedAt: now,
      }], { source: "workbench" });
      return true;
    });
  }

  /** Admit the answer's continuation with each virtual steer's input in send order; they retire only once it is accepted. */
  deliverWith<Result>(threadId: string, admit: (steers: WorkbenchUserInput[][]) => Promise<Result>) {
    return this.serial(threadId, async () => {
      const steers = await this.virtualSteers(threadId);
      const result = await admit(steers.map(entry => WorkbenchUserInputSchema.array().parse(entry.input)));
      try {
        await this.resolve(steers, "dismissed");
      } catch (error) {
        // The continuation already carries them; release at the next turn start retires copies left pending.
        this.ports.warn(`Delivered virtual steers for ${threadId.slice(0, 120)} could not be retired: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      }
      return result;
    });
  }

  /** Once no questionnaire waits (stopped, dropped by other accepted work), its virtual steers end undelivered with resend/dismiss. */
  release(threadId: string) {
    return this.serial(threadId, async () => {
      if (await this.ports.hasPendingQuestionnaire(threadId)) return;
      await this.resolve(await this.virtualSteers(threadId), "interrupted");
    });
  }

  /** Pending held steers outside the live turn, in send order. The live turn's steers and the compaction queue belong to other owners. */
  private async virtualSteers(threadId: string) {
    const turn = await this.ports.latestTurn(threadId);
    return (await this.ports.readSteers(threadId))
      .filter(entry => entry.status === "pending" && entry.itemId
        && !entry.entryKey.startsWith(COMPACTION_ENTRY_PREFIX)
        && !(turn?.live && entry.turnId === turn.id))
      .sort(sendOrder);
  }

  private async resolve(entries: readonly WorkbenchSteerHistoryEntry[], status: "dismissed" | "interrupted") {
    if (!entries.length) return;
    const now = this.ports.now();
    await this.ports.record(entries.map(entry => ({
      kind: "steer" as const,
      entry: {
        ...entry, threadId: WorkbenchThreadIdSchema.parse(entry.threadId), turnId: WorkbenchTurnIdSchema.parse(entry.turnId),
        status, resolvedAt: now, error: null,
      },
      publicItemId: WorkbenchItemIdSchema.parse(entry.itemId),
      observedAt: now,
    })), { source: "workbench" });
  }

  private serial<Result>(threadId: string, operation: () => Promise<Result>) {
    const run = (this.chains.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.chains.set(threadId, run);
    void run.then(() => undefined, () => undefined).then(() => {
      if (this.chains.get(threadId) === run) this.chains.delete(threadId);
    });
    return run;
  }
}
