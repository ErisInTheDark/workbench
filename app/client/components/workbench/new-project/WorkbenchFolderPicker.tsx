/*
 * Exports:
 * - default WorkbenchFolderPicker: InputList-styled folder explorer over daemon git roots, with a drive browser for adding a projects root.
 */
"use client";

import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode } from "react";

import type { DaemonId } from "workbench-shared/workbench/identity";
import type { ProjectFolderList } from "workbench-shared/workbench/project/project-creation";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchClientController } from "../workbench-client-context";
import { BackArrowIcon, FolderClosedIcon, FolderGit2Icon, PlusIcon } from "../workbench-icons";
import IconButton from "../../ui/IconButton";
import { displayFolderPath, FolderPickerState, type FolderPickerAction, type FolderPickerFolder } from "./folder-picker-state";

type Listing = { key: string; phase: "loading" } | { key: string; phase: "ready"; value: ProjectFolderList }
  | { key: string; phase: "failed"; error: string };
type DaemonRoots = { daemonId: DaemonId; hostname: string; roots: string[] | null; error: string | null };
type Row = {
  key: string;
  label: ReactNode;
  icon: ReactNode;
  detail?: ReactNode;
  folder: FolderPickerFolder | null;
  blocked?: boolean;
  onOpen: () => void;
};

function errorMessage(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : fallback).slice(0, 500);
}

function Message ({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return <p role={tone === "danger" ? "alert" : "status"} className={`
    m-0 px-3 py-2 text-[0.82rem]
    ${tone === "danger" ? "text-danger" : "text-fg/muted"}
  `}>{children}</p>;
}

export default function WorkbenchFolderPicker ({ dispatch, state }: {
  dispatch: Dispatch<FolderPickerAction>;
  state: FolderPickerState;
}) {
  const mounted = useWorkbenchClientController().mounted;
  const daemons = mounted?.presentationClient.snapshot().data?.daemons ?? [];
  const daemonKey = daemons.map(daemon => `${daemon.id}:${daemon.hostname}`).join("\0");
  const [rootsRevision, setRootsRevision] = useState(0);
  const [roots, setRoots] = useState<DaemonRoots[] | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [rootError, setRootError] = useState("");
  const [addingRoot, setAddingRoot] = useState(false);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusFirstRow = useRef(false);
  const browsing = state.mode === "add-root" || state.path !== null;
  const listingKey = browsing ? `${state.mode}\0${state.daemonId}\0${state.path ?? ""}` : "";

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    void Promise.all(daemons.map(async ({ id, hostname }): Promise<DaemonRoots> => {
      try {
        const { paths } = await mounted.workspace.daemon({ kind: "installation", daemonId: id }).projectDiscoverySettings.read();
        return { daemonId: id, hostname, roots: paths, error: null };
      } catch (error) {
        return { daemonId: id, hostname, roots: null, error: errorMessage(error, "Project roots are unavailable.") };
      }
    })).then(next => { if (!cancelled) setRoots(next); });
    return () => { cancelled = true; };
    // daemonKey captures the daemon identities this effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, daemonKey, rootsRevision]);

  useEffect(() => {
    if (!mounted || !browsing || !state.daemonId) return;
    let cancelled = false;
    const key = listingKey;
    setListing({ key, phase: "loading" });
    mounted.workspace.daemon({ kind: "installation", daemonId: state.daemonId }).projectCreation
      .listFolders({ path: state.path })
      .then(value => { if (!cancelled) setListing({ key, phase: "ready", value }); },
        error => { if (!cancelled) setListing({ key, phase: "failed", error: errorMessage(error, "That folder cannot be read.") }); });
    return () => { cancelled = true; };
  }, [mounted, browsing, listingKey, state.daemonId, state.path]);

  const current = !browsing ? null : listing?.key === listingKey ? listing : { key: listingKey, phase: "loading" as const };
  const showHosts = daemons.length > 1;
  const selectedPath = state.selected?.path ?? null;

  const rows: Row[] = !browsing
    ? (roots ?? []).flatMap(entry => [
      ...(entry.roots ?? []).map((root): Row => {
        const folder = { daemonId: entry.daemonId, path: root };
        return {
          key: `${entry.daemonId}\0${root}`,
          label: displayFolderPath(root),
          icon: <FolderClosedIcon size={16} />,
          detail: showHosts ? entry.hostname : undefined,
          folder,
          onOpen: () => dispatch({ type: "open", folder }),
        };
      }),
      {
        key: `${entry.daemonId}\0add`,
        label: "add projects root",
        icon: <PlusIcon size={16} />,
        detail: showHosts ? entry.hostname : undefined,
        folder: null,
        onOpen: () => dispatch({ type: "begin-add-root", daemonId: entry.daemonId }),
      },
    ])
    : current?.phase === "ready" ? current.value.entries.map((entry): Row => {
      const folder: FolderPickerFolder = { daemonId: state.daemonId!, path: entry.path, isGitRepository: entry.isGitRepository };
      const blocked = state.mode === "place" && entry.isGitRepository;
      return {
        key: entry.path,
        label: entry.name,
        icon: entry.isGitRepository ? <FolderGit2Icon size={16} /> : <FolderClosedIcon size={16} />,
        detail: blocked ? "existing project" : undefined,
        folder,
        blocked,
        onOpen: () => dispatch({ type: "open", folder }),
      };
    }) : [];

  useEffect(() => {
    if (!focusFirstRow.current || (browsing && current?.phase !== "ready") || (!browsing && !roots)) return;
    focusFirstRow.current = false;
    rowRefs.current.find(Boolean)?.focus();
  });

  function navigate (action: FolderPickerAction) {
    focusFirstRow.current = true;
    dispatch(action);
  }

  function goUp () {
    navigate({ type: "up", parentPath: current?.phase === "ready" ? current.value.parentPath : null });
  }

  function rowKeyDown (event: KeyboardEvent<HTMLButtonElement>, index: number, row: Row) {
    const move = (next: number) => {
      event.preventDefault();
      rowRefs.current[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if ((event.key === "Enter" || event.key === "ArrowRight") && !row.blocked) {
      event.preventDefault();
      focusFirstRow.current = true;
      row.onOpen();
    } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && state.path !== null) {
      event.preventDefault();
      goUp();
    }
  }

  async function confirmRoot () {
    const folder = FolderPickerState.target(state);
    if (!mounted || state.mode !== "add-root" || !folder) return;
    setAddingRoot(true);
    setRootError("");
    try {
      const daemon = mounted.workspace.daemon({ kind: "installation", daemonId: folder.daemonId });
      const { paths } = await daemon.projectDiscoverySettings.read();
      const result = await daemon.projectDiscoverySettings.update({ paths: [...paths, folder.path] });
      if (!result.accepted) {
        setRootError(result.issues.some(issue => issue.reason === "duplicate")
          ? "That folder is already a projects root." : "That folder cannot be used as a projects root.");
        return;
      }
      setRootsRevision(value => value + 1);
      navigate({ type: "root-added", folder: { daemonId: folder.daemonId, path: result.paths.at(-1) ?? folder.path } });
      await mounted.refreshInstallationProjects(folder.daemonId);
    } catch (error) {
      setRootError(errorMessage(error, "Unable to add the projects root."));
    } finally {
      setAddingRoot(false);
    }
  }

  const crumbs = FolderPickerState.crumbs(state);
  const addTarget = state.mode === "add-root" ? FolderPickerState.target(state) : null;
  rowRefs.current.length = rows.length;

  return (
    <div className="overflow-hidden rounded-[0.8rem] border border-text/16 bg-text/[0.03]">
      <div className="flex min-h-10 items-center gap-1 border-b border-text/16 py-1 pl-1 pr-1">
        <IconButton
          label="Up one folder"
          display="hover-border"
          size="compact"
          disabled={state.path === null}
          onClick={goUp}
        ><BackArrowIcon size={14} /></IconButton>
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-hover-reveal">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return <span key={crumb.path ?? "top"} className="flex shrink-0 items-center">
              {index ? <span aria-hidden="true" className="px-0.5 text-fg/muted/60">/</span> : null}
              <button
                type="button"
                aria-current={last ? "location" : undefined}
                disabled={last}
                className={`
                  rounded-md px-1.5 py-1 text-[0.82rem] transition enabled:cursor-pointer
                  enabled:hover:bg-text/[0.06] enabled:hover:text-text
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                  ${last ? "font-medium text-text" : "text-fg/muted"}
                `}
                onClick={() => navigate(crumb.path === null
                  ? { type: "home" }
                  : { type: "open", folder: { daemonId: state.daemonId!, path: crumb.path } })}
              >{crumb.label}</button>
            </span>;
          })}
        </nav>
      </div>
      <div
        role="listbox"
        aria-label={state.mode === "add-root" ? "Folders to use as a projects root" : "Folders to place the project in"}
        className="h-72 overflow-y-auto overscroll-contain scrollbar-hover-reveal"
      >
        {(browsing ? current?.phase === "loading" : !roots) ? Array.from({ length: 5 }, (_, index) => (
          <div key={index} aria-hidden="true" className="flex items-center gap-2 py-2.5 pl-3">
            <span className="size-4 rounded workbench-skeleton" />
            <span className="h-3 rounded-full workbench-skeleton" style={{ width: `${40 - index * 4}%` }} />
          </div>
        )) : current?.phase === "failed" ? <Message tone="danger">{current.error}</Message>
          : browsing && !rows.length ? <Message>No folders here.</Message>
          : rows.map((row, index) => {
            const selected = Boolean(row.folder && selectedPath === row.folder.path && state.selected?.daemonId === row.folder.daemonId);
            return (
              <div key={row.key} role="presentation" className="group/folder relative flex items-center odd:bg-text/[0.03]">
                <span aria-hidden="true" className={`
                  pointer-events-none absolute inset-x-1 inset-y-0.5 rounded-[0.6rem] border transition
                  ${selected
                    ? "border-text/22 bg-text/[0.08] opacity-100"
                    : row.blocked ? "opacity-0" : "border-transparent bg-text/[0.05] opacity-0 group-hover/folder:opacity-100"}
                `} />
                <button
                  ref={node => { rowRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={row.blocked || undefined}
                  className={`
                    relative flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[0.6rem] py-2 pl-3 pr-10 text-left text-[0.85rem] outline-none md:min-h-9
                    focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft
                    ${row.blocked ? "cursor-not-allowed text-fg/muted/60" : "cursor-pointer text-text"}
                  `}
                  onClick={() => {
                    if (row.blocked) return;
                    if (!row.folder) row.onOpen();
                    else dispatch({ type: "select", folder: selected ? null : row.folder });
                  }}
                  onDoubleClick={() => { if (!row.blocked && row.folder) navigate({ type: "open", folder: row.folder }); }}
                  onKeyDown={event => rowKeyDown(event, index, row)}
                >
                  <span className={`shrink-0 ${selected ? "text-text" : "text-fg/muted"}`}>{row.icon}</span>
                  <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>{row.label}</span>
                  {row.detail ? <span className="shrink-0 text-[0.74rem] text-fg/muted">{row.detail}</span> : null}
                </button>
                {row.folder && !row.blocked ? <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Open ${typeof row.label === "string" ? row.label : displayFolderPath(row.folder.path)}`}
                  className={`
                    absolute right-2 flex size-7 cursor-pointer items-center justify-center rounded-md text-fg/muted transition
                    hover:bg-surface-hover hover:text-text
                    ${selected ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/folder:opacity-100"}
                  `}
                  onClick={() => navigate({ type: "open", folder: row.folder! })}
                ><BackArrowIcon size={14} className="rotate-180" /></button> : null}
              </div>
            );
          })}
        {current?.phase === "ready" && current.value.truncated
          ? <Message>Only the first {current.value.entries.length} folders are shown.</Message> : null}
        {!browsing && roots?.some(entry => entry.error)
          ? roots.flatMap(entry => entry.error ? [<Message key={entry.daemonId} tone="danger">{entry.error}</Message>] : []) : null}
      </div>
      {state.mode === "add-root" ? (
        <div className="flex items-center justify-between gap-3 border-t border-text/16 py-2 pl-3 pr-2">
          <p className={`m-0 min-w-0 truncate text-[0.8rem] ${rootError ? "text-danger" : "text-fg/muted"}`} role={rootError ? "alert" : undefined}>
            {rootError || (addTarget ? displayFolderPath(addTarget.path) : "Choose a folder to scan for projects.")}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={`
                rounded-full px-3 py-1.5 text-[0.84rem] text-fg/muted transition enabled:cursor-pointer
                enabled:hover:bg-text/[0.06] enabled:hover:text-text
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
              `}
              disabled={addingRoot}
              onClick={() => { setRootError(""); navigate({ type: "cancel-add-root" }); }}
            >Cancel</button>
            <PrimaryButton disabled={!addTarget || addingRoot} pendingHalo={addingRoot} onClick={() => { void confirmRoot(); }}>
              Use as projects root
            </PrimaryButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
