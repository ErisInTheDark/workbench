/*
 * Exports:
 * - createSvgCodeBlockPreviewSrcDoc: build the sandboxed SVG preview document and its content policy.
 * - ThreadRenderOptions: parse options plus the live reveal cursor that animates newly streamed text and framed blocks in document order, the frontier caret, and per-paragraph holding.
 * - renderThreadMarkdown: render parsed markdown, inline content and interactive code headers; top-level section breaks host section-action slots; partial text renders its stream frontier.
 * - renderThreadInlineMarkdown: render inline markdown without a block container.
 */

import { Fragment, useState, type ReactNode } from "react";

import {
  parseCommentLine,
} from "../../../workbench/markdown/comment-markdown";
import {
  formatThreadStateChangeMode,
  isThreadMarkdownSectionBreak,
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
import { holdsInside, holdStreamingBlocks } from "../../../workbench/markdown/markdown-hold";
import { getInlineMentionMarkClassName } from "../../../workbench/thread/inline-mention-styles";
import type { MarkdownRevealCursor } from "../../../workbench/markdown/MarkdownRevealTimeline";
import {
  splitUnifiedDiffLine,
  type UnifiedDiffDisplayLine,
} from "workbench-shared/workbench/thread/unified-diff";
import ChevronIcon from "../ChevronIcon";
import ProjectFilePath from "../ProjectFilePath";
import { CheckIcon, CopyIcon, PreviewIcon, WrapTextIcon } from "../workbench-icons";
import IconButton from "../../ui/IconButton";
import Disclosure from "../../ui/Disclosure";
import ThreadFileList from "./ThreadFileList";
import ThreadInlineCode from "./ThreadInlineCode";
import ThreadInlineIcon from "./ThreadInlineIcon";
import ThreadMarkdownSectionActions from "./ThreadMarkdownSectionActions";
import ThreadNotice from "./ThreadNotice";
import ThreadPlanSummary from "./ThreadPlanSummary";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadRevealText, { ThreadRevealBlock, ThreadStreamCaret } from "./ThreadRevealText";
import ThreadVisFrame from "./ThreadVisFrame";

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
  addition: "bg-[color-mix(in srgb, var(--success) 12%, transparent)]",
  context: "",
  deletion: "bg-[color-mix(in srgb, var(--danger) 12%, transparent)]",
  note: "",
} satisfies Record<UnifiedDiffDisplayLine["type"], string>;
const THREAD_TABLE_CELL_CLASS = "min-w-0 max-w-[60cqw] [overflow-wrap:anywhere]";

interface ThreadCodeBlockHeader {
  fileLink: Extract<ParsedInlineNode, { type: "projectFileLink" }> | null;
  language: string;
}

/** Parse options plus the live reveal cursor; `partial` only ever reaches the block and inline text at the stream frontier. */
export type ThreadRenderOptions = MarkdownParseOptions & {
  /** The stream frontier draws a typewriter caret after its last visible character. */
  caret?: boolean;
  /** Per-paragraph reveal: partial text shows only complete blocks (see holdStreamingBlocks). */
  holdIncompleteBlocks?: boolean;
  reveal?: MarkdownRevealCursor;
};

function settledOptions (options: ThreadRenderOptions): ThreadRenderOptions {
  return options.partial || options.caret ? { ...options, caret: false, partial: false } : options;
}

const FRAMED_BLOCK_TYPES: ReadonlySet<ParsedBlock["type"]> = new Set(["blockquote", "code", "details", "hr", "notice", "ol", "plan", "table", "ul"]);

/** A framed block whose first character is still arriving enters with the style's block motion. */
function renderEnteringBlock (block: ParsedBlock, options: ThreadRenderOptions, key: string, render: () => ReactNode) {
  const startedAt = FRAMED_BLOCK_TYPES.has(block.type) ? options.reveal?.blockEntry() ?? null : null;
  const rendered = render();
  return startedAt === null ? rendered : <ThreadRevealBlock key={key} startedAt={startedAt}>{rendered}</ThreadRevealBlock>;
}

function lastContentBlockIndex (blocks: readonly ParsedBlock[]) {
  return blocks.findLastIndex((block) => block.type !== "break" && block.type !== "list-break");
}

/** Visible text in document order; runs still fading in from the stream are wrapped in their fade. */
function renderRevealedText (text: string, options: ThreadRenderOptions, key: string): ReactNode {
  const cursor = options.reveal;
  if (!cursor) return text;
  return cursor.text(text).map((piece) => piece.startedAt === null
    ? <Fragment key={`${key}-${piece.key}`}>{piece.text}</Fragment>
    : <ThreadRevealText key={`${key}-${piece.key}`} startedAt={piece.startedAt}>{piece.text}</ThreadRevealText>);
}

/** An indivisible inline token (chip, mention, bare icon) fades in whole. */
function renderRevealedAtom (node: ReactNode, visibleLength: number, options: ThreadRenderOptions, key: string): ReactNode {
  const startedAt = options.reveal?.atom(visibleLength) ?? null;
  return startedAt === null ? node : <ThreadRevealText key={key} startedAt={startedAt}>{node}</ThreadRevealText>;
}

export function createSvgCodeBlockPreviewSrcDoc (svgSource: string) {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"color-scheme\" content=\"light dark\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\">",
    `<style>${SVG_PREVIEW_SRC_DOC_STYLE}</style>`,
    "</head>",
    "<body>",
    svgSource,
    "</body>",
    "</html>",
  ].join("");
}

function collectFileLinkRun(nodes: ParsedInlineNode[], start: number) {
  const first = nodes[start];
  if (first?.type !== "projectFileLink") return null;
  const files: Array<Extract<ParsedInlineNode, { type: "projectFileLink" }>> = [first];
  let end = start + 1;
  while (end < nodes.length) {
    let next = end;
    let separatorText = "";
    while (true) {
      const separator = nodes[next];
      if (separator?.type === "break") separatorText += "\n";
      else if (separator?.type === "text") separatorText += separator.text;
      else break;
      next += 1;
    }
    const candidate = nodes[next];
    if (candidate?.type !== "projectFileLink"
      || !/^(?:[\s,;]*|[\s,;]+and[\s,;]+)$/iu.test(separatorText)) break;
    files.push(candidate);
    end = next + 1;
  }
  return files.length > 1 ? { end, files } : null;
}

function fileLinkLabelLength (file: Extract<ParsedInlineNode, { type: "projectFileLink" }>) {
  return (file.label ?? file.relativePath).length;
}

function renderThreadInlineNodes (
  nodes: ParsedInlineNode[],
  keyPrefix: string,
  options: ThreadRenderOptions,
): ReactNode[] {
  let consumedThrough = -1;
  return nodes.map((node, index) => {
    if (index < consumedThrough) return null;
    const key = `${keyPrefix}-${index}`;
    const run = options.profile === "thread" ? collectFileLinkRun(nodes, index) : null;
    if (run) {
      consumedThrough = run.end;
      const visibleLength = run.files.reduce((total, file) => total + fileLinkLabelLength(file), 0);
      return renderRevealedAtom(<ThreadFileList files={run.files} key={key} projectId={options.projectId} />, visibleLength, options, key);
    }

    switch (node.type) {
      case "text":
        return <Fragment key={key}>{renderRevealedText(node.text, options, key)}</Fragment>;
      case "strong":
        return <strong key={key}>{renderThreadInlineNodes(node.children, key, options)}</strong>;
      case "em":
        return <em key={key}>{renderThreadInlineNodes(node.children, key, options)}</em>;
      case "delete":
        return (
          <del
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in srgb, var(--danger) 16%, transparent)] px-[0.08em] text-inherit decoration-current decoration-[0.08em]"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </del>
        );
      case "insert":
        return (
          <ins
            className="-mx-[0.04em] rounded-[0.2em] bg-[color-mix(in srgb, var(--success) 16%, transparent)] px-[0.08em] text-inherit no-underline"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </ins>
        );
      case "code":
        return (
          <ThreadInlineCode key={key}>
            {renderRevealedText(node.text, options, key)}
          </ThreadInlineCode>
        );
      case "break":
        options.reveal?.atom();
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
            className="rounded-[0.35rem] bg-fg/6 px-[0.34em] py-[0.08em] text-fg/60"
            data-inline-comment="true"
            key={key}
          >
            {renderThreadInlineNodes(node.children, key, options)}
          </span>
        );
      case "mark":
        return (
          <mark className="rounded-[0.2em] bg-[color-mix(in srgb, var(--attention) 22%, transparent)] px-[0.08em] text-inherit" key={key}>
            {renderThreadInlineNodes(node.children, key, options)}
          </mark>
        );
      case "underline":
        return <u key={key}>{renderThreadInlineNodes(node.children, key, options)}</u>;
      case "subscript":
        return <sub key={key}>{renderThreadInlineNodes(node.children, key, options)}</sub>;
      case "superscript":
        return <sup key={key}>{renderThreadInlineNodes(node.children, key, options)}</sup>;
      case "markTag":
        return (
          <u data-mark={node.name} key={key} title={node.name}>
            {renderThreadInlineNodes(node.children, key, options)}
          </u>
        );
      case "commentThread":
        return null;
      case "threadIcon": {
        if (!node.children) {
          return renderRevealedAtom(<ThreadInlineIcon color={node.color} iconType={node.iconType} key={key} label={null} />, 1, options, key);
        }
        options.reveal?.atom();
        return (
          <ThreadInlineIcon
            animateLabelTint={options.reveal?.animates ?? false}
            color={node.color}
            iconType={node.iconType}
            key={key}
            label={renderThreadInlineNodes(node.children, key, options)}
          />
        );
      }
      case "attachmentMention":
        return renderRevealedAtom(<span key={key} title={node.number === null ? "Removed attachment" : `Attachment ${node.number}`}
          className={`${getInlineMentionMarkClassName("attachment")} rounded-[0.35rem] px-[0.34em] py-[0.08em] ${node.number === null ? "text-danger" : ""}`}>
          {node.text}
        </span>, node.text.length, options, key);
      case "knownSkillMention":
        return renderRevealedAtom(
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
          </span>,
          node.text.length,
          options,
          key,
        );
      case "projectFileLink": {
        return renderRevealedAtom(
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
          />,
          fileLinkLabelLength(node),
          options,
          key,
        );
      }
    }
  });
}

export function renderThreadInlineMarkdown (
  markdown: string,
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const nodes = renderThreadInlineNodes(parseInlineMarkdown(markdown, options), keyPrefix, options);
  return options.caret ? [...nodes, <ThreadStreamCaret key={`${keyPrefix}-caret`} />] : nodes;
}

/** Only the last content block is at the stream frontier; everything before it is settled. */
function renderThreadBlockSequence (
  parsedBlocks: readonly ParsedBlock[],
  options: ThreadRenderOptions,
  keyFor: (index: number) => string,
  sectionActionsFor?: (block: ParsedBlock) => ReactNode,
) {
  const holding = Boolean(options.partial && options.holdIncompleteBlocks);
  const blocks = holding ? holdStreamingBlocks(parsedBlocks, (markdown) => parseBlocks(markdown, options)) : parsedBlocks;
  const frontierIndex = lastContentBlockIndex(blocks);
  const settled = settledOptions(options);
  // Held text shows only complete blocks, so the last one must not hide its final token as unfinished; it keeps the caret.
  const frontierOptions = holding && frontierIndex >= 0 && !holdsInside(blocks[frontierIndex]!) ? { ...options, partial: false } : options;
  return blocks.map((block, index) => renderEnteringBlock(block, options, `${keyFor(index)}-entry`, () => renderThreadBlock(
    block,
    index === frontierIndex ? frontierOptions : settled,
    keyFor(index),
    sectionActionsFor?.(block),
  )));
}

function renderThreadChildBlocks (
  children: ParsedBlock[],
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  return renderThreadBlockSequence(children, options, (index) => `${keyPrefix}-child-${index}`);
}

function renderThreadListBlock (
  block: Extract<ParsedBlock, { type: "ul" | "ol" }>,
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const Tag = block.type;
  const settled = settledOptions(options);

  return (
    <Tag className={`${BLOCK_SPACING_CLASS} ${block.type === "ul" ? "list-disc" : "list-decimal"} pl-[1.3rem]`} key={keyPrefix}>
      {block.items.map((item, index) => renderThreadListItem(
        item,
        index === block.items.length - 1 ? options : settled,
        `${keyPrefix}-item-${index}`,
      ))}
    </Tag>
  );
}

function renderThreadListItemText (item: ParsedListItem, options: ThreadRenderOptions, keyPrefix: string) {
  return renderThreadInlineMarkdown(item.text, item.children.length ? settledOptions(options) : options, `${keyPrefix}-content`);
}

function renderThreadListItem (
  item: ParsedListItem,
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const content = renderThreadListItemText(item, options, keyPrefix);
  if (!item.children.length) {
    return <li className="[&+li]:mt-1" key={keyPrefix} value={item.ordinal ?? undefined}>{content.length ? content : <br />}</li>;
  }

  const childContent = renderThreadChildBlocks(item.children, options, keyPrefix);
  if (!content.length) {
    return <li className="[&+li]:mt-1" key={keyPrefix} value={item.ordinal ?? undefined}>{childContent}</li>;
  }

  return (
    <li className="[&+li]:mt-1" key={keyPrefix} value={item.ordinal ?? undefined}>
      <details
        className="block min-w-0 max-w-full"
        open
      >
        <summary className="flex min-w-0 max-w-full cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">{content}</span>
          <ChevronIcon
            className="ml-[0.12em] transform-[rotate(-90deg)] [details[open]>summary_&]:transform-[rotate(0deg)] transition-transform"
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
  options: ThreadRenderOptions,
) {
  return (options.profile ?? "editor") === "thread"
    && block.items.length === 1
    && /^\d+[.)]$/.test(block.items[0].marker);
}

function renderThreadSingleItemOrderedStep (
  block: Extract<ParsedBlock, { type: "ol" }>,
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const item = block.items[0];
  const content = renderThreadListItemText(item, options, keyPrefix);
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

function renderThreadStateChange (mode: string, keyPrefix: string, sectionActions?: ReactNode) {
  return (
    <div
      className={`
        relative my-[0.85em] flex items-center gap-2 font-sans leading-none text-fg/muted last:mb-0
        before:(block h-px flex-1 bg-[color-mix(in srgb, var(--text) 10%, transparent)] content-[''])
        after:(block h-px flex-1 bg-[color-mix(in srgb, var(--text) 10%, transparent)] content-[''])
      `}
      data-thread-state-change="true"
      data-thread-state-mode={mode}
      key={keyPrefix}
    >
      <span className="text-[0.62em] font-medium uppercase tracking-[0.14em]" data-thread-state-change-kicker="true">Mode</span>
      <span className="text-[0.84em] font-semibold text-text" data-thread-state-change-label="true">{formatThreadStateChangeMode(mode)}</span>
      {sectionActions}
    </div>
  );
}

function renderThreadMarkdownBlocks (markdown: string, options: ThreadRenderOptions, keyPrefix: string) {
  return renderThreadBlockSequence(parseBlocks(markdown, options), options, (index) => `${keyPrefix}-${index}`);
}

function renderThreadPlanBlock (
  block: Extract<ParsedBlock, { type: "plan" }>,
  options: ThreadRenderOptions,
  keyPrefix: string,
  sectionActions?: ReactNode,
) {
  const content = renderThreadMarkdownBlocks(block.text, options, `${keyPrefix}-content`);
  const disclosure = (
    <Disclosure
      className={sectionActions === undefined ? BLOCK_SPACING_CLASS : undefined}
      contentClassName="mt-2"
      initialOpen
      key={keyPrefix}
      summary={<ThreadPlanSummary markdown={block.text} />}
      summaryClassName="text-[0.92em] font-medium leading-[1.6]"
    >
      <ThreadPreviewFrame
        backgroundClassName="before:bg-[linear-gradient(to right, transparent, #8882 10%, #8882 90%, transparent)]"
        contentClassName="mb-8 px-4 py-8"
        edgeBleed="wide"
        edgeOffset="none"
        mode="panel"
      >
        {content.length ? content : <p className={BLOCK_SPACING_CLASS}><br /></p>}
      </ThreadPreviewFrame>
    </Disclosure>
  );
  if (sectionActions === undefined) return disclosure;
  // A closed <details> hides non-summary children, so section actions hang from a wrapper that owns the spacing.
  return (
    <div className={`relative ${BLOCK_SPACING_CLASS}`} key={keyPrefix}>
      {disclosure}
      {sectionActions}
    </div>
  );
}

function renderThreadDetailsBlock (block: Extract<ParsedBlock, { type: "details" }>, options: ThreadRenderOptions, keyPrefix: string) {
  return (
    <div className={BLOCK_SPACING_CLASS} key={keyPrefix}>
      <Disclosure
        contentClassName="mt-[0.25em] pl-[1.625rem]"
        initialOpen={block.open}
        summary={renderThreadInlineMarkdown(block.summary, block.text ? settledOptions(options) : options, `${keyPrefix}-summary`)}
        summaryClassName="font-semibold !text-text"
      >
        {renderThreadMarkdownBlocks(block.text, options, `${keyPrefix}-content`)}
      </Disclosure>
    </div>
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
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const content = renderThreadInlineMarkdown(cell.text, options, keyPrefix);
  return content.length ? content : <br />;
}

function renderThreadTableBlock (
  block: Extract<ParsedBlock, { type: "table" }>,
  options: ThreadRenderOptions,
  keyPrefix: string,
) {
  const settled = settledOptions(options);
  const frontierRow = block.rows.length ? block.rows.at(-1)! : block.header;
  const cellOptions = (row: readonly ParsedTableCell[], columnIndex: number) => (
    row === frontierRow && columnIndex === row.length - 1 ? options : settled
  );
  return (
    <div
      className={`${BLOCK_SPACING_CLASS} max-w-full overflow-hidden rounded-[0.75rem] bg-[color-mix(in srgb, var(--text) 4%, transparent)]`}
      key={keyPrefix}
    >
      <div className="max-w-full overflow-x-auto [container-type:inline-size]">
        <table className="w-max min-w-full border-collapse font-sans text-[0.92em] leading-[1.45]">
          <thead>
            <tr className="border-b-2 border-[color-mix(in srgb, var(--text) 16%, transparent)] bg-[color-mix(in srgb, var(--text) 5%, transparent)]">
              {block.header.map((cell, index) => (
                <th
                  className={`${getThreadTableCellAlignClassName(block.alignments[index] ?? null)} ${THREAD_TABLE_CELL_CLASS} px-[0.65rem] py-[0.48rem] text-[0.82em] font-semibold text-text align-top`}
                  key={`${keyPrefix}-header-${index}`}
                  scope="col"
                >
                  {renderThreadTableCellContent(cell, cellOptions(block.header, index), `${keyPrefix}-header-${index}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                className="border-t border-[color-mix(in srgb, var(--text) 7%, transparent)] first:border-t-0"
                key={`${keyPrefix}-row-${rowIndex}`}
              >
                {block.header.map((_, columnIndex) => {
                  const cell = row[columnIndex] ?? { text: "" };
                  return (
                    <td
                      className={`${getThreadTableCellAlignClassName(block.alignments[columnIndex] ?? null)} ${THREAD_TABLE_CELL_CLASS} px-[0.85rem] py-[0.5rem] align-top text-text`}
                      key={`${keyPrefix}-row-${rowIndex}-cell-${columnIndex}`}
                    >
                      {renderThreadTableCellContent(cell, cellOptions(row, columnIndex), `${keyPrefix}-row-${rowIndex}-cell-${columnIndex}`)}
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

function renderThreadNoticeBlock (block: Extract<ParsedBlock, { type: "notice" }>, options: ThreadRenderOptions, keyPrefix: string) {
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

function renderThreadDiffCodeBlock (text: string, keyPrefix: string, options: ThreadRenderOptions) {
  const lines = text.split("\n");

  return lines.map((line, index) => {
    const displayLine = splitUnifiedDiffLine(line);
    const lineKey = `${keyPrefix}-diff-line-${index}`;

    return (
      <Fragment key={lineKey}>
        <span
          className={`block min-h-[1lh] px-[0.95rem] ${DIFF_CODE_BLOCK_LINE_CLASS_NAMES[displayLine.type]}`}
          data-thread-codeblock-diff-line={displayLine.type}
        >
          {displayLine.prefix ? (
            <span className="sr-only" data-thread-codeblock-diff-prefix="true">{displayLine.prefix}</span>
          ) : null}
          {renderRevealedText(displayLine.text, options, lineKey)}
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

/** Code body is rendered (and reveal-split) in document order by the caller; the component only owns chrome state. */
function ThreadCodeBlock ({
  block,
  content,
  header,
  keyPrefix,
  options,
}: {
  block: Extract<ParsedBlock, { type: "code" }>;
  content: ReactNode;
  header: ThreadCodeBlockHeader;
  keyPrefix: string;
  options: MarkdownParseOptions;
}) {
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
      className={`${BLOCK_SPACING_CLASS} max-w-full overflow-hidden rounded-[0.75rem] bg-[color-mix(in srgb, var(--text) 4%, transparent)]`}
      data-thread-codeblock="true"
      data-thread-codeblock-diff={isDiffCodeBlock ? "true" : undefined}
    >
      <div className="flex min-h-[2.05rem] items-center justify-between gap-2 border-b border-[color-mix(in srgb, var(--text) 8%, transparent)] px-[0.65rem] py-[0.28rem]">
        <span className="flex min-w-0 items-center gap-1.5 pl-[0.15rem] font-mono text-[0.72em] leading-none text-fg/muted">
          <span className="min-w-0 truncate">{language || "code"}</span>
          {header.fileLink ? renderThreadInlineNodes([header.fileLink], `${keyPrefix}-header-file`, options) : null}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
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
          </IconButton>
          {isSvgCodeBlock ? (
            <IconButton
              type="button"
              label={isSvgPreviewing ? "Show SVG source" : "Preview SVG code block"}
              display="hover-border"
              size="compact"
              aria-pressed={isSvgPreviewing}
              className={CODE_BLOCK_HEADER_BUTTON_CLASS}
              data-thread-codeblock-toggle-state={isSvgPreviewing ? "active" : "idle"}
              onClick={() => setIsSvgPreviewing((current) => !current)}
              title={isSvgPreviewing ? "Show SVG source" : "Preview SVG code block"}
            >
              <PreviewIcon size={16} />
            </IconButton>
          ) : null}
          <IconButton
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
          </IconButton>
        </div>
      </div>
      <div className="relative min-h-[2.8rem]" data-thread-codeblock-body="true">
        <pre
          className={`
            max-w-full overflow-x-auto whitespace-pre py-[0.8rem]
            code-wrap:overflow-x-hidden code-wrap:wrap-anywhere code-wrap:whitespace-pre-wrap code-wrap:[word-break:break-word]
            ${isDiffCodeBlock ? "px-0" : "px-[0.95rem]"}
            ${isSvgPreviewing ? "invisible pointer-events-none" : ""}
          `}
          data-language={language}
          data-thread-codeblock-pre="true"
        >
          <code
            className="
              block w-max min-w-full rounded-none bg-transparent p-0 font-mono text-[0.94em]
              code-wrap:max-w-full code-wrap:min-w-0 code-wrap:w-full code-wrap:wrap-anywhere code-wrap:[white-space:inherit]
            "
            data-thread-codeblock-code="true"
          >
            {content}
          </code>
        </pre>
        {svgPreviewSrcDoc ? (
          <div className="absolute inset-0 overflow-auto p-[0.95rem]">
            <ThreadVisFrame className="size-full" document={svgPreviewSrcDoc} key={svgPreviewSrcDoc} title="SVG code block preview" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderThreadCodeBlock (block: Extract<ParsedBlock, { type: "code" }>, options: ThreadRenderOptions, keyPrefix: string) {
  const { reveal: _reveal, ...chromeOptions } = options;
  const header = parseThreadCodeBlockHeader(block.language, chromeOptions);
  const content = <>
    {isDiffCodeBlockLanguage(header.language)
      ? renderThreadDiffCodeBlock(block.text, keyPrefix, options)
      : renderRevealedText(block.text, options, `${keyPrefix}-code`)}
    {options.caret ? <ThreadStreamCaret /> : null}
  </>;
  return (
    <ThreadCodeBlock block={block} content={content} header={header} key={keyPrefix} keyPrefix={keyPrefix} options={chromeOptions} />
  );
}

function renderThreadBlock (
  block: ParsedBlock,
  options: ThreadRenderOptions,
  keyPrefix: string,
  sectionActions?: ReactNode,
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
      return <Tag className={HEADING_CLASSES[block.level as 1 | 2 | 3 | 4 | 5 | 6]} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix)}</Tag>;
    }
    case "blockquote":
      return (
        <blockquote
          className={`${BLOCK_SPACING_CLASS} border-l-[0.18rem] [border-left-color: color-mix(in srgb, var(--text) 14%, transparent)] pl-[0.9rem] text-fg/muted`}
          key={keyPrefix}
        >
          {renderThreadInlineMarkdown(block.text, options, keyPrefix)}
        </blockquote>
      );
    case "plan":
      return renderThreadPlanBlock(block, options, keyPrefix, sectionActions);
    case "details":
      return renderThreadDetailsBlock(block, options, keyPrefix);
    case "notice":
      return renderThreadNoticeBlock(block, options, keyPrefix);
    case "comment":
      return (
        <p
          className={`${BLOCK_SPACING_CLASS} mx-0 rounded-[0.6rem] bg-fg/6 px-[0.75rem] py-[0.55rem] text-[0.9em] text-fg/60`}
          data-block-comment="true"
          key={keyPrefix}
        >
          {renderRevealedText(parseCommentLine(block.text)?.map((comment) => comment.body).join(" ") ?? block.text, options, keyPrefix)}
        </p>
      );
    case "suggestion":
      return null;
    case "ul":
      return renderThreadListBlock(block, options, keyPrefix);
    case "ol":
      return isThreadSingleItemOrderedStep(block, options)
        ? renderThreadSingleItemOrderedStep(block, options, keyPrefix)
        : renderThreadListBlock(block, options, keyPrefix);
    case "hr":
      return <hr className="[margin-inline: 10%] my-8 [border-color: color-mix(in srgb, var(--text), var(--app-bg-solid) 70%)]" key={keyPrefix} />;
    case "code":
      return renderThreadCodeBlock(block, options, keyPrefix);
    case "table":
      return renderThreadTableBlock(block, options, keyPrefix);
    case "paragraph": {
      const stateChangeMode = parseThreadStateChangeMode(block.text, options);
      if (stateChangeMode) {
        options.reveal?.atom(stateChangeMode.length);
        return renderThreadStateChange(stateChangeMode, keyPrefix, sectionActions);
      }

      return <p className={BLOCK_SPACING_CLASS} key={keyPrefix}>{renderThreadInlineMarkdown(block.text, options, keyPrefix)}</p>;
    }
  }
}

/** `partial` marks text still streaming; `reveal` walks visible text so newly streamed runs fade in. */
export function renderThreadMarkdown (
  markdown: string,
  options: ThreadRenderOptions = {},
) {
  const threadOptions = {
    ...options,
    profile: "thread",
  } satisfies ThreadRenderOptions;
  let sectionBreakIndex = 0;
  const renderedBlocks = renderThreadBlockSequence(
    parseBlocks(markdown, threadOptions),
    threadOptions,
    (index) => `thread-markdown-${index}`,
    (block) => isThreadMarkdownSectionBreak(block, threadOptions)
      ? <ThreadMarkdownSectionActions breakIndex={sectionBreakIndex++} />
      : undefined,
  );

  return renderedBlocks.length ? renderedBlocks : <p className={BLOCK_SPACING_CLASS}><br /></p>;
}
