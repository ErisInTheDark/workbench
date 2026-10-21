/*
 * Exports:
 * - ThreadEntryMotionOwner: one view's entry motion and activity run controllers, and the thread it opened on.
 * - default useThreadEntryMotion: keep that owner per view key, telling history from new activity as turns arrive.
 */
"use client";

import { useRef } from "react";

import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ThreadActivityRunController from "./ThreadActivityRunController";
import ThreadEntryMotionController, { getProjectedEntryMotionIdentities } from "./ThreadEntryMotionController";

type MotionTurns = WorkbenchTranscriptProjection["turns"];

export interface ThreadEntryMotionOwner {
  readonly controller: ThreadEntryMotionController;
  readonly activityRunController: ThreadActivityRunController;
  /** The thread the view opened on; a later thread under the same key is a draft's launch handoff. */
  readonly initialThreadId: string;
}

interface OwnerState extends ThreadEntryMotionOwner {
  key: string;
  threadId: string;
  seeded: boolean;
  admitted: MotionTurns | null;
}

function motionIdentities (turns: MotionTurns) {
  return turns.flatMap(turn => turn.items.flatMap(getProjectedEntryMotionIdentities));
}

/**
 * Items already present when the turns first arrive are history, not new activity: they never animate in. Seeded from
 * the rendered projection, since provider-item turns omit generic and interaction items. The owner is stable per key.
 */
export default function useThreadEntryMotion (key: string, threadId: string, turns: MotionTurns | null): ThreadEntryMotionOwner {
  const ownerRef = useRef<OwnerState | null>(null);
  const current = ownerRef.current;
  const isLaunchHandoff = current?.key === key && current.threadId !== threadId;
  if (current?.key !== key) {
    ownerRef.current = {
      controller: new ThreadEntryMotionController(turns ? motionIdentities(turns) : undefined),
      activityRunController: new ThreadActivityRunController(),
      key,
      initialThreadId: threadId,
      threadId,
      seeded: Boolean(turns),
      admitted: null,
    };
  } else if (turns && (!current.seeded || isLaunchHandoff)) {
    current.controller.seed(motionIdentities(turns));
    current.seeded = true;
    current.threadId = threadId;
  } else if (turns && current.admitted !== turns) {
    current.controller.admit(motionIdentities(turns));
  }
  const owner = ownerRef.current!;
  if (owner.seeded) owner.admitted = turns;
  return owner;
}
