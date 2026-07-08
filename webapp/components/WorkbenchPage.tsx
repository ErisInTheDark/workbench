/*
 * Exports:
 * - default WorkbenchPage: render the client-only Workbench shell with a diagnostic loading fallback. Keywords: workbench, dynamic import, loading fallback, Chrome sockets.
 * - Local helpers: delay and show a socket-pool recovery hint while the Workbench dynamic import is still loading. Keywords: next dynamic, webpack-hmr, net internals.
 */
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const CHROME_SOCKET_POOLS_URL = "chrome://net-internals/#sockets";
const WORKBENCH_LOADING_HINT_DELAY_MS = 1000;

function WorkbenchLoadingFallback() {
  const [showSocketHint, setShowSocketHint] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShowSocketHint(true);
    }, WORKBENCH_LOADING_HINT_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (!showSocketHint) {
    return <div className="min-h-screen" suppressHydrationWarning />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10 text-text" suppressHydrationWarning>
      <section className="max-w-[34rem] space-y-4 text-center">
        <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.22em] text-muted">
          Workbench is loading
        </p>
        <h1 className="m-0 text-[1.55rem] font-semibold tracking-[-0.03em] text-text">
          If this page stays empty, Chrome may have a stuck local socket pool.
        </h1>
        <p className="m-0 text-[0.92rem] leading-6 text-muted">
          If <code className="rounded bg-[color-mix(in_srgb,var(--text)_8%,transparent)] px-1.5 py-0.5 font-mono text-[0.84rem] text-text">webpack-hmr</code> is stalled in DevTools, open Chrome socket internals and flush socket pools.
        </p>
        <p className="m-0 text-[0.92rem] leading-6 text-muted">
          <a className="font-medium text-text underline decoration-[color-mix(in_srgb,var(--text)_28%,transparent)] underline-offset-4 hover:decoration-text" href={CHROME_SOCKET_POOLS_URL}>
            Open Chrome socket internals
          </a>
          <span className="block pt-2 font-mono text-[0.78rem] text-muted">{CHROME_SOCKET_POOLS_URL}</span>
        </p>
      </section>
    </main>
  );
}

const Workbench = dynamic(() => import("./workbench"), {
  ssr: false,
  loading: () => <WorkbenchLoadingFallback />,
});

export default function WorkbenchPage() {
  return <Workbench />;
}
