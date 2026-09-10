/*
 * No exports. Compiler regressions protect identity namespaces and consuming contracts.
 */
import type { WorkbenchComposerProfileSlot } from "../types";
import type {
  DraftId, NativeItemId, NativeThreadId, NativeTurnId, ProjectId,
  ThreadReference, WorkbenchItemId, WorkbenchThreadId, WorkbenchTurnId,
} from "./identity";
import type { getProjectQualifiedThreadDisplayKey, getThreadDisplayThreadKey } from "./thread/thread-display-layout";

type Assert<Value extends true> = Value;
type Distinct<Left, Right> = Left extends Right ? false : Right extends Left ? false : true;
type ThreadProfileId = Extract<WorkbenchComposerProfileSlot, { kind: "thread" }>["threadId"];
type DisplayThreadId = Parameters<typeof getThreadDisplayThreadKey>[1];
type LocalKey = ReturnType<typeof getThreadDisplayThreadKey>;
type QualifiedKey = ReturnType<typeof getProjectQualifiedThreadDisplayKey>;

type IdentityBoundaryChecks = [
  Assert<Distinct<NativeThreadId, WorkbenchThreadId>>,
  Assert<Distinct<NativeTurnId, WorkbenchTurnId>>,
  Assert<Distinct<NativeItemId, WorkbenchItemId>>,
  Assert<Distinct<WorkbenchThreadId, WorkbenchTurnId>>,
  Assert<Distinct<WorkbenchTurnId, WorkbenchItemId>>,
  Assert<Distinct<ProjectId, WorkbenchThreadId>>,
  Assert<Distinct<DraftId, WorkbenchThreadId>>,
  Assert<Distinct<ThreadReference, ThreadProfileId>>,
  Assert<Distinct<NativeThreadId, ThreadProfileId>>,
  Assert<Distinct<NativeThreadId, DisplayThreadId>>,
  Assert<Distinct<LocalKey, QualifiedKey>>,
  Assert<WorkbenchThreadId extends ThreadProfileId ? true : false>,
  Assert<WorkbenchThreadId extends DisplayThreadId ? true : false>,
];
