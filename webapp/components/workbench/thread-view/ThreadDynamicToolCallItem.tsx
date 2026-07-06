/*
 * Exports:
 * - default ThreadDynamicToolCallItem: render dynamic tool calls, including structured questionnaire results, inside thread history. Keywords: workbench, thread, dynamic tool, questionnaire.
 * - Local helpers: normalize questionnaire payloads, parse recorded answers, and render generic JSON sections for non-questionnaire tools. Keywords: JSON, tool result, user input, display.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type {
  WorkbenchUserInputOption,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import {
  buildQuestionnaireTranscriptPairs,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "../../../lib/workbench/thread/thread-questionnaire-transcript";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadUserInputRequest from "./ThreadUserInputRequest";
import { humanizeThreadLabel } from "./thread-view-primitives";

type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

const WORKBENCH_QUESTIONNAIRE_TOOL_NAME = "workbench_request_user_input";
const COPILOT_SKILL_TOOL_NAME = "skill";
const COPILOT_TASK_TOOL_NAME = "task";
const COPILOT_DYNAMIC_TOOL_METADATA_KEY = "__copilotWorkbench";
const JSON_BLOCK_CLASS = "m-0 max-w-full overflow-x-auto whitespace-pre rounded-[0.9rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3 font-mono text-[0.78em] leading-[1.6] text-text";
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

function hasJsonValue (value: unknown) {
  return value !== null && value !== undefined;
}

function formatJsonValue (value: unknown) {
  return JSON.stringify(value, null, 2) ?? "null";
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

function parseOpenCodeQuestionnaireRequest(value: unknown, requestId: string) {
  const request = parseQuestionnaireRequest(value, requestId);
  if (!request) {
    return null;
  }

  const singleQuestionText = request.questions.length === 1
    ? request.questions[0]?.question.trim() ?? ""
    : "";
  if (!singleQuestionText || request.title.trim() !== "User input request" || request.summary.trim()) {
    return request;
  }

  return {
    ...request,
    title: singleQuestionText,
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
  inlineMentionSources,
  pairs,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
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
          <div className="ml-auto w-fit max-w-[min(42rem,86%)] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-4 py-3 text-left leading-[1.55] text-text">
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
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadQuestionnaireHistorySummary ({
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

function readTextContentItems (item: DynamicToolCallItem) {
  return (item.contentItems ?? []).filter((entry): entry is Extract<NonNullable<DynamicToolCallItem["contentItems"]>[number], { type: "inputText" }> => entry.type === "inputText")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function getCopilotDynamicToolMetadata (item: DynamicToolCallItem) {
  return asRecord(asRecord(item.arguments)?.[COPILOT_DYNAMIC_TOOL_METADATA_KEY]);
}

function getToolLabelText (item: DynamicToolCallItem, fallback = "tool") {
  const metadata = getCopilotDynamicToolMetadata(item);
  return asString(metadata?.agentDisplayName)?.trim()
    || asString(metadata?.agentName)?.trim()
    || asString(asRecord(item.arguments)?.name)?.trim()
    || humanizeThreadLabel(asString(asRecord(item.arguments)?.agent_type)?.trim() || fallback);
}

function ThreadJsonSection ({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (!hasJsonValue(value)) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-[0.67em] uppercase tracking-[0.18em] text-muted">{label}</p>
      <pre className={JSON_BLOCK_CLASS}>{formatJsonValue(value)}</pre>
    </div>
  );
}

function ThreadMetaLine ({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-muted">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </p>
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

function isOpenCodeQuestionToolCall(item: DynamicToolCallItem) {
  return item.namespace === "opencode" && item.tool === "question";
}

function ThreadQuestionnaireToolCallItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: DynamicToolCallItem;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const request = isOpenCodeQuestionToolCall(item)
    ? parseOpenCodeQuestionnaireRequest(item.arguments, `history:${item.id}`)
    : parseQuestionnaireRequest(item.arguments, `history:${item.id}`);
  const { response } = parseQuestionnaireResponse(item);
  const statusLabel = response ? "Answered" : "Unanswered";
  const initialIsOpen = item.status !== "completed" || !response;
  const [isOpen, setIsOpen] = useState(initialIsOpen);

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      defaultOpen={initialIsOpen}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
      }}
      chevronClassName="mt-[0.22em]"
      summary={(
        <ThreadQuestionnaireHistorySummary
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
      summaryClassName="items-start text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3">
          {request ? (
            <ThreadUserInputRequest
              mode="history"
              request={request}
              response={response}
              statusLabel={item.durationMs !== null ? `${statusLabel} | ${Math.round(item.durationMs)}ms` : statusLabel}
            />
          ) : item.status === "inProgress" ? (
            <p className="m-0 px-1 py-1 text-[0.84em] leading-[1.6] text-muted">
              Waiting for a response in the composer.
            </p>
          ) : (
            <p className="m-0 px-1 py-1 text-[0.84em] leading-[1.6] text-muted">
              Questionnaire details unavailable.
            </p>
          )}
        </div>
      </>
    </ThreadDisclosure>
  );
}

function ThreadGenericDynamicToolCallItem ({
  item,
}: {
  item: DynamicToolCallItem;
}) {
  const metaParts = buildMetaParts(item);

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      open={item.status !== "completed" || item.success === false}
      summary={(
        <>
          <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-[0.45rem]">
            <ThreadSummaryText text="Tool" />
            {item.namespace ? <code className={INLINE_CODE_CLASS}>{item.namespace}</code> : null}
            <code className={INLINE_CODE_CLASS}>{item.tool}</code>
          </span>
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-text"
    >
      <>
        <ThreadMetaLine
          label="Success:"
          value={item.success === null ? "pending" : item.success ? "true" : "false"}
        />
        <ThreadJsonSection label="Arguments" value={item.arguments} />
        <ThreadJsonSection label="Content items" value={item.contentItems} />
      </>
    </ThreadDisclosure>
  );
}

function ThreadToolBubble ({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3">
      <div className="m-0 pb-2 text-[0.74em] font-medium leading-[1.4] text-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

function ThreadSkillToolCallItem ({
  item,
}: {
  item: DynamicToolCallItem;
}) {
  const argumentsRecord = asRecord(item.arguments);
  const metadata = getCopilotDynamicToolMetadata(item);
  const skillName = asString(metadata?.skillName)?.trim()
    || asString(argumentsRecord?.skill)?.trim()
    || "skill";
  const skillPath = asString(metadata?.skillPath)?.trim() ?? "";
  const skillDescription = asString(metadata?.skillDescription)?.trim() ?? "";
  const skillContent = asString(metadata?.skillContent)?.trim() || readTextContentItems(item);
  const metaParts = buildMetaParts(item);

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      open={item.status !== "completed" || item.success === false}
      summary={(
        <>
          <span>Loaded skill: </span>
          <code className={INLINE_CODE_CLASS}>{skillName}</code>
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {skillPath ? <ThreadMetaLine label="Path:" value={<code className={INLINE_CODE_CLASS}>{skillPath}</code>} /> : null}
        {skillDescription ? (
          <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] px-4 py-3">
            <p className="m-0 text-[0.84em] leading-[1.65] text-text">{skillDescription}</p>
          </div>
        ) : null}
        {skillContent ? (
          <ThreadDisclosure
            contentClassName="mt-2 pl-6"
            summary={<ThreadSummaryText text="Skill context" />}
            summaryClassName="text-[0.84em] leading-[1.6] text-muted"
          >
            <pre className={`${JSON_BLOCK_CLASS} mt-2`}>{skillContent}</pre>
          </ThreadDisclosure>
        ) : null}
      </>
    </ThreadDisclosure>
  );
}

function ThreadTaskToolCallItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: DynamicToolCallItem;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const argumentsRecord = asRecord(item.arguments);
  const metadata = getCopilotDynamicToolMetadata(item);
  const metaParts = buildMetaParts(item);
  const prompt = asString(argumentsRecord?.prompt)?.trim() ?? "";
  const description = asString(argumentsRecord?.description)?.trim() ?? "";
  const agentDescription = asString(metadata?.agentDescription)?.trim() ?? "";
  const responseMarkdown = asString(metadata?.latestMessage)?.trim() || readTextContentItems(item);
  const labelText = getToolLabelText(item, "subagent");

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 space-y-3 pl-6"
      open={item.status !== "completed" || item.success === false}
      summary={(
        <>
          <span>{item.status === "completed" ? "Ran " : "Running "}</span>
          <span className="font-medium text-text">{labelText}</span>
          {metaParts.length ? (
            <span className="ml-2 text-[0.78em] text-muted">
              {metaParts.map((part, index) => (
                <span key={`${item.id}:meta:${index}`}>
                  {index ? <span className="text-muted"> | </span> : null}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <>
        {description ? <ThreadMetaLine label="Task:" value={description} /> : null}
        {agentDescription ? <ThreadMetaLine label="Agent:" value={agentDescription} /> : null}
        {prompt ? (
          <ThreadToolBubble label="Main agent">
            <ThreadMarkdown inlineMentionSources={inlineMentionSources} markdown={prompt} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />
          </ThreadToolBubble>
        ) : null}
        {responseMarkdown ? (
          <ThreadToolBubble label={labelText}>
            <ThreadMarkdown inlineMentionSources={inlineMentionSources} markdown={responseMarkdown} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />
          </ThreadToolBubble>
        ) : (
          item.status !== "completed" ? (
            <p className="m-0 text-[0.84em] leading-[1.6] text-muted">
              Waiting for the subagent response.
            </p>
          ) : null
        )}
      </>
    </ThreadDisclosure>
  );
}

export default function ThreadDynamicToolCallItem ({
  inlineMentionSources,
  item,
  threadCwdPath,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  item: DynamicToolCallItem;
  threadCwdPath?: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (item.tool === WORKBENCH_QUESTIONNAIRE_TOOL_NAME || isOpenCodeQuestionToolCall(item)) {
    return <ThreadQuestionnaireToolCallItem inlineMentionSources={inlineMentionSources} item={item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  if (item.tool === COPILOT_SKILL_TOOL_NAME) {
    return <ThreadSkillToolCallItem item={item} />;
  }

  if (item.tool === COPILOT_TASK_TOOL_NAME) {
    return <ThreadTaskToolCallItem inlineMentionSources={inlineMentionSources} item={item} threadCwdPath={threadCwdPath} projectFilePaths={projectFilePaths} projectId={projectId} projectRootPath={projectRootPath} workspaceRoots={workspaceRoots} />;
  }

  return <ThreadGenericDynamicToolCallItem item={item} />;
}
