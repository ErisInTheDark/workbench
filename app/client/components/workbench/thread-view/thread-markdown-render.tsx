/*
 * Exports:
 * - renderThreadMarkdown: render parsed markdown, inline content and interactive code headers.
 */

import { Fragment, useState, type ReactNode } from "react";

import {
  parseBlockCommentBody,
} from "../../../workbench/markdown/comment-markdown";
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
} from "../../../workbench/markdown/markdown-parse";
import { getInlineMentionMarkClassName } from "../../../workbench/thread/inline-mention-styles";
import type { ThreadMarkdownAppendRenderTarget } from "../../../workbench/markdown/markdown-append-presentation";
import {
  splitUnifiedDiffLine,
  type UnifiedDiffDisplayLine,
} from "workbench-shared/workbench/thread/unified-diff";
import ChevronIcon from "../ChevronIcon";
import ProjectFilePath from "../ProjectFilePath";
import { CheckIcon, CopyIcon, PreviewIcon, WrapTextIcon } from "../workbench-icons";
import WorkbenchIconButton from "../WorkbenchIconButton";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadInlineCode from "./ThreadInlineCode";
import ThreadInlineIcon from "./ThreadInlineIcon";
import ThreadNotice from "./ThreadNotice";
import ThreadPlanSummary from "./ThreadPlanSummary";
import ThreadPreviewFrame from "./ThreadPreviewFrame";

// reusable classes only
const BLOCK_SPACING_CLASS = "mb-[0.9em] last:mb-0";
const CODE_BLOCK_HEADER_BUTTON_CLASS = [
  "data-[thread-codeblock-copy-state=copied]:text-success",
  "data-[thread-codeblock-copy-state=failed]:text-danger",
].join(" ");
const HEADING_CLASSES = {
  1: `${BLOCK_SPACING_CLASS} font-sans text-[1.16em] font-semibold leading-[1.2]`,
  2: `${BLOCK_SPACING_CLASS} font-sans text-[1.08em] font-semibold leading-[1.2]`,
  3: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  4: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  5: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
  6: `${BLOCK_SPACING_CLASS} font-sans text-[1em] font-semibold leading-[1.2]`,
} satisfies Record<1 | 2 | 3 | 4 | 5 | 6, string>;
const SVG_PREVIEW_SRC_DOC_STYLE = [
  "html,body{margin:0;padding:0;background:transparent;min-height:100%;}",
  "body{display:grid;place-items:center;box-sizing:border-box;min-height:100vh;overflow:auto;}",
  "*,::before,::after{box-sizing:border-box;}",
  "svg{display:block;max-width:100%;max-height:100vh;}",
].join("");
const CODE_BLOCK_HEADER_FILE_LINK_PATTERN = /(^|\s)#\[([^\]\r\n]+)\](?=\s|$)/;
const DIFF_CODE_BLOCK_LINE_CLASS_NAMES = {
  addition: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)]",
  context: "",
  deletion: "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]",
  note: "",
} satisfies Record<UnifiedDiffDisplayLine["type"], string>;
const THREAD_TABLE_CELL_CLASS = "min-w-0 max-w-[60cqw] [overflow-wrap:anywhere]";

interface ThreadCodeBlockHeader {
  fileLink: Extract<ParsedInlineNode, { type: "projectFileLink" }> | null;
  language: string;
}

function areNumberArraysEqual(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderAppendReveal(children: ReactNode, key: string) {
  return (
    <span
      className="thread-markdown-append-reveal"
      data-thread-markdown-append-reveal="true"
      key={key}
    >
      {children}
    </span>
  );
}

function createSvgCodeBlockPreviewSrcDoc (svgSource: string) {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"color-scheme\" content=\"light dark\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline';\">",
    `<style>${SVG_PREVIEW_SRC_DOC_STYLE}</style>`,
    "</head>",
    "<body>",
    svgSource,
    "</body>",
    "</html>",
  ].join("");
}

function renderThreadInlineNodes (
  nodes: ParsedInlineNode[],
  keyPrefix: string,
  options: MarkdownParseOptions,
  appendTarget?: ThreadMarkdownAppendRenderTarget,
  path: number[] = [],
  indexOffset = 0,
): ReactNode[] {
  if (appendTarget?.kind === "inlineTail" && path.length === 0) {
    return [
      ...renderThreadInlineNodes(nodes.slice(0, appendTarget.startNodeIndex), keyPrefix, options),
      renderAppendReveal(
        renderThreadInlineNodes(
          nodes.slice(appendTarget.startNodeIndex),
          keyPrefix,
          options,
          undefined,
          [],
          appendTarget.startNodeIndex,
        ),
        `${keyPrefix}-append-${appendTarget.revisionKey}`,
      ),
    ];
  }
  return nodes.map((node, index) => {
    const actualIndex = index + indexOffset;
    const key = `${keyPrefix}-${actualIndex}`;
    const nodePath = [...path, actualIndex];

    switch (node.type) {
      case "text": {
        const isTarget = appendTarget?.kind === "text"
          && areNumberArraysEqual(nodePath, appendTarget.nodePath);
        if (!isTarget) return <Fragment key={key}>{node.text}</Fragment>;
        return (
          <Fragment key={key}>
            {node.text.slice(0, appendTarget.prefixLength)}
            {renderAppendReveal(
              node.text.slice(appendTarget.prefixLength),
              `${key}-append-${appendTarget.revisionKey}`,
            )}
          </Fragment>
        );
      }
      case "strong":
        return <strong key={key}>{renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}</strong>;
      case "em":
        return <em key={key}>{renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}</em>;
      case "delete":
        return (
          <del
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-[0.08em] text-inherit decoration-current decoration-[0.08em]"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}
          </del>
        );
      case "insert":
        return (
          <ins
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-[0.08em] text-inherit no-underline"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}
          </ins>
        );
      case "code":
        return (
          <ThreadInlineCode key={key}>
            {node.text}
          </ThreadInlineCode>
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
            {renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}
          </a>
        );
      case "inlineComment":
        return (
          <span
            className="rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--comment-fg-bg:color-mix(in_srgb,var(--text)_6%,var(--fg-bg,var(--bg)))] px-[0.34em] py-[0.08em] text-[color:color-mix(in_srgb,var(--text)_60%,var(--comment-fg-bg))]"
            data-inline-comment="true"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options, appendTarget, nodePath)}
          </span>
        );
      case "threadIcon":
        return (
          <ThreadInlineIcon
            color={node.color}
            iconType={node.iconType}
            key={key}
            source={node.source}
          />
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
            absolutePath={node.absolutePath}
            columnNumber={node.columnNumber}
            exists={node.exists}
            key={key}
            label={node.label}
            lineNumber={node.lineNumber}
            openPath={node.openPath}
            path={node.relativePath}
            projectId={node.projectId ?? options.projectId}
            targetType={node.targetType}
          />
        );
      }
    }
  });
}

function renderThreadInlineMarkdown (
  markdown: string,
  options: MarkdownParseOptions,
  keyPrefix: string,
  appendTarget?: ThreadMarkdownAppendRenderTarget,
) {
  return renderThreadInlineNodes(parseInlineMarkdown(markdown, options), keyPrefix, options, appendTarget);
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
    return <li className="[&+li]:mt-1" key={keyPrefix} value={item.ordinal ?? undefined}>{content.length ? content : <br />}</li>;
  }

  const childContent = renderThreadChildBlocks(item.children, options, keyPrefix);

  return (
    <li className="[&+li]:mt-1" key={keyPrefix} value={item.ordinal ?? undefined}>
      <details
        className="thread-disclosure block min-w-0 max-w-full"
        open
      >
        <summary className="flex min-w-0 max-w-full cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">{content.length ? content : <br />}</span>
          <ChevronIcon
            data-thread-chevron
            className="ml-[0.12em] transition-transform"
            size={20}
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
        <span className="mr-[0.22em] text-fg/muted" data-thread-step-marker="true">{item.marker}</span>
        {content.length ? <> {content}</> : null}
      </p>
      {childContent}
    </Fragment>
  );
}

function renderThreadStateChange (mode: string, keyPrefix: string) {
  return (
    <div
      className="my-[0.85em] flex items-center gap-2 font-sans leading-none text-fg/muted last:mb-0 before:block before:h-px before:flex-1 before:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] before:content-[''] after:block after:h-px after:flex-1 after:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] after:content-['']"
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
      summary={<ThreadPlanSummary markdown={block.text} />}
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
      <div className="max-w-full overflow-x-auto [container-type:inline-size]">
        <table className="w-max min-w-full border-collapse font-sans text-[0.92em] leading-[1.45]">
          <thead>
            <tr className="border-b-2 border-[color-mix(in_srgb,var(--text)_16%,transparent)] bg-[color-mix(in_srgb,var(--text)_5%,transparent)]">
              {block.header.map((cell, index) => (
                <th
                  className={`${getThreadTableCellAlignClassName(block.alignments[index] ?? null)} ${THREAD_TABLE_CELL_CLASS} px-[0.65rem] py-[0.48rem] text-[0.82em] font-semibold text-text align-top`}
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
                      className={`${getThreadTableCellAlignClassName(block.alignments[columnIndex] ?? null)} ${THREAD_TABLE_CELL_CLASS} px-[0.85rem] py-[0.5rem] align-top text-text`}
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

function renderThreadNoticeBlock (block: Extract<ParsedBlock, { type: "notice" }>, options: MarkdownParseOptions, keyPrefix: string) {
  return (
    <ThreadNotice
      bodyMarkdown={block.text}
      color={block.color}
      key={keyPrefix}
      source={block.source}
      title={block.title}
    >
      {renderThreadMarkdownBlocks(block.text, options, `${keyPrefix}-content`)}
    </ThreadNotice>
  );
}

function getCodeBlockLanguageToken(language: string) {
  return language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function isSvgCodeBlockLanguage (language: string) {
  return getCodeBlockLanguageToken(language) === "svg";
}

function isDiffCodeBlockLanguage (language: string) {
  return getCodeBlockLanguageToken(language) === "diff";
}

function renderThreadDiffCodeBlock (text: string, keyPrefix: string) {
  const lines = text.split("\n");

  return lines.map((line, index) => {
    const displayLine = splitUnifiedDiffLine(line);

    return (
      <Fragment key={`${keyPrefix}-diff-line-${index}`}>
        <span
          className={`block min-h-[1lh] px-[0.95rem] ${DIFF_CODE_BLOCK_LINE_CLASS_NAMES[displayLine.type]}`}
          data-thread-codeblock-diff-line={displayLine.type}
        >
          {displayLine.prefix ? (
            <span className="sr-only" data-thread-codeblock-diff-prefix="true">{displayLine.prefix}</span>
          ) : null}
          {displayLine.text}
        </span>
        {index < lines.length - 1 ? (
          <span aria-hidden="true" className="hidden" data-thread-codeblock-diff-separator="true">{"\n"}</span>
        ) : null}
      </Fragment>
    );
  });
}

function parseThreadCodeBlockHeader(language: string, options: MarkdownParseOptions): ThreadCodeBlockHeader {
  const match = CODE_BLOCK_HEADER_FILE_LINK_PATTERN.exec(language);
  if (!match) {
    return {
      fileLink: null,
      language: language.trim(),
    };
  }

  const nodes = parseInlineMarkdown(match[0].trim(), options);
  const fileLink = nodes.length === 1 && nodes[0]?.type === "projectFileLink"
    ? nodes[0]
    : null;
  if (!fileLink) {
    return {
      fileLink: null,
      language: language.trim(),
    };
  }

  return {
    fileLink,
    language: `${language.slice(0, match.index)}${match[1] ?? ""}${language.slice(match.index + match[0].length)}`.trim(),
  };
}

function getCompletedSvgPreviewSource(svgSource: string) {
  const completedMarkupEnd = svgSource.lastIndexOf(">");
  return completedMarkupEnd >= 0
    ? svgSource.slice(0, completedMarkupEnd + 1)
    : "";
}

function ThreadCodeBlock ({
  block,
  keyPrefix,
  options,
}: {
  block: Extract<ParsedBlock, { type: "code" }>;
  keyPrefix: string;
  options: MarkdownParseOptions;
}) {
  const header = parseThreadCodeBlockHeader(block.language, options);
  const language = header.language;
  const isDiffCodeBlock = isDiffCodeBlockLanguage(language);
  const isSvgCodeBlock = isSvgCodeBlockLanguage(language);
  const [isSvgPreviewing, setIsSvgPreviewing] = useState(false);
  const completedSvgSource = isSvgCodeBlock
    ? getCompletedSvgPreviewSource(block.text)
    : "";
  const svgPreviewSrcDoc = isSvgCodeBlock && isSvgPreviewing
    ? createSvgCodeBlockPreviewSrcDoc(completedSvgSource)
    : null;

  return (
    <div
      className={`${BLOCK_SPACING_CLASS} max-w-full overflow-hidden rounded-[0.75rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]`}
      data-thread-codeblock="true"
      data-thread-codeblock-diff={isDiffCodeBlock ? "true" : undefined}
      data-thread-codeblock-svg-preview-state={isSvgCodeBlock ? (isSvgPreviewing ? "preview" : "code") : undefined}
    >
      <div className="flex min-h-[2.05rem] items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--text)_8%,transparent)] px-[0.65rem] py-[0.28rem]">
        <span className="flex min-w-0 items-center gap-1.5 pl-[0.15rem] font-mono text-[0.72em] leading-none text-fg/muted">
          <span className="min-w-0 truncate">{language || "code"}</span>
          {header.fileLink ? renderThreadInlineNodes([header.fileLink], `${keyPrefix}-header-file`, options) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <WorkbenchIconButton
            type="button"
            label="Copy code block"
            display="hover-border"
            size="compact"
            className={`${CODE_BLOCK_HEADER_BUTTON_CLASS} group`}
            data-thread-codeblock-copy="true"
            data-thread-codeblock-copy-state="idle"
            title="Copy code block"
          >
            <span className="block group-data-[thread-codeblock-copy-state=copied]:hidden" data-thread-codeblock-copy-icon="copy">
              <CopyIcon size={16} />
            </span>
            <span className="hidden group-data-[thread-codeblock-copy-state=copied]:block" data-thread-codeblock-copy-icon="check">
              <CheckIcon size={16} />
            </span>
          </WorkbenchIconButton>
          {isSvgCodeBlock ? (
            <WorkbenchIconButton
              type="button"
              label={isSvgPreviewing ? "Show SVG source" : "Preview SVG code block"}
              display="hover-border"
              size="compact"
              aria-pressed={isSvgPreviewing}
              className={CODE_BLOCK_HEADER_BUTTON_CLASS}
              data-thread-codeblock-svg-preview="true"
              data-thread-codeblock-toggle-state={isSvgPreviewing ? "active" : "idle"}
              onClick={() => setIsSvgPreviewing((current) => !current)}
              title={isSvgPreviewing ? "Show SVG source" : "Preview SVG code block"}
            >
              <PreviewIcon size={16} />
            </WorkbenchIconButton>
          ) : null}
          <WorkbenchIconButton
            type="button"
            label="Toggle code block line wrapping"
            display="hover-border"
            size="compact"
            aria-pressed={false}
            className={CODE_BLOCK_HEADER_BUTTON_CLASS}
            data-thread-codeblock-toggle-state="idle"
            data-thread-codeblock-wrap-toggle="true"
            title="Toggle code block line wrapping"
          >
            <WrapTextIcon size={16} />
          </WorkbenchIconButton>
        </div>
      </div>
      <div className="relative min-h-[2.8rem]" data-thread-codeblock-body="true">
        <pre
          className={`max-w-full overflow-x-auto whitespace-pre py-[0.8rem] ${isDiffCodeBlock ? "px-0" : "px-[0.95rem]"}`}
          data-language={language}
          data-thread-codeblock-pre="true"
        >
          <code className="block w-max min-w-full rounded-none bg-transparent p-0 font-mono text-[0.94em]" data-thread-codeblock-code="true">
            {isDiffCodeBlock ? renderThreadDiffCodeBlock(block.text, keyPrefix) : block.text}
          </code>
        </pre>
        {svgPreviewSrcDoc ? (
          <div
            className="absolute inset-0 overflow-auto p-[0.95rem]"
            data-thread-codeblock-svg-preview-layer="true"
          >
            <iframe
              className="block size-full border-0 bg-transparent"
              data-thread-codeblock-svg-preview-frame="true"
              key={svgPreviewSrcDoc}
              sandbox=""
              srcDoc={svgPreviewSrcDoc}
              title="SVG code block preview"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderThreadBlock (
  block: ParsedBlock,
  options: MarkdownParseOptions,
  keyPrefix: string,
  appendTarget?: ThreadMarkdownAppendRenderTarget,
) {
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
      return <Tag className={HEADING_CLASSES[block.level as 1 | 2 | 3 | 4 | 5 | 6]} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix, appendTarget)}</Tag>;
    }
    case "blockquote":
      return (
        <blockquote
          className={`${BLOCK_SPACING_CLASS} border-l-[0.18rem] [border-left-color:color-mix(in_srgb,var(--text)_14%,transparent)] pl-[0.9rem] text-fg/muted`}
          key={keyPrefix}
        >
          {renderThreadInlineMarkdown(block.text, options, keyPrefix, appendTarget)}
        </blockquote>
      );
    case "plan":
      return renderThreadPlanBlock(block, options, keyPrefix);
    case "notice":
      return renderThreadNoticeBlock(block, options, keyPrefix);
    case "comment":
      return (
        <p
          className={`${BLOCK_SPACING_CLASS} mx-0 rounded-[0.6rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--comment-fg-bg:color-mix(in_srgb,var(--text)_6%,var(--fg-bg,var(--bg)))] px-[0.75rem] py-[0.55rem] text-[0.9em] text-[color:color-mix(in_srgb,var(--text)_60%,var(--comment-fg-bg))]`}
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
      return <hr className="[margin-inline:10%] my-8 [border-color:color-mix(var(--text),var(--shell-fade-bg)_70%)]" key={keyPrefix} />;
    case "code":
      return <ThreadCodeBlock block={block} key={keyPrefix} keyPrefix={keyPrefix} options={options} />;
    case "table":
      return renderThreadTableBlock(block, options, keyPrefix);
    case "paragraph": {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        return renderThreadStateChange(stateChangeMode, keyPrefix);
      }

      return <p className={BLOCK_SPACING_CLASS} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix, appendTarget)}</p>;
    }
  }
}

export function renderThreadMarkdown (
  markdown: string,
  options: MarkdownParseOptions = {},
  appendTarget?: ThreadMarkdownAppendRenderTarget,
) {
  const threadOptions = {
    ...options,
    profile: "thread",
  } satisfies MarkdownParseOptions;
  const renderedBlocks = parseBlocks(markdown, threadOptions)
    .map((block, index) => renderThreadBlock(
      block,
      threadOptions,
      `thread-markdown-${index}`,
      appendTarget?.blockIndex === index ? appendTarget : undefined,
    ));

  return renderedBlocks.length ? renderedBlocks : <p className={BLOCK_SPACING_CLASS}><br /></p>;
}
