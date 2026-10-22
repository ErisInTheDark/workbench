/*
 * Exports:
 * - default WorkbenchGitChangesetProvider: give the diff views one changeset (working tree, commit or stash).
 * - useGitChangeset: the provided changeset and its live snapshot.
 */
"use client";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { GitChangeset } from "../../../workbench/git/git-changeset";

const Context = createContext<GitChangeset | null>(null);

export function useGitChangeset() {
  const changeset = useContext(Context);
  if (!changeset) throw new Error("A Git changeset provider is required.");
  const snapshot = useSyncExternalStore(changeset.subscribe, changeset.getSnapshot, changeset.getSnapshot);
  return { changeset, snapshot };
}

export default function WorkbenchGitChangesetProvider({ changeset, children }: { changeset: GitChangeset; children: ReactNode }) {
  return <Context.Provider value={changeset}>{children}</Context.Provider>;
}
