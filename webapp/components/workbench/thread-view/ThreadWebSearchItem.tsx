/*
 * Exports:
 * - ThreadWebSearchOutput: optional enriched display data for future web search result rendering. Keywords: workbench, thread, web search, output.
 * - default ThreadWebSearchItem: render Codex web search actions inside thread history. Keywords: workbench, thread, web search.
 * - Local helpers: format web search summaries, queries, URLs, and optional output sections. Keywords: search query, external URL, result.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";
import { truncateThreadText } from "./thread-view-primitives";

type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

export interface ThreadWebSearchOutput {
  sources: Array<{
    snippet?: string | null;
    title?: string | null;
    url?: string | null;
  }>;
  status: string | null;
  text: string;
}

const JSON_BLOCK_CLASS = "m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text";
const INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.78em] leading-[1.6] text-text";

function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function getSearchQueries(item: WebSearchItem) {
  if (item.action?.type === "search") {
    return uniqueNonEmptyStrings([
      item.action.query,
      ...(item.action.queries ?? []),
      item.query,
    ]);
  }

  return uniqueNonEmptyStrings([item.query]);
}

function formatUrlLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const path = `${parsedUrl.pathname}${parsedUrl.search}`.replace(/\/$/, "");
    return truncateThreadText(`${parsedUrl.host}${path || ""}`, 96);
  } catch {
    return truncateThreadText(url, 96);
  }
}

function getWebSearchSummary(item: WebSearchItem): ReactNode {
  const action = item.action;

  if (action?.type === "search") {
    const queries = getSearchQueries(item);
    if (queries.length > 1) {
      return (
        <>
          <span>Searched web: </span>
          <span className="font-medium text-text">{queries.length} queries</span>
        </>
      );
    }

    return (
      <>
        <span>Searched web: </span>
        <span className="font-medium text-text">{truncateThreadText(queries[0] ?? "search", 96)}</span>
      </>
    );
  }

  if (action?.type === "openPage" && isNonEmptyString(action.url)) {
    return (
      <>
        <span>Opened page: </span>
        <span className="font-medium text-text">{formatUrlLabel(action.url)}</span>
      </>
    );
  }

  if (action?.type === "findInPage") {
    return (
      <>
        <span>Searched page: </span>
        <span className="font-medium text-text">{truncateThreadText(action.pattern?.trim() || item.query || "page", 96)}</span>
      </>
    );
  }

  if (isNonEmptyString(item.query)) {
    return (
      <>
        <span>Used web search: </span>
        <span className="font-medium text-text">{truncateThreadText(item.query, 96)}</span>
      </>
    );
  }

  return <ThreadSummaryText text="Used web search" />;
}

function ThreadExternalUrl ({
  url,
}: {
  url: string;
}) {
  return (
    <a
      className="break-all text-accent underline-offset-3 hover:underline focus-visible:underline focus-visible:outline-none"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {formatUrlLabel(url)}
    </a>
  );
}

function ThreadDetailLine ({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
      <span>{label}</span>
      <span className="min-w-0 text-text">{value}</span>
    </p>
  );
}

function ThreadQueriesList ({
  queries,
}: {
  queries: string[];
}) {
  if (!queries.length) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">
        {queries.length === 1 ? "Query" : "Queries"}
      </p>
      <ul className="m-0 space-y-1 pl-4 text-[0.84em] leading-[1.6] text-text">
        {queries.map((query) => (
          <li key={query} className="break-words">
            {query}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThreadWebSearchOutputDetails ({
  output,
}: {
  output: ThreadWebSearchOutput;
}) {
  const sources = output.sources.filter((source) => isNonEmptyString(source.url) || isNonEmptyString(source.title) || isNonEmptyString(source.snippet));

  return (
    <div className="space-y-3">
      {isNonEmptyString(output.status) ? (
        <ThreadDetailLine
          label="Status:"
          value={<span>{output.status}</span>}
        />
      ) : null}
      {isNonEmptyString(output.text) ? (
        <div className="space-y-2">
          <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">Output</p>
          <pre className={JSON_BLOCK_CLASS}>{output.text.trim()}</pre>
        </div>
      ) : null}
      {sources.length ? (
        <div className="space-y-2">
          <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">Sources</p>
          <div className="space-y-2">
            {sources.map((source, index) => (
              <div
                key={`${source.url ?? ""}:${source.title ?? ""}:${index}`}
                className="rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-3 py-2"
              >
                <p className="m-0 text-[0.84em] leading-[1.5] text-text">
                  {isNonEmptyString(source.url) ? (
                    <ThreadExternalUrl url={source.url} />
                  ) : (
                    source.title?.trim()
                  )}
                </p>
                {isNonEmptyString(source.snippet) ? (
                  <p className="m-0 mt-1 text-[0.78em] leading-[1.6] text-muted">{source.snippet.trim()}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThreadWebSearchDetails ({
  item,
  output,
}: {
  item: WebSearchItem;
  output?: ThreadWebSearchOutput | null;
}) {
  const action = item.action;
  const queries = getSearchQueries(item);

  return (
    <>
      {action?.type === "search" || queries.length ? (
        <ThreadQueriesList queries={queries} />
      ) : null}
      {action?.type === "openPage" && isNonEmptyString(action.url) ? (
        <ThreadDetailLine
          label="URL:"
          value={<ThreadExternalUrl url={action.url} />}
        />
      ) : null}
      {action?.type === "findInPage" ? (
        <>
          {isNonEmptyString(action.url) ? (
            <ThreadDetailLine
              label="URL:"
              value={<ThreadExternalUrl url={action.url} />}
            />
          ) : null}
          {isNonEmptyString(action.pattern) ? (
            <ThreadDetailLine
              label="Pattern:"
              value={<code className={INLINE_CODE_CLASS}>{action.pattern.trim()}</code>}
            />
          ) : null}
        </>
      ) : null}
      {output ? <ThreadWebSearchOutputDetails output={output} /> : null}
      {action?.type === "other" ? (
        <div className="space-y-2">
          <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">Action</p>
          <pre className={JSON_BLOCK_CLASS}>{JSON.stringify(action, null, 2)}</pre>
        </div>
      ) : null}
    </>
  );
}

export default function ThreadWebSearchItem ({
  item,
  output = null,
}: {
  item: WebSearchItem;
  output?: ThreadWebSearchOutput | null;
}) {
  const shouldOpen = !item.action || item.action.type === "other";

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      open={shouldOpen}
      summary={getWebSearchSummary(item)}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadWebSearchDetails item={item} output={output} />
    </ThreadDisclosure>
  );
}
