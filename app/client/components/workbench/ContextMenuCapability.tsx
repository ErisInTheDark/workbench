/*
 * Exports:
 * - ContextMenuCapabilityMenuFactory: callback used to build a context menu on demand.
 * - default ContextMenuCapability: open and refresh a child's document context menu.
 */
"use client";

import { useEffect, type MouseEvent, type ReactNode } from "react";

import {
  useWorkbenchContextMenu,
  type WorkbenchContextMenuDefinition,
} from "./WorkbenchContextMenuContext";


export type ContextMenuCapabilityMenuFactory = (
  event: MouseEvent<HTMLElement>,
) => WorkbenchContextMenuDefinition | null;

export default function ContextMenuCapability ({
  children,
  disabled = false,
  menu,
}: {
  children: ReactNode;
  disabled?: boolean;
  menu: WorkbenchContextMenuDefinition | ContextMenuCapabilityMenuFactory | null;
}) {
  const { openContextMenu, refreshContextMenu } = useWorkbenchContextMenu();

  useEffect(() => {
    if (menu && typeof menu !== "function") refreshContextMenu(menu);
  }, [menu, refreshContextMenu]);

  return (
    <span
      className="contents"
      onContextMenu={(event) => {
        if (disabled || !menu) {
          return;
        }

        const menuDefinition = typeof menu === "function" ? menu(event) : menu;
        if (!menuDefinition || !menuDefinition.items.length) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        openContextMenu({
          menu: menuDefinition,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      {children}
    </span>
  );
}
