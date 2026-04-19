"use client";

import { startTransition, useEffect, useState } from "react";

import type {
  ChangeSummary,
  ExplorerSnapshot,
  TreeNode,
  WorkbenchControls,
} from "../lib/types";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  root: "Project",
  tree: [],
  changes: {},
  currentPath: "",
  expandedDirectories: [""],
  locallyModifiedPaths: [],
};

function SaveIcon () {
  return (
    <span className="relative block size-5">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="save-icon-main size-5">
        <path d="M4.25 4.25h9l2.5 2.5v9h-11.5z" strokeLinejoin="round" />
        <path d="M7 4.25v4h5v-4" strokeLinejoin="round" />
        <path d="M7.25 15h5.5" strokeLinecap="round" />
      </svg>
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        aria-hidden="true"
        className="save-icon-slash pointer-events-none absolute inset-0 size-5 opacity-0 transition-opacity"
      >
        <path d="M4 16 16 4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function ZoomOutIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M8.25 12.75a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" />
      <path d="M11.75 11.75 16 16" strokeLinecap="round" />
      <path d="M6.5 8.25h3.5" strokeLinecap="round" />
    </svg>
  );
}

function ZoomInIcon () {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-5">
      <path d="M8.25 12.75a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" />
      <path d="M11.75 11.75 16 16" strokeLinecap="round" />
      <path d="M8.25 6.5v3.5" strokeLinecap="round" />
      <path d="M6.5 8.25h3.5" strokeLinecap="round" />
    </svg>
  );
}

function ExplorerChevronIcon ({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      data-role="tree-chevron"
      className="shrink-0 transition-transform mt-0.5"
      style={{
        width: "1.1rem",
        height: "1.1rem",
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <path d="M7 5.75 12 10 7 14.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExplorerModifiedDot ({ hidden = false }: { hidden?: boolean }) {
  return (
    <span
      data-role="tree-modified"
      hidden={hidden}
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#d0ad12] dark:bg-[#ffd84d]"
      aria-hidden="true"
    />
  );
}

function ExplorerFileSpacer () {
  return (
    <span
      data-role="tree-spacer"
      className="shrink-0"
      style={{ width: "1.1rem", height: "1.1rem" }}
      aria-hidden="true"
    />
  );
}

function describeChange (filePath: string, changes: Record<string, ChangeSummary>) {
  const entry = changes[filePath];
  if (!entry) {
    return "";
  }

  const parts = [];
  if (entry.additions) {
    parts.push(`+${entry.additions}`);
  }
  if (entry.deletions) {
    parts.push(`-${entry.deletions}`);
  }
  return parts.join(" ");
}

function hasModifiedDescendant (node: TreeNode, modifiedPaths: Set<string>): boolean {
  if (node.type === "file") {
    return modifiedPaths.has(node.path);
  }

  return node.children.some((child) => hasModifiedDescendant(child, modifiedPaths));
}

interface ExplorerTreeProps {
  changes: Record<string, ChangeSummary>;
  controls: WorkbenchControls | null;
  currentPath: string;
  expandedDirectories: Set<string>;
  modifiedPaths: Set<string>;
  nested?: boolean;
  nodes: TreeNode[];
}

function ExplorerTree ({
  changes,
  controls,
  currentPath,
  expandedDirectories,
  modifiedPaths,
  nested = false,
  nodes,
}: ExplorerTreeProps) {
  return (
    <ul
      className={`m-0 p-0${nested ? " ml-4" : ""}`}
      data-role={nested ? "tree-group-nested" : "tree-group-root"}
    >
      {nodes.map((node) => {
        if (node.type === "directory") {
          const isExpanded = expandedDirectories.has(node.path);
          const isModified = hasModifiedDescendant(node, modifiedPaths);

          return (
            <li
              key={`${node.type}:${node.path}`}
              className="m-0 list-none"
              data-path={node.path}
              data-tree-key={`${node.type}:${node.path}`}
              data-tree-type={node.type}
            >
              <div className="flex min-w-0 items-center gap-2">
                <button
                  data-role="tree-button"
                  type="button"
                  className="inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
                  onClick={() => {
                    controls?.toggleDirectory(node.path);
                  }}
                >
                  <ExplorerChevronIcon expanded={isExpanded} />
                  <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                  <ExplorerModifiedDot hidden={!isModified} />
                </button>
              </div>
              {isExpanded ? (
                <ExplorerTree
                  changes={changes}
                  controls={controls}
                  currentPath={currentPath}
                  expandedDirectories={expandedDirectories}
                  modifiedPaths={modifiedPaths}
                  nested
                  nodes={node.children}
                />
              ) : null}
            </li>
          );
        }

        const change = describeChange(node.path, changes);
        const isModified = modifiedPaths.has(node.path);
        const isCurrent = node.path === currentPath;

        return (
          <li
            key={`${node.type}:${node.path}`}
            className="m-0 list-none"
            data-path={node.path}
            data-tree-key={`${node.type}:${node.path}`}
            data-tree-type={node.type}
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                data-role="tree-button"
                type="button"
                className={`inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none${isCurrent ? " font-semibold text-accent" : ""}`}
                onClick={() => {
                  void controls?.openFile(node.path);
                }}
              >
                <ExplorerFileSpacer />
                <span data-role="tree-label" className="min-w-0 truncate">{node.name}</span>
                <ExplorerModifiedDot hidden={!isModified} />
                <span
                  data-role="tree-change"
                  hidden={!change}
                  className="shrink-0 text-[0.8rem] text-muted"
                >
                  {change}
                </span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function Workbench () {
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const [controls, setControls] = useState<WorkbenchControls | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => { };

    import("../lib/workbench-client").then(async ({ initWorkbench }) => {
      const nextCleanup = await initWorkbench({
        onExplorerStateChange: (snapshot) => {
          if (cancelled) {
            return;
          }

          startTransition(() => {
            setExplorer(snapshot);
          });
        },
        onControlsReady: (nextControls) => {
          if (cancelled) {
            return;
          }

          setControls(nextControls);
        },
      });

      if (cancelled) {
        nextCleanup?.();
        return;
      }

      cleanup = nextCleanup ?? (() => { });
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const expandedDirectories = new Set(explorer.expandedDirectories);
  const modifiedPaths = new Set(explorer.locallyModifiedPaths);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[minmax(16rem,21rem)_1fr] md:items-start">
      <aside className="flex min-h-0 min-w-0 flex-col px-5 pb-5 md:sticky md:top-0 md:h-screen md:self-start md:px-6 md:py-5">
        <nav
          id="file-tree"
          className="explorer-scrollbar min-h-0 flex-1 overflow-y-auto pb-8 pr-2 text-[0.95rem] leading-6 -ml-3"
          aria-label="Project files"
        >
          <ExplorerTree
            changes={explorer.changes}
            controls={controls}
            currentPath={explorer.currentPath}
            expandedDirectories={expandedDirectories}
            modifiedPaths={modifiedPaths}
            nodes={explorer.tree}
          />
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col px-5 pb-5 md:px-6 md:pb-5">
        <header className="ui-sticky-header sticky top-0 z-10 flex items-end justify-between gap-4 py-3">
          <div className="min-w-0">
            <p id="file-path" className="truncate text-base font-semibold leading-tight">
              Select a file
            </p>
            <p id="status-line" className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted">
              Markdown files open as rich text. Save with Ctrl/Cmd+S.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              id="zoom-out"
              type="button"
              title="Decrease editor text size"
              aria-label="Decrease editor text size"
              className="ui-icon-button"
            >
              <ZoomOutIcon />
              <span className="sr-only">Decrease editor text size</span>
            </button>
            <button
              id="zoom-in"
              type="button"
              title="Increase editor text size"
              aria-label="Increase editor text size"
              className="ui-icon-button"
            >
              <ZoomInIcon />
              <span className="sr-only">Increase editor text size</span>
            </button>
            <button
              id="save-file"
              type="button"
              title="Save current file"
              aria-label="Save current file"
              className="ui-icon-button group"
              data-invalid="false"
            >
              <SaveIcon />
              <span className="sr-only">Save current file</span>
            </button>
          </div>
        </header>

        <div
          id="floating-toolbar"
          className="fixed left-0 top-0 z-30 hidden items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] p-1 shadow-float backdrop-blur-xl"
          hidden
        >
          <button
            data-command="bold"
            type="button"
            title="Bold"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            b
          </button>
          <button
            data-command="italic"
            type="button"
            title="Italic"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            i
          </button>
          <button
            data-command="inline-code"
            type="button"
            title="Inline code"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            code
          </button>
          <button
            data-command="del"
            type="button"
            title="Deleted text"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            del
          </button>
          <button
            data-command="ins"
            type="button"
            title="Inserted text"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ins
          </button>
          <button
            data-command="h1"
            type="button"
            title="Heading 1"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            h1
          </button>
          <button
            data-command="h2"
            type="button"
            title="Heading 2"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            h2
          </button>
          <button
            data-command="unordered-list"
            type="button"
            title="Bullets"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ul
          </button>
          <button
            data-command="ordered-list"
            type="button"
            title="Numbers"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            ol
          </button>
          <button
            data-command="quote"
            type="button"
            title="Quote"
            className="min-w-8 rounded-full px-2 py-1 transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
          >
            &gt;
          </button>
        </div>

        <section className="min-h-0 flex-1">
          <div
            id="editor"
            className="editor-content mx-auto min-h-[calc(100vh-6rem)] max-w-[56rem] pb-16 font-serif text-[1.08rem] leading-[1.72] whitespace-normal outline-none"
            contentEditable
            suppressContentEditableWarning
            spellCheck
            data-placeholder="Select a markdown file to start editing."
          />
        </section>

        <div
          id="save-conflict-dialog"
          hidden
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-conflict-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_74%,transparent)] px-5 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-5 py-4 shadow-float">
            <p className="m-0 text-[0.84rem] tracking-[0.02em] text-muted">Write conflict</p>
            <h2 id="save-conflict-title" className="mt-0.5 text-base font-semibold leading-tight">
              This file changed on disk
            </h2>
            <p id="save-conflict-summary" className="mt-3 text-sm leading-6 text-muted">
              Reload from disk to discard your unsaved editor state, or overwrite anyway to write what is currently in the editor.
            </p>
            <p id="save-conflict-expected" className="mt-3 text-[0.84rem] tracking-[0.02em] text-muted" />
            <p id="save-conflict-actual" className="mt-1 text-[0.84rem] tracking-[0.02em] text-muted" />
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                id="save-conflict-keep-editing"
                type="button"
                className="rounded-xl px-3 py-1.5 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                Keep editing
              </button>
              <button
                id="save-conflict-reload"
                type="button"
                className="rounded-xl px-3 py-1.5 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                Reload from disk
              </button>
              <button
                id="save-conflict-overwrite"
                type="button"
                className="rounded-xl px-3 py-1.5 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              >
                Overwrite anyway
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
