/*
 * Exports:
 * - default CodexProviderObservations: translate admitted Codex ingress without a second lifecycle.
 * - CodexProviderPublication: public notification and typed shared-state facts beside retained native input.
 * - mapProviderLifecycleNotification: decode compatible Codex lifecycle events at the provider edge.
 * - mapProviderActivityNotification: decode compatible Codex activity events at the provider edge.
 * - admitCodexTranscriptObservations/mapCodexTranscriptObservation: supply Codex identity evidence to shared admission.
 */
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import { WorkbenchDurableQuestionnaireSchema, normalizeWorkbenchTimestampMs } from "workbench-shared/workbench/thread/thread-state";
import { NativeThreadIdSchema, ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";
import type { JsonRpcNotification } from "./bridge-types";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { admitNativeTranscriptObservations, mapNativeTranscriptObservation } from "./thread-identity-transcript-mapping";
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import { mapProviderNotification, mapProviderThreadItem } from "./CodexProviderIdentity";
import { normalizeThreadTitle } from "./lib/thread-bootstrap";

export function admitCodexTranscriptObservations(
  owners: NativeTranscriptIdentityOwners,
  observations: Parameters<typeof admitNativeTranscriptObservations>[1],
) {
  return admitNativeTranscriptObservations(owners, observations, "codex", getCodexItemIdentityKind);
}
export function mapCodexTranscriptObservation(...[owners, native, observation]: Parameters<typeof mapNativeTranscriptObservation>) {
  return mapNativeTranscriptObservation(owners, native, observation,
    native?.harness === "codex" ? getCodexItemIdentityKind : undefined,
    (destination, item) => mapProviderThreadItem(owners, destination, item));
}

type AdmittedIdentities = {
  knownThread(reference: (typeof ThreadReferenceSchema)["_output"]): Pick<ReturnType<WorkbenchThreadIdentityController["knownThread"]>, "threadId">;
  knownTurn(reference: (typeof TurnReferenceSchema)["_output"]): Pick<ReturnType<WorkbenchThreadIdentityController["knownTurn"]>, "turnId">;
};
function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function timestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? normalizeWorkbenchTimestampMs(value) : null;
}

export function mapProviderLifecycleNotification(
  notification: JsonRpcNotification, identities: AdmittedIdentities,
): WorkbenchProviderObservation["lifecycle"] {
  const params = record(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim()
    ? identities.knownThread(ThreadReferenceSchema.parse(params.threadId)).threadId : null;
  if (!threadId) return null;
  if (notification.method === "item/started" || notification.method === "item/completed") {
    const item = record(params.item);
    const turnId = typeof params.turnId === "string" ? identities.knownTurn(TurnReferenceSchema.parse(params.turnId)).turnId : null;
    return item?.type === "userMessage" && turnId ? { event: { kind: "userInputDelivered", turnId }, threadId } : null;
  }
  if (notification.method === "turn/started") {
    const turn = record(params.turn);
    if (turn?.workbenchAdmission === "connecting" || turn?.workbenchAdmission === "providerPending") return null;
    const turnId = typeof turn?.id === "string" ? identities.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId : null;
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return turnId && items.some(item => record(item)?.type === "userMessage")
      ? { event: { kind: "userInputDelivered", turnId }, threadId } : null;
  }
  if (notification.method === "turn/completed") {
    const turn = record(params.turn);
    const turnId = typeof turn?.id === "string" ? identities.knownTurn(TurnReferenceSchema.parse(turn.id)).turnId : null;
    const status = turn?.status;
    return turnId && (status === "completed" || status === "interrupted" || status === "failed")
      ? { event: { kind: "turnCompleted", status, turnId }, threadId } : null;
  }
  if (notification.method === "questionnaire/requested") {
    const requestKey = typeof params.requestKey === "string" ? params.requestKey : null;
    const turnId = typeof params.turnId === "string" ? identities.knownTurn(TurnReferenceSchema.parse(params.turnId)).turnId : null;
    if (!requestKey) return null;
    const questionnaire = WorkbenchDurableQuestionnaireSchema.safeParse({
      itemId: typeof params.itemId === "string" ? params.itemId : null, request: params.request, requestKey, turnId,
    });
    return { event: { kind: "pendingInput", questionnaire: questionnaire.success ? questionnaire.data : null, requestKey, turnId }, threadId };
  }
  if (notification.method === "questionnaire/resolved") {
    const requestKey = typeof params.requestKey === "string" ? params.requestKey : null;
    return requestKey ? { event: { kind: "inputResolved", requestKey }, threadId } : null;
  }
  return notification.method === "thread/status/changed" && record(params.status)?.type === "systemError"
    ? { event: { kind: "providerSystemError" }, threadId } : null;
}

export function mapProviderActivityNotification(
  notification: JsonRpcNotification, identities: AdmittedIdentities,
): WorkbenchProviderObservation["activity"] {
  if (notification.method !== "turn/started" && notification.method !== "item/started" && notification.method !== "item/completed") return null;
  const params = record(notification.params);
  const threadId = typeof params?.threadId === "string" && params.threadId.trim()
    ? identities.knownThread(ThreadReferenceSchema.parse(params.threadId)).threadId : null;
  if (!threadId) return null;
  return notification.method === "turn/started"
    ? { kind: "turnStarted", startedAt: timestamp(record(params.turn)?.startedAt), threadId }
    : { kind: "activity", threadId };
}

export type CodexProviderPublication = {
  notification: JsonRpcNotification;
  nativeNotification: JsonRpcNotification;
  observation: WorkbenchProviderObservation;
};

export default class CodexProviderObservations {
  constructor(private readonly owners: NativeTranscriptIdentityOwners) {}

  native(notification: JsonRpcNotification): CodexProviderPublication {
    const params = record(notification.params);
    const sourceId = typeof params?.threadId === "string" ? params.threadId : record(params?.thread)?.id;
    const native = typeof sourceId === "string"
      ? this.owners.threads.knownNativeBinding("codex", NativeThreadIdSchema.parse(sourceId)) : null;
    const publicNotification = native
      ? mapProviderNotification(this.owners, native, notification as ServerNotification) : notification;
    return { notification: publicNotification, nativeNotification: notification, observation: this.workbench(publicNotification) };
  }

  workbench(notification: JsonRpcNotification): WorkbenchProviderObservation {
    const params = record(notification.params);
    const identity = typeof params?.threadId === "string"
      ? this.owners.threads.knownThread(ThreadReferenceSchema.parse(params.threadId)) : null;
    const titleValue = typeof params?.threadName === "string" ? params.threadName : params?.name;
    const title = notification.method === "thread/name/updated" && typeof titleValue === "string"
      ? normalizeThreadTitle(titleValue) : null;
    return {
      ...(identity ? { projectId: identity.projectId } : {}),
      lifecycle: mapProviderLifecycleNotification(notification, this.owners.threads),
      activity: mapProviderActivityNotification(notification, this.owners.threads),
      title: identity && title ? { threadId: identity.threadId, title } : null,
    };
  }
}
