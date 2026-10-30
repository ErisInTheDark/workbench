/*
 * Exports:
 * - default ThreadComponentTree: draw one rendered skill-component tree once its skill styles are loaded, as a block or
 *   inline in a line, falling back to given content if drawing throws.
 * - useThreadComponentRender: request one stored or fresh component render and load its styles, keyed by its target.
 */
"use client";

import { Component, useContext, useEffect, useState, type ReactNode } from "react";
import { readThreadComponentRender, type ThreadComponentRender } from "workbench-shared/workbench/thread/thread-component-tree";
import { renderThreadComponentNode } from "./thread-component-render";
import type { ThreadRenderOptions } from "./thread-markdown-render";
import { ThreadComponentStylesContext } from "./ThreadComponentStyles";

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function ComponentTree({ tree, options }: { tree: ThreadComponentRender["tree"]; options?: ThreadRenderOptions }) {
  return renderThreadComponentNode(tree, options);
}

export type ThreadComponentRenderState = { key: string; result: ThreadComponentRender | null; error: string | null };

/**
 * One render per `key`: `request` runs when `ready` and nothing has rendered for the key yet; `refreshKey` retries an
 * unrendered key when what it depends on (such as active skills) changes.
 */
export function useThreadComponentRender({ key, ready, refreshKey, request }: {
  key: string; ready: boolean; refreshKey: string; request: () => Promise<unknown>;
}): ThreadComponentRenderState {
  const styles = useContext(ThreadComponentStylesContext);
  const [state, setState] = useState<ThreadComponentRenderState>({ key, result: null, error: null });
  useEffect(() => {
    if (!ready || (state.key === key && state.result)) return;
    let current = true;
    setState(previous => previous.key === key && previous.result ? previous : { key, result: null, error: null });
    void request().then(
      async result => {
        if (!current) return;
        try {
          const parsed = readThreadComponentRender(result);
          if (!styles) throw new Error("Thread component styles are unavailable.");
          await styles.ensure(parsed.styleRevisions);
          if (current) setState({ key, result: parsed, error: null });
        }
        catch (error) { if (current) setState({ key, result: null, error: error instanceof Error ? error.message : "Component render failed." }); }
      },
      error => { if (current) setState({ key, result: null, error: error instanceof Error ? error.message : "Component render failed." }); },
    );
    return () => { current = false; };
    // `request` is recreated every render; `key` names what it asks for.
  }, [key, ready, refreshKey, styles]);
  return state.key === key ? state : { key, result: null, error: null };
}

export default function ThreadComponentTree({ fallback, inline = false, options, tree }: {
  fallback: ReactNode;
  /** Flows within a line of text, as a component drawn inside a call's summary. */
  inline?: boolean;
  options?: ThreadRenderOptions;
  tree: ThreadComponentRender["tree"];
}) {
  const Wrapper = inline ? "span" : "div";
  return (
    <RenderBoundary fallback={fallback}>
      <Wrapper className={inline ? "inline-flex min-w-0 items-center align-middle" : undefined} data-wb-component="true">
        <ComponentTree tree={tree} options={options} />
      </Wrapper>
    </RenderBoundary>
  );
}
