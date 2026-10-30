/*
 * Exports:
 * - default useThreadSkillMcpMatchers: one thread's active skills' MCP matchers as a sandboxed runtime, rebuilt when its
 *   active skills' compiled matchers change; null while none apply or they are loading.
 */
"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import SkillMcpMatcherRuntime from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../../components/workbench/WorkbenchWorkspaceContext";
import useWorkspaceObservation from "../app/use-workspace-observation";
import loadQuickJS from "./load-quickjs";

export default function useThreadSkillMcpMatchers(threadId: string | null): SkillMcpMatcherRuntime | null {
  const daemon = useWorkbenchDaemonClient();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const query = useMemo(() => threadId
    ? { kind: "thread" as const, threadId: ThreadReferenceSchema.parse(threadId) }
    : null, [threadId]);
  const observed = useWorkspaceObservation(workspace, query);
  const skillKey = JSON.stringify((threadId ? observed.value?.runtime[threadId]?.skills ?? [] : []).map(skill => skill.path));
  const [runtime, setRuntime] = useState<SkillMcpMatcherRuntime | null>(null);
  const shown = useRef(runtime);
  useEffect(() => { shown.current = runtime; }, [runtime]);

  useEffect(() => {
    if (!threadId || skillKey === "[]") { setRuntime(null); return; }
    let current = true;
    void (async () => {
      const { bundles, failures } = await daemon.threads.components.matchers({ threadId: ThreadReferenceSchema.parse(threadId) });
      if (!current) return;
      for (const failure of failures) console.warn(`Skill ${failure.skillName} MCP matchers failed to compile: ${failure.message.slice(0, 500)}`);
      if (!bundles.length) { setRuntime(null); return; }
      // Unchanged matchers keep their runtime, so presentation caches survive unrelated skill changes.
      if (shown.current?.key === SkillMcpMatcherRuntime.keyOf(bundles)) return;
      const module = await loadQuickJS();
      if (!current) return;
      setRuntime(new SkillMcpMatcherRuntime(module, bundles, {
        onFailure: failure => console.warn(`Skill ${failure.skillName} MCP matcher: ${failure.message.slice(0, 500)}`),
      }));
    })().catch((error: unknown) => {
      if (current) console.warn("Skill MCP matchers failed to load.", (error instanceof Error ? error.message : String(error)).slice(0, 500));
    });
    return () => { current = false; };
  }, [daemon, skillKey, threadId]);

  // A replaced runtime stays usable until the render that dropped it commits, then frees its QuickJS memory.
  useEffect(() => () => runtime?.dispose(), [runtime]);
  return runtime;
}
