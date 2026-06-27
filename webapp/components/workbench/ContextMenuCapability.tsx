/*
 * Exports:
 * - ContextMenuCapabilityMenuFactory: callback used to build a context menu on demand. Keywords: context menu, capability, factory.
 * - default ContextMenuCapability: wrap children and open their document context menu on right click. Keywords: context menu, wrapper, right click.
 */
"use client";

import type { MouseEvent, ReactNode } from "react";

import {
  useWorkbenchContextMenu,
  type WorkbenchContextMenuDefinition,
} from "./WorkbenchContextMenuProvider";

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
  const { openContextMenu } = useWorkbenchContextMenu();

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
