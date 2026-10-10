/*
 * Exports:
 * - default ThreadTodoPill: one todo as a toned pill, `#id` once known and a required mark, whose tooltip shows the full todo.
 */
"use client";

import WorkbenchPill from "../WorkbenchPill";
import MarkdownRender from "../../ui/MarkdownRender";
import { AsteriskIcon, ClipboardListIcon } from "../workbench-icons";

/** Hue utilities are listed whole so Tailwind can see them. */
const TONE = "bg-hue-250/14 text-hue-250";

export default function ThreadTodoPill({ id, onRemove, removeLabel, required, text }: {
  /** Absent while the todo is still being added. */
  id?: number;
  onRemove?: () => void;
  removeLabel?: string;
  required: boolean;
  /** Absent for a removal, which knows only the id. */
  text?: string;
}) {
  const firstLine = text?.split("\n")[0]!.replace(/[*_`~]+/gu, "") ?? "";
  return (
    <WorkbenchPill
      className={TONE}
      icon={<><ClipboardListIcon size={12} />{required ? <AsteriskIcon aria-label="required" size={12} /> : null}</>}
      onRemove={onRemove}
      removeLabel={removeLabel}
      tooltip={text ? (
        <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] overflow-auto text-[0.84rem] text-text">
          <MarkdownRender markdown={text} />
        </div>
      ) : undefined}
    >
      {[id === undefined ? null : `#${id}`, firstLine].filter(Boolean).join(" ")}
    </WorkbenchPill>
  );
}
