/*
 * Keywords: thread identity, native tuple, catalog, database.
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
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";

export interface WorkbenchNativeThreadIdentity {
  harness: string;
  nativeLocation: string;
  nativeThreadId: string;
}

export interface WorkbenchThreadIdentityMetadata {
  native: WorkbenchNativeThreadIdentity;
  projectId: string;
  projectRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activityAt: number;
}

export interface WorkbenchThreadIdentityLookup {
  threadId: string;
  projectId?: string;
  harness?: WorkbenchHarness;
}

export interface WorkbenchThreadIdentityBinding extends WorkbenchNativeThreadIdentity {
  pending: boolean;
  turnIndex: number | null;
}

export interface WorkbenchThreadIdentityRecord {
  threadId: string;
  projectId: string;
  projectRoot: string;
  bindings: readonly WorkbenchThreadIdentityBinding[];
}

export type WorkbenchTurnIdentityMetadata = Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }>;

export interface WorkbenchTurnIdentityRecord {
  threadId: string;
  turnId: string;
  turnIndex: number;
  native: WorkbenchNativeThreadIdentity & { nativeTurnId: string | null };
}

export interface WorkbenchTurnIdentityLookup {
  threadId: string;
  turnId: string;
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
