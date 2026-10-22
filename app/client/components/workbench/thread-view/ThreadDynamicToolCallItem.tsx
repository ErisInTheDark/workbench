/*
 * Exports:
 * - default ThreadDynamicToolCallItem: render generic tool calls and code-mode executions as step rows, Workbench questionnaire history and MCP tool enable decisions.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { repairQuestionnaireQuestion } from "workbench-shared/workbench/thread/thread-questionnaire-request";
import type {
  WorkbenchUserInputOption,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "workbench-shared/types";
import { useProject } from "../use-projects";
import {
  buildQuestionnaireTranscriptPairs,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import ThreadBubbleCopyButton from "./ThreadBubbleCopyButton";
import Disclosure from "../../ui/Disclosure";
import ThreadDurationText from "./ThreadDurationText";
import MarkdownRender from "../../ui/MarkdownRender";
import ThreadMessageTimestamp from "./ThreadMessageTimestamp";
import ThreadStepRow from "./ThreadStepRow";
import ThreadSummaryText from "./ThreadSummaryText";
import { ThreadHydratedToolCallDetails } from "./ThreadToolCallDetails";
import { getCommandIcon } from "./thread-activity-chips";
import { CodeIcon } from "../workbench-icons";
import ThreadFileChangeItem from "./ThreadFileChangeItem";
import { getNativeToolDisplay, isNativeFileOperation, getThreadCommandOutcomeDisplay } from "../../../workbench/thread/thread-command-matchers";
import { ThreadCommandSummary } from "./thread-view-primitives";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { ThreadMcpDecisionCard, type ThreadMcpRequestSubject } from "./ThreadMcpToolRequest";
import { isMcpToolRequestApproved } from "workbench-shared/workbench/mcp/mcp-tool-request";
import { formatDynamicToolInvocation, formatToolCallOutput } from "./format-thread-tool-call";
import { humanizeThreadLabel } from "./thread-view-formatters";
import { useThreadItemLiveDuration } from "./use-thread-live-duration";

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

function parseQuestionOptions (value: unknown): WorkbenchUserInputOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      description: asString(record?.description) ?? "",
      label: asString(record?.label) ?? "",
    };
  });
}

function parseQuestion (value: unknown, index: number) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return repairQuestionnaireQuestion(index, {
    allowOther: typeof record.allowOther === "boolean" ? record.allowOther
      : typeof record.isOther === "boolean" ? record.isOther : undefined,
    header: asString(record.header),
    id: asString(record.id),
    isSecret: asBoolean(record.isSecret),
    options: parseQuestionOptions(record.options),
    question: asString(record.question),
  });
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

/** What an MCP enable or sign-in request was about, when this questionnaire was one. */
function parseMcpRequestSubject (value: unknown): ThreadMcpRequestSubject | null {
  const request = asRecord(value);
  const tool = asRecord(request?.mcpTool);
  const toolServer = asString(tool?.server);
  const toolName = asString(tool?.tool);
  if (tool && toolServer && toolName) {
    return { kind: "tool", tool: { server: toolServer, tool: toolName, title: asString(tool.title), description: asString(tool.description) ?? "" } };
  }
  const authorization = asRecord(request?.mcpAuthorization);
  const server = asString(authorization?.server);
  const host = asString(authorization?.host);
  return server && host ? { kind: "authorization", authorization: { server, host } } : null;
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
  pairs,
}: {
  answeredAt: number | null;
  pairs: Array<{ answerMarkdown: string; promptText: string }>;
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
          <div className="group/thread-bubble relative ml-auto w-fit max-w-[min(42rem,86%)] rounded-[1.15rem] bg-fg/6 px-4 py-3 text-left leading-[1.55] text-text">
            <MarkdownRender
              className="text-[0.98em] leading-[1.55] [&_h3]:mb-[0.2em] [&_h3]:text-[1.15em] [&_p]:leading-[1.55]"
              markdown={pair.answerMarkdown}
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
  isOpen,
  request,
  response,
}: {
  answeredAt: number | null;
  isOpen: boolean;
  request: WorkbenchUserInputRequest | null;
  response: WorkbenchUserInputResponse | null;
}) {
  const transcriptPairs = request ? buildQuestionnaireTranscriptPairs(request, response) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-w-0">{renderQuestionnaireHistorySummary(request)}</div>
      {!isOpen ? (
        <ThreadQuestionnaireTranscriptPreview answeredAt={answeredAt} pairs={transcriptPairs} />
      ) : null}
    </div>
  );
}

function buildMetaParts (item: DynamicToolCallItem): ReactNode[] {
  return [
    item.status !== "completed" ? <ThreadSummaryText text={humanizeThreadLabel(item.status)} /> : null,
    item.durationMs !== null ? <ThreadDurationText durationMs={item.durationMs} /> : null,
    item.resultExpiredAt ? "Result expired." : null,
  ];
}

function ThreadQuestionnaireToolCallItem ({
  answeredAt,
  item,
}: {
  answeredAt: number | null;
  item: DynamicToolCallItem;
}) {
  const request = parseQuestionnaireRequest(item.arguments, `history:${item.id}`);
  const { response } = parseQuestionnaireResponse(item);
  const statusLabel = response ? "Answered" : "Unanswered";
  const [isOpen, setIsOpen] = useState(item.status !== "completed" || !response);

  return (
    <Disclosure
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
          isOpen={isOpen}
          request={request}
          response={response}
        />
      )}
      summaryClassName="items-start text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <>
        <div className="rounded-[1.15rem] bg-fg/4 p-3">
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
    </Disclosure>
  );
}

function ThreadGenericDynamicToolCallItem ({ item }: { item: DynamicToolCallItem }) {
  const project = useProject.contextual();
  const display = getNativeToolDisplay(item, { knownSkills: project?.matcherContext.knownSkills });
  const outcome = item.success === false ? "failed" : item.status;
  const outcomeDisplay = display ? getThreadCommandOutcomeDisplay(display, outcome) : null;
  const Icon = getCommandIcon(outcomeDisplay?.summaryStats);

  return (
    <ThreadStepRow
      icon={<Icon size={16} />}
      meta={buildMetaParts(item)}
      summary={outcomeDisplay ? <ThreadCommandSummary display={outcomeDisplay} line />
        : <span className="inline-flex min-w-0 max-w-full items-baseline gap-[0.45rem] overflow-hidden">
          <ThreadSummaryText text="Tool" />
          {item.namespace ? <code className={INLINE_CODE_CLASS}>{item.namespace}</code> : null}
          <code className={INLINE_CODE_CLASS}>{item.tool}</code>
        </span>}
      renderContent={() => <ThreadHydratedToolCallDetails
        invocation={formatDynamicToolInvocation({ argumentsValue: item.arguments, namespace: item.namespace, tool: item.tool })}
        item={item}
        output={body => body.resultExpiredAt ? null : formatToolCallOutput({ content: body.contentItems })}
      />}
    />
  );
}

/** Code-mode JavaScript reads like a shell command: the code is the step, and opening it shows the code with its output. */
function ThreadCodeModeItem ({ item }: { item: DynamicToolCallItem }) {
  const code = asString(asRecord(item.arguments)?.code)?.trim() ?? "";
  const failed = item.success === false || item.status === "failed";
  return (
    <ThreadStepRow
      icon={<CodeIcon size={16} />}
      iconClassName={failed ? "text-danger" : undefined}
      meta={buildMetaParts(item)}
      summary={<span className="min-w-0 truncate font-mono text-[0.92em] text-text" title={code}>{code.split(/\r?\n/u)[0] || item.tool}</span>}
      renderContent={() => <ThreadHydratedToolCallDetails
        invocation={code}
        item={item}
        output={body => body.resultExpiredAt ? null : formatToolCallOutput({ content: body.contentItems })}
      />}
    />
  );
}

export default function ThreadDynamicToolCallItem ({
  activeStartedAtMs,
  answeredAt = null,
  item,
}: {
  activeStartedAtMs?: number | null;
  answeredAt?: number | null;
  item: DynamicToolCallItem;
}) {
  const visibleDurationMs = useThreadItemLiveDuration(item.durationMs, activeStartedAtMs);
  const presentedItem = visibleDurationMs === item.durationMs
    ? item
    : { ...item, durationMs: visibleDurationMs ?? null };
  const mcpSubject = item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME ? parseMcpRequestSubject(item.arguments) : null;
  if (mcpSubject) {
    const request = parseQuestionnaireRequest(item.arguments, `history:${item.id}`);
    return <div className="py-2">
      <ThreadMcpDecisionCard subject={mcpSubject} reason={request?.questions[0]?.question ?? ""}
        approved={isMcpToolRequestApproved(parseQuestionnaireResponse(item).response)} />
    </div>;
  }
  if (item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME) {
    return <ThreadQuestionnaireToolCallItem answeredAt={answeredAt} item={presentedItem} />;
  }

  if (isNativeFileOperation(item)) return <ThreadFileChangeItem items={[presentedItem]} />;
  if (item.namespace === "opencode" && item.tool === "execute") return <ThreadCodeModeItem item={presentedItem} />;
  return <ThreadGenericDynamicToolCallItem item={presentedItem} />;
}
