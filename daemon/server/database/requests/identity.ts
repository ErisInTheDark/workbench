/*
 * Exports:
 * - identityRequests: database requests that admit and resolve thread, turn and transcript item identities.
 */
import type {
  WorkbenchNativeThreadIdentity,
  WorkbenchThreadIdentityLookup,
  WorkbenchThreadIdentityMetadata,
  WorkbenchThreadReplacementBinding,
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
} from "../thread-identity/workbench-thread-identity-types.ts";
import type {
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
} from "../transcript/workbench-transcript-types.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

function requireIdentity<Identity>(identity: Identity | null, action: string): Identity {
  if (!identity) throw new Error(`Replacement binding ${action} returned no identity.`);
  return identity;
}

export const identityRequests = {
  observeThreadIdentities: defineDatabaseRequest({
    run: ({ threadIdentities }, inputs: readonly WorkbenchThreadIdentityMetadata[]) => threadIdentities.observeMany(inputs),
    local: inputs => inputs.length ? undefined : { value: [] },
  }),
  resolveThreadIdentity: defineDatabaseRequest({
    read: "core",
    run: ({ threadIdentities }, input: WorkbenchThreadIdentityLookup) => threadIdentities.resolve(input),
  }),
  resolveNativeThreadIdentity: defineDatabaseRequest({
    read: "core",
    run: ({ threadIdentities }, input: WorkbenchNativeThreadIdentity) => threadIdentities.resolveNative(input),
  }),
  reserveReplacementBinding: defineDatabaseRequest({
    run: ({ threadIdentities }, input: WorkbenchThreadReplacementBinding) => (
      requireIdentity(threadIdentities.reserveReplacementBinding(input), "reservation")
    ),
  }),
  releaseReplacementBinding: defineDatabaseRequest({
    run: ({ threadIdentities }, input: Omit<WorkbenchThreadReplacementBinding, "reservedAt">) => (
      requireIdentity(threadIdentities.releaseReplacementBinding(input), "release")
    ),
  }),
  listThreadIdentities: defineDatabaseRequest({
    read: "core",
    run: ({ threadIdentities }) => threadIdentities.list(),
  }),
  observeTurnIdentities: defineDatabaseRequest({
    run: ({ threadIdentities }, inputs: readonly WorkbenchTurnIdentityMetadata[]) => threadIdentities.observeTurns(inputs),
    local: inputs => inputs.length ? undefined : { value: [] },
  }),
  resolveTurnIdentity: defineDatabaseRequest({
    read: "core",
    run: ({ threadIdentities }, input: WorkbenchTurnIdentityLookup) => threadIdentities.resolveTurn(input),
  }),
  admitTranscriptItemIdentities: defineDatabaseRequest({
    run: ({ transcriptIdentities }, inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]) => transcriptIdentities.admitMany(inputs),
    local: inputs => inputs.length ? undefined : { value: [] },
  }),
  resolveTranscriptItemIdentity: defineDatabaseRequest({
    read: "core",
    run: ({ transcriptIdentities }, input: WorkbenchTranscriptItemIdentityLookup) => transcriptIdentities.resolve(input),
  }),
};
