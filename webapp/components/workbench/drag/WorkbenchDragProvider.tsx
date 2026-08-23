/*
 * Exports:
 * - default WorkbenchDragProvider: provide one drag controller and render its lifecycle-owned ghost. Keywords: React, drag, ghost, provider.
 */
"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import WorkbenchDragController from "../../../lib/workbench/layout/WorkbenchDragController";
import { WorkbenchDragContext } from "./workbench-drag-context";

export default function WorkbenchDragProvider({ children, controller: suppliedController }: { children: ReactNode; controller?: WorkbenchDragController }) {
  const ownedController = useMemo(() => suppliedController ?? new WorkbenchDragController(), [suppliedController]);
  const snapshot = useSyncExternalStore(ownedController.subscribe, ownedController.getSnapshot, ownedController.getSnapshot);
  useEffect(() => () => { if (!suppliedController) ownedController.dispose(); }, [ownedController, suppliedController]);
  return (
    <WorkbenchDragContext.Provider value={ownedController}>
      {children}
      {snapshot.active ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 max-w-[18rem] truncate rounded-[0.7rem] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-3 py-1.5 text-[0.78rem] font-medium text-text shadow-float backdrop-blur"
          style={{ left: 0, top: 0, transform: `translate3d(${snapshot.x + 12}px, ${snapshot.y + 12}px, 0)` }}
        >
          {snapshot.label}
        </div>
      ) : null}
    </WorkbenchDragContext.Provider>
  );
}
