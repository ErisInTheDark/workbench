/*
 * Exports:
 * - default WorkbenchSvgTabs: horizontally scrolling svg file tabs, each one pill holding its name, dirty marker and close button;
 *   middle-click also closes.
 */
"use client";

import { useEffect, useRef } from "react";
import { XIcon } from "../workbench-icons";
import type { SvgOpenTab } from "./use-svg-file-tabs";

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export default function WorkbenchSvgTabs({
  dirtyKeys,
  index,
  onClose,
  onSelect,
  tabs,
}: {
  dirtyKeys: ReadonlySet<string>;
  index: number;
  onClose: (index: number) => void;
  onSelect: (index: number) => void;
  tabs: readonly SvgOpenTab[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index, tabs.length]);
  return (
    <div
      ref={listRef}
      aria-label="Open SVG files"
      className="scrollbar-hover-reveal flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-1"
      role="tablist"
    >
      {tabs.map((item, position) => {
        const selected = position === index;
        const folder = item.tab.folderAddress?.join("/");
        const name = fileName(item.tab.filePath);
        return (
          <div
            key={item.key}
            className={`
              group/svg-tab flex h-8 shrink-0 items-center rounded-lg pl-2.5 pr-1 text-[0.9rem] transition-colors
              ${selected ? "bg-fg/8 text-text" : "text-fg/muted hover:bg-fg/5 hover:text-text"}
            `}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(position); } }}
            onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="flex max-w-[16rem] items-center gap-1.5 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              onClick={() => onSelect(position)}
              title={folder ? `${folder}: ${item.tab.filePath}` : item.tab.filePath}
            >
              <span className="truncate">{name}</span>
              {folder ? <span className="truncate text-[0.78em] text-fg/muted">{folder}</span> : null}
            </button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              title={`Close ${name} (middle-click)`}
              className="group/close ml-1 grid size-5 place-items-center rounded-md text-fg/muted hover:bg-fg/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              onClick={() => onClose(position)}
            >
              {dirtyKeys.has(item.key) ? <>
                <span aria-label="Unsaved changes" className="size-2 rounded-full bg-accent group-hover/close:hidden" />
                <XIcon size={12} className="hidden group-hover/close:block" />
              </> : <XIcon size={12} className={selected ? "" : "opacity-0 group-hover/svg-tab:opacity-100"} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
