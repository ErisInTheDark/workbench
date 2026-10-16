/*
 * Exports:
 * - default WorkbenchSvgWorkspace: tabbed svg editors that stay mounted (history, selection) while hidden, with new-file and save-as path prompts.
 */
"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { WorkbenchControls } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import IconButton from "../../ui/IconButton";
import { PlusIcon } from "../workbench-icons";
import type { SvgFileTabs } from "./use-svg-file-tabs";
import WorkbenchSvgEditorView from "./WorkbenchSvgEditorView";
import WorkbenchSvgTabs from "./WorkbenchSvgTabs";

const NEW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
</svg>
`;

type PathPrompt =
  | { kind: "new"; location: ProjectLocationReference | null; path: string }
  | { kind: "save-as"; location: ProjectLocationReference | null; path: string; index: number; content: string; done(): void };

type FileCreatingControls = WorkbenchControls & {
  createTextFile(path: string, content: string, location?: ProjectLocationReference | null): Promise<void>;
};

function canCreateFiles(controls: WorkbenchControls | null): controls is FileCreatingControls {
  return Boolean(controls && "createTextFile" in controls);
}

function directoryOf(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

export default function WorkbenchSvgWorkspace({ controls, tabs }: { controls: WorkbenchControls | null; tabs: SvgFileTabs }) {
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [prompt, setPrompt] = useState<PathPrompt | null>(null);
  const [promptError, setPromptError] = useState("");
  const [creating, setCreating] = useState(false);
  const focused = tabs.tabs[tabs.index];

  const markDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys(current => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt || !canCreateFiles(controls)) return;
    const path = prompt.path.trim().replace(/^\/+/u, "");
    if (!/\.svg$/iu.test(path)) {
      setPromptError("SVG file names end in .svg.");
      return;
    }
    setCreating(true);
    setPromptError("");
    try {
      await controls.createTextFile(path, prompt.kind === "new" ? NEW_SVG : prompt.content, prompt.location);
      if (prompt.kind === "new") tabs.open(prompt.location, path);
      else {
        prompt.done();
        tabs.replace(prompt.index, prompt.location, path);
      }
      setPrompt(null);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "The file could not be created.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-1rem)] min-w-0 flex-col md:h-dvh">
      <header className="flex items-center gap-2 pt-3">
        <WorkbenchSvgTabs dirtyKeys={dirtyKeys} index={tabs.index} onClose={tabs.close} onSelect={tabs.select} tabs={tabs.tabs} />
        <IconButton label="New SVG file" display="hover-border" disabled={!canCreateFiles(controls)}
          onClick={() => {
            setPromptError("");
            setPrompt({ kind: "new", location: focused?.location ?? null, path: `${directoryOf(focused?.tab.filePath ?? "")}untitled.svg` });
          }}>
          <PlusIcon size={18} />
        </IconButton>
      </header>
      {prompt ? (
        <form className="flex flex-wrap items-center gap-2 py-2 text-[0.84rem]" onSubmit={event => { void submit(event); }}>
          <label className="text-fg/muted" htmlFor="svg-path-prompt">{prompt.kind === "new" ? "New file" : "Save as"}</label>
          <input
            id="svg-path-prompt"
            autoFocus
            className="min-w-[16rem] flex-1 rounded-lg bg-fg/5 px-2.5 py-1.5 font-mono text-[0.82rem] text-text outline-none focus:bg-fg/8"
            disabled={creating}
            onChange={event => setPrompt({ ...prompt, path: event.target.value })}
            onFocus={event => {
              const name = event.target.value.lastIndexOf("/") + 1;
              event.target.setSelectionRange(name, event.target.value.replace(/\.svg$/iu, "").length);
            }}
            onKeyDown={event => { if (event.key === "Escape") setPrompt(null); }}
            value={prompt.path}
          />
          <button type="submit" disabled={creating} className="rounded-lg px-2.5 py-1.5 text-accent hover:bg-accent-soft disabled:opacity-50">
            {prompt.kind === "new" ? "Create" : "Save"}
          </button>
          <button type="button" className="rounded-lg px-2.5 py-1.5 text-fg/muted hover:bg-fg/5" onClick={() => setPrompt(null)}>Cancel</button>
          {promptError ? <p role="alert" className="m-0 w-full text-danger">{promptError}</p> : null}
        </form>
      ) : null}
      {tabs.tabs.map((item, position) => (
        <div key={item.key} className="flex min-h-0 flex-1 flex-col" hidden={position !== tabs.index}>
          <WorkbenchSvgEditorView
            active={position === tabs.index}
            controls={controls}
            embedded
            location={item.location}
            onDirtyChange={dirty => markDirty(item.key, dirty)}
            onSaveAs={canCreateFiles(controls) ? (content, done) => {
              setPromptError("");
              setPrompt({ kind: "save-as", location: item.location, path: item.tab.filePath, index: position, content, done });
            } : undefined}
            path={item.tab.filePath}
          />
        </div>
      ))}
    </div>
  );
}
