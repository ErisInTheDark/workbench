/*
 * Exports:
 * - default WorkbenchDragProvider: provide one drag controller and render its lifecycle-owned ghost.
 */
"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import WorkbenchDragController from "../../../workbench/layout/WorkbenchDragController";
import type { WorkbenchThreadDragAction } from "../../../workbench/layout/workbench-drag";
import { FolderInputIcon, OpenThreadIcon, PinIcon, SnoozedThreadIcon } from "../workbench-icons";
import { WorkbenchDragContext } from "./workbench-drag-context";

const ACTION_ICONS = {
  folder: FolderInputIcon,
  main: OpenThreadIcon,
  pinned: PinIcon,
  snoozed: SnoozedThreadIcon,
} satisfies Record<WorkbenchThreadDragAction, typeof PinIcon>;

export default function WorkbenchDragProvider ({ children, controller: suppliedController }: { children: ReactNode; controller?: WorkbenchDragController }) {
  const ownedController = useMemo(() => suppliedController ?? new WorkbenchDragController(), [suppliedController]);
  const snapshot = useSyncExternalStore(ownedController.subscribe, ownedController.getSnapshot, ownedController.getSnapshot);
  useEffect(() => () => { if (!suppliedController) ownedController.dispose(); }, [ownedController, suppliedController]);
  return (
    <WorkbenchDragContext.Provider value={ownedController}>
      {children}
      {snapshot.active ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 flex flex-col gap-1 items-start whitespace-nowrap"
          style={{ left: 0, top: 0, transform: `translate3d(${snapshot.x + 12}px, ${snapshot.y + 12}px, 0)` }}
        >
          <span className="max-w-[18rem] truncate rounded-[0.7rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-3 py-1.5 text-[0.78rem] font-medium text-text shadow-float backdrop-blur">{snapshot.label}</span>
          {snapshot.targetPreview ? (() => {
            const ActionIcon = ACTION_ICONS[snapshot.targetPreview.action];
            return (
              <span className="inline-flex shrink-0 items-center gap-1 px-3 py-1.5 text-[0.92rem] font-bold text-accent border border-[color-mix(in_srgb,var(--text)_18%,transparent)] rounded-full bg-[color-mix(in_srgb,var(--bg)_8%,transparent)] backdrop-blur">
                <ActionIcon size={14} />
                {snapshot.targetPreview.label}
              </span>
            );
          })() : null}
        </div>
      ) : null}
    </WorkbenchDragContext.Provider>
  );
}
