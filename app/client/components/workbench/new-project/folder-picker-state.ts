/*
 * Exports:
 * - FolderPickerFolder: one daemon folder the picker can open or select.
 * - FolderPickerState/FolderPickerAction: display state and transitions for placing a project or adding a projects root.
 * - displayFolderPath: POSIX-style display form of an absolute path (`C:\git` → `/c/git`).
 * - FolderPickerState (namespace): initial state, reducer, breadcrumbs, and the folder the current state targets.
 */
import type { DaemonId } from "workbench-shared/workbench/identity";

export interface FolderPickerFolder {
  daemonId: DaemonId;
  path: string;
  isGitRepository?: boolean;
}

/**
 * `place` browses inside one git root; `path: null` there is the virtual list of every root.
 * `add-root` browses one daemon's whole disk; `path: null` there is its filesystem roots.
 */
export type FolderPickerState = {
  mode: "place" | "add-root";
  daemonId: DaemonId | null;
  root: string | null;
  path: string | null;
  selected: FolderPickerFolder | null;
};

export type FolderPickerAction =
  | { type: "open"; folder: FolderPickerFolder }
  | { type: "select"; folder: FolderPickerFolder | null }
  | { type: "up"; parentPath: string | null }
  | { type: "home" }
  | { type: "begin-add-root"; daemonId: DaemonId }
  | { type: "root-added"; folder: FolderPickerFolder }
  | { type: "cancel-add-root" };

function samePath(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function ancestorPaths(path: string) {
  const drive = /^([A-Za-z]:)(?:[\\/]|$)/u.exec(path);
  const separator = drive ? "\\" : "/";
  const segments = (drive ? path.slice(drive[1]!.length) : path).split(/[\\/]+/u).filter(Boolean);
  const paths = [drive ? `${drive[1]}\\` : "/"];
  let current = drive ? drive[1]! : "";
  for (const segment of segments) {
    current = `${current}${separator}${segment}`;
    paths.push(current);
  }
  return paths;
}

function leafName(path: string) {
  return /^[A-Za-z]:[\\/]?$/u.test(path) ? displayFolderPath(path) : path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path;
}

/** Display an absolute path POSIX-style; Windows drives become `/c/...`. */
export function displayFolderPath(path: string) {
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/u.exec(path);
  if (!drive) return path.replace(/\\/gu, "/");
  const rest = (drive[2] ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  return `/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ""}`;
}

export namespace FolderPickerState {
  export const initial: FolderPickerState = { mode: "place", daemonId: null, root: null, path: null, selected: null };

  /** Repositories are existing projects; discovery would hide anything placed inside them. */
  function placeable(state: FolderPickerState, folder: FolderPickerFolder) {
    return state.mode === "add-root" || !folder.isGitRepository;
  }

  export function reduce(state: FolderPickerState, action: FolderPickerAction): FolderPickerState {
    switch (action.type) {
      case "open":
        if (!placeable(state, action.folder)) return state;
        return {
          ...state,
          daemonId: action.folder.daemonId,
          root: state.mode === "place" ? state.root ?? action.folder.path : null,
          path: action.folder.path,
          selected: null,
        };
      case "select":
        if (action.folder && !placeable(state, action.folder)) return state;
        return { ...state, selected: action.folder };
      case "up":
        if (state.path === null) return state;
        if (state.mode === "place" && state.root && samePath(state.path, state.root)) return initial;
        return { ...state, path: action.parentPath, selected: null };
      case "home":
        return state.mode === "place" ? initial : { ...state, path: null, selected: null };
      case "begin-add-root":
        return { mode: "add-root", daemonId: action.daemonId, root: null, path: null, selected: null };
      case "root-added":
        return { mode: "place", daemonId: action.folder.daemonId, root: action.folder.path, path: action.folder.path, selected: null };
      case "cancel-add-root":
        return initial;
    }
  }

  /** Breadcrumbs from the virtual top level to the open folder; placement never climbs above its git root. */
  export function crumbs(state: FolderPickerState): { label: string; path: string | null }[] {
    const head = { label: state.mode === "place" ? "Project roots" : "Drives", path: null };
    if (state.path === null) return [head];
    const ancestors = ancestorPaths(state.path);
    const rootIndex = state.mode === "place" && state.root
      ? Math.max(0, ancestors.findIndex(candidate => samePath(candidate, state.root!))) : 0;
    return [head, ...ancestors.slice(rootIndex).map((path, index) => ({
      label: index === 0 && state.mode === "place" ? displayFolderPath(path) : leafName(path),
      path,
    }))];
  }

  /** The folder a confirm acts on: the selected child, otherwise the open folder. */
  export function target(state: FolderPickerState): FolderPickerFolder | null {
    if (state.selected) return state.selected;
    return state.daemonId && state.path !== null ? { daemonId: state.daemonId, path: state.path } : null;
  }
}
