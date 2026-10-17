/*
 * Exports:
 * - NEW_SVG_SOURCE: the empty icon-sized drawing a new svg file starts as.
 * - canCreateTextFiles: whether the mounted controls can write a new text file directly.
 * - default WorkbenchSvgFileView: one svg file's editor in the main pane, with the save-as path prompt that moves its tab to the copy.
 */
"use client";

import { useState, type FormEvent } from "react";
import type { WorkbenchControls } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import WorkbenchSvgEditorView from "./WorkbenchSvgEditorView";

export const NEW_SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
</svg>
`;

type FileCreatingControls = WorkbenchControls & {
  createTextFile(path: string, content: string, location?: ProjectLocationReference | null): Promise<void>;
};

export function canCreateTextFiles(controls: WorkbenchControls | null): controls is FileCreatingControls {
  return Boolean(controls && "createTextFile" in controls);
}

interface SaveAsPrompt {
  content: string;
  done(): void;
  path: string;
}

export default function WorkbenchSvgFileView({ controls, location, onOpenCopy, path }: {
  controls: WorkbenchControls | null;
  location: ProjectLocationReference | null;
  /** Show the written copy in place of this file. */
  onOpenCopy: (path: string) => void;
  path: string;
}) {
  const [prompt, setPrompt] = useState<SaveAsPrompt | null>(null);
  const [promptError, setPromptError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt || !canCreateTextFiles(controls)) return;
    const nextPath = prompt.path.trim().replace(/^\/+/u, "");
    if (!/\.svg$/iu.test(nextPath)) {
      setPromptError("SVG file names end in .svg.");
      return;
    }
    setSaving(true);
    setPromptError("");
    try {
      await controls.createTextFile(nextPath, prompt.content, location);
      prompt.done();
      setPrompt(null);
      onOpenCopy(nextPath);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : "The file could not be created.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:h-full">
      {prompt ? (
        <form className="flex flex-wrap items-center gap-2 py-2 text-[0.84rem]" onSubmit={event => { void submit(event); }}>
          <label className="text-fg/muted" htmlFor="svg-save-as-path">Save as</label>
          <input
            id="svg-save-as-path"
            autoFocus
            className="min-w-[16rem] flex-1 rounded-lg bg-fg/5 px-2.5 py-1.5 font-mono text-[0.82rem] text-text outline-none focus:bg-fg/8"
            disabled={saving}
            onChange={event => setPrompt({ ...prompt, path: event.target.value })}
            onFocus={event => {
              const name = event.target.value.lastIndexOf("/") + 1;
              event.target.setSelectionRange(name, event.target.value.replace(/\.svg$/iu, "").length);
            }}
            onKeyDown={event => { if (event.key === "Escape") setPrompt(null); }}
            value={prompt.path}
          />
          <button type="submit" disabled={saving} className="rounded-lg px-2.5 py-1.5 text-accent hover:bg-accent-soft disabled:opacity-50">
            Save
          </button>
          <button type="button" className="rounded-lg px-2.5 py-1.5 text-fg/muted hover:bg-fg/5" onClick={() => setPrompt(null)}>Cancel</button>
          {promptError ? <p role="alert" className="m-0 w-full text-danger">{promptError}</p> : null}
        </form>
      ) : null}
      <WorkbenchSvgEditorView
        key={path}
        controls={controls}
        location={location}
        onSaveAs={canCreateTextFiles(controls) ? (content, done) => {
          setPromptError("");
          setPrompt({ content, done, path });
        } : undefined}
        path={path}
      />
    </div>
  );
}
