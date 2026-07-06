/*
 * Exports:
 * - default AgentThreadViewer: read and poll one thread from the app-server bridge in a chrome-free page. Keywords: agent thread, standalone, thread/read.
 * - Local helpers: resolve URL inputs, classify active status, and read ThreadPayloads through CodexAppServerClient. Keywords: thread id, harness, polling.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import { CodexAppServerClient } from "../../../lib/codex/app-server-client";
import type { ThreadReadResponse } from "../../../lib/codex/generated/app-server/v2/ThreadReadResponse";
import { isCodexJsonRpcFailure } from "../../../lib/codex/protocol";
import { toThreadPayload } from "../../../lib/codex/thread-adapter";
import type { ThreadPayload, WorkbenchBrowseScreenshotEntry, WorkbenchHarness } from "../../../lib/types";
import ThreadRenderSurface from "./ThreadRenderSurface";

const ACTIVE_THREAD_REFRESH_INTERVAL_MS = 1500;
const IDLE_THREAD_REFRESH_INTERVAL_MS = 5000;

type AgentThreadViewerStatus = "idle" | "loading" | "ready" | "failed";

function normalizeThreadId(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function normalizeHarness(value: string | null | undefined): WorkbenchHarness {
  return value === "copilot" || value === "opencode" ? value : "codex";
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
  const response = await client.sendRequest<ThreadReadResponse>({
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

  const payload = toThreadPayload(response.result.thread, harness);
  if (harness !== "codex") {
    return payload;
  }

  const screenshotResponse = await client.sendRequest<{ data?: WorkbenchBrowseScreenshotEntry[] }>({
    method: "browse/screenshot/list",
    params: {
      threadId,
    },
    workbenchHarness: harness,
  }).catch(() => null);
  if (!screenshotResponse || isCodexJsonRpcFailure(screenshotResponse)) {
    return payload;
  }

  return {
    ...payload,
    browseScreenshotEntries: screenshotResponse.result.data ?? [],
  };
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
          <p className="m-0 text-[0.92rem] leading-6 text-muted">
            Add a thread id to the URL, such as <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread/&lt;threadId&gt;</code> or <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">/agent/thread?threadId=&lt;threadId&gt;</code>.
          </p>
        </div>
      ) : (
        <>
          {status === "failed" ? (
            <div className="mx-auto max-w-[56rem] px-5 pt-5 md:px-6">
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
