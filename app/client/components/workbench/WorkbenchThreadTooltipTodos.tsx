/*
 * Exports:
 * - default WorkbenchThreadTooltipTodos: a thread's todos as wrapping `#id title,` items beside a muted clipboard, required first, optional ones behind a reveal chip; each title's tooltip shows the full todo.
 */
"use client";

import { useState } from "react";

import { workbenchThreadTodoTitle, type WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import MarkdownRender from "../ui/MarkdownRender";
import RevealChip from "../ui/RevealChip";
import Tooltip from "../ui/Tooltip";
import { ClipboardListIcon } from "./workbench-icons";

/** Titled todos show their title; older free-form ones fall back to their first line without markdown marks. */
function todoLabel(text: string) {
  return (workbenchThreadTodoTitle(text) ?? text.split("\n")[0]!).replace(/[*_`~]+/gu, "");
}

export default function WorkbenchThreadTooltipTodos({ todos }: { todos: readonly WorkbenchThreadTodo[] }) {
  const [showOptional, setShowOptional] = useState(false);
  const required = todos.filter(todo => todo.required);
  const optional = todos.filter(todo => !todo.required);
  const shown = showOptional ? [...required, ...optional] : required;
  // The comma belongs to the item before it, so a wrap never strands one at a line start.
  const trailingComma = (index: number) => index < shown.length - 1 || (!showOptional && optional.length > 0);
  return (
    // Rows match the claimed-path chips below: 24px lines beside a 20px icon slot.
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[0.8rem] text-text">
      <span className="inline-flex size-5 shrink-0 items-center justify-center text-fg/muted" aria-hidden="true">
        <ClipboardListIcon size={16} />
      </span>
      {shown.map((todo, index) => (
        <span className="flex h-6 min-w-0 max-w-full items-center whitespace-nowrap" key={todo.id}>
          <span className="shrink-0 text-fg/muted">{`#${todo.id} `}</span>
          <Tooltip
            content={(
              <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] text-[0.84rem] text-text">
                <MarkdownRender markdown={todo.text} />
              </div>
            )}
            interactive
            placement="top"
          >
            {/* Untitled todos fall back to a first line that can run for a paragraph; the tooltip holds the rest. */}
            <span className="min-w-0 max-w-[14rem] truncate rounded-sm hover:bg-fg/6" data-thread-tooltip-todo={todo.id}>
              {todoLabel(todo.text)}
            </span>
          </Tooltip>
          {trailingComma(index) ? <span className="shrink-0 text-fg/muted">,</span> : null}
        </span>
      ))}
      {optional.length ? (
        <RevealChip
          aria-expanded={showOptional}
          data-thread-tooltip-optional-todos="true"
          onClick={() => setShowOptional(!showOptional)}
        >
          {showOptional ? "hide optional" : required.length ? `+${optional.length} optional` : `${optional.length} optional`}
        </RevealChip>
      ) : null}
    </div>
  );
}
