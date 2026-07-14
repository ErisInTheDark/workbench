/*
 * Exports:
 * - useStableBrowseResultEntriesByTurn: preserve turn-owned result chunk arrays across thread-level sidecar refreshes. Keywords: browse, screenshot, render, chunk.
 */
"use client";

import { useEffect, useMemo, useRef } from "react";

import type { WorkbenchBrowseResultEntry } from "../../../lib/types";

const EMPTY_BROWSE_RESULT_ENTRIES: readonly WorkbenchBrowseResultEntry[] = [];

interface StableBrowseResultEntriesByTurnResult {
  cacheEntriesByTurnId: Map<string, StableBrowseResultEntriesByTurnEntry>;
  entriesByTurnId: Map<string, readonly WorkbenchBrowseResultEntry[]>;
}

interface StableBrowseResultEntriesByTurnEntry {
  entries: readonly WorkbenchBrowseResultEntry[];
  signature: string;
}

function getBrowseResultEntryChunkSignature(entry: WorkbenchBrowseResultEntry) {
  return [
    entry.entryKey,
    entry.turnId,
    entry.commandItemId ?? "",
    entry.recordedAt,
    entry.assetUrl,
    entry.action,
    entry.actionIndex,
  ].join("\n");
}

function getBrowseResultEntriesChunkSignature(entries: readonly WorkbenchBrowseResultEntry[]) {
  return entries.map(getBrowseResultEntryChunkSignature).join("\n---\n");
}

export function useStableBrowseResultEntriesByTurn(
  entries: readonly WorkbenchBrowseResultEntry[] = EMPTY_BROWSE_RESULT_ENTRIES,
) {
  const previousEntriesRef = useRef<Map<string, StableBrowseResultEntriesByTurnEntry>>(new Map());
  const stableResult = useMemo((): StableBrowseResultEntriesByTurnResult => {
    const groupedEntriesByTurnId = new Map<string, WorkbenchBrowseResultEntry[]>();
    for (const entry of entries) {
      const turnEntries = groupedEntriesByTurnId.get(entry.turnId) ?? [];
      turnEntries.push(entry);
      groupedEntriesByTurnId.set(entry.turnId, turnEntries);
    }

    const cacheEntriesByTurnId = new Map<string, StableBrowseResultEntriesByTurnEntry>();
    const entriesByTurnId = new Map<string, readonly WorkbenchBrowseResultEntry[]>();
    for (const [turnId, turnEntries] of groupedEntriesByTurnId) {
      const signature = getBrowseResultEntriesChunkSignature(turnEntries);
      const previousEntry = previousEntriesRef.current.get(turnId);
      const stableEntries = previousEntry?.signature === signature ? previousEntry.entries : turnEntries;
      const cacheEntry = {
        entries: stableEntries,
        signature,
      };
      cacheEntriesByTurnId.set(turnId, cacheEntry);
      entriesByTurnId.set(turnId, stableEntries);
    }

    return {
      cacheEntriesByTurnId,
      entriesByTurnId,
    };
  }, [entries]);

  useEffect(() => {
    previousEntriesRef.current = stableResult.cacheEntriesByTurnId;
  }, [stableResult]);

  return stableResult.entriesByTurnId;
}
