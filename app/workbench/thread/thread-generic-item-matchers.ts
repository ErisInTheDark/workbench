/*
 * Keywords: generic item, provider, presentation, matcher, registry.
 * Exports:
 * - matchThreadGenericItem: select a validated presentation without changing provider data.
 */
import type { WorkbenchProjectedGenericItem } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { matchSleepItem } from "./generic-item-matchers/sleep";

const matchers = [matchSleepItem];

export function matchThreadGenericItem(item: Pick<WorkbenchProjectedGenericItem, "nativeType" | "safeValue">) {
  for (const match of matchers) {
    const result = match(item);
    if (result) return result;
  }
  return null;
}
