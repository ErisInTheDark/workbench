/*
 * Exports:
 * - default WorkbenchContextMenuProvider: own and render the active document context menu. Keywords: context menu, provider, document.
 */
"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import WorkbenchContextMenuContext, {
  type WorkbenchContextMenuController,
  type WorkbenchContextMenuRequest,
} from "./WorkbenchContextMenuContext";
import WorkbenchContextMenuSurface from "./WorkbenchContextMenuSurface";

interface ActiveWorkbenchContextMenu extends WorkbenchContextMenuRequest {
  generation: number;
}

export default function WorkbenchContextMenuProvider ({ children }: { children: ReactNode }) {
  const generationRef = useRef(0);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveWorkbenchContextMenu | null>(null);

  const closeContextMenu = useCallback(() => {
    setActiveContextMenu(null);
  }, []);

  const openContextMenu = useCallback((request: WorkbenchContextMenuRequest) => {
    generationRef.current += 1;
    setActiveContextMenu({
      ...request,
      generation: generationRef.current,
    });
  }, []);

  const controller: WorkbenchContextMenuController = {
    closeContextMenu,
    openContextMenu,
  };

  return (
    <WorkbenchContextMenuContext.Provider value={controller}>
      {children}
      {activeContextMenu ? (
        <WorkbenchContextMenuSurface
          generation={activeContextMenu.generation}
          menu={activeContextMenu.menu}
          onClose={closeContextMenu}
          x={activeContextMenu.x}
          y={activeContextMenu.y}
        />
      ) : null}
    </WorkbenchContextMenuContext.Provider>
  );
}
