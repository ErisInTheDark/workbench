/*
 * Exports:
 * - WorkbenchTabIconState: tab icon state derived from global thread status. Keywords: tab icon, favicon, thread, questionnaire, active.
 * - default WorkbenchTabIcon: synchronize the browser tab icon with Workbench thread status. Keywords: tab icon, favicon, thread, questionnaire, active.
 */
"use client";

import { useEffect } from "react";

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

export default function WorkbenchTabIcon({ state }: { state: WorkbenchTabIconState }) {
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
