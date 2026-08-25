/*
 * Exports:
 * - ThreadTextBlock: render wrapped plain thread text with optional monospace styling. Keywords: workbench, thread, text.
 * - ThreadCommandSummary: render the compact command summary label used in thread turns. Keywords: workbench, thread, command.
 */
"use client";

import type { ReactNode } from "react";
import { getInlineMentionMarkClassName } from "../../../lib/workbench/thread/inline-mention-styles";
import type {
  ThreadCommandDisplayPart,
  ThreadCommandSummaryDisplay,
} from "../../../lib/workbench/thread/thread-command-matchers";

import ProjectFilePath from "../ProjectFilePath";
import ThreadInlineCode from "./ThreadInlineCode";
import ThreadSummaryText from "./ThreadSummaryText";

const THREAD_SKILL_MENTION_CLASS = `
${getInlineMentionMarkClassName("skill")}
rounded-[0.35rem] px-[0.34em] py-[0.08em]
font-mono text-[0.94em]
`;

type RegexPatternTokenKind = "escape" | "group" | "literal" | "operator";

interface RegexPatternToken {
  kind: RegexPatternTokenKind;
  text: string;
}

const REGEX_TOKEN_CLASS_NAMES: Record<RegexPatternTokenKind, string> = {
  escape: "text-muted",
  group: "text-[color:color-mix(in_srgb,var(--accent)_30%,var(--text)_70%)]",
  literal: "text-text",
  operator: "text-muted",
};

function tokenizeRegexPattern(pattern: string) {
  const tokens: RegexPatternToken[] = [];
  let inCharacterClass = false;
  const append = (kind: RegexPatternTokenKind, text: string) => {
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else tokens.push({ kind, text });
  };

  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === "\\") {
      append("escape", character);
      if (index + 1 < pattern.length) append("literal", pattern[index + 1] ?? "");
      index += Math.min(2, pattern.length - index);
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") {
        append("operator", character);
        inCharacterClass = false;
      } else if (character === "-" || character === "^") {
        append("operator", character);
      } else {
        append("literal", character);
      }
      index += 1;
      continue;
    }
    if (character === "[") {
      append("operator", character);
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      append("group", character);
      index += 1;
      continue;
    }
    if (character === "{") {
      const quantifier = /^\{\d+(?:,\d*)?\}/u.exec(pattern.slice(index))?.[0];
      if (quantifier) {
        append("operator", quantifier);
        index += quantifier.length;
        continue;
      }
    }
    if ("|^$.*+?".includes(character)) {
      append("operator", character);
      index += 1;
      continue;
    }
    append("literal", character);
    index += 1;
  }
  return tokens;
}

function ThreadCommandPattern({ pattern, syntax }: { pattern: string; syntax: "literal" | "regex" }) {
  const tokens = syntax === "regex" ? tokenizeRegexPattern(pattern) : [{ kind: "literal" as const, text: pattern }];
  return (
    <span className="contents" data-thread-command-pattern={syntax}>
      <ThreadInlineCode
        className="inline-block shrink-1 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom text-text [font-variant-ligatures:none]"
        title={pattern}
      >
        {tokens.map((token, index) => (
          <span
            className={REGEX_TOKEN_CLASS_NAMES[token.kind]}
            data-thread-pattern-token={token.kind}
            key={`${token.kind}:${index}`}
          >
            {token.text}
          </span>
        ))}
      </ThreadInlineCode>
    </span>
  );
}

export function ThreadTextBlock ({
  children,
  monospace = false,
}: {
  children: ReactNode;
  monospace?: boolean;
}) {
  return (
    <div className={`whitespace-pre-wrap break-words ${monospace ? "font-mono text-[0.78em] leading-[1.6]" : ""}`}>
      {children}
    </div>
  );
}

function ThreadCommandStageArrowIcon () {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      className="size-5.5 shrink-0 opacity-30"
    >
      <path d="M3.75 10H14.25" strokeLinecap="round" />
      <path d="M10.75 6L14.75 10L10.75 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function splitCommandSummaryStages (parts: ThreadCommandDisplayPart[]) {
  const stages: ThreadCommandDisplayPart[][] = [[]];

  for (const part of parts) {
    if (part.type === "separator") {
      if (stages[stages.length - 1]?.length) {
        stages.push([]);
      }
      continue;
    }

    stages[stages.length - 1]?.push(part);
  }

  return stages.filter((stage) => stage.length);
}

function ThreadCommandStageParts ({
  parts,
  projectFilePaths,
  projectId,
}: {
  parts: ThreadCommandDisplayPart[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
  return (
    <>
      {parts.map((part, index) => (
        part.type === "separator" ? null : part.type === "skill" ? (
          <span
            key={`skill:${part.path}:${index}`}
            className={THREAD_SKILL_MENTION_CLASS}
            title={part.path}
          >
            /{part.name}
          </span>
        ) : part.type === "path" ? (
          <ProjectFilePath
            key={`path:${part.path}:${part.lineNumber ?? ""}:${part.columnNumber ?? ""}:${index}`}
            className="max-w-full shrink min-w-0 align-baseline"
            columnNumber={part.columnNumber ?? null}
            disambiguationPaths={projectFilePaths}
            label={part.label}
            lineNumber={part.lineNumber ?? null}
            path={part.path}
            projectId={projectId}
          />
        ) : part.type === "pattern" ? (
          <ThreadCommandPattern key={`pattern:${part.pattern}:${index}`} pattern={part.pattern} syntax={part.syntax} />
        ) : (
          <span key={`text:${index}`} className="contents">
            {part.variant === "code" ? (
              <ThreadInlineCode
                className={part.clamp ? "inline-block shrink-1 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom" : ""}
                title={part.clamp ? part.text : undefined}
              >
                {part.text}
              </ThreadInlineCode>
            ) : part.variant === "primary" ? (
              <span className="font-medium whitespace-nowrap text-text">
                {part.text}
              </span>
            ) : (
              <ThreadSummaryText text={part.text} />
            )}
          </span>
        )
      ))}
    </>
  );
}

export function ThreadCommandSummary ({
  display,
  projectFilePaths,
  projectId,
}: {
  display: ThreadCommandSummaryDisplay;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
  const stages = splitCommandSummaryStages(display.summaryParts);

  return (
    <span className="inline-flex max-w-[calc(100%-0.6rem)] min-w-0 flex-wrap items-center gap-x-[0.45rem] gap-y-[0.3rem] align-bottom">
      {display.showShell && display.shell ? (
        <span className="shrink-0 font-mono text-[0.78em] leading-[1.6] text-muted">
          {display.shell}:
        </span>
      ) : null}
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-[0.45rem] gap-y-[0.3rem]">
        {stages.map((stage, index) => (
          index === 0 ? (
            <span key={`stage:${index}`} className="inline-flex min-w-0 max-w-full items-baseline gap-[0.3rem]">
              <ThreadCommandStageParts parts={stage} projectFilePaths={projectFilePaths} projectId={projectId} />
            </span>
          ) : (
            <span
              key={`stage:${index}`}
              className="inline-flex min-w-0 max-w-full items-center gap-[0.3rem]"
            >
              <ThreadCommandStageArrowIcon />
              <span className="inline-flex min-w-0 max-w-full items-baseline gap-[0.3rem]">
                <ThreadCommandStageParts parts={stage} projectFilePaths={projectFilePaths} projectId={projectId} />
              </span>
            </span>
          )
        ))}
      </span>
    </span>
  );
}
