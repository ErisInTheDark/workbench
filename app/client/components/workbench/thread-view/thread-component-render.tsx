/*
 * Exports:
 * - renderThreadComponentNode: turn a validated component tree into native React nodes.
 */
import { createContext, createElement, Fragment, useContext, type ElementType, type ReactElement, type ReactNode } from "react";
import { readThreadComponentTree, type ThreadComponentNode, type ThreadComponentValue } from "workbench-shared/workbench/thread/thread-component-tree";
import * as kit from "../../vis-kit";
import { renderThreadMarkdown, type ThreadRenderOptions } from "./thread-markdown-render";

type RenderedValue = null | boolean | number | string | ReactElement | RenderedValue[] | { [key: string]: RenderedValue };

/** The resolved trees of the innermost component body's nested invocations, keyed by their markup. */
const NestedComponentsContext = createContext<Readonly<Record<string, ThreadComponentValue>>>({});

function NestedThreadComponent({ markup, markdownOptions }: { markup: string; markdownOptions?: ThreadRenderOptions }) {
  const nested = useContext(NestedComponentsContext)[markup];
  if (!nested) throw new Error(`Missing nested component: ${markup}`);
  return renderNode(readThreadComponentTree(nested), undefined, markdownOptions);
}

function renderValue(value: ThreadComponentValue, key?: string, options?: ThreadRenderOptions): RenderedValue {
  if (Array.isArray(value)) return value.map((child, index) => renderValue(child, `${key ?? "node"}-${index}`, options));
  if (!value || typeof value !== "object") return value;
  if (value.$workbench === "element" && typeof value.type === "string"
    && value.props && typeof value.props === "object" && !Array.isArray(value.props)) {
    return renderNode({ $workbench: "element", type: value.type, props: value.props }, key, options);
  }
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, renderValue(child, undefined, options)]));
}

function renderNode(node: ThreadComponentNode, key?: string, options?: ThreadRenderOptions): ReactElement {
  if (node.type === "workbench:markdown") {
    const { source, components } = node.props;
    if (typeof source !== "string" || !components || typeof components !== "object" || Array.isArray(components)) {
      throw new Error("Invalid component markdown.");
    }
    return createElement(NestedComponentsContext.Provider, { key, value: components }, renderThreadMarkdown(source, {
      ...options,
      componentContext: { threadId: "", itemId: "", sourceText: source },
      componentRenderer: NestedThreadComponent,
    }));
  }
  const name = node.type.startsWith("kit:") ? node.type.slice(4) : null;
  const exported = name ? kit[name as keyof typeof kit] : null;
  if (name && (typeof exported !== "function" && (typeof exported !== "object" || exported === null))) {
    throw new Error(`Unknown kit component: ${name}`);
  }
  const type = name ? exported as ElementType : node.type === "fragment" ? Fragment : node.type;
  const props = Object.fromEntries(Object.entries(node.props).map(([name, value]) => [name, renderValue(value, `${key ?? "node"}-${name}`, options)]));
  // Like markdown links, component links never navigate the Workbench tab itself.
  const link = node.type === "a" ? { target: "_blank", rel: "noreferrer" } : {};
  return createElement(type, { ...props, ...link, ...(key === undefined ? {} : { key }) });
}

export function renderThreadComponentNode(node: ThreadComponentNode, options?: ThreadRenderOptions): ReactNode {
  return renderNode(node, undefined, options);
}
