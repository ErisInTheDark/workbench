/*
 * Exports:
 * - renderThreadMarkdown: render shared markdown parse nodes into React thread display elements. Keywords: thread, markdown, React, renderer.
 */

import { Fragment, type ReactNode } from "react";

import {
  parseBlockCommentBody,
} from "../../../lib/workbench/markdown/comment-markdown";
import {
  formatThreadStateChangeMode,
  parseBlocks,
  parseInlineMarkdown,
  parseThreadStateChangeMode,
  stripInlineCodeSpans,
  type MarkdownParseOptions,
  type ParsedBlock,
  type ParsedInlineNode,
  type ParsedListItem,
  type ParsedTableAlignment,
  type ParsedTableCell,
} from "../../../lib/workbench/markdown/markdown-parse";
import { getInlineMentionMarkClassName } from "../../../lib/workbench/thread/inline-mention-styles";
import ChevronIcon from "../ChevronIcon";
import ProjectFilePath from "../ProjectFilePath";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadPreviewFrame from "./ThreadPreviewFrame";

// reusable classes only
const BLOCK_SPACING_CLASS = "mb-[0.9em] last:mb-0";
const HEADING_CLASSES = {
  1: `${BLOCK_SPACING_CLASS} font-sans text-[1.16em] font-semibold leading-[1.2]`,
  2: `${BLOCK_SPACING_CLASS} font-sans text-[1.08em] font-semibold leading-[1.2]`,
  3: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  4: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  5: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  6: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
} satisfies Record<1 | 2 | 3 | 4 | 5 | 6, string>;

function renderThreadInlineNodes (nodes: ParsedInlineNode[], keyPrefix: string, options: MarkdownParseOptions): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.text}</Fragment>;
      case "strong":
        return <strong key={key}>{renderThreadInlineNodes(node.children, key, options)}</strong>;
      case "em":
        return <em key={key}>{renderThreadInlineNodes(node.children, key, options)}</em>;
      case "delete":
        return (
          <del
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-[0.08em] text-inherit decoration-current decoration-[0.08em]"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </del>
        );
      case "insert":
        return (
          <ins
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-[0.08em] text-inherit no-underline"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </ins>
        );
      case "code":
        return (
          <code
            className="rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.94em]"
            key={key}
          >
            {node.text}
          </code>
        );
      case "break":
        return <br key={key} />;
      case "link":
        return (
          <a
            className="text-accent underline decoration-accent-soft decoration-[0.08em] underline-offset-[0.16em]"
            href={node.href}
            key={key}
            rel="noreferrer"
            target="_blank"
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </a>
        );
      case "inlineComment":
        return (
          <span
            className="rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-[0.34em] py-[0.08em] text-[color:color-mix(in_srgb,var(--text)_60%,transparent)]"
            data-inline-comment="true"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </span>
        );
      case "knownSkillMention":
        return (
          <span
            className={`
              ${getInlineMentionMarkClassName("skill")}
              rounded-[0.35rem] px-[0.34em] py-[0.08em]
            `}
            data-known-skill-mention="true"
            key={key}
            title={node.title}
          >
            {node.text}
          </span>
        );
      case "projectFileLink": {
        return (
          <ProjectFilePath
            columnNumber={node.columnNumber}
            disambiguationPaths={options.projectFilePaths}
            key={key}
            label={node.label}
            lineNumber={node.lineNumber}
            path={node.relativePath}
            projectId={options.projectId}
          />
        );
      }
    }
  });
}

function renderThreadInlineMarkdown (markdown: string, options: MarkdownParseOptions, keyPrefix: string) {
  return renderThreadInlineNodes(parseInlineMarkdown(markdown, options), keyPrefix, options);
}

function renderThreadChildBlocks (
  children: ParsedBlock[],
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  return children.map((child, index) => renderThreadBlock(child, options, `${keyPrefix}-child-${index}`));
}

function renderThreadListBlock (
  block: Extract<ParsedBlock, { type: "ul" | "ol" }>,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const Tag = block.type;

  return (
    <Tag className={`${BLOCK_SPACING_CLASS} ${block.type === "ul" ? "list-disc" : "list-decimal"} pl-[1.3rem]`} key={keyPrefix}>
      {block.items.map((item, index) => renderThreadListItem(item, options, `${keyPrefix}-item-${index}`))}
    </Tag>
  );
}

function renderThreadListItem (
  item: ParsedListItem,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const content = renderThreadInlineMarkdown(item.text, options, `${keyPrefix}-content`);
  if (!item.children.length) {
    return <li className="[&+li]:mt-1" key={keyPrefix}>{content.length ? content : <br />}</li>;
  }

  const childContent = renderThreadChildBlocks(item.children, options, keyPrefix);

  return (
    <li className="[&+li]:mt-1" key={keyPrefix}>
      <details
        className="thread-disclosure block min-w-0 max-w-full"
        open
      >
        <summary className="flex min-w-0 max-w-full cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">{content.length ? content : <br />}</span>
          <ChevronIcon
            data-thread-chevron
            className="ml-[0.12em] size-[1.2em] transition-transform"
          />
        </summary>
        {childContent}
      </details>
    </li>
  );
}

function isThreadSingleItemOrderedStep (
  block: Extract<ParsedBlock, { type: "ol" }>,
  options: MarkdownParseOptions,
) {
  return (options.profile ?? "editor") === "thread"
    && block.items.length === 1
    && /^\d+[.)]$/.test(block.items[0].marker);
}

function renderThreadSingleItemOrderedStep (
  block: Extract<ParsedBlock, { type: "ol" }>,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const item = block.items[0];
  const content = renderThreadInlineMarkdown(item.text, options, `${keyPrefix}-content`);
  const childContent = renderThreadChildBlocks(item.children, options, keyPrefix);

  // multiple periods = probably not top level step marker, render as normal list item with marker in content
  if (stripInlineCodeSpans(item.text).match(/\..*?\./)) {
    return (
      <Fragment key={keyPrefix}>
        <p className={BLOCK_SPACING_CLASS}>
          {item.marker}
          {content.length ? <> {content}</> : null}
        </p>
        {childContent}
      </Fragment>
    );
  }

  return (
    <Fragment key={keyPrefix}>
      <p
        className="mb-[0.55em] font-sans text-[1em] font-semibold leading-[1.25] last:mb-0"
        data-thread-step-line="true"
      >
        <span className="mr-[0.22em] text-muted" data-thread-step-marker="true">{item.marker}</span>
        {content.length ? <> {content}</> : null}
      </p>
      {childContent}
    </Fragment>
  );
}

function renderThreadStateChange (mode: string, keyPrefix: string) {
  return (
    <div
      className="my-[0.85em] flex items-center gap-2 font-sans leading-none text-muted last:mb-0 before:block before:h-px before:flex-1 before:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] before:content-[''] after:block after:h-px after:flex-1 after:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] after:content-['']"
      data-thread-state-change="true"
      data-thread-state-mode={mode}
      key={keyPrefix}
    >
      <span className="text-[0.62em] font-medium uppercase tracking-[0.14em]" data-thread-state-change-kicker="true">Mode</span>
      <span className="text-[0.84em] font-semibold text-text" data-thread-state-change-label="true">{formatThreadStateChangeMode(mode)}</span>
    </div>
  );
}

function renderThreadMarkdownBlocks (markdown: string, options: MarkdownParseOptions, keyPrefix: string) {
  return parseBlocks(markdown, options)
    .map((block, index) => renderThreadBlock(block, options, `${keyPrefix}-${index}`));
}

function renderThreadPlanBlock (block: Extract<ParsedBlock, { type: "plan" }>, options: MarkdownParseOptions, keyPrefix: string) {
  const content = renderThreadMarkdownBlocks(block.text, options, `${keyPrefix}-content`);

  return (
    <ThreadDisclosure
      className={BLOCK_SPACING_CLASS}
      contentClassName="mt-2"
      initialOpen
      key={keyPrefix}
      summary="Plan"
      summaryClassName="text-[0.92em] font-medium leading-[1.6]"
    >
      <ThreadPreviewFrame
        backgroundClassName="before:bg-[linear-gradient(to_right,transparent,#8882_10%,#8882_90%,transparent)]"
        contentClassName="mb-8 px-4 py-8"
        edgeBleed="wide"
        edgeOffset="none"
        mode="panel"
      >
        {content.length ? content : <p className={BLOCK_SPACING_CLASS}><br /></p>}
      </ThreadPreviewFrame>
    </ThreadDisclosure>
  );
}

function getThreadTableCellAlignClassName (alignment: ParsedTableAlignment) {
  switch (alignment) {
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    case "left":
    default:
      return "text-left";
  }
}

function renderThreadTableCellContent (
  cell: ParsedTableCell,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const content = renderThreadInlineMarkdown(cell.text, options, keyPrefix);
  return content.length ? content : <br />;
}

function renderThreadTableBlock (
  block: Extract<ParsedBlock, { type: "table" }>,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  return (
    <div
      className={`${BLOCK_SPACING_CLASS} max-w-full overflow-hidden rounded-[0.75rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]`}
      key={keyPrefix}
    >
      <div className="max-w-full overflow-x-auto">
        <table className="w-max min-w-full border-collapse font-sans text-[0.92em] leading-[1.45]">
          <thead>
            <tr className="border-b-2 border-[color-mix(in_srgb,var(--text)_16%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)]">
              {block.header.map((cell, index) => (
                <th
                  className={`${getThreadTableCellAlignClassName(block.alignments[index] ?? null)} px-[0.65rem] py-[0.48rem] text-[0.82em] font-semibold text-text align-top`}
                  key={`${keyPrefix}-header-${index}`}
                  scope="col"
                >
                  {renderThreadTableCellContent(cell, options, `${keyPrefix}-header-${index}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                className="border-t border-[color-mix(in_srgb,var(--text)_7%,transparent)] first:border-t-0"
                key={`${keyPrefix}-row-${rowIndex}`}
              >
                {block.header.map((_, columnIndex) => {
                  const cell = row[columnIndex] ?? { text: "" };
                  return (
                    <td
                      className={`${getThreadTableCellAlignClassName(block.alignments[columnIndex] ?? null)} px-[0.85rem] py-[0.5rem] align-top text-text`}
                      key={`${keyPrefix}-row-${rowIndex}-cell-${columnIndex}`}
                    >
                      {renderThreadTableCellContent(cell, options, `${keyPrefix}-row-${rowIndex}-cell-${columnIndex}`)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderThreadBlock (block: ParsedBlock, options: MarkdownParseOptions, keyPrefix: string) {
  switch (block.type) {
    case "list-break":
      return Array.from(
        { length: Math.max(1, block.count) },
        (_, index) => <p className="-my-2" data-list-break="true" key={`${keyPrefix}-${index}`}><br /></p>,
      );
    case "break":
      return Array.from({ length: block.count }, (_, index) => <br key={`${keyPrefix}-${index}`} />);
    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className={HEADING_CLASSES[block.level as 1 | 2 | 3 | 4 | 5 | 6]} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix)}</Tag>;
    }
    case "blockquote":
      return (
        <blockquote
          className={`${BLOCK_SPACING_CLASS} border-l-[0.18rem] [border-left-color:color-mix(in_srgb,var(--text)_14%,transparent)] pl-[0.9rem] text-muted`}
          key={keyPrefix}
        >
          {renderThreadInlineMarkdown(block.text, options, keyPrefix)}
        </blockquote>
      );
    case "plan":
      return renderThreadPlanBlock(block, options, keyPrefix);
    case "comment":
      return (
        <p
          className={`${BLOCK_SPACING_CLASS} mx-0 rounded-[0.6rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-[0.75rem] py-[0.55rem] text-[0.9em] text-[color:color-mix(in_srgb,var(--text)_60%,transparent)]`}
          data-block-comment="true"
          key={keyPrefix}
        >
          {parseBlockCommentBody(block.text) ?? block.text}
        </p>
      );
    case "ul":
      return renderThreadListBlock(block, options, keyPrefix);
    case "ol":
      return isThreadSingleItemOrderedStep(block, options)
        ? renderThreadSingleItemOrderedStep(block, options, keyPrefix)
        : renderThreadListBlock(block, options, keyPrefix);
    case "hr":
      return <hr className={BLOCK_SPACING_CLASS} key={keyPrefix} />;
    case "code":
      return (
        <div className={`${BLOCK_SPACING_CLASS} max-w-full overflow-hidden rounded-[0.75rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]`} key={keyPrefix}>
          {block.language ? (
            <div className="border-b border-[color-mix(in_srgb,var(--text)_8%,transparent)] px-[0.8rem] py-[0.36rem] font-mono text-[0.72em] leading-none text-muted">
              {block.language}
            </div>
          ) : null}
          <pre
            className="max-w-full overflow-x-auto whitespace-pre px-[0.95rem] py-[0.8rem]"
            data-language={block.language}
          >
            <code className="block w-max min-w-full rounded-none bg-transparent p-0 font-mono text-[0.94em]">{block.text}</code>
          </pre>
        </div>
      );
    case "table":
      return renderThreadTableBlock(block, options, keyPrefix);
    case "paragraph": {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        return renderThreadStateChange(stateChangeMode, keyPrefix);
      }

      return <p className={BLOCK_SPACING_CLASS} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix)}</p>;
    }
  }
}

export function renderThreadMarkdown (markdown: string, options: MarkdownParseOptions = {}) {
  const threadOptions = {
    ...options,
    profile: "thread",
  } satisfies MarkdownParseOptions;
  const renderedBlocks = renderThreadMarkdownBlocks(markdown, threadOptions, "thread-markdown");

  return renderedBlocks.length ? renderedBlocks : <p className={BLOCK_SPACING_CLASS}><br /></p>;
}
