/*
 * Exports:
 * - default ThreadPreview: a real Workbench transcript inside a vis page, from render-lab shorthand items; MCP calls are
 *   presented by the given skill matcher functions and draw the given skill components, as the app would. The agent's
 *   headless checks see every run, step and card open.
 */
"use client";

import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ElementType } from "react";
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
import ThreadTextPresentationController from "../../workbench/thread/ThreadTextPresentationController";
import ThreadTextPresentationContext from "../workbench/ThreadTextPresentationContext";
import { createThreadRenderFixture } from "../workbench/thread-view/thread-render-lab-input";
import ThreadItemActionsContext, { readOnlyThreadItemActions } from "../workbench/thread-view/ThreadItemActionsContext";
import ThreadRenderLabBoundary from "../workbench/thread-view/ThreadRenderLabBoundary";
import ThreadRenderSurface from "../workbench/thread-view/ThreadRenderSurface";
import { ThreadSkillComponentPreviewContext, type ThreadSkillComponentPreview } from "../workbench/thread-view/ThreadSkillCallComponent";
import StaticSkillMcpMatchers, { type SkillMcpMatcherFunction } from "./StaticSkillMcpMatchers";

const PRESENTATION_SOURCE = { kind: "json" as const, sourceKey: "vis-preview" };

function Problem({ children }: { children: string }) {
  return <p className="m-0 whitespace-pre-wrap text-[0.78rem] text-danger" role="alert">{children}</p>;
}

export default function ThreadPreview({ components = {}, items, matchers = [] }: {
  /** A skill's components by name, as its matcher's `component` names them; each gets `{ ...props, call }`. */
  components?: Readonly<Record<string, ElementType>>;
  /** One turn: command strings, `{ command }`, or `{ type }` userMessage/agentMessage/reasoning/webSearch/mcpToolCall. */
  items: readonly JsonValue[];
  /** A skill's matcher files' default exports, first answer wins. */
  matchers?: readonly SkillMcpMatcherFunction[];
}) {
  const [text] = useState(() => new ThreadTextPresentationController());
  useEffect(() => () => text.dispose(), [text]);
  // Matchers come from imports, so their identities only change when the page's code does.
  const skillMcpMatchers = useMemo(() => new StaticSkillMcpMatchers(matchers), matchers); // eslint-disable-line react-hooks/exhaustive-deps
  const failures = useSyncExternalStore(skillMcpMatchers.subscribe, () => skillMcpMatchers.failures, () => skillMcpMatchers.failures);
  const itemsKey = JSON.stringify(items);
  const fixture = useMemo(() => {
    try { return { thread: createThreadRenderFixture([...items]), error: null }; }
    catch (error) { return { thread: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [itemsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo<ThreadSkillComponentPreview>(() => ({ component, fallback, props }) => {
    const Component = components[component];
    if (!Component) return <><Problem>{`${component} isn't in ThreadPreview's components.`}</Problem>{fallback}</>;
    return <div data-wb-component="true">{createElement(Component, props)}</div>;
  }, [components]);
  return (
    <ThreadTextPresentationContext value={text}>
      <ThreadItemActionsContext.Provider value={readOnlyThreadItemActions}>
        <ThreadSkillComponentPreviewContext value={preview}>
          {fixture.error ? <Problem>{fixture.error}</Problem> : null}
          {failures.map(failure => <Problem key={failure}>{failure}</Problem>)}
          <ThreadRenderLabBoundary key={itemsKey} revision={0}>
            <ThreadRenderSurface
              // The agent's headless checks cannot click rows open, so they see every body; the user's card stays as the app.
              expanded={typeof window !== "undefined" && window.wb?.audience === "agent"}
              presentationSource={PRESENTATION_SOURCE}
              skillMcpMatchers={skillMcpMatchers}
              thread={fixture.thread}
            />
          </ThreadRenderLabBoundary>
        </ThreadSkillComponentPreviewContext>
      </ThreadItemActionsContext.Provider>
    </ThreadTextPresentationContext>
  );
}
