/*
 * Exports:
 * - default ThreadDynamicToolCallItem: render generic tool calls and Workbench questionnaire history.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type {
  WorkbenchUserInputOption,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../workbench/thread/inline-mention-highlights";
import {
  buildQuestionnaireTranscriptPairs,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import ThreadBubbleCopyButton from "./ThreadBubbleCopyButton";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadMessageTimestamp from "./ThreadMessageTimestamp";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadToolCallDetails from "./ThreadToolCallDetails";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import { getOpenCodeToolDisplay, isOpenCodeFileOperation, getThreadCommandOutcomeDisplay } from "../../../workbench/thread/thread-command-matchers";
import { ThreadCommandSummary } from "./thread-view-primitives";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { formatDynamicToolInvocation, formatToolCallOutput } from "./format-thread-tool-call";
import { humanizeThreadLabel } from "./thread-view-formatters";
import { useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { readGlobalWorkbenchSettings, readProjectWorkbenchSettings, resolveWorkbenchSettings } from "../../../workbench/state/workbench-settings";

type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

const WORKBENCH_QUESTIONNAIRE_TOOL_NAME = "workbench_request_user_input";
const INLINE_CODE_CLASS = "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.78em] leading-[1.6] text-text";
const MAX_QUESTIONNAIRE_SUMMARY_LABELS = 3;

function asRecord (value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString (value: unknown) {
  return typeof value === "string" ? value : null;
}

function asBoolean (value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function createFallbackQuestionId (index: number) {
  return `question-${index + 1}`;
}

function parseQuestionOptions (value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = asRecord(entry);
    const label = asString(record?.label)?.trim() ?? "";
    if (!label) {
      return null;
    }

    return {
      description: asString(record?.description)?.trim() ?? "",
      label,
    } satisfies WorkbenchUserInputOption;
  }).filter((entry): entry is WorkbenchUserInputOption => entry !== null);
}

function parseQuestion (value: unknown, index: number) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const header = asString(record.header)?.trim() ?? "";
  const questionText = asString(record.question)?.trim() ?? "";
  const options = parseQuestionOptions(record.options);
  if (!header && !questionText && !options.length) {
    return null;
  }

  const parsedQuestion: WorkbenchUserInputQuestion = {
    allowOther: false,
    header,
    id: asString(record.id)?.trim() || createFallbackQuestionId(index),
    isSecret: asBoolean(record.isSecret),
    options,
    question: questionText,
  };

  return parsedQuestion;
}

function parseQuestionnaireRequest (value: unknown, requestId: string) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const title = asString(record.title)?.trim() ?? "";
  const summary = asString(record.summary)?.trim() ?? "";
  const submitLabel = asString(record.submitLabel)?.trim() ?? "";
  const questions = Array.isArray(record.questions)
    ? record.questions.map((entry, index) => parseQuestion(entry, index)).filter((entry): entry is WorkbenchUserInputQuestion => entry !== null)
    : [];

  if (!title && !summary && !questions.length) {
    return null;
  }

  return {
    id: requestId,
    questions,
    submitLabel,
    summary,
    title: title || "User input request",
  } satisfies WorkbenchUserInputRequest;
}

function parseQuestionnaireResponse (item: DynamicToolCallItem) {
  const rawText = item.contentItems?.filter((entry): entry is Extract<NonNullable<DynamicToolCallItem["contentItems"]>[number], { type: "inputText" }> => entry.type === "inputText")
    .map((entry) => entry.text)
    .join("\n\n")
    .trim() ?? "";
  if (!rawText) {
    return {
      rawText: "",
      response: null,
    };
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    const record = asRecord(parsed);
    const answersRecord = asRecord(record?.answers);
    if (!answersRecord) {
      return {
        rawText,
        response: null,
      };
    }

    const answers = Object.fromEntries(Object.entries(answersRecord).map(([questionId, answerValue]) => {
      const answerRecord = asRecord(answerValue);
      const answerList = Array.isArray(answerRecord?.answers)
        ? answerRecord.answers.filter((entry): entry is string => typeof entry === "string")
        : [];
      return [questionId, { answers: answerList }];
    }));

    return {
      rawText,
      response: {
        answers,
      } satisfies WorkbenchUserInputResponse,
    };
  } catch {
    return {
      rawText,
      response: null,
    };
  }
}

function renderQuestionnaireTopicList (labels: string[], hiddenCount: number) {
  const nodes: ReactNode[] = [];

  labels.forEach((label, index) => {
    if (index > 0) {
      nodes.push(index === labels.length - 1 && hiddenCount === 0 ? " and " : ", ");
    }
    nodes.push(<span key={`label:${index}`} className="font-medium text-text">{label}</span>);
  });

  if (hiddenCount > 0) {
    nodes.push(labels.length ? ", and " : "");
    nodes.push(`${hiddenCount} more`);
  }

  return nodes;
}

function renderQuestionnaireHistorySummary (request: WorkbenchUserInputRequest | null) {
  if (!request || request.questions.length <= 1) {
    return (
      <>
        <span>Asked: </span>
        <span className="font-medium text-text">
          {request ? getSingleQuestionnaireSummaryLabel(request) : "User input request"}
        </span>
      </>
    );
  }

  const visibleLabels = request.questions
    .map((question, index) => getQuestionnaireTopicLabel(question, index))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONNAIRE_SUMMARY_LABELS);
  const hiddenCount = Math.max(0, request.questions.length - visibleLabels.length);

  if (!visibleLabels.length) {
    return (
      <>
        <span>Asked: </span>
        <span className="font-medium text-text">{request.title.trim() || "User input request"}</span>
      </>
    );
  }

  return (
    <>
      <span>Asked about </span>
      {renderQuestionnaireTopicList(visibleLabels, hiddenCount)}
    </>
  );
}

function ThreadQuestionnaireTranscriptPreview ({
  answeredAt,
  inlineMentionSources,
  pairs,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  answeredAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  pairs: Array<{ answerMarkdown: string; promptText: string }>;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!pairs.length) {
    return null;
  }

  return (
    <div className="mt-2 flex w-full flex-col gap-2">
      {pairs.map((pair, index) => (
        <div key={`pair:${index}`} className="flex w-full flex-col gap-1.5">
          {pair.promptText ? (
            <div className="max-w-[34rem] whitespace-pre-wrap break-words text-[0.86em] leading-[1.55] text-text">
              {pair.promptText}
            </div>
          ) : null}
          <div className="group/thread-bubble relative ml-auto w-fit max-w-[min(42rem,86%)] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))] px-4 py-3 text-left leading-[1.55] text-text">
            <ThreadMarkdown
              className="text-[0.98em] leading-[1.55] [&_h3]:mb-[0.2em] [&_h3]:text-[1.15em] [&_p]:leading-[1.55]"
              inlineMentionSources={inlineMentionSources}
              markdown={pair.answerMarkdown}
              threadCwdPath={threadCwdPath}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              workspaceRoots={workspaceRoots}
            />
            <ThreadBubbleCopyButton markdown={pair.answerMarkdown} side="right" />
          </div>
          <ThreadMessageTimestamp align="right" timestampSeconds={answeredAt === null ? null : answeredAt / 1_000} />
        </div>
      ))}
    </div>
  );
}

function ThreadQuestionnaireHistorySummary ({
  answeredAt,
  inlineMentionSources,
  isOpen,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  request,
  response,
  workspaceRoots,
}: {
  answeredAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  isOpen: boolean;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  request: WorkbenchUserInputRequest | null;
  response: WorkbenchUserInputResponse | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const transcriptPairs = request ? buildQuestionnaireTranscriptPairs(request, response) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-w-0">{renderQuestionnaireHistorySummary(request)}</div>
      {!isOpen ? (
        <ThreadQuestionnaireTranscriptPreview
          answeredAt={answeredAt}
          inlineMentionSources={inlineMentionSources}
          pairs={transcriptPairs}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          workspaceRoots={workspaceRoots}
        />
      ) : null}
    </div>
  );
}

function buildMetaParts (item: DynamicToolCallItem) {
  const metaParts: ReactNode[] = [];

  if (item.status !== "completed") {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:status`}
        text={humanizeThreadLabel(item.status)}
      />,
    );
  }

  if (item.durationMs !== null) {
    metaParts.push(
      <ThreadDurationText
        key={`${item.id}:duration`}
        durationMs={item.durationMs}
      />,
    );
  }

  return metaParts;
}

function ThreadQuestionnaireToolCallItem ({
  answeredAt,
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  answeredAt: number | null;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: DynamicToolCallItem;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const request = parseQuestionnaireRequest(item.arguments, `history:${item.id}`);
  const { response } = parseQuestionnaireResponse(item);
  const statusLabel = response ? "Answered" : "Unanswered";
  const [isOpen, setIsOpen] = useState(item.status !== "completed" || !response);

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      open={isOpen}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
      chevronClassName="mt-[0.22em]"
      summary={(
        <ThreadQuestionnaireHistorySummary
          answeredAt={response ? answeredAt : null}
          inlineMentionSources={inlineMentionSources}
          isOpen={isOpen}
          threadCwdPath={threadCwdPath}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          request={request}
          response={response}
          workspaceRoots={workspaceRoots}
        />
      )}
      summaryClassName="items-start text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <>
        <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_4%,var(--app-bg-solid))] p-3">
          {request ? (
            <ThreadUserInputRequest
              mode="history"
              request={request}
              response={response}
              statusLabel={item.durationMs !== null ? `${statusLabel} | ${Math.round(item.durationMs)}ms` : statusLabel}
            />
          ) : item.status === "inProgress" ? (
            <p className="m-0 px-1 py-1 text-[0.84em] leading-[1.6] text-fg/muted">
              Waiting for a response in the composer.
            </p>
          ) : (
            <p className="m-0 px-1 py-1 text-[0.84em] leading-[1.6] text-fg/muted">
              Questionnaire details unavailable.
            </p>
          )}
        </div>
        {response ? <ThreadMessageTimestamp align="right" timestampSeconds={answeredAt === null ? null : answeredAt / 1_000} /> : null}
      </>
    </ThreadDisclosure>
  );
}

function ThreadGenericDynamicToolCallItem ({
  item,
  hasCapturedChildren,
  projectFilePaths,
  projectId,
}: {
  item: DynamicToolCallItem;
  hasCapturedChildren?: boolean;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
}) {
  const metaParts = buildMetaParts(item);
  const display = getOpenCodeToolDisplay(item);
  const outcome = item.success === false ? "failed" : item.status;
  const outcomeDisplay = display ? getThreadCommandOutcomeDisplay(display, outcome) : null;
  const state = useWorkbenchClientStateSnapshot();
  const settings = resolveWorkbenchSettings(
    readGlobalWorkbenchSettings(state.records),
    readProjectWorkbenchSettings(state.daemonRegistrationId, projectId ?? "", state.records),
  );
  if (hasCapturedChildren && !settings.threadCodeDetails && outcome !== "failed") return null;

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      summary={(
        <>
          {hasCapturedChildren ? <ThreadSummaryText text="Code details" />
            : outcomeDisplay ? <ThreadCommandSummary display={outcomeDisplay} projectFilePaths={projectFilePaths} projectId={projectId} />
            : <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-[0.45rem]">
            <ThreadSummaryText text="Tool" />
            {item.namespace ? <code className={INLINE_CODE_CLASS}>{item.namespace}</code> : null}
            <code className={INLINE_CODE_CLASS}>{item.tool}</code>
          </span>}
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-fg/muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-fg/muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      renderContent={() => <ThreadToolCallDetails
        invocation={formatDynamicToolInvocation({ argumentsValue: item.arguments, namespace: item.namespace, tool: item.tool })}
        output={formatToolCallOutput({ content: item.contentItems })}
      />}
    />
  );
}

export default function ThreadDynamicToolCallItem ({
  answeredAt = null,
  hasCapturedChildren,
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  answeredAt?: number | null;
  hasCapturedChildren?: boolean;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: DynamicToolCallItem;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME) {
    return <ThreadQuestionnaireToolCallItem answeredAt={answeredAt} inlineMentionSources={inlineMentionSources} item={item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  if (isOpenCodeFileOperation(item)) {
    return <ThreadFileChangeItem items={[item]} projectFilePaths={projectFilePaths} projectId={projectId}
      projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }
  return <ThreadGenericDynamicToolCallItem item={item} hasCapturedChildren={hasCapturedChildren}
    projectFilePaths={projectFilePaths} projectId={projectId} />;
}
