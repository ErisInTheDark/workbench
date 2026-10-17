/*
 * Exports:
 * - default WorkbenchMobileShellHeader: render the sticky shell header, subscribing to its own mobile visibility so scroll gestures re-render only the header.
 */
"use client";

import { useSyncExternalStore, type ReactNode } from "react";

import { WORKBENCH_STICKY_CHROME_ATTRIBUTE } from "../../workbench/workbench-dom";
import type MobileShellHeaderVisibilityController from "./MobileShellHeaderVisibilityController";

export default function WorkbenchMobileShellHeader({ children, className, hidden, visibility }: {
  children: ReactNode;
  className: string;
  hidden: boolean;
  visibility: MobileShellHeaderVisibilityController;
}) {
  const visible = useSyncExternalStore(visibility.subscribe, visibility.getVisible, visibility.getVisible);
  return (
    <header
      className={`${className} ${visible
        ? "-translate-y-1 opacity-100"
        : "pointer-events-none -translate-y-[calc(100%+0.75rem)] opacity-0"
      }`}
      hidden={hidden}
      {...{ [WORKBENCH_STICKY_CHROME_ATTRIBUTE]: "" }}
      // A slid-away header keeps its controls out of focus and interaction until it returns.
      inert={!visible}
    >
      {children}
    </header>
  );
}
