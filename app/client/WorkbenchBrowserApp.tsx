/*
 * Default export:
 * - WorkbenchBrowserApp: select the ordinary Workbench SPA or a chrome-free thread rendering surface from browser location. Keywords: React, route, app shell.
 */
import { useLayoutEffect } from "react";

import AgentThreadViewer from "./components/workbench/thread-view/AgentThreadViewer.tsx";
import ThreadRenderLab from "./components/workbench/thread-view/ThreadRenderLab.tsx";
import Workbench from "./components/workbench.tsx";
import WorkbenchClientStateProvider from "./components/workbench/WorkbenchClientStateProvider.tsx";
import WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController.ts";
import WorkbenchAppRuntimeClient from "./workbench/app/WorkbenchAppRuntimeClient.ts";
import { usePathname } from "./workbench/navigation/browser-navigation.ts";

const SAFE_AREA_BOTTOM_PROPERTY = "--workbench-safe-area-bottom";
const TEXT_INPUT_TYPES = new Set(["email", "number", "password", "search", "tel", "text", "url"]);

function acceptsTextInput(element: Element | null) {
  const textEntry = element?.closest("input, textarea, [contenteditable], [role='textbox']");
  if (!textEntry) return false;
  if (textEntry instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(textEntry.type);
  if (textEntry instanceof HTMLTextAreaElement || textEntry.getAttribute("role") === "textbox") return true;
  return textEntry.getAttribute("contenteditable") !== "false";
}

function useWorkbenchSafeAreaBottom() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousValue = root.style.getPropertyValue(SAFE_AREA_BOTTOM_PROPERTY);
    const previousPriority = root.style.getPropertyPriority(SAFE_AREA_BOTTOM_PROPERTY);
    const viewport = window.visualViewport;
    const closedViewportHeights = new Map<number, number>();
    const update = () => {
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = Math.round(viewport?.width ?? window.innerWidth);
      const textInputFocused = acceptsTextInput(document.activeElement);
      if (!textInputFocused) {
        closedViewportHeights.set(
          viewportWidth,
          Math.max(closedViewportHeights.get(viewportWidth) ?? 0, viewportHeight),
        );
      }
      const closedViewportHeight = closedViewportHeights.get(viewportWidth);
      const keyboardVisible = Boolean(
        viewport
        && Math.abs(viewport.scale - 1) < 0.01
        && textInputFocused
        && closedViewportHeight
        && viewportHeight < closedViewportHeight * 0.75,
      );
      root.style.setProperty(
        SAFE_AREA_BOTTOM_PROPERTY,
        keyboardVisible ? "0px" : "env(safe-area-inset-bottom, 0px)",
      );
    };

    update();
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      if (previousValue) root.style.setProperty(SAFE_AREA_BOTTOM_PROPERTY, previousValue, previousPriority);
      else root.style.removeProperty(SAFE_AREA_BOTTOM_PROPERTY);
    };
  }, []);
}

function threadIdFromPath(pathname: string) {
  const match = /^\/agent\/thread\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export default function WorkbenchBrowserApp({
  controller,
  runtime,
}: {
  controller: WorkbenchClientStateController;
  runtime: WorkbenchAppRuntimeClient;
}) {
  useWorkbenchSafeAreaBottom();
  const pathname = usePathname();
  let content;
  if (pathname === "/agent/thread-lab") {
    content = <ThreadRenderLab />;
  } else if (pathname === "/agent/thread" || pathname.startsWith("/agent/thread/")) {
    content = <AgentThreadViewer initialThreadId={threadIdFromPath(pathname)} />;
  } else {
    content = <Workbench appRuntime={runtime} />;
  }
  return (
    <WorkbenchClientStateProvider controller={controller}>
      {content}
    </WorkbenchClientStateProvider>
  );
}
