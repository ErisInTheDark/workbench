/*
 * Exports:
 * - orderComposerProfiles: sort a copy by turn usage with stable creation/id ties.
 * - composerProfileRecency: use edit time until the first recorded turn.
 */
import type { WorkbenchComposerProfile } from "workbench-shared/types";

export function composerProfileRecency(profile: WorkbenchComposerProfile) {
  return profile.lastUsedAt ?? profile.updatedAt;
}

export function orderComposerProfiles(profiles: readonly WorkbenchComposerProfile[], direction: "oldest" | "newest") {
  const sign = direction === "oldest" ? 1 : -1;
  return [...profiles].sort((left, right) => sign * (
    composerProfileRecency(left) - composerProfileRecency(right)
    || left.createdAt - right.createdAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));
}
