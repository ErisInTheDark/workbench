/*
 * Exports:
 * - WorkbenchShellTabFrameProps: the strip's facts for one tab: destination, focus, preview state and its actions.
 * - default WorkbenchShellTab: one shell tab pill; a real link to its destination, italic while it is the preview tab,
 *   with a close control (an amber asterisk while unsaved), middle-click close, double-click or double-tap to keep open, and a
 *   context menu.
 */
"use client";

import { useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";

import type Tooltip from "../../ui/Tooltip";
import ContextMenuCapability from "../ContextMenuCapability";
import type { WorkbenchContextMenuAction } from "../WorkbenchContextMenuContext";
import { AsteriskIcon, XIcon } from "../workbench-icons";
import { isWorkbenchTabDoubleTap, type WorkbenchTabTap } from "./workbench-tab-gestures";

export interface WorkbenchShellTabFrameProps {
  tab: string;
  href: string | undefined;
  selected: boolean;
  preview: boolean;
  onClose(): void;
  onKeepOpen(): void;
}

export default function WorkbenchShellTab({
  actions = [], detail, dirty = false, href, icon, label, onClose, onKeepOpen, onSelectedActivate, preview, selected,
  tab, title, wrap,
}: WorkbenchShellTabFrameProps & {
  /** Extra context-menu actions, such as renaming a thread. */
  actions?: WorkbenchContextMenuAction[];
  /** A quieter suffix, such as the folder of a file from another folder. */
  detail?: string | null;
  dirty?: boolean;
  icon: ReactNode;
  label: ReactNode;
  /** Double-activating an already kept, focused tab, such as starting a rename. */
  onSelectedActivate?: () => void;
  title?: string;
  /** Wraps the pill element, such as in a hover tooltip that needs the element itself as its trigger. */
  wrap?: (tab: ComponentProps<typeof Tooltip>["children"]) => ReactElement;
}) {
  const lastTap = useRef<WorkbenchTabTap | null>(null);
  const activateTwice = () => {
    if (preview) onKeepOpen();
    else if (selected) onSelectedActivate?.();
  };
  const menu = {
    id: `shell-tab:${tab}`,
    label: "Tab",
    items: [
      ...(preview ? [{ id: "keep-open", label: "Keep open", onSelect: onKeepOpen }] : []),
      ...actions,
      { id: "close", label: "Close", onSelect: onClose },
    ],
  };
  const element = (
    <div
      className={`
        group/shell-tab relative flex h-8 max-w-[11rem] shrink-0 md:max-w-[15rem] items-center rounded-lg pl-2.5 pr-1 text-[0.88rem]
        transition-colors
        ${selected ? "bg-fg/8 text-text" : "text-fg/muted hover:bg-fg/5 hover:text-text"}
      `}
      data-selected={selected}
      data-workbench-shell-tab={tab}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(); } }}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
    >
      <a
        aria-selected={selected}
        className={`
          flex min-w-0 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          after:absolute after:inset-0 after:content-['']
          ${preview ? "italic" : ""}
          ${selected ? "font-medium" : ""}
        `}
        draggable={false}
        href={href}
        onDoubleClick={event => { event.preventDefault(); activateTwice(); }}
        onPointerUp={event => {
          if (event.pointerType !== "touch") return;
          const tap = { tab, atMs: event.timeStamp };
          if (isWorkbenchTabDoubleTap(lastTap.current, tap)) {
            lastTap.current = null;
            activateTwice();
          } else lastTap.current = tap;
        }}
        role="tab"
        title={title}
      >
        <span className="inline-flex shrink-0 items-center">{icon}</span>
        <span className="truncate">{label}</span>
        {detail ? <span className="truncate text-[0.8em] text-fg/muted not-italic">{detail}</span> : null}
      </a>
      <button
        aria-label={dirty ? "Close, unsaved changes are kept as a draft" : "Close tab"}
        className={`
          group/close relative z-10 ml-1 grid size-5 shrink-0 place-items-center rounded-md text-fg/muted
          hover:bg-fg/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
        `}
        onClick={event => { event.preventDefault(); onClose(); }}
        type="button"
      >
        {dirty ? <>
          <AsteriskIcon size={12} aria-hidden="true" className="text-[color:var(--attention)] group-hover/close:hidden" />
          <XIcon size={12} className="hidden group-hover/close:block" />
        </> : (
          <XIcon
            size={12}
            className={selected ? "" : "opacity-0 coarse-touch:opacity-100 group-hover/shell-tab:opacity-100 group-focus-within/shell-tab:opacity-100"}
          />
        )}
      </button>
    </div>
  );
  return <ContextMenuCapability menu={menu}>{wrap ? wrap(element) : element}</ContextMenuCapability>;
}
