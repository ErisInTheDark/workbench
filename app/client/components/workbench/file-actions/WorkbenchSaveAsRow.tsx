/*
 * Exports:
 * - default WorkbenchSaveAsRow: the path row both file editors show for Save as; it writes the content to a new file
 *   (creating missing folders on the way) and never overwrites one that exists.
 */
"use client";

import { useRef, useState, type FormEvent } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchClientController } from "../workbench-client-context";
import { CheckIcon, XIcon } from "../workbench-icons";

function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export default function WorkbenchSaveAsRow({ initialPath, location, onCancel, onWritten, readContent }: {
  /** The current file's path; the copy keeps its extension. */
  initialPath: string;
  location: ProjectLocationReference | null;
  onCancel: () => void;
  /** The copy exists at `path`; hand the editor's draft over to it. */
  onWritten: (path: string) => Promise<void>;
  readContent: () => string;
}) {
  const controls = useWorkbenchClientController().mounted?.controls ?? null;
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const extension = extensionOf(initialPath);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = path.trim().replace(/^\/+/u, "");
    if (!controls || saving) return;
    if (extension && extensionOf(target) !== extension) {
      setError(`The new name must end in ${extension}.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await controls.createTextFile(target, readContent(), location);
      await onWritten(target);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The file could not be created.");
      setSaving(false);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 py-2"
      onKeyDown={event => {
        if (event.key !== "Escape" || saving) return;
        event.preventDefault();
        onCancel();
      }}
      onSubmit={event => { void submit(event); }}
    >
      {/* Read-only rather than disabled while writing, so a refused name keeps focus for the retry. */}
      <input
        ref={inputRef}
        aria-label="Save as"
        autoFocus
        className="min-w-[8rem] flex-1 rounded-lg bg-fg/5 px-2.5 py-1.5 font-mono text-[0.82rem] text-text outline-none focus:bg-fg/8"
        readOnly={saving}
        onChange={event => setPath(event.target.value)}
        onFocus={event => {
          const value = event.target.value;
          const start = value.lastIndexOf("/") + 1;
          event.target.setSelectionRange(start, extension && value.toLowerCase().endsWith(extension)
            ? value.length - extension.length : value.length);
        }}
        spellCheck={false}
        value={path}
      />
      <PrimaryButton type="submit" shape="compact" disabled={saving || !controls} pendingHalo={saving}>
        <CheckIcon size={14} className="mr-1.5 shrink-0" />Save
      </PrimaryButton>
      <PrimaryButton type="button" shape="compact" disabled={saving} onClick={onCancel}>
        <XIcon size={14} className="mr-1.5 shrink-0" />Cancel
      </PrimaryButton>
      {error ? <p role="alert" className="m-0 w-full text-[0.84rem] text-danger">{error}</p> : null}
    </form>
  );
}
