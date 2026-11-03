/*
 * Exports:
 * - ThreadSkillExtensionsHandle/useThreadSkillExtensionsOwner: one thread's skill extensions owner following its active
 *   skills, and its matchers and css; no owner for drafts.
 * - useThreadSkillComponent: one component's render through the nearest thread's owner, held while shown.
 * - default ThreadSkillExtensions: share an owner with the transcript below it and mount its skills' stylesheet scoped to their
 *   component markup.
 */
"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import SkillMcpMatcherRuntime from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import loadQuickJS from "../../../workbench/skills/load-quickjs";
import SkillComponentWorkerClient from "../../../workbench/skills/SkillComponentWorkerClient";
import ThreadSkillExtensionsController, {
  type ThreadSkillComponentRequest, type ThreadSkillComponentState, type ThreadSkillExtensionsState,
} from "../../../workbench/skills/ThreadSkillExtensionsController";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";

/** Every thread view's components render in one worker, each thread in its own session. */
const componentWorker = new SkillComponentWorkerClient();

const ThreadSkillExtensionsContext = createContext<ThreadSkillExtensionsController | null>(null);

const NO_EXTENSIONS: ThreadSkillExtensionsState = { key: null, matchers: null, css: "", error: null };
const PENDING: ThreadSkillComponentState = { status: "pending" };
const UNAVAILABLE: ThreadSkillComponentState = { status: "failed", error: "Skill components are unavailable here." };
const noSubscription = () => () => {};
const warn = (message: string) => { console.warn(message); };

export interface ThreadSkillExtensionsHandle {
  owner: ThreadSkillExtensionsController | null;
  state: ThreadSkillExtensionsState;
}

export function useThreadSkillExtensionsOwner(threadId: string | null): ThreadSkillExtensionsHandle {
  const daemon = useWorkbenchDaemonClient();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const query = useMemo(() => threadId ? { kind: "thread" as const, threadId: ThreadReferenceSchema.parse(threadId) } : null, [threadId]);
  const observed = useWorkspaceObservation(workspace, query);
  // Until the thread's facts arrive its skills are unknown, so components wait instead of failing for want of a skill.
  const known = !workspace || observed.phase !== "pending";
  const skills = threadId ? observed.value?.runtime[threadId]?.skills ?? [] : [];
  const skillKey = JSON.stringify(skills.map(skill => [skill.path, skill.activatedAt]));
  const owner = useMemo(() => {
    if (!threadId) return null;
    const thread = ThreadReferenceSchema.parse(threadId);
    return new ThreadSkillExtensionsController({
      extensions: signal => daemon.threads.skills.extensions({ threadId: thread }, { signal }),
      results: async names => (await daemon.threads.components.results({ threadId: thread, names: [...names] })).results,
      images: async urls => (await daemon.threads.components.images({ threadId: thread, urls: [...urls] })).images,
      keep: async (target, tree) => { await daemon.threads.components.keep({ threadId: thread, target, tree }); },
      kept: async target => (await daemon.threads.components.kept({ threadId: thread, target })).tree,
      evaluator: () => componentWorker.open(),
      matchers: async bundles => new SkillMcpMatcherRuntime(await loadQuickJS(), bundles, {
        onFailure: failure => warn(`Skill ${failure.skillName} MCP matcher: ${failure.message.slice(0, 500)}`),
      }),
      warn,
    });
  }, [daemon, threadId]);
  const state = useSyncExternalStore(owner?.subscribe ?? noSubscription, owner?.snapshot ?? (() => NO_EXTENSIONS), owner?.snapshot ?? (() => NO_EXTENSIONS));
  useLayoutEffect(() => { if (known) owner?.setSkills(skillKey, skills.length > 0); }, [known, owner, skillKey, skills.length]);
  useEffect(() => () => owner?.dispose(), [owner]);
  // A replaced matcher runtime stays usable until the render that dropped it commits, then frees its QuickJS memory.
  useEffect(() => () => state.matchers?.dispose(), [state.matchers]);
  return { owner, state };
}

/** `key` names `request` (rebuilt each render); null until the component is ready to draw. */
export function useThreadSkillComponent(key: string | null, request: ThreadSkillComponentRequest | null): ThreadSkillComponentState {
  const owner = useContext(ThreadSkillExtensionsContext);
  const subscribe = owner?.subscribe ?? noSubscription;
  const loaded = useSyncExternalStore(subscribe, () => owner?.snapshot().key ?? null, () => null);
  const read = () => owner && key !== null ? owner.peek(key) : PENDING;
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => owner && key !== null && request ? owner.hold(key, request) : undefined,
    [owner, key, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  return owner ? state : UNAVAILABLE;
}

export default function ThreadSkillExtensions({ extensions, scope, children }: {
  extensions: ThreadSkillExtensionsHandle;
  /** The `data-thread-component-style` value of the element its components draw inside. */
  scope: string;
  children: ReactNode;
}) {
  const { css } = extensions.state;
  return <ThreadSkillExtensionsContext.Provider value={extensions.owner}>
    {/* Skill utilities land in the app's own utilities layer and arrive later, so the scope stops at component markup: a
        thread-wide scope would let a plain utility (such as .flex) override the app's variant of it (such as a container query). */}
    {css ? <style>{`@scope ([data-thread-component-style="${scope}"] [data-wb-component="true"]) {${css}}`}</style> : null}
    {children}
  </ThreadSkillExtensionsContext.Provider>;
}
