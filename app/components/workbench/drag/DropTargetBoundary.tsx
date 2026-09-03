/*
 * Exports:
 * - default DropTargetBoundary: constrain extended target ranges to the nearest DOM boundary resolved through closest(). Keywords: drop, boundary, range.
 */
"use client";

import { useState, type ReactNode } from "react";

import { DropTargetBoundaryContext } from "./workbench-drag-context";

export default function DropTargetBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <DropTargetBoundaryContext.Provider value={element}>
      <div className={className} data-workbench-drop-target-boundary="true" ref={setElement}>{children}</div>
    </DropTargetBoundaryContext.Provider>
  );
}
