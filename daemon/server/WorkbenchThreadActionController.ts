/*
 * Exports:
 * - WorkbenchThreadActionOwners: shared identity, profile/state and project owners.
 * - default WorkbenchThreadActionController: route WB actions without constructing provider packets.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import {
  workbenchThreadActions, type WorkbenchThreadActionMap, type WorkbenchThreadCreate,
  type WorkbenchThreadMessage, type WorkbenchThreadStop,
} from "workbench-shared/workbench/thread/thread-actions";
import { ThreadReferenceSchema, TurnReferenceSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

export interface WorkbenchThreadActionOwners {
  transcripts: Pick<WorkbenchTranscriptReader, "readPage" | "history">;
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  projects: Pick<WorkbenchProjectCatalogController, "resolveProjectById">;
  identities: Pick<WorkbenchThreadIdentityController, "resolve" | "resolveTurn">;
  profiles: Pick<WorkbenchThreadStateFeature, "captureCreationProfile">;
  state: Pick<
    WorkbenchThreadStateController,
    "acceptProviderIntent" | "getCanonicalThreadEntry" | "handleRequest" | "listPendingQuestionnaires"
  >;
  warn(message: string): void;
}

type Actions = {
  [Method in keyof WorkbenchThreadActionMap]: (
    input: WorkbenchThreadActionMap[Method]["params"],
    connectionId?: string,
  ) => Promise<WorkbenchThreadActionMap[Method]["result"]>;
};

export default class WorkbenchThreadActionController {
  constructor(private readonly owners: WorkbenchThreadActionOwners) {}

  async materialize(threadId: string, turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const thread = await this.owners.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
    signal?.throwIfAborted();
    if (!thread) throw new Error("Transcript thread identity has not been admitted.");
    const groups = new Map<WorkbenchHarness, string[]>();
    for (const turnId of turnIds) {
      const turn = await this.owners.identities.resolveTurn({
        threadId: thread.threadId, turnId: TurnReferenceSchema.parse(turnId),
      });
      signal?.throwIfAborted();
      // Locally authored turns already have their facts in SQLite.
      if (!turn?.native.nativeTurnId) continue;
      const group = groups.get(turn.native.harness) ?? [];
      group.push(turn.turnId);
      groups.set(turn.native.harness, group);
    }
    for (const [harness, turns] of groups) {
      signal?.throwIfAborted();
      await this.provider(harness).threads.materialize(thread.threadId, turns, signal);
    }
  }

  private provider(harness: WorkbenchHarness) {
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!key) throw new Error(`Provider ${harness} is not installed.`);
    return this.owners.providers.get(key);
  }

  private async target(reference: string) {
    const identity = await this.owners.identities.resolve({ threadId: ThreadReferenceSchema.parse(reference) });
    if (!identity) {
      const threadId = reference.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 160);
      throw new Error(`The requested thread has no durable Workbench identity. threadId=${threadId}`);
    }
    const binding = identity.bindings[0];
    if (!binding) throw new Error("The requested thread has no provider binding.");
    return { identity, harness: binding.harness, provider: this.provider(binding.harness) };
  }

  private readonly actions: Actions = {
    "questionnaires/pending/read": async () => {
      const providerPending = (await Promise.all(installedProviderKeys.map(
        key => this.owners.providers.get(key).interactions?.pending() ?? [],
      ))).flat();
      const data = [...this.owners.state.listPendingQuestionnaires()];
      for (const request of providerPending) {
        if (!data.some(candidate =>
          candidate.harness === request.harness
          && candidate.threadId === request.threadId
          && candidate.requestKey === request.requestKey)) {
          data.push(request);
        }
      }
      return { data };
    },
    "thread/questionnaires/read": async input => {
      return { data: (await this.owners.transcripts.history(input.threadId)).questionnaireEntries };
    },
    "thread/steers/read": async input => {
      return { data: (await this.owners.transcripts.history(input.threadId)).steerEntries };
    },
    "thread/browse/read": async input => {
      return { data: (await this.owners.transcripts.history(input.threadId)).browseResultEntries };
    },
    "thread/create": input => this.create(input),
    "thread/message/submit": input => this.message(input),
    "thread/metadata/read": async input => {
      const target = await this.target(input.threadId);
      return target.provider.threads.read(target.identity.threadId);
    },
    "thread/page/read": async input => {
      return this.owners.transcripts.readPage(input);
    },
    "thread/title/set": async (input, connectionId) => {
      const target = await this.target(input.threadId);
      if (!connectionId) throw new Error("Thread title changes require the observing connection.");
      const response = await this.owners.state.handleRequest(connectionId, {
        method: "workbench/thread-state/title/set",
        projectId: target.identity.projectId,
        identity: { harness: target.harness, threadId: target.identity.threadId },
        title: input.title,
      });
      if ("error" in response) throw new Error(response.error.message);
      return { ok: true };
    },
    "thread/compact": async input => {
      const target = await this.target(input.threadId);
      await target.provider.threads.compact(target.identity.threadId);
      return { ok: true };
    },
    "thread/provider/delete": async input => {
      const target = await this.target(input.threadId);
      if (target.identity.bindings.length !== 1) throw new Error("Provider deletion requires one unambiguous thread binding.");
      if (!target.provider.threads.delete) throw new Error("This provider does not support deleting its threads.");
      await target.provider.threads.delete(target.identity.threadId);
      return { ok: true };
    },
    "thread/stop": (input, connectionId) => this.stop(input, connectionId),
    "thread/goal/read": async input => {
      const target = await this.target(input.threadId);
      return { goal: await target.provider.goals?.read(target.identity.threadId) ?? null };
    },
    "thread/goal/update": async input => {
      const target = await this.target(input.threadId);
      if (!target.provider.goals) throw new Error("This provider does not support native goals.");
      return { goal: await target.provider.goals.update({ ...input, threadId: target.identity.threadId }) };
    },
    "thread/goal/remove": async input => {
      const target = await this.target(input.threadId);
      await target.provider.goals?.clear(target.identity.threadId);
      return { ok: true };
    },
  };

  async handle<Method extends keyof WorkbenchThreadActionMap>(method: Method, params: object, connectionId?: string) {
    const input = workbenchThreadActions[method].params.parse(params) as WorkbenchThreadActionMap[Method]["params"];
    return this.actions[method](input, connectionId);
  }

  private async create(input: WorkbenchThreadCreate) {
    const project = await this.owners.projects.resolveProjectById(input.projectId);
    const captured = await this.owners.profiles.captureCreationProfile(undefined, project.rootPath, input.profile);
    return this.provider(captured.selection.settings.harness).threads.create({
      cwd: captured.cwd, profile: captured.selection, ...(input.context ? { context: input.context } : {}),
      projectRoots: project.roots.map(root => root.rootPath),
      additionalWritableRoots: input.additionalWritableRoots,
    });
  }

  private async message(input: WorkbenchThreadMessage) {
    const { identity, harness, provider } = await this.target(input.threadId);
    const providerInput = input.intent === "newTurn"
      ? { ...input, threadId: identity.threadId }
      : {
          threadId: identity.threadId,
          clientMessageId: input.clientMessageId,
          input: input.input,
          ...(input.context ? { context: input.context } : {}),
          intent: "continue" as const,
        };
    const result = await provider.threads.submit(providerInput);
    try {
      const turnId = WorkbenchTurnIdSchema.parse(result.kind === "started" ? result.turn.id : result.turnId);
      await this.owners.state.acceptProviderIntent(identity.projectId, harness, identity.threadId, turnId);
    } catch {
      const warning = "Your message was accepted, but Workbench could not update its thread state. Do not resend it.";
      this.owners.warn(warning);
      return { ...result, warning: [result.warning?.slice(0, 500), warning].filter(Boolean).join(" ") };
    }
    return result;
  }

  private async stop(input: WorkbenchThreadStop, connectionId?: string): Promise<{ ok: true }> {
    const { identity, harness, provider } = await this.target(input.threadId);
    if (input.intent === "snooze") {
      if (!input.requestKey) throw new Error("There is no pending questionnaire to snooze.");
      const response = await this.owners.state.handleRequest(connectionId ?? "", {
        method: "workbench/thread-state/questionnaire/snooze",
        projectId: identity.projectId, identity: { harness, threadId: identity.threadId },
        requestKey: input.requestKey,
      });
      if ("error" in response) throw new Error(response.error.message);
      if (typeof response.result === "object" && response.result !== null && "accepted" in response.result && !response.result.accepted) throw new Error("The pending questionnaire changed before it could be snoozed.");
      return { ok: true };
    }
    if (input.turnId) await provider.threads.interrupt(identity.threadId, input.turnId);
    if (input.requestKey) {
      const response = await this.owners.state.handleRequest(connectionId ?? "", {
        method: "workbench/thread-state/questionnaire/dismiss",
        projectId: identity.projectId, identity: { harness, threadId: identity.threadId },
        requestKey: input.requestKey,
      });
      if ("error" in response) throw new Error(response.error.message);
      if (typeof response.result === "object" && response.result !== null && "accepted" in response.result && !response.result.accepted) throw new Error("The pending questionnaire changed before it could be dismissed.");
    }
    return { ok: true };
  }
}
