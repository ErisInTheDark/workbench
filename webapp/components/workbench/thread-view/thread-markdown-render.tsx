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
} from "../../../lib/workbench/markdown/markdown-parse";
import {
  getProjectFilePathDisplay,
  projectFilePathInteractiveClassName,
  projectFilePathLabelClassName,
  projectFilePathLocationClassName,
  projectFilePathPillClassName,
} from "../../../lib/workbench/project/project-file-path";

const BLOCK_SPACING_CLASS = "mb-[0.9em] last:mb-0";
const HEADING_CLASSES = {
  1: `${BLOCK_SPACING_CLASS} font-sans text-[1.16em] font-semibold leading-[1.2]`,
  2: `${BLOCK_SPACING_CLASS} font-sans text-[1.08em] font-semibold leading-[1.2]`,
  3: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  4: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  5: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  6: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
} satisfies Record<1 | 2 | 3 | 4 | 5 | 6, string>;

function renderThreadInlineNodes(nodes: ParsedInlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.text}</Fragment>;
      case "strong":
        return <strong key={key}>{renderThreadInlineNodes(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderThreadInlineNodes(node.children, key)}</em>;
      case "delete":
        return (
          <del
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-[0.08em] text-inherit decoration-current decoration-[0.08em]"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key)}
          </del>
        );
      case "insert":
        return (
          <ins
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-[0.08em] text-inherit no-underline"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key)}
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
            rel={node.external ? "noreferrer" : undefined}
            target={node.external ? "_blank" : undefined}
          >
            {renderThreadInlineNodes(node.children, key)}
          </a>
        );
      case "inlineComment":
        return (
          <span
            className="rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-[0.34em] py-[0.08em] text-[color:color-mix(in_srgb,var(--text)_60%,transparent)]"
            data-inline-comment="true"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key)}
          </span>
        );
      case "knownSkillMention":
        return (
          <span
            className="rounded-[0.35rem] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-[0.34em] py-[0.08em] ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]"
            data-known-skill-mention="true"
            key={key}
            title={node.title}
          >
            {node.text}
          </span>
        );
      case "projectFileLink": {
        const display = getProjectFilePathDisplay(node.relativePath, {
          columnNumber: node.columnNumber,
          lineNumber: node.lineNumber,
        });
        const className = `${projectFilePathPillClassName} ${projectFilePathInteractiveClassName}`;

        return (
          <a
            className={className}
            data-project-file-path="true"
            data-project-file-relative-path={node.relativePath}
            href={node.href}
            key={key}
            title={display.title}
          >
            <span className={projectFilePathLabelClassName}>{display.fileName}</span>
            {display.locationSuffix ? (
              <span className={projectFilePathLocationClassName}>{display.locationSuffix}</span>
            ) : null}
          </a>
        );
      }
    }
  });
}

function renderThreadInlineMarkdown(markdown: string, options: MarkdownParseOptions, keyPrefix: string) {
  return renderThreadInlineNodes(parseInlineMarkdown(markdown, options), keyPrefix);
}

function renderThreadListBlock(
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

function renderThreadListItem(
  item: ParsedListItem,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const content = renderThreadInlineMarkdown(item.text, options, `${keyPrefix}-content`);
  if (!item.children.length) {
    return <li className="[&+li]:mt-1" key={keyPrefix}>{content.length ? content : <br />}</li>;
  }

  const childContent = item.children
    .map((child, index) => (
      child.type === "ul" || child.type === "ol"
        ? renderThreadListBlock(child, options, `${keyPrefix}-child-${index}`)
        : null
    ));

  return (
    <li className="[&+li]:mt-1" key={keyPrefix}>
      <details open>
        <summary>{content.length ? content : <br />}</summary>
        {childContent}
      </details>
    </li>
  );
}

function isThreadSingleItemOrderedStep(
  block: Extract<ParsedBlock, { type: "ol" }>,
  options: MarkdownParseOptions,
) {
  return (options.profile ?? "editor") === "thread"
    && block.items.length === 1
    && /^\d+[.)]$/.test(block.items[0].marker);
}

function renderThreadSingleItemOrderedStep(
  block: Extract<ParsedBlock, { type: "ol" }>,
  options: MarkdownParseOptions,
  keyPrefix: string,
) {
  const item = block.items[0];
  const content = renderThreadInlineMarkdown(item.text, options, `${keyPrefix}-content`);
  const childContent = item.children
    .map((child, index) => (
      child.type === "ul" || child.type === "ol"
        ? renderThreadListBlock(child, options, `${keyPrefix}-child-${index}`)
        : null
    ));

  if (stripInlineCodeSpans(item.text).includes(".")) {
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

function renderThreadStateChange(mode: string, keyPrefix: string) {
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

function renderThreadBlock(block: ParsedBlock, options: MarkdownParseOptions, keyPrefix: string) {
  switch (block.type) {
    case "list-break":
      return Array.from(
        { length: Math.max(1, block.count) },
        (_, index) => <p className={BLOCK_SPACING_CLASS} data-list-break="true" key={`${keyPrefix}-${index}`}><br /></p>,
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
        <pre
          className={`${BLOCK_SPACING_CLASS} overflow-x-auto whitespace-pre-wrap break-words rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-[0.95rem] py-[0.8rem]`}
          data-language={block.language}
          key={keyPrefix}
        >
          <code className="rounded-none bg-transparent p-0 font-mono text-[0.94em]">{block.text}</code>
        </pre>
      );
    case "paragraph": {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        return renderThreadStateChange(stateChangeMode, keyPrefix);
      }

      return <p className={BLOCK_SPACING_CLASS} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix)}</p>;
    }
  }
}

export function renderThreadMarkdown(markdown: string, options: MarkdownParseOptions = {}) {
  const threadOptions = {
    ...options,
    profile: "thread",
  } satisfies MarkdownParseOptions;
  const renderedBlocks = parseBlocks(markdown)
    .map((block, index) => renderThreadBlock(block, threadOptions, `thread-markdown-${index}`));

  return renderedBlocks.length ? renderedBlocks : <p className={BLOCK_SPACING_CLASS}><br /></p>;
}
