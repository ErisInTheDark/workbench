/*
 * Exports:
 * - default ThreadRenderLab: paste JSON thread data and render it through the Workbench transcript renderer. Keywords: command matcher, render lab, thread item.
 * - Local helpers: build the hydrated Browse command sample shown in the lab editor. Keywords: sample, browser, commandExecution, fixture.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import ThreadRenderSurface from "./ThreadRenderSurface";
import { parseThreadRenderInput } from "./thread-render-lab-input";

function buildSampleThreadItemsText({
  threadLabUrl = "http://localhost:<workbench-port>/agent/thread-lab",
}: {
  threadLabUrl?: string;
} = {}) {
  return JSON.stringify([
  {
    command: `wb browse run --thread thread-lab-sample --session thread-lab-check --summary "verify hydrated lab renders pasted command items" --command "stop --force" --command "open ${threadLabUrl} --headless" --command "wait timeout 3000" --command "eval document.body.innerText.slice(0, 200)"`,
    cwd: "c:/git/web/workbench",
    status: "inProgress",
    aggregatedOutput: [
      JSON.stringify({ startedAt: 1760000000000, summary: "verify hydrated lab renders pasted command items", totalActions: 4, type: "browse-sequence-start" }),
      JSON.stringify({ action: "stop", index: 0, result: { action: "stop", durationMs: 120, exitCode: 0, ok: true, stderr: "", stdout: "" }, type: "browse-action-complete" }),
      JSON.stringify({ action: "open", index: 1, result: { action: "open", durationMs: 1010, exitCode: 0, ok: true, stderr: "", stdout: JSON.stringify({ title: "Workbench", url: threadLabUrl }, null, 2) }, type: "browse-action-complete" }),
      JSON.stringify({ action: "wait", index: 2, session: "thread-lab-check", startedAt: 1760000001130, type: "browse-action-start" }),
    ].join("\n"),
  },
  {
    command: `wb browse run --thread thread-lab-sample --session thread-lab-check --summary "verify hydrated lab renders pasted command items" --command "open ${threadLabUrl} --headless" --command "wait timeout 3000" --command "eval document.body.innerText.slice(0, 200)"`,
    cwd: "c:/git/web/workbench",
    durationMs: 8920,
    aggregatedOutput: [
      JSON.stringify({ startedAt: 1760000000000, summary: "verify hydrated lab renders pasted command items", totalActions: 3, type: "browse-sequence-start" }),
      JSON.stringify({ action: "open", index: 0, session: "thread-lab-check", startedAt: 1760000000001, type: "browse-action-start" }),
      JSON.stringify({ action: "open", index: 0, result: { action: "open", args: ["open", threadLabUrl, "--session", "thread-lab-check", "--local", "--headless"], durationMs: 1810, exitCode: 0, ok: true, stderr: "", stdout: JSON.stringify({ title: "Workbench", url: threadLabUrl }, null, 2) }, type: "browse-action-complete" }),
      JSON.stringify({ action: "wait", index: 1, session: "thread-lab-check", startedAt: 1760000001812, type: "browse-action-start" }),
      JSON.stringify({ action: "wait", index: 1, result: { action: "wait", args: ["wait", "timeout", "3000", "--session", "thread-lab-check", "--local"], durationMs: 3005, exitCode: 0, ok: true, stderr: "", stdout: JSON.stringify({ waited: true }, null, 2) }, type: "browse-action-complete" }),
      JSON.stringify({ action: "eval", index: 2, session: "thread-lab-check", startedAt: 1760000004819, type: "browse-action-start" }),
      JSON.stringify({ action: "eval", index: 2, result: { action: "eval", args: ["eval", "document.body.innerText.slice(0, 200)", "--session", "thread-lab-check", "--local"], durationMs: 420, exitCode: 0, ok: true, stderr: "", stdout: JSON.stringify({ result: "Thread render lab\\n\\nPaste a full thread payload, a { thread } response..." }, null, 2) }, type: "browse-action-complete" }),
      JSON.stringify({ durationMs: 8920, ok: true, results: [], stoppedAtIndex: null, type: "browse-sequence-complete" }),
    ].join("\n"),
  },
  ], null, 2);
}

function buildThreadLabSampleRoutes() {
  if (typeof window === "undefined") {
    return {};
  }

  const threadLabUrl = new URL("/agent/thread-lab", window.location.href);
  threadLabUrl.hostname = "localhost";
  return {
    threadLabUrl: threadLabUrl.toString(),
  };
}

export default function ThreadRenderLab() {
  const [inputText, setInputText] = useState(() => buildSampleThreadItemsText());
  const [hasMounted, setHasMounted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sampleText = useMemo(() => buildSampleThreadItemsText(buildThreadLabSampleRoutes()), [hasMounted]);
  const parsedInput = useMemo(() => parseThreadRenderInput(inputText), [inputText]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    setInputText((currentText) => currentText === buildSampleThreadItemsText() ? sampleText : currentText);
  }, [sampleText]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const handleInput = () => {
      setInputText(textarea.value);
    };
    textarea.addEventListener("input", handleInput);
    return () => {
      textarea.removeEventListener("input", handleInput);
    };
  }, []);

  return (
    <main className="min-h-dvh bg-bg text-text">
      <div className="mx-auto grid min-h-dvh w-full max-w-[92rem] grid-rows-[auto_1fr] gap-4 px-4 py-4 md:px-6 md:py-6">
        <header className="space-y-1">
          <h1 className="m-0 text-[1.15rem] font-semibold tracking-tight">Thread render lab</h1>
          <p className="m-0 max-w-[62rem] text-[0.86rem] leading-6 text-muted">
            Paste a full thread payload, a <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">{"{ thread }"}</code> response, a turn, an array of thread items, command strings, or simplified command objects to test the real transcript renderer and command matcher display.
          </p>
        </header>
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(20rem,0.78fr)_minmax(0,1.22fr)]">
          <section className="flex min-h-[18rem] flex-col rounded-[1.2rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="m-0 text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-muted">Input JSON</p>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-[0.78rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                onClick={() => {
                  setInputText(sampleText);
                }}
              >
                Reset sample
              </button>
            </div>
            <textarea
              ref={textareaRef}
              className="explorer-scrollbar min-h-0 flex-1 resize-none bg-transparent px-4 pb-4 font-mono text-[0.78rem] leading-6 text-text outline-none placeholder:text-muted"
              data-thread-render-lab-hydrated={hasMounted ? "true" : "false"}
              spellCheck={false}
              value={inputText}
              onInput={(event) => {
                setInputText(event.currentTarget.value);
              }}
            />
          </section>
          <section className="explorer-scrollbar min-h-[24rem] overflow-y-auto rounded-[1.2rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]">
            {parsedInput.error ? (
              <p className="m-0 px-5 py-4 text-[0.9rem] leading-6 text-danger">{parsedInput.error}</p>
            ) : (
              <ThreadRenderSurface
                className="px-4 py-4 md:px-5"
                emptyMessage="Paste thread items to render them here."
                flattenCompletedWork
                thread={parsedInput.thread}
              />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
