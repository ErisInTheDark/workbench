/*
 * Exports:
 * - useThreadPresentedText: bind one optional transcript presentation source to an exact field with canonical fallback. Keywords: thread, text, presentation, leaf.
 */
"use client";

import type {
  ThreadTextPresentationField,
  ThreadTextPresentationSource,
} from "../../../workbench/thread/ThreadTextPresentationController";
import { useWorkbenchThreadTextPresentationField } from "../use-workbench-client";

export default function useThreadPresentedText({
  canonicalText,
  field,
  index = null,
  itemId,
  source,
  threadId,
  turnId,
}: {
  canonicalText: string;
  field: ThreadTextPresentationField;
  index?: number | null;
  itemId: string;
  source?: ThreadTextPresentationSource | null;
  threadId: string;
  turnId: string;
}) {
  return useWorkbenchThreadTextPresentationField(source ? {
    field,
    index,
    itemId,
    source,
    threadId,
    turnId,
  } : null, canonicalText);
}
