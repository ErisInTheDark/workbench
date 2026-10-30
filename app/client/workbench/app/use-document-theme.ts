/*
 * Exports:
 * - default useDocumentTheme: the theme the app is painting, read from the root element's `data-workbench-theme`, so it
 *   follows every writer (bootstrap, settings, the render lab's palette picker).
 */
import { useSyncExternalStore } from "react";
import { WORKBENCH_SETTING_DEFINITIONS, type WorkbenchTheme } from "workbench-shared/workbench/settings/workbench-setting-definitions";

function read(): WorkbenchTheme {
  const value = document.documentElement.dataset.workbenchTheme;
  return WORKBENCH_SETTING_DEFINITIONS.theme.options?.find(option => option.value === value)?.value ?? "default";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-workbench-theme"] });
  return () => observer.disconnect();
}

export default function useDocumentTheme(): WorkbenchTheme {
  return useSyncExternalStore(subscribe, read, () => "default");
}
