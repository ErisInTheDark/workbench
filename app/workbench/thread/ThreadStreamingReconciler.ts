/*
 * Keywords: thread, streaming, reconciliation, duplicate index, provenance, settlement.
 * Exports:
 * - default ThreadStreamingReconciler: owns structural matching, duplicate selection, and live item key lifecycle.
 */

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { getThreadStateChangeTagText } from "../markdown/markdown-parse";

interface StreamingItemDescriptor {
  kind: "agentMessage" | "reasoning" | "plan";
  text: string;
  stateChangeLike: boolean;
  stateChangeTag: string | null;
}

interface StreamingItemProvenance {
  key: string;
  clientCreated: boolean;
}

interface StreamingCandidate {
  index: number;
  item: ThreadItem;
  descriptor: StreamingItemDescriptor;
  provenance: StreamingItemProvenance;
}

type StreamingReconciliationOptions = { settleStreamingKeys?: boolean };

function describeStreamingItem(item: ThreadItem): StreamingItemDescriptor | null {
  if (item.type !== "agentMessage" && item.type !== "reasoning" && item.type !== "plan") return null;
  const rawText = item.type === "reasoning" ? [...item.content, ...item.summary].join("\n") : item.text;
  const text = rawText.replace(/\s+/g, " ").trim();
  const stateChangeLike = item.type === "agentMessage" && text.startsWith("<set-state");
  return {
    kind: item.type,
    text,
    stateChangeLike,
    stateChangeTag: stateChangeLike ? getThreadStateChangeTagText(text) : null,
  };
}

function areDescriptorsCompatible(left: StreamingItemDescriptor, right: StreamingItemDescriptor) {
  if (left.kind !== right.kind) return false;
  if (left.stateChangeLike || right.stateChangeLike) {
    return left.stateChangeTag !== null && left.stateChangeTag === right.stateChangeTag;
  }
  return left.text.startsWith(right.text) || right.text.startsWith(left.text);
}

function canPruneCandidate(incoming: StreamingCandidate, existing: StreamingCandidate) {
  if (incoming.descriptor.kind === "reasoning" && incoming.item.id !== existing.item.id) {
    if (!incoming.provenance.clientCreated && !existing.provenance.clientCreated) return false;
  } else if (incoming.descriptor.stateChangeLike || existing.descriptor.stateChangeLike) {
    if (incoming.provenance.clientCreated === existing.provenance.clientCreated) return false;
  }
  return areDescriptorsCompatible(incoming.descriptor, existing.descriptor);
}

export default class ThreadStreamingReconciler {
  private readonly clientCreatedStreamingItemKeys = new Set<string>();

  addClientCreatedItemKey(key: string) {
    this.clientCreatedStreamingItemKeys.add(key);
  }

  clearClientCreatedItemKeys() {
    this.clientCreatedStreamingItemKeys.clear();
  }

  hasClientCreatedItemForTurn(turnId: string) {
    const prefix = `${turnId}:`;
    for (const key of this.clientCreatedStreamingItemKeys) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  forgetReplacedStreamingItem(clientKey: string, _canonicalKey: string, options: StreamingReconciliationOptions = {}) {
    this.forgetStreamingItemKey(clientKey, options);
  }

  forgetStreamingItemKey(key: string, options: StreamingReconciliationOptions = {}) {
    if (options.settleStreamingKeys === false) return;
    this.clientCreatedStreamingItemKeys.delete(key);
  }

  hasClientCreatedItemKey(key: string) {
    return this.clientCreatedStreamingItemKeys.has(key);
  }

  isStructurallyMatchingItem(incoming: ThreadItem, live: ThreadItem) {
    const incomingDescriptor = describeStreamingItem(incoming);
    const liveDescriptor = describeStreamingItem(live);
    return incomingDescriptor !== null && liveDescriptor !== null
      && areDescriptorsCompatible(incomingDescriptor, liveDescriptor);
  }

  pruneDuplicateItems(
    turnId: string,
    items: ThreadItem[],
    mergeItems: (incoming: ThreadItem, live: ThreadItem) => ThreadItem,
    options: StreamingReconciliationOptions = {},
  ) {
    const nextItems: ThreadItem[] = [];
    const candidatesByBucket = new Map<string, StreamingCandidate[]>();
    const provenanceByKey = new Map<string, StreamingItemProvenance>();
    let changed = false;

    const getProvenance = (item: ThreadItem) => {
      const key = `${turnId}:${item.id}`;
      let provenance = provenanceByKey.get(key);
      if (!provenance) {
        provenance = { key, clientCreated: this.hasClientCreatedItemKey(key) };
        provenanceByKey.set(key, provenance);
      }
      return provenance;
    };
    const bucketKey = (descriptor: StreamingItemDescriptor) => `${descriptor.kind}:${descriptor.text.charAt(0)}`;
    const indexCandidate = (candidate: StreamingCandidate) => {
      const key = bucketKey(candidate.descriptor);
      let bucket = candidatesByBucket.get(key);
      if (!bucket) {
        bucket = [];
        candidatesByBucket.set(key, bucket);
      }
      const last = bucket.at(-1);
      if (!last || last.index < candidate.index) {
        bucket.push(candidate);
      } else {
        const insertionIndex = bucket.findIndex((existing) => existing.index > candidate.index);
        bucket.splice(insertionIndex, 0, candidate);
      }
    };

    for (const item of items) {
      const descriptor = describeStreamingItem(item);
      if (!descriptor) {
        nextItems.push(item);
        continue;
      }
      const incoming: StreamingCandidate = {
        descriptor, index: nextItems.length, item, provenance: getProvenance(item),
      };
      let existing: StreamingCandidate | undefined;
      if (descriptor.text) {
        // Empty predecessors match any prefix. Compare both buckets in original output order.
        for (const key of [bucketKey(descriptor), `${descriptor.kind}:`]) {
          const match = candidatesByBucket.get(key)?.find((candidate) => canPruneCandidate(incoming, candidate));
          if (match && (!existing || match.index < existing.index)) existing = match;
        }
      }
      if (!existing) {
        nextItems.push(item);
        indexCandidate(incoming);
        continue;
      }

      changed = true;
      const preferIncoming = incoming.provenance.clientCreated !== existing.provenance.clientCreated
        ? existing.provenance.clientCreated
        : descriptor.text.length >= existing.descriptor.text.length;
      const replaced = preferIncoming ? existing : incoming;
      this.forgetStreamingItemKey(replaced.provenance.key, options);
      if (options.settleStreamingKeys !== false) {
        // Same-key candidates share this record, so later comparisons observe settlement immediately.
        replaced.provenance.clientCreated = false;
      }
      if (preferIncoming) {
        const merged = mergeItems(item, existing.item);
        const oldBucket = candidatesByBucket.get(bucketKey(existing.descriptor))!;
        oldBucket.splice(oldBucket.indexOf(existing), 1);
        nextItems[existing.index] = merged;
        const mergedDescriptor = describeStreamingItem(merged);
        if (mergedDescriptor) {
          indexCandidate({ descriptor: mergedDescriptor, index: existing.index, item: merged, provenance: getProvenance(merged) });
        }
      }
    }
    return changed ? nextItems : items;
  }
}
