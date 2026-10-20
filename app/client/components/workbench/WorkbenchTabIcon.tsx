/*
 * Exports:
 * - WorkbenchTabIconState: tab icon state derived from global thread status.
 * - default WorkbenchTabIcon: derive the tab icon state from sidebar threads and the current thread, and synchronize the browser tab icon with it.
 */
"use client";

import { useEffect, useMemo } from "react";

import {
  isThreadStatusActive, isThreadStatusWaitingOnUserInput, threadAttentionLabels, threadLifecycleSignal,
} from "./thread-attention";
import { useThreads } from "./use-threads";

export type WorkbenchTabIconState = "default" | "questionnaire" | "active";

const TAB_ICON_HREFS: Record<WorkbenchTabIconState, string> = {
  active: "/tab-icons/active.png",
  default: "/tab-icons/default.png",
  questionnaire: "/tab-icons/questionnaire.png",
};

function ensureIconLink(rel: "icon" | "shortcut icon") {
  const selector = `link[rel="${rel}"]`;
  const existingLink = document.head.querySelector<HTMLLinkElement>(selector);
  if (existingLink) {
    return existingLink;
  }

  const link = document.createElement("link");
  link.rel = rel;
  document.head.appendChild(link);
  return link;
}

export default function WorkbenchTabIcon() {
  const sidebars = useThreads.sidebars();
  const currentThread = useThreads.current();
  const attention = useMemo(() => threadAttentionLabels(sidebars), [sidebars]);
  const signal = useMemo(() => threadLifecycleSignal(sidebars), [sidebars]);
  const state: WorkbenchTabIconState = (currentThread && currentThread.id in attention
    && isThreadStatusWaitingOnUserInput(currentThread.status)) || signal === "needsAttention"
    ? "questionnaire"
    : (currentThread && isThreadStatusActive(currentThread.status)) || signal === "working" ? "active" : "default";
  useEffect(() => {
    const href = TAB_ICON_HREFS[state];
    for (const rel of ["icon", "shortcut icon"] as const) {
      const link = ensureIconLink(rel);
      link.type = "image/png";
      link.href = href;
    }
  }, [state]);

  return null;
}
