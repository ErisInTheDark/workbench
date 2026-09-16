/*
 * Exports:
 * - default AgentThreadViewer: show a chrome-free WB SQL thread view.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import StandaloneThreadController from "../../../workbench/transcript/StandaloneThreadController";
import ThreadTextPresentationContext from "../ThreadTextPresentationContext";
import ThreadRenderSurface from "./ThreadRenderSurface";

function normalizeThreadId(value: string | null | undefined) {
  return value?.trim() ?? "";
}

const emptySubscribe = () => () => undefined;
const emptySnapshot = () => null;

function SqlThreadViewer({ threadId }: { threadId: string }) {
  const [controller, setController] = useState<StandaloneThreadController | null>(null);
  useEffect(() => {
    const owner = new StandaloneThreadController(threadId);
    setController(owner);
    void owner.refresh();
    return () => owner.dispose();
  }, [threadId]);
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const source = state?.source;
  const projection = source?.status === "ready" || source?.status === "loading" ? source.projection : null;
  const error = state?.error ?? (source?.status === "failed" ? source.message : null);
  return (
    <ThreadTextPresentationContext value={controller?.text ?? null}>
      {error ? (
        <div role="alert" className="mx-auto max-w-content px-5 pt-5 text-danger md:px-6">
          <p>{error}</p>
          <button type="button" className="rounded px-2 py-1 hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" onClick={() => void controller?.refresh()}>Retry</button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1"><ThreadRenderSurface
        thread={state?.thread}
        emptyMessage={error ? "" : source?.status === "unavailable"
          ? "Waiting for the transcript connection..."
          : source?.status === "absent" ? "No thread activity was captured yet." : "Loading thread..."}
        sql={{
          projection,
          loading: state?.loading ?? true,
          canLoadPrevious: state?.nextCursor != null,
          loadPrevious: () => { void controller?.loadPrevious(); },
        }}
      /></div>
    </ThreadTextPresentationContext>
  );
}

export default function AgentThreadViewer({
  initialThreadId = "",
}: {
  initialThreadId?: string;
}) {
  const [locationSearch, setLocationSearch] = useState("");
  const [locationPathname, setLocationPathname] = useState("");

  useEffect(() => {
    setLocationPathname(window.location.pathname);
    setLocationSearch(window.location.search);
  }, []);

  const locationOptions = useMemo(() => {
    const searchParams = new URLSearchParams(locationSearch);
    const pathThreadId = locationPathname.match(/\/agent\/thread\/([^/?#]+)/)?.[1];
    return {
      threadId: normalizeThreadId(initialThreadId)
        || normalizeThreadId(pathThreadId ? decodeURIComponent(pathThreadId) : "")
        || normalizeThreadId(searchParams.get("threadId")),
    };
  }, [initialThreadId, locationPathname, locationSearch]);

  return (
    <main className="flex h-dvh min-h-0 flex-col bg-bg text-text">
      <nav className="flex shrink-0 items-center gap-3 px-5 py-2 text-sm text-fg/muted">
        <span>Captured thread viewer</span>
        <a href="/agent/thread-lab" className="rounded px-2 py-1 hover:bg-fg-7 hover:text-text">Thread render lab</a>
      </nav>
      {!locationOptions.threadId ? (
        <div className="mx-auto flex min-h-0 flex-1 max-w-[42rem] items-center px-5 py-8 md:px-6">
          <p className="m-0 text-[0.92rem] leading-6 text-fg/muted">
            Add a thread id to the URL, such as <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread/&lt;threadId&gt;</code> or <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread?threadId=&lt;threadId&gt;</code>.
          </p>
        </div>
      ) : (
        <SqlThreadViewer key={locationOptions.threadId} threadId={locationOptions.threadId} />
      )}
    </main>
  );
}
