/*
 * Exports:
 * - default WorkbenchEnvironmentFile: lazy disclosure editing one env file with highlighting, dirty marker, ctrl+s, save and discard.
 */
"use client";

import { useMemo } from "react";
import type EnvironmentFilesController from "../../../workbench/environment/EnvironmentFilesController";
import type { EnvironmentFileState } from "../../../workbench/environment/EnvironmentFilesController";
import { envHighlightClassName, tokenizeEnv } from "../../../workbench/environment/env-highlights";
import ChevronIcon from "../ChevronIcon";
import PlaintextEditable from "../thread-view/PlaintextEditable";
import { ResetIcon, SaveIcon } from "../workbench-icons";
import IconButton from "../../ui/IconButton";

const editorClassName = `
  block min-h-[4lh] whitespace-pre-wrap wrap-anywhere px-3 py-2 font-mono text-[0.82rem] leading-5 outline-none
  data-[empty=true]:before:(content-[attr(data-placeholder)] pointer-events-none text-fg/muted)
`;

export default function WorkbenchEnvironmentFile({
  controller,
  file,
  savedStoreKeys,
}: {
  controller: EnvironmentFilesController;
  file: EnvironmentFileState;
  savedStoreKeys: ReadonlySet<string> | null;
}) {
  const highlights = useMemo(() => tokenizeEnv(file.content, savedStoreKeys)
    .map(token => ({ start: token.start, end: token.end, className: envHighlightClassName(token.kind) })), [file.content, savedStoreKeys]);
  const busy = file.status === "saving";
  return (
    <details className="group/env-file" onToggle={event => { if (event.currentTarget.open) void controller.open(file.path); }}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-[0.83rem] text-text hover:bg-fg/5 [&::-webkit-details-marker]:hidden">
        <ChevronIcon size={14} className="shrink-0 -rotate-90 text-fg/muted transition-transform group-open/env-file:rotate-0 motion-reduce:transition-none" />
        <span className="min-w-0 truncate font-mono">{file.path}</span>
        {file.dirty ? <span aria-label="Unsaved changes" title="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
      </summary>
      <div className="ml-5 mt-1 space-y-2 pb-2">
        {file.status === "loading" || file.status === "idle" ? <p role="status" className="m-0 text-xs text-fg/muted">Loading...</p> : null}
        {file.status === "failed" ? <div className="flex items-center gap-2">
          <p role="alert" className="m-0 text-xs text-danger">{file.error}</p>
          <button type="button" className="rounded-lg px-2 py-1 text-xs text-accent hover:bg-accent-soft"
            onClick={() => { void controller.open(file.path); }}>Retry</button>
        </div> : null}
        {file.status === "ready" || file.status === "saving" ? <>
          <div className="rounded-[0.8rem] border border-text/16 bg-text/[0.03] focus-within:bg-text/[0.06]">
            <PlaintextEditable
              ariaLabel={`${file.path} contents`}
              className={editorClassName}
              highlightText
              highlights={highlights}
              onChange={value => controller.edit(file.path, value)}
              onKeyDown={event => {
                if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void controller.save(file.path);
                }
              }}
              placeholder="KEY=value"
              value={file.content}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <IconButton type="button" label={`Save ${file.path}`} display="hover-border" size="small"
              disabled={!file.dirty || busy} pendingHalo={busy} onClick={() => { void controller.save(file.path); }}>
              <SaveIcon size={16} />
            </IconButton>
            <IconButton type="button" label={`Discard unsaved changes to ${file.path}`} display="hover-border" size="small"
              tone="danger" disabled={!file.dirty || busy} onClick={() => { void controller.discard(file.path); }}>
              <ResetIcon size={16} />
            </IconButton>
            {file.error ? <p role="alert" className="m-0 text-xs text-danger">{file.error}</p> : null}
          </div>
        </> : null}
      </div>
    </details>
  );
}
