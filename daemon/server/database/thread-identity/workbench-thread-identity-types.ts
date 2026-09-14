/*
 * Exports:
 * - WorkbenchNativeThreadIdentity: trusted provider identity, never a public thread id.
 * - WorkbenchThreadIdentityMetadata: provider metadata sufficient for identity admission.
 * - WorkbenchThreadIdentityLookup: public WB-first lookup with optional disambiguating scope.
 * - WorkbenchThreadIdentityBinding: one native destination owned by a Workbench thread.
 * - WorkbenchThreadIdentityRecord: durable thread identity and its native destinations.
 * - WorkbenchThreadIdentityDatabase: typed identity operations on the existing database worker.
 * - WorkbenchTurnIdentityMetadata: native turn metadata sufficient for identity admission without a body.
 * - WorkbenchTurnIdentityRecord: canonical turn identity with its private native destination.
 * - WorkbenchTurnIdentityLookup: public-first turn lookup within one WB thread.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type {
  NativeThreadId, NativeTurnId, ProjectId, ThreadReference, TurnReference,
  WorkbenchThreadId, WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";

export interface WorkbenchNativeThreadIdentity {
  harness: string;
  nativeLocation: string;
  nativeThreadId: NativeThreadId;
}

export interface WorkbenchThreadIdentityMetadata {
  native: WorkbenchNativeThreadIdentity;
  projectId: ProjectId;
  projectRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
}

export interface WorkbenchThreadIdentityLookup {
  threadId: WorkbenchThreadId | NativeThreadId | ThreadReference;
  projectId?: ProjectId;
  harness?: WorkbenchHarness;
}

export interface WorkbenchThreadIdentityBinding extends WorkbenchNativeThreadIdentity {
  pending: boolean;
  turnIndex: number | null;
}

export interface WorkbenchThreadIdentityRecord {
  threadId: WorkbenchThreadId;
  projectId: ProjectId;
  projectRoot: string;
  bindings: readonly WorkbenchThreadIdentityBinding[];
}

export type WorkbenchTurnIdentityMetadata = Omit<Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }>, "turnId"> & {
  turnId: WorkbenchTurnId | NativeTurnId;
};

export interface WorkbenchTurnIdentityRecord {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  turnIndex: number;
  native: WorkbenchNativeThreadIdentity & { nativeTurnId: NativeTurnId | null };
}

export interface WorkbenchTurnIdentityLookup {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId | NativeTurnId | TurnReference;
}

export interface WorkbenchThreadIdentityDatabase {
  observeThreadIdentities(inputs: readonly WorkbenchThreadIdentityMetadata[]): Promise<WorkbenchThreadIdentityRecord[]>;
  resolveThreadIdentity(input: WorkbenchThreadIdentityLookup): Promise<WorkbenchThreadIdentityRecord | null>;
  resolveNativeThreadIdentity(input: WorkbenchNativeThreadIdentity): Promise<WorkbenchThreadIdentityRecord | null>;
  listThreadIdentities(): Promise<WorkbenchThreadIdentityRecord[]>;
  /** Requested records first, then other records whose ordered indexes changed. */
  observeTurnIdentities(inputs: readonly WorkbenchTurnIdentityMetadata[]): Promise<WorkbenchTurnIdentityRecord[]>;
  resolveTurnIdentity(input: WorkbenchTurnIdentityLookup): Promise<WorkbenchTurnIdentityRecord | null>;
}
