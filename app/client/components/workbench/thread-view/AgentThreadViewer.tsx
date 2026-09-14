/*
 * Exports:
 * - default AgentThreadViewer: show a chrome-free SQL Codex view or another provider's existing projection.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import { CodexAppServerClient } from "workbench-shared/codex/app-server-client";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { WorkbenchThreadResponse } from "workbench-shared/workbench/thread/workbench-thread-identity";
import { isCodexJsonRpcFailure } from "workbench-shared/codex/protocol";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import type { ThreadPayload, WorkbenchHarness } from "workbench-shared/types";
import StandaloneThreadController from "../../../workbench/transcript/StandaloneThreadController";
import ThreadTextPresentationContext from "../ThreadTextPresentationContext";
import ThreadRenderSurface from "./ThreadRenderSurface";

const ACTIVE_THREAD_REFRESH_INTERVAL_MS = 1500;
const IDLE_THREAD_REFRESH_INTERVAL_MS = 5000;

type AgentThreadViewerStatus = "idle" | "loading" | "ready" | "failed";

function normalizeThreadId(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function normalizeHarness(value: string | null | undefined): WorkbenchHarness {
  return ProviderKeySchema.parse(value ?? "codex");
}

function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

async function readStandaloneThreadPayload(
  client: CodexAppServerClient,
  threadId: string,
  harness: WorkbenchHarness,
) {
  await client.connect();
  const response = await client.sendRequest<WorkbenchThreadResponse<ThreadReadResponse>>({
    method: "thread/read",
    params: {
      includeTurns: true,
      threadId,
    },
    workbenchHarness: harness,
    workbenchThreadHydration: { mode: "legacyFull" },
  });

  if (isCodexJsonRpcFailure(response)) {
    const detail = response.error.data ? ` ${JSON.stringify(response.error.data)}` : "";
    throw new Error(`${response.error.message}${detail}`);
  }

  return toThreadPayload(response.result.thread, harness);
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
      <ThreadRenderSurface
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
      />
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
  const [thread, setThread] = useState<ThreadPayload | null>(null);
  const [status, setStatus] = useState<AgentThreadViewerStatus>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setLocationPathname(window.location.pathname);
    setLocationSearch(window.location.search);
  }, []);

  const locationOptions = useMemo(() => {
    const searchParams = new URLSearchParams(locationSearch);
    const pathThreadId = locationPathname.match(/\/agent\/thread\/([^/?#]+)/)?.[1];
    return {
      harness: normalizeHarness(searchParams.get("harness")),
      threadId: normalizeThreadId(initialThreadId)
        || normalizeThreadId(pathThreadId ? decodeURIComponent(pathThreadId) : "")
        || normalizeThreadId(searchParams.get("threadId")),
    };
  }, [initialThreadId, locationPathname, locationSearch]);

  useEffect(() => {
    if (locationOptions.harness === "codex") return;
    if (!locationOptions.threadId) {
      setThread(null);
      setStatus("idle");
      setError("");
      return;
    }

    const client = new CodexAppServerClient();
    let cancelled = false;
    let timeoutId: number | null = null;

    async function loadThread() {
      setStatus((currentStatus) => currentStatus === "ready" ? currentStatus : "loading");
      try {
        const nextThread = await readStandaloneThreadPayload(client, locationOptions.threadId, locationOptions.harness);
        if (cancelled) {
          return;
        }

        setThread(nextThread);
        setError("");
        setStatus("ready");
        timeoutId = window.setTimeout(
          () => {
            void loadThread();
          },
          isThreadStatusActive(nextThread.status) ? ACTIVE_THREAD_REFRESH_INTERVAL_MS : IDLE_THREAD_REFRESH_INTERVAL_MS,
        );
      } catch (readError) {
        if (cancelled) {
          return;
        }

        setError(readError instanceof Error ? readError.message : "Unable to read thread.");
        setStatus("failed");
        timeoutId = window.setTimeout(() => {
          void loadThread();
        }, IDLE_THREAD_REFRESH_INTERVAL_MS);
      }
    }

    void loadThread();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      client.close();
    };
  }, [locationOptions.harness, locationOptions.threadId]);

  return (
    <main className="min-h-dvh bg-bg text-text">
      {!locationOptions.threadId ? (
        <div className="mx-auto flex min-h-dvh max-w-[42rem] items-center px-5 py-8 md:px-6">
          <p className="m-0 text-[0.92rem] leading-6 text-fg/muted">
            Add a thread id to the URL, such as <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread/&lt;threadId&gt;</code> or <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread?threadId=&lt;threadId&gt;</code>.
          </p>
        </div>
      ) : locationOptions.harness === "codex" ? (
        <SqlThreadViewer key={locationOptions.threadId} threadId={locationOptions.threadId} />
      ) : (
        <>
          {status === "failed" ? (
            <div className="mx-auto max-w-content px-5 pt-5 md:px-6">
              <p className="m-0 rounded-[0.9rem] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-4 py-3 text-[0.86rem] leading-6 text-danger">
                {error || "Unable to read thread."}
              </p>
            </div>
          ) : null}
          <ThreadRenderSurface
            emptyMessage={status === "loading" ? "Loading thread..." : "No thread activity was captured yet."}
            thread={thread}
          />
        </>
      )}
    </main>
  );
}
