/*
 * Exports:
 * - ThreadCanonicalLayerInput: raw canonical thread materialization input. Keywords: thread, canonical, layer.
 * - ThreadCanonicalLayerOptions: canonical normalization callback configuration. Keywords: thread, canonical, normalize.
 * - default ThreadCanonicalLayer: cache owner for raw input to complete canonical thread output. Keywords: thread, canonical, controller.
 */

import type { ThreadPayload } from "../../types";
import { getTurnRenderSignature } from "./thread-item-signature";

export interface ThreadCanonicalLayerInput {
  key: string;
  rawThread: ThreadPayload;
  revision: number;
}

export interface ThreadCanonicalLayerOptions {
  normalizeCanonicalThread: (thread: ThreadPayload) => ThreadPayload;
}

interface ThreadCanonicalLayerCacheEntry {
  canonicalThread: ThreadPayload;
  rawThread: ThreadPayload;
  revision: number;
  turnSignaturesById: Map<string, string>;
}

export default class ThreadCanonicalLayer {
  private readonly cacheByKey = new Map<string, ThreadCanonicalLayerCacheEntry>();
  private readonly options: ThreadCanonicalLayerOptions;

  constructor(options: ThreadCanonicalLayerOptions) {
    this.options = options;
  }

  clear() {
    this.cacheByKey.clear();
  }

  invalidate(key: string) {
    this.cacheByKey.delete(key);
  }

  render(input: ThreadCanonicalLayerInput) {
    const previous = this.cacheByKey.get(input.key);
    if (previous && previous.rawThread === input.rawThread && previous.revision === input.revision) {
      return previous.canonicalThread;
    }

    const normalizedThread = this.options.normalizeCanonicalThread(input.rawThread);
    const nextTurnSignaturesById = new Map<string, string>();
    const previousTurnSignaturesById = previous?.turnSignaturesById ?? new Map<string, string>();
    const previousTurnsById = new Map(previous?.canonicalThread.turns.map((turn) => [turn.id, turn]) ?? []);
    let didReuseTurn = false;
    const turns = normalizedThread.turns.map((turn) => {
      const previousTurn = previousTurnsById.get(turn.id);
      const previousSignature = previousTurnSignaturesById.get(turn.id);
      const signature = previousTurn === turn && previousSignature
        ? previousSignature
        : getTurnRenderSignature(turn);
      nextTurnSignaturesById.set(turn.id, signature);
      if (previousTurn && previousSignature === signature) {
        if (previousTurn !== turn) {
          didReuseTurn = true;
        }
        return previousTurn;
      }
      return turn;
    });
    const canonicalThread = didReuseTurn ? { ...normalizedThread, turns } : normalizedThread;
    this.cacheByKey.set(input.key, {
      canonicalThread,
      rawThread: input.rawThread,
      revision: input.revision,
      turnSignaturesById: nextTurnSignaturesById,
    });
    return canonicalThread;
  }
}
