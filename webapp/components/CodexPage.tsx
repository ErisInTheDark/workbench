"use client";

import { useEffect, useState } from "react";

import {
  CODEX_CLIENT_INFO,
  getCodexAppServerUrl,
} from "../lib/codex/config";
import {
  createBootstrapMessages,
  createTextInput,
  createThreadStartRequest,
  createTurnStartRequest,
} from "../lib/codex/protocol";

interface CodexReadyStatus {
  detail: string;
  ok: boolean;
  phase: "connect" | "initialize" | "ready";
  status: number | null;
  statusText: string;
  url: string;
}

const sampleBootstrap = createBootstrapMessages();
const sampleThreadStart = createThreadStartRequest(1);
const sampleTurnStart = createTurnStartRequest(
  2,
  "thread-id",
  [createTextInput("Summarize the active chapter notes.")],
);

export default function CodexPage() {
  const [readyStatus, setReadyStatus] = useState<CodexReadyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadReadyStatus() {
      setLoading(true);

      try {
        const response = await fetch("/api/codex/ready", {
          cache: "no-store",
        });
        const payload = await response.json() as CodexReadyStatus;
        if (active) {
          setReadyStatus(payload);
        }
      } catch (error) {
        if (active) {
          setReadyStatus({
            detail: error instanceof Error ? error.message : "Unknown error",
            ok: false,
            phase: "connect",
            status: null,
            statusText: error instanceof Error ? error.message : "Unknown error",
            url: getCodexAppServerUrl(),
          });
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadReadyStatus();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-5 py-8 text-sm md:px-8">
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-[0.24em] text-muted">Codex view</p>
        <h1 className="text-3xl font-semibold tracking-tight text-text">App-server scaffold</h1>
        <p className="max-w-2xl text-sm leading-7 text-muted">
          This is the initial typed framework for a Codex-backed view. The local app-server is
          orchestrated alongside Next.js, and this route is where a richer in-browser Codex client
          can grow next.
        </p>
      </div>

      <section className="mt-10 grid gap-8 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-8">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-text">Local transport</h2>
            <p className="font-mono text-xs leading-6 text-muted">{getCodexAppServerUrl()}</p>
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-text">Typed bootstrap helpers</h2>
            <pre className="overflow-x-auto rounded-xl bg-bg-soft p-4 text-xs leading-6 text-text">
              <code>{JSON.stringify(sampleBootstrap, null, 2)}</code>
            </pre>
            <pre className="overflow-x-auto rounded-xl bg-bg-soft p-4 text-xs leading-6 text-text">
              <code>{JSON.stringify(sampleThreadStart, null, 2)}</code>
            </pre>
            <pre className="overflow-x-auto rounded-xl bg-bg-soft p-4 text-xs leading-6 text-text">
              <code>{JSON.stringify(sampleTurnStart, null, 2)}</code>
            </pre>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl bg-bg-soft p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-muted">Health</p>
            <p className="mt-3 text-sm leading-7 text-text">
              {loading
                ? "Checking local app-server readiness..."
                : readyStatus?.ok
                  ? "App-server ready."
                  : "App-server not ready yet."}
            </p>
            {readyStatus ? (
              <div className="mt-2 space-y-1 text-xs leading-6 text-muted">
                <p>{readyStatus.status ?? "ERR"} {readyStatus.statusText}</p>
                <p>{readyStatus.phase} Â· {readyStatus.url}</p>
                <p>{readyStatus.detail}</p>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl bg-bg-soft p-4">
            <p className="text-xs uppercase tracking-[0.24em] text-muted">Client identity</p>
            <p className="mt-3 text-sm leading-7 text-text">{CODEX_CLIENT_INFO.title}</p>
            <p className="text-xs leading-6 text-muted">
              {CODEX_CLIENT_INFO.name} v{CODEX_CLIENT_INFO.version}
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
