/*
 * Exports:
 * - default WorkbenchReloadTree: a device's dirty scopes nested under their nearest dirty ancestor, collapsed to roots, each
 *   node reloading itself and everything beneath it on a hover action.
 */
"use client";

import { useState } from "react";

import type { ReloadDirtNode } from "workbench-shared/reload/reload-dirt-tree";
import type { WorkbenchReloadDirtScope } from "workbench-shared/types";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { ChevronDownIcon } from "../workbench-icons";
import ReloadImpactChips from "./ReloadImpactChips";
import { DANGER_HOLD_MS, RELOAD_HOLD_MS, reloadImpact } from "./reload-device";

const SIDEBAR_BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";

interface TreeProps {
  disabled: boolean;
  pendingScopes: ReadonlySet<string>;
  onReload(scope: WorkbenchReloadDirtScope): void;
}

/** A child named under its parent reads as the remaining suffix, such as `/tools` under `server:codex`. */
function nodeLabel(node: ReloadDirtNode, parent: ReloadDirtNode | null) {
  const name = node.scope.scope;
  return parent && name.startsWith(`${parent.scope.scope}/`) ? name.slice(parent.scope.scope.length) : name;
}

function TreeNode({ node, parent, depth, ...props }: TreeProps & { node: ReloadDirtNode; parent: ReloadDirtNode | null; depth: number }) {
  const [open, setOpen] = useState(false);
  const { scope } = node;
  const pending = props.pendingScopes.has(scope.scope);
  return (
    <li>
      <div
        className="group flex min-h-7 items-center gap-1 rounded-lg pr-0.5 hover:bg-fg/3"
        style={{ paddingLeft: `${depth * 0.85}rem` }}
      >
        <button
          aria-expanded={node.children.length ? open : undefined}
          aria-label={open ? `Collapse ${scope.scope}` : `Expand ${scope.scope}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg/muted enabled:hover:text-text disabled:opacity-0"
          disabled={!node.children.length}
          onClick={() => setOpen(!open)}
          type="button"
        >
          <ChevronDownIcon className={`transition-transform ${open ? "" : "-rotate-90"}`} size={12} />
        </button>
        <Tooltip content={<span className="block max-w-60">{scope.description}</span>}>
          <span className={`min-w-0 truncate text-[0.8rem] text-text ${depth === 0 ? "font-medium" : ""}`}>
            {nodeLabel(node, parent)}
          </span>
        </Tooltip>
        <ReloadImpactChips impact={reloadImpact([scope])} named={false} />
        {node.children.length && !open ? (
          <span className="shrink-0 text-[0.72rem] text-fg/muted">+{node.size - 1}</span>
        ) : null}
        <span className="flex-1" />
        <PrimaryButton
          className={`
            ${SIDEBAR_BUTTON}
            ${pending ? "" : "opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"}
          `}
          disabled={props.disabled || pending}
          holdToConfirmMs={scope.destructive ? DANGER_HOLD_MS : RELOAD_HOLD_MS}
          onClick={() => props.onReload(scope)}
          pendingHalo={pending}
          shape="compact"
          tone={scope.destructive ? "danger" : "default"}
        >
          {scope.destructive ? "Restart" : "Reload"}
        </PrimaryButton>
      </div>
      {open && node.children.length ? (
        <ul className="m-0 list-none p-0">
          {node.children.map(child => (
            <TreeNode key={child.scope.scope} node={child} parent={node} depth={depth + 1} {...props} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function WorkbenchReloadTree({ nodes, ...props }: TreeProps & { nodes: readonly ReloadDirtNode[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map(node => <TreeNode key={node.scope.scope} node={node} parent={null} depth={0} {...props} />)}
    </ul>
  );
}
