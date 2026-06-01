/*
 * Exports:
 * - getThreadWebSearchLiveLabel: derive the live activity label for a web-search item. Keywords: workbench, thread, web search, live.
 * - isThreadWebSearchPlaceholder: detect empty in-progress web-search placeholders. Keywords: workbench, thread, web search, placeholder.
 * - ThreadWebSearchSequence: render grouped adjacent Codex web search actions. Keywords: workbench, thread, web search, grouped.
 * - ThreadWebSearchOutput: optional enriched display data for future web search result rendering. Keywords: workbench, thread, web search, output.
 * - default ThreadWebSearchItem: render Codex web search actions inside thread history. Keywords: workbench, thread, web search.
 * - Local helpers: format web search summaries, queries, URLs, and optional output sections. Keywords: search query, external URL, result.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
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
const ROW_LABEL_CLASS = "shrink-0 text-muted";
const ROW_VALUE_CLASS = "min-w-0 break-words font-medium text-text";

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

interface ParsedSearchQuery {
  scope: string | null;
  terms: string;
}

function formatSearchScope(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }

  try {
    return formatUrlLabel(trimmedValue.match(/^https?:\/\//iu) ? trimmedValue : `https://${trimmedValue}`);
  } catch {
    return truncateThreadText(trimmedValue.replace(/^https?:\/\//iu, ""), 96);
  }
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const trimmedQuery = query.trim();
  const siteMatch = /^site:(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/iu.exec(trimmedQuery);
  if (!siteMatch) {
    return {
      scope: null,
      terms: trimmedQuery,
    };
  }

  const rawScope = siteMatch[1] ?? siteMatch[2] ?? siteMatch[3] ?? "";
  const terms = (siteMatch[4] ?? "").trim();
  if (!rawScope.trim() || !terms) {
    return {
      scope: null,
      terms: trimmedQuery,
    };
  }

  return {
    scope: formatSearchScope(rawScope),
    terms,
  };
}

function getParsedSearchQueries(item: WebSearchItem) {
  return getSearchQueries(item).map((query) => ({
    query,
    ...parseSearchQuery(query),
  }));
}

function formatSearchQueryLabel(query: string) {
  const parsedQuery = parseSearchQuery(query);
  return parsedQuery.scope
    ? (
      <>
        <span>{parsedQuery.scope}</span>
        <span> for </span>
        <span>{truncateThreadText(parsedQuery.terms, 96)}</span>
      </>
    )
    : truncateThreadText(parsedQuery.terms, 96);
}

export function isThreadWebSearchPlaceholder(item: WebSearchItem) {
  return (!item.action || item.action.type === "other") && !isNonEmptyString(item.query);
}

export function getThreadWebSearchLiveLabel(item: WebSearchItem) {
  switch (item.action?.type) {
    case "search":
      return "Searching web...";
    case "openPage":
      return "Opening page...";
    case "findInPage":
      return "Searching page...";
    default:
      return "Using web...";
  }
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
      const parsedQueries = queries.map(parseSearchQuery);
      const sharedScope = parsedQueries[0]?.scope && parsedQueries.every((query) => query.scope === parsedQueries[0]?.scope)
        ? parsedQueries[0].scope
        : null;

      return (
        <>
          <span>{sharedScope ? "Searched " : "Searched web: "}</span>
          {sharedScope ? <span className="font-medium text-text">{sharedScope}</span> : null}
          {sharedScope ? <span>: </span> : null}
          <span className="font-medium text-text">{queries.length} queries</span>
        </>
      );
    }

    return (
      <>
        <span>Searched </span>
        <span className="font-medium text-text">{formatSearchQueryLabel(queries[0] ?? "search")}</span>
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

export function ThreadWebSearchActionRow ({
  item,
}: {
  item: WebSearchItem;
}) {
  const action = item.action;
  const queries = getSearchQueries(item);

  if (action?.type === "search" && queries.length) {
    const parsedQueries = getParsedSearchQueries(item);
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
        <span className={ROW_LABEL_CLASS}>Searched</span>
        <span className="min-w-0 break-words text-text">
          {parsedQueries.map((query, index) => (
            <span key={query.query}>
              {index ? <span>, </span> : null}
              {query.scope ? (
                <>
                  <span className="font-medium">{query.scope}</span>
                  <span className="text-muted"> for </span>
                  <span className="font-medium">{query.terms}</span>
                </>
              ) : (
                <span className="font-medium">{query.terms}</span>
              )}
            </span>
          ))}
        </span>
      </span>
    );
  }

  if (action?.type === "openPage" && isNonEmptyString(action.url)) {
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
        <span className={ROW_LABEL_CLASS}>Opened</span>
        <span className="min-w-0"><ThreadExternalUrl url={action.url} /></span>
      </span>
    );
  }

  if (action?.type === "findInPage") {
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
        <span className={ROW_LABEL_CLASS}>Searched page</span>
        <span className="min-w-0 break-words text-text">{action.pattern?.trim() || item.query || "page"}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 align-bottom">
      <span className={ROW_LABEL_CLASS}>Web</span>
      <span className="min-w-0 break-words text-text">{item.query || "Used web"}</span>
    </span>
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
  const hasOutput = Boolean(output);

  return (
    <>
      {action?.type === "search" && !hasOutput ? (
        <ThreadWebSearchActionRow item={item} />
      ) : action?.type === "search" || queries.length ? (
        <ThreadQueriesList queries={queries} />
      ) : null}
      {action?.type === "openPage" && isNonEmptyString(action.url) && !hasOutput ? (
        <ThreadWebSearchActionRow item={item} />
      ) : action?.type === "openPage" && isNonEmptyString(action.url) ? (
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

function getWebSearchSequenceSummary(items: WebSearchItem[]): ReactNode {
  if (items.length === 1) {
    return getWebSearchSummary(items[0]);
  }

  const openPageItems = items.filter((item) => item.action?.type === "openPage" && isNonEmptyString(item.action.url));
  if (openPageItems.length === items.length) {
    return (
      <>
        <span>Opened </span>
        <span className="font-medium text-text">{items.length}</span>
        <span> pages</span>
      </>
    );
  }

  const searchQueries = uniqueNonEmptyStrings(items.flatMap((item) => getSearchQueries(item)));
  const searchItems = items.filter((item) => item.action?.type === "search");
  if (searchQueries.length && openPageItems.length) {
    return (
      <>
        <span>Searched web and opened </span>
        <span className="font-medium text-text">{openPageItems.length}</span>
        <span>{openPageItems.length === 1 ? " page" : " pages"}</span>
      </>
    );
  }

  if (searchItems.length === items.length && searchQueries.length) {
    return (
      <>
        <span>Searched web: </span>
        <span className="font-medium text-text">{searchQueries.length === 1 ? truncateThreadText(searchQueries[0], 96) : `${searchQueries.length} queries`}</span>
      </>
    );
  }

  return (
    <>
      <span>Used web: </span>
      <span className="font-medium text-text">{items.length}</span>
      <span> actions</span>
    </>
  );
}

export function ThreadWebSearchSequence ({
  items,
}: {
  items: WebSearchItem[];
}) {
  const visibleItems = items.filter((item) => !isThreadWebSearchPlaceholder(item));
  if (!visibleItems.length) {
    return null;
  }

  if (visibleItems.length === 1) {
    return <ThreadWebSearchItem item={visibleItems[0]} />;
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-1 pl-6"
      summary={getWebSearchSequenceSummary(visibleItems)}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <div className="space-y-1">
        {visibleItems.map((item) => (
          <ThreadDisclosureStaticRow
            key={item.id}
            summary={<ThreadWebSearchActionRow item={item} />}
            summaryClassName="text-[0.92em] leading-[1.6]"
          />
        ))}
      </div>
    </ThreadDisclosure>
  );
}

export default function ThreadWebSearchItem ({
  item,
  output = null,
}: {
  item: WebSearchItem;
  output?: ThreadWebSearchOutput | null;
}) {
  if (isThreadWebSearchPlaceholder(item)) {
    return null;
  }

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
