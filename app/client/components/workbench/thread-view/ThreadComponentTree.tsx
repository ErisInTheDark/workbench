/*
 * Exports:
 * - default ThreadComponentTree: draw one rendered skill-component tree, as a block or inline in a line, falling back to
 *   given content if drawing throws.
 */
"use client";

import { Component, type ReactNode } from "react";
import type { ThreadComponentNode } from "workbench-shared/workbench/thread/thread-component-tree";
import { renderThreadComponentNode } from "./thread-component-render";
import type { ThreadRenderOptions } from "./thread-markdown-render";

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function ComponentTree({ tree, options }: { tree: ThreadComponentNode; options?: ThreadRenderOptions }) {
  return renderThreadComponentNode(tree, options);
}

export default function ThreadComponentTree({ fallback, inline = false, options, tree }: {
  fallback: ReactNode;
  /** Flows within a line of text, as a component drawn inside a call's summary. */
  inline?: boolean;
  options?: ThreadRenderOptions;
  tree: ThreadComponentNode;
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
